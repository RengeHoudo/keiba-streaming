import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { parseJraResult, createJraResultProvider } from '../src/jra-result.js';
import { validateJraResult } from '../src/jra-result-data.js';
import { createJraWorker, PAGES_ORIGIN } from '../src/jra-worker.js';
import { createJraClient } from '../src/jra-client.js';
import { applyAction, initialState, validateState } from '../src/state.js';
import { raceBalance } from '../src/domain.js';
import { createBrowserStore } from '../src/browser-store.js';
import { createApp } from '../src/server.js';

// Synthetic public fixture: no real horse names or user purchase records.
const query = {date:'2026-11-08',venue:'京都',number:4};
const cname = 'pw01sde1008202605020420261108/AB';
const sourceUrl = `https://www.jra.go.jp/JRADB/accessS.html?CNAME=${encodeURIComponent(cname)}`;
const fetchedAt = '2026-11-08T06:00:00.000Z';
const payouts = {win:[['2',250]],place:[['2',120],['5',180],['1',200]],umaren:[['2-5',1000]],wide:[['2-5',400],['1-2',500],['1-5',600]],umatan:[['2-5',2000]],trio:[['1-2-5',3000]],tierce:[['2-5-1',10000]]};
const html = `<table><caption><div class="date">2026年11月8日（日曜）5回京都2日</div><img src="/JRADB/img/race_number_main/race_num_4.png" alt="4レース"></caption><thead><tr><th class="place">着順</th></tr></thead><tbody>${[2,5,1,3,4,6,7,8].map((n,i)=>`<tr><td class="place">${i+1}</td><td class="num">${n}</td><td>架空馬</td></tr>`).join('')}</tbody></table>
<div class="refund_area mt30"><h2>払戻金</h2><ul>${Object.entries(payouts).map(([type,rows])=>`<li class="${type}"><dl><dt>券種</dt><dd>${rows.map(([n,y])=>`<div class="line"><div class="num">${n}</div><div class="yen">${y.toLocaleString('en-US')}<span class="unit">円</span></div><div class="pop">1<span>番人気</span></div></div>`).join('')}</dd></dl></li>`).join('')}</ul></div>`;
const data = () => parseJraResult(html,query,sourceUrl,fetchedAt);
function setup() {
  let s=applyAction(initialState(),{type:'race.update',payload:{fields:query}});
  s=applyAction(s,{type:'tickets.add',payload:{tickets:[{type:'win',numbers:[2],amount:500},{type:'wide',numbers:[5,1],amount:200},{type:'exacta',numbers:[5,2],amount:100},{type:'trio',numbers:[5,1,2],amount:300},{type:'trifecta',numbers:[2,5,1],amount:100}]}});
  return s;
}
const importResult = s => applyAction(s,{type:'result.import',payload:{data:data()}});

test('JRA結果: 公式形式の着順と全7券種を読み、100円あたり金額を正規化',()=>{
  const d=data();assert.deepEqual(d.order,[2,5,1]);assert.equal(d.dividends.length,11);
  assert.equal(d.dividends.find(x=>x.type==='trifecta').amount,10000);
  assert.equal(d.headCount,8);assert.equal(d.sourceUrl,sourceUrl);
});
test('JRA結果: 同着・除外・不足配当・別レース・異なる着順・外部URLを拒否',()=>{
  for(const bad of [html.replace('<td class="place">2</td>','<td class="place">1</td>'),html.replace('<td class="place">8</td>','<td class="place">除外</td>'),html.replace('class="tierce"','class="unknown"'),html.replace('2026年11月8日','2026年11月9日'),html.replace('<div class="num">2-5-1</div>','<div class="num">2-1-5</div>')]) assert.throws(()=>parseJraResult(bad,query,sourceUrl,fetchedAt));
  assert.throws(()=>validateJraResult({...data(),sourceUrl:'https://foreign.example/'},query));
  assert.throws(()=>validateJraResult({...data(),dividends:[...data().dividends.slice(1),data().dividends[1]]},query));
});
test('JRA結果: 7頭では複勝2頭分を確認し、3着の複勝を当たりにしない',()=>{
  const d=data();d.headCount=7;d.dividends=d.dividends.filter(x=>!(x.type==='place'&&x.numbers[0]===1));
  assert.equal(validateJraResult(d,query).dividends.length,10);
});
test('JRA結果: 固定JRAリンクだけをたどり、キャッシュ・同時取得を共有',async()=>{
  let calls=0;let now=0;
  const provider=createJraResultProvider({now:()=>now,fetchImpl:async(url,init)=>{
    calls++;assert.equal(init.redirect,'manual');assert.ok(url.startsWith('https://www.jra.go.jp/JRADB/accessS.html'));
    const body=String(init.body??'');
    return new Response(body.includes('pw01sli')?'onclick="doAction(\'/JRADB/accessS.html\',\'pw01srl10082026050220261108/B1\')"':body.includes('pw01srl')?`<a href="/JRADB/accessS.html?CNAME=${cname}">4R</a>`:html,{headers:{'Content-Type':'text/html;charset=utf-8'}});
  }});
  const [a,b]=await Promise.all([provider.getResult(query),provider.getResult(query)]);assert.deepEqual(a,b);assert.equal(calls,3);
  await provider.getResult(query);assert.equal(calls,3);now=60001;await provider.getResult(query);assert.equal(calls,6);
});
test('JRA結果: 未公開はavailable=false、取得失敗を確定0円に変換しない',async()=>{
  const provider=createJraResultProvider({fetchImpl:async()=>new Response('<html>no result links</html>',{headers:{'Content-Type':'text/html'}})});
  const result=await provider.getResult(query);assert.equal(result.available,false);assert.equal(result.dividends,undefined);
  assert.throws(()=>applyAction(setup(),{type:'result.import',payload:{data:result}}),/まだ取得できません/);
  const fail=createJraResultProvider({fetchImpl:async()=>{throw new Error('fetch failed');}});
  await assert.rejects(fail.getResult(query),/接続できません/);
});
test('JRA結果: 外部転送・HTML以外・過大応答を拒否し、失敗をキャッシュしない',async()=>{
  for(const response of [()=>new Response(null,{status:302,headers:{Location:'https://foreign.example'}}),()=>Response.json({}),()=>new Response('x'.repeat(2*1024*1024+1),{headers:{'Content-Type':'text/html'}})]) {
    let calls=0;const p=createJraResultProvider({fetchImpl:async()=>{calls++;return response();}});
    await assert.rejects(p.getResult(query));await assert.rejects(p.getResult(query));assert.equal(calls,2);
  }
});
test('JRA結果: 購入額に応じて払戻・収支を計算し、再取得でも二重計上せず保存復元',()=>{
  let s=importResult(setup());const r=s.races[0];
  assert.deepEqual(raceBalance(r),{investment:1200,payout:21450,profit:20250,pending:false});
  assert.equal(r.status,'final');assert.equal(r.result.source.url,sourceUrl);
  s=importResult(s);assert.deepEqual(raceBalance(s.races[0]),raceBalance(r));
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(s))),s);
  assert.throws(()=>applyAction(s,{type:'result.import',payload:{data:{...data(),number:5}}}),/レース番号/);
  const changed=applyAction(s,{type:'race.update',payload:{fields:{date:'2026-11-09'}}});
  assert.equal(changed.races[0].result.source,undefined);assert.equal(raceBalance(changed.races[0]).pending,true);
});
test('JRA結果: 手動払戻の置換を履歴に残し、購入額変更後は再取得で再計算',()=>{
  let s=setup();s=applyAction(s,{type:'result.save',payload:{result:{...s.races[0].result,manualPayout:1234,note:'手動確認',confirmed:true}}});
  s=importResult(s);assert.equal(s.races[0].result.adjustments.at(-1).before,1234);assert.equal(s.races[0].result.manualPayout,null);
  const t=s.races[0].tickets[0];s=applyAction(s,{type:'ticket.update',payload:{id:t.id,ticket:{...t,amount:1000}}});
  assert.equal(raceBalance(s.races[0]).pending,true);s=importResult(s);assert.equal(raceBalance(s.races[0]).payout,22700);
});
test('JRA結果: Worker→クライアント→IndexedDBで公開版も取得・確定、購入記録は外部送信しない',async t=>{
  const worker=createJraWorker({resultProvider:{getResult:async()=>data()}});
  const client=createJraClient({endpoint:'https://api.example/api/jra/races',fetchImpl:(url,init)=>{
    assert.equal(init.body,undefined);assert.equal(init.credentials,'omit');
    assert.deepEqual([...new URL(url).searchParams.keys()],['date','venue','number']);
    return worker.fetch(new Request(url,{...init,headers:{...init.headers,Origin:PAGES_ORIGIN}}));
  }});
  const store=createBrowserStore({indexedDB:new IDBFactory(),makeChannel:null});t.after(()=>store.close());
  let s=await store.read();s=await store.action({type:'state.import',payload:{state:setup()},expectedRevision:s.revision});
  const fetched=await client.getResult(query);
  s=await store.action({type:'result.import',payload:{data:fetched},expectedRevision:s.revision});
  assert.equal(raceBalance(s.races[0]).payout,21450);
  assert.deepEqual(await store.read(),s);
  const bad=new Request('https://api.example/api/jra/result?date=2026-11-08&venue=京都&number=4&url=https://evil.example');
  assert.equal((await worker.fetch(bad)).status,400);
});
test('JRA結果: ローカルHTTP APIから取得・保存、外部Originは拒否',async t=>{
  const app=await createApp({dataDir:await mkdtemp(path.join(os.tmpdir(),'keiba-result-')),jraResultProvider:{getResult:async()=>data()}});
  t.after(()=>app.close());const a=await app.listen(0);const base=`http://127.0.0.1:${a.port}`;
  const url=`${base}/api/jra/result?${new URLSearchParams(query)}`;
  assert.equal((await fetch(url,{headers:{Origin:'https://evil.example'}})).status,403);
  const d=await fetch(url).then(r=>r.json());assert.deepEqual(d,data());
  let s=await fetch(`${base}/api/state`).then(r=>r.json());
  for(const action of [{type:'state.import',payload:{state:setup()}},{type:'result.import',payload:{data:d}}]) {
    const response=await fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...action,expectedRevision:s.revision})});
    s=await response.json();assert.equal(response.status,200,s.error);
  }
  assert.equal(raceBalance(s.races[0]).payout,21450);
});
