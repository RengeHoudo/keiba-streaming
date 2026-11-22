import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { createJraProvider, JRA_NOTICE, parseCalendar } from '../src/jra.js';
import { createJraWorker, PAGES_ORIGIN } from '../src/jra-worker.js';
import { createJraClient, validateSchedule } from '../src/jra-client.js';
import { calendarUrl } from '../src/calendar-url.js';
import { createBrowserStore } from '../src/browser-store.js';

const date = '2026-11-22';
const html = await readFile(new URL('./fixtures/jra-calendar.html', import.meta.url), 'utf8');
const schedule = () => ({ date, sourceUrl: calendarUrl(date), fetchedAt: '2026-11-22T00:00:00.000Z', notice: JRA_NOTICE, races: parseCalendar(html, date), cached: false });
const base = 'https://jra.example.test/api/jra/races';
const request = (query = `date=${date}`, options = {}) => new Request(`${base}?${query}`, { headers: { Origin: PAGES_ORIGIN }, ...options });

test('公開JRA: Pagesから取得でき、GET/OPTIONSだけを許可してCORSを返す', async () => {
  const worker = createJraWorker({ provider: { getSchedule: async () => schedule() } });
  const response = await worker.fetch(request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), PAGES_ORIGIN);
  assert.equal(response.headers.get('Access-Control-Allow-Credentials'), null);
  assert.deepEqual((await response.json()).races, schedule().races);
  const options = await worker.fetch(request('', { method: 'OPTIONS', headers: { Origin: PAGES_ORIGIN } }));
  assert.equal(options.status, 204); assert.equal(options.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS');
  assert.equal((await worker.fetch(request('', { method: 'POST', body: 'private purchase data' }))).status, 405);
});
test('公開JRA: 任意URL・重複日付・不正日付・他サイトを拒否して上流にアクセスしない', async () => {
  let calls = 0; const worker = createJraWorker({ provider: { getSchedule: async () => { calls++; return schedule(); } } });
  for (const query of ['url=https://example.com', `date=${date}&url=https://example.com`, `date=${date}&date=${date}`, 'date=2026-02-30', 'date=../../secret']) assert.equal((await worker.fetch(request(query))).status, 400);
  const response = await worker.fetch(request(`date=${date}`, { headers: { Origin: 'https://foreign.example' } }));
  assert.equal(response.status, 403); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(calls, 0);
});
test('公開JRA: 取得エラーを明示し、連続アクセスを制限・時間経過で解除', async () => {
  let now = 1000;
  const worker = createJraWorker({ now: () => now, provider: { getSchedule: async () => { throw new Error('この日の開催情報は見つかりません'); } } });
  for (let i = 0; i < 30; i++) assert.equal((await worker.fetch(request())).status, 502);
  const limited = await worker.fetch(request()); assert.equal(limited.status, 429); assert.equal(limited.headers.get('Retry-After'), '60');
  now += 60000; assert.equal((await worker.fetch(request())).status, 502);
});
test('公開JRA: Worker→クライアント→ブラウザ保存の取り込みで既存馬券と着順を維持', async t => {
  let downloads = 0;
  const provider = createJraProvider({ fetchImpl: async url => { downloads++; assert.equal(url, calendarUrl(date)); return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8' } }); } });
  const worker = createJraWorker({ provider });
  const client = createJraClient({ endpoint: base, fetchImpl: async (url, init) => {
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
    return worker.fetch(new Request(url, { ...init, headers: { ...init.headers, Origin: PAGES_ORIGIN } }));
  } });
  const fetched = await client.getSchedule(date); assert.equal(fetched.races.length, 4);
  const store = createBrowserStore({ indexedDB: new IDBFactory(), makeChannel: null }); t.after(() => store.close());
  let state = await store.read();
  const action = () => ({ type: 'race.importJra', payload: { date, venue: '京都', number: 11 }, expectedRevision: state.revision });
  state = await store.action(await client.resolveImport(action()));
  state = await store.action({ type: 'tickets.add', payload: { tickets: [{ type: 'win', numbers: [14], amount: 100 }] }, expectedRevision: state.revision });
  state = await store.action({ type: 'result.order', payload: { order: [14,3,7] }, expectedRevision: state.revision });
  const before = state.races.find(r => r.id === state.display.raceId);
  state = await store.action(await client.resolveImport(action()));
  const after = state.races.find(r => r.id === state.display.raceId);
  assert.deepEqual(after.tickets, before.tickets); assert.deepEqual(after.result, before.result);
  assert.equal(after.source.url, calendarUrl(date)); assert.equal(after.startTime, '15:40');
  assert.equal(downloads, 1); // Successful public reads share the provider cache.
});
test('公開JRA: 日付・出典URL・レース項目の不正応答を取り込み前に拒否', () => {
  const cases = [
    { ...schedule(), date: '2026-11-23' },
    { ...schedule(), sourceUrl: 'https://foreign.example' },
    { ...schedule(), races: [{ ...schedule().races[0], startTime: '25:00' }] },
    { ...schedule(), races: [{ ...schedule().races[0], venue: '<script>' }] },
    { ...schedule(), races: [schedule().races[0], schedule().races[0]] },
  ];
  for (const input of cases) assert.throws(() => validateSchedule(input, date));
});
test('公開JRA: APIの異常応答や対象レース欠落は取り込み操作へ変換しない', async () => {
  const client = response => createJraClient({ endpoint: base, fetchImpl: async () => response() });
  await assert.rejects(client(() => new Response('login page', { headers: { 'Content-Type': 'text/html' } })).getSchedule(date), /正しい応答/);
  await assert.rejects(client(() => Response.json({ error: '取得失敗' }, { status: 502 })).getSchedule(date), /取得失敗/);
  await assert.rejects(client(() => Response.json(schedule())).resolveImport({ type: 'race.importJra', payload: { date, venue: '札幌', number: 1 } }), /指定のレースがありません/);
});
