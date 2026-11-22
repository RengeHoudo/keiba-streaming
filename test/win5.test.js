import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { initialState, applyAction, validateState } from '../src/state.js';
import { normalize, parseTickets, parseDividends, isWinning, raceBalance, dayBalance, displayPages, expandFormation } from '../src/domain.js';
import { parseWin5Result, createWin5Provider } from '../src/jra-win5.js';
import { validateWin5Result } from '../src/jra-win5-data.js';
import { createJraClient } from '../src/jra-client.js';
import { createJraWorker, PAGES_ORIGIN } from '../src/jra-worker.js';
import { createBrowserStore } from '../src/browser-store.js';
import { createApp } from '../src/server.js';
import { exportCsv } from '../src/export.js';

const date='2026-11-22', cname='pw17hde01202611221/20';
const sourceUrl=`https://www.jra.go.jp/JRADB/access5.html?CNAME=${encodeURIComponent(cname)}`;
const order=[1,1,3,4,5];
const legs=[['京都',9],['東京',10],['京都',10],['東京',11],['京都',11]].map(([venue,number],i)=>({venue,number,startTime:`14:${String(i*10).padStart(2,'0')}`}));
const html=`<h2>2026年11月22日（日曜）</h2><table><tr class="time red">${legs.map(l=>`<td>${l.startTime.replace(':','時')}分</td>`).join('')}</tr>
<tr class="race yellow">${legs.map(l=>`<td><div class="num"><span class="rc">${l.venue}</span><span class="num">${l.number}</span></div></td>`).join('')}</tr>
<tr class="horse yellow">${order.map(n=>`<td><div class="num"><span>${n}</span></div><div class="name">架空馬</div></td>`).join('')}</tr></table>
<div class="win5_data_unit hit_mark"><h3>的中馬番</h3><div class="main">1-1-3-4-5</div></div>
<div class="win5_data_unit harai"><h3>払戻金</h3><div class="main">12,340<span>円</span></div></div>`;
const data=()=>parseWin5Result(html,date,sourceUrl,'2026-11-22T07:00:00Z');
const act=(s,type,payload={})=>applyAction(s,{type,payload});
function setup() {
  let s=act(initialState(),'race.create',{kind:'win5',date});
  return act(s,'tickets.add',{tickets:[{type:'win5',numbers:order,amount:100},{type:'win5',numbers:order,amount:200},{type:'win5',numbers:[1,2,3,4,5],amount:100}]});
}
test('WIN5は同じ馬番を5レース順で保存し、貼付・配当・判定・各表示で順序を保持',()=>{
  assert.deepEqual(normalize('win5',order),order);
  assert.equal(isWinning('win5',order,order),true);
  assert.equal(isWinning('win5',[1,3,1,4,5],order),false);
  assert.equal(isWinning('win5',order,[1,1,3]),null);
  const rows=parseTickets('ｗｉｎ５\n01-01-03-04-05 100円\n01→01→03→04→05 200円');
  assert.equal(rows.filter(r=>r.status==='add').length,2);assert.equal(rows.at(-1).duplicate,true);
  assert.deepEqual(parseDividends('WIN5 01-01-03-04-05 12,340円'),[{type:'win5',numbers:order,amount:12340}]);
  assert.equal(expandFormation('win5',[[1],[1],[3],[4],[5,6]]).length,2);
  for (const mode of ['compact','list','formation']) {
    const tickets=setup().races.at(-1).tickets;const pages=displayPages(tickets,mode);
    const expanded=pages.flatMap(p=>p.compact ? p.compact.flatMap(r=>expandFormation(r.type,r.columns).map(numbers=>({numbers,amount:r.amount}))) : p.formation ? expandFormation(p.type,p.formation.columns).map(numbers=>({numbers,amount:p.amount})) : p.tickets.map(({numbers,amount})=>({numbers,amount})));
    assert.deepEqual(expanded.map(JSON.stringify).sort(),tickets.map(({numbers,amount})=>JSON.stringify({numbers,amount})).sort());
  }
});
test('WIN5結果は公式形式の5レース・勝馬・確定配当を照合し、不正結果を拒否',()=>{
  assert.deepEqual(data().legs,legs);assert.deepEqual(data().order,order);assert.equal(data().dividend,12340);
  for(const bad of [html.replace('2026年11月22日','2026年11月21日'),html.replace('1-1-3-4-5','1-1-3-4-6'),html.replace('12,340','600,000,001'),html.replace('<span>5</span>','<span>5</span></div><div class="num"><span>6</span>'),html.replace('1-1-3-4-5','1・2-1-3-4-5')]) assert.throws(()=>parseWin5Result(bad,date,sourceUrl,'2026-11-22T07:00:00Z'));
  assert.throws(()=>validateWin5Result({...data(),sourceUrl:'https://example.com'},date));
  assert.throws(()=>validateWin5Result({...data(),legs:[legs[0],...legs.slice(0,4)]},date));
  const unavailable=parseWin5Result(html.replace('1-1-3-4-5','-').replace('12,340','-'),date,sourceUrl,'2026-11-22T07:00:00Z');
  assert.equal(unavailable.available,false);assert.deepEqual(unavailable.legs,legs);assert.equal(unavailable.dividend,undefined);
});
test('重複購入を含むWIN5払戻・日別収支・CSV・JSON復元・金額修正を計算',()=>{
  let s=setup();s=act(s,'win5.import',{data:data()});
  assert.deepEqual(raceBalance(s.races.at(-1)),{investment:400,payout:37020,profit:36620,pending:false});
  s=act(s,'win5.import',{data:data()});assert.equal(dayBalance(s.races,date).payout,37020);
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(s))),s);assert.match(exportCsv(s),/WIN5/);
  const ticket=s.races.at(-1).tickets[0];s=act(s,'ticket.update',{id:ticket.id,ticket:{...ticket,amount:300}});
  assert.equal(raceBalance(s.races.at(-1)).pending,true);
  s=act(s,'win5.import',{data:data()});assert.equal(raceBalance(s.races.at(-1)).payout,61700);
  assert.throws(()=>act(s,'win5.import',{data:{...data(),date:'2026-11-21'}}),/開催日/);
  assert.throws(()=>act(s,'tickets.add',{tickets:[{type:'win',numbers:[1],amount:100}]}),/WIN5/);
  assert.throws(()=>act(initialState(),'tickets.add',{tickets:[{type:'win5',numbers:order,amount:100}]}),/WIN5/);
});
test('WIN5の手動判定・手動払戻と、取得中の切替・削除・結果編集・対象レース変更',()=>{
  let s=setup();const race=s.races.at(-1);const id=race.id;
  s=act(s,'result.order',{order});
  s=act(s,'result.save',{result:{...s.races.at(-1).result,complete:true,confirmed:true,dividends:parseDividends('WIN5 1-1-3-4-5 12,340円')}});
  assert.equal(raceBalance(s.races.at(-1)).payout,37020);
  s=act(s,'race.select',{raceId:s.races[0].id});
  s=act(s,'win5.import',{raceId:id,data:data()});assert.equal(s.display.raceId,s.races[0].id);
  const expectedResult=JSON.stringify(s.races.at(-1).result);
  s=act(s,'result.save',{raceId:id,result:{...s.races.at(-1).result,manualPayout:10,note:'手動確認'}});
  assert.throws(()=>act(s,'win5.import',{raceId:id,data:data(),expectedResult}),/取得中/);
  assert.throws(()=>act(s,'win5.import',{raceId:id,data:{...data(),legs:[legs[1],legs[0],...legs.slice(2)]}}),/並び/);
  s=act(s,'race.delete',{raceId:id});assert.throws(()=>act(s,'win5.import',{raceId:id,data:data()}),/見つかりません/);
});
test('WIN5取得は公式一覧のリンクを使い、キャッシュと同時取得を共有',async()=>{
  let now=0,calls=0;
  const provider=createWin5Provider({now:()=>now,legProvider:{getResult:async q=>({available:true,order:[order[legs.findIndex(l=>l.venue===q.venue&&l.number===q.number)]]})},fetchImpl:async(url,init)=>{
    assert.equal(url,'https://www.jra.go.jp/JRADB/access5.html');assert.equal(init.redirect,'manual');calls++;
    return new Response(String(init.body).includes('pw17hli')?`<a onclick="doAction('/JRADB/access5.html','${cname}')">結果</a>`:html,{headers:{'Content-Type':'text/html;charset=utf-8'}});
  }});
  const [a,b]=await Promise.all([provider.getResult(date),provider.getResult(date)]);assert.deepEqual(a,b);assert.equal(calls,2);
  await provider.getResult(date);assert.equal(calls,2);now=60001;await provider.getResult(date);assert.equal(calls,4);
});
test('WIN5未公開・接続失敗・不正転送は確定0円を生成しない',async()=>{
  const empty=createWin5Provider({fetchImpl:async()=>new Response('<html></html>',{headers:{'Content-Type':'text/html'}})});
  assert.equal((await empty.getResult(date)).available,false);
  for(const response of [()=>Promise.reject(new Error('offline')),()=>new Response('',{status:302}),()=>Response.json({}),()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'Content-Type':'text/html'}})]) {
    const provider=createWin5Provider({fetchImpl:response});await assert.rejects(provider.getResult(date));
  }
});
test('WIN5の対象レースに取消・返還や勝馬不一致がある場合は自動確定しない',async()=>{
  for(const legProvider of [{getResult:async()=>{throw new Error('取消');}},{getResult:async()=>({available:false})},{getResult:async()=>({available:true,order:[18]})}]) {
    const provider=createWin5Provider({legProvider,fetchImpl:async(url,init)=>new Response(String(init.body).includes('pw17hli')?cname:html,{headers:{'Content-Type':'text/html;charset=utf-8'}})});
    await assert.rejects(provider.getResult(date));
  }
});
test('PagesのWIN5取得→IndexedDB保存→再読込、CORSと入力制限',async t=>{
  const worker=createJraWorker({win5Provider:{getResult:async()=>data()}});
  const client=createJraClient({endpoint:'https://api.example/api/jra/races',fetchImpl:(url,init)=>{
    assert.deepEqual([...new URL(url).searchParams.keys()],['date']);assert.equal(init.body,undefined);
    return worker.fetch(new Request(url,{...init,headers:{...init.headers,Origin:PAGES_ORIGIN}}));
  }});
  const store=createBrowserStore({indexedDB:new IDBFactory(),makeChannel:null});t.after(()=>store.close());
  let s=await store.read();s=await store.action({type:'state.import',payload:{state:setup()},expectedRevision:s.revision});
  s=await store.action({type:'win5.import',payload:{data:await client.getWin5Result(date)},expectedRevision:s.revision});
  assert.equal(raceBalance((await store.read()).races.at(-1)).payout,37020);
  assert.equal((await worker.fetch(new Request(`https://api.example/api/jra/win5?date=${date}&url=evil`))).status,400);
  assert.equal((await worker.fetch(new Request(`https://api.example/api/jra/win5?date=${date}`,{headers:{Origin:'https://evil.example'}}))).status,403);
});
test('ローカルHTTPもWIN5情報を取得でき、余分なパラメーターを拒否',async t=>{
  const app=await createApp({dataDir:await mkdtemp(path.join(os.tmpdir(),'keiba-win5-')),win5Provider:{getResult:async()=>data()}});t.after(()=>app.close());
  const address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
  assert.deepEqual(await fetch(`${base}/api/jra/win5?date=${date}`).then(r=>r.json()),data());
  assert.equal((await fetch(`${base}/api/jra/win5?date=${date}&date=${date}`)).status,400);
});
