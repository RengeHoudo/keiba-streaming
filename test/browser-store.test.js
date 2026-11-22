import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { createBrowserStore } from '../src/browser-store.js';
import { raceBalance, displayPages } from '../src/domain.js';
import { demoState } from '../src/demo.js';
import { exportCsv } from '../src/export.js';

function stores(t) {
  const indexedDB = new IDBFactory();
  const channels = new Set();
  const makeChannel = () => {
    const channel = { onmessage: null, postMessage(data) { for (const peer of channels) if (peer !== channel) peer.onmessage?.({ data }); }, close() { channels.delete(channel); } };
    channels.add(channel); return channel;
  };
  const open = () => { const store = createBrowserStore({ indexedDB, name: 'test', makeChannel }); t.after(() => store.close()); return store; };
  return { open, indexedDB };
}
test('Pages: ブラウザ保存・別タブ読込・再起動・JSON復元・undoで購入記録を保持', async t => {
  const { open } = stores(t); const control = open(); const overlay = open();
  const initial = await control.read(); assert.equal(initial.races[0].tickets.length, 0);
  assert.deepEqual(await overlay.read(), initial);
  const demo = demoState();
  const saved = await control.action({ type: 'state.import', payload: { state: demo }, expectedRevision: initial.revision });
  assert.deepEqual((await open().read()).races, demo.races);
  assert.ok(displayPages(saved.races[0].tickets, 'compact').length > 0);
  assert.match(exportCsv(saved), /サンプルレース/);
  const cleared = await control.action({ type: 'tickets.clear', expectedRevision: saved.revision });
  const undone = await overlay.action({ type: 'undo', expectedRevision: cleared.revision });
  assert.deepEqual(undone.races, saved.races);
  assert.deepEqual(raceBalance(undone.races[0]), raceBalance(saved.races[0]));
});
test('Pages: 2タブの同時更新は1件だけ保存、片方に最新状態付き409を返す', async t => {
  const { open } = stores(t); const one = open(); const two = open();
  const state = await one.read();
  const action = { type: 'tickets.add', payload: { tickets: [{ type: 'wide', numbers: [3,14], amount: 200 }] }, expectedRevision: state.revision };
  const results = await Promise.allSettled([one.action(action), two.action(action)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const error = results.find(r => r.status === 'rejected').reason;
  assert.equal(error.status, 409); assert.equal(error.state.races[0].tickets.length, 1);
  assert.deepEqual(await one.read(), await two.read());
});
test('Pages: 保存完了後に別タブへ通知し購入金額を同期', async t => {
  const { open } = stores(t); const one = open(); const two = open();
  const initial = await one.read();
  const received = new Promise(resolve => two.subscribe(state => { if (state?.revision === 1) resolve(state); }));
  const saved = await one.action({ type: 'tickets.add', payload: { tickets: [{ type: 'win', numbers: [14], amount: 100 }] }, expectedRevision: initial.revision });
  assert.deepEqual(await received, saved);
});
test('Pages: 容量不足による保存失敗で現在の記録とundoを変更しない', async t => {
  const { open } = stores(t); const store = open(); const initial = await store.read();
  const put = IDBObjectStore.prototype.put;
  try {
    IDBObjectStore.prototype.put = () => { throw new DOMException('Full', 'QuotaExceededError'); };
    await assert.rejects(store.action({ type: 'race.status', payload: { status: 'live' }, expectedRevision: initial.revision }), /Full/);
  } finally { IDBObjectStore.prototype.put = put; }
  assert.deepEqual(await store.read(), initial);
  await assert.rejects(store.action({ type: 'undo', expectedRevision: initial.revision }), /取り消せる操作がありません/);
});
test('Pages: 破損した保存記録を空データで上書きしない', async t => {
  const { open, indexedDB } = stores(t); const store = open(); await store.read();
  const db = await new Promise(resolve => { const r = indexedDB.open('test', 1); r.onsuccess = () => resolve(r.result); });
  t.after(() => db.close());
  await new Promise(resolve => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put({ state: { version: 999 }, undo: [] }, 'current'); tx.oncomplete = resolve; });
  await assert.rejects(store.read(), /対応していないデータ形式/);
  const raw = await new Promise(resolve => { const r = db.transaction('records').objectStore('records').get('current'); r.onsuccess = () => resolve(r.result); });
  assert.equal(raw.state.version, 999);
});
