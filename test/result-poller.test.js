import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAction } from '../src/state.js';
import { createResultPoller, needsResult } from '../src/result-poller.js';

const act=(s,type,payload={})=>applyAction(s,{type,payload});
function setup() {
  let s=act(initialState(),'race.update',{fields:{date:'2026-11-22',venue:'京都',startTime:'15:00'}});
  return act(s,'tickets.add',{tickets:[{type:'win',numbers:[1],amount:100}]});
}
const start=Date.parse('2026-11-22T15:00:00+09:00');
test('発走前には取得せず、購入のあるJRAレースだけを対象にする',()=>{
  const r=setup().races[0];
  assert.equal(needsResult(r,start-1),false);assert.equal(needsResult(r,start),true);
  assert.equal(needsResult({...r,tickets:[]},start),false);
  assert.equal(needsResult({...r,autoResult:false},start),false);
  assert.equal(needsResult({...r,venue:'地方'},start),false);
  assert.equal(needsResult({...r,startTime:''},start),false);
  assert.equal(needsResult({...r,startTime:'',status:'pending'},start),true);
});
test('選択レースを変えても未確定の購入レースを巡回し、エラー後も60秒で再試行',async()=>{
  let s=setup();const first=s.races[0].id;
  s=act(s,'race.create',{date:'2026-11-22'});
  s=act(s,'race.update',{fields:{venue:'東京',startTime:'15:00'}});
  s=act(s,'tickets.add',{tickets:[{type:'win',numbers:[1],amount:100}]});
  const second=s.display.raceId;
  let now=start;const called=[];
  const p=createResultPoller({getState:()=>s,now:()=>now,check:async r=>{called.push(r.id);throw new Error('offline');}});
  await p.tick();now+=3000;await p.tick();assert.deepEqual(called,[first,second]);
  now=start+59999;await p.tick();assert.equal(called.length,2);
  now++;await p.tick();assert.deepEqual(called,[first,second,first]);
  s=act(s,'result.save',{raceId:first,result:{...s.races[0].result,confirmed:true,manualPayout:0,note:'確認済み'}});
  now+=60000;await p.tick();assert.equal(called.at(-1),second);
  s=act(s,'race.update',{raceId:second,fields:{autoResult:false}});
  now+=60000;await p.tick();assert.equal(called.length,4);
});
test('多数のレースでも公平に巡回し、同時リクエストと連続アクセスを抑える',async()=>{
  const s=setup();s.races=Array.from({length:36},(_,i)=>({...structuredClone(s.races[0]),id:String(i)}));
  let now=start;const called=[];
  const p=createResultPoller({getState:()=>s,now:()=>now,check:async r=>called.push(r.id)});
  for(let i=0;i<36;i++){await p.tick();now+=3000;}
  assert.equal(new Set(called).size,36);
  let release;let count=0;
  const slow=createResultPoller({getState:()=>s,now:()=>now,check:()=>{count++;return new Promise(resolve=>{release=resolve;});}});
  const request=slow.tick();now+=60000;await slow.tick();assert.equal(count,1);release();await request;
});
test('自動確認設定は旧バックアップでONとなり、停止設定は復元後も残る',()=>{
  let s=setup();delete s.races[0].autoResult;
  s=act(s,'state.import',{state:s});assert.equal(s.races[0].autoResult,true);
  s=act(s,'race.update',{fields:{autoResult:false}});
  s=act(s,'state.import',{state:JSON.parse(JSON.stringify(s))});assert.equal(s.races[0].autoResult,false);
});
