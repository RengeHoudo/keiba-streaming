import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { calendarUrl, parseCalendar, decodeCalendar, createJraProvider } from '../src/jra.js';

const fixture = await readFile(new URL('./fixtures/jra-calendar.html', import.meta.url), 'utf8');
const htmlResponse = () => new Response(fixture, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
test('JRA番組を開催場・R・名称・コース・距離・時刻に変換し、障害も区別', () => {
  const races = parseCalendar(fixture, '2026-11-22');
  assert.equal(races.length, 4);
  assert.deepEqual(races[0], { date: '2026-11-22', venue: '東京', number: 1, name: '2歳未勝利', surface: 'ダート', distance: 1300, startTime: '09:50' });
  assert.deepEqual(races[2], { date: '2026-11-22', venue: '京都', number: 11, name: '第43回 マイルチャンピオンシップ(GI)', surface: '芝', distance: 1600, startTime: '15:40' });
  assert.equal(races[3].surface, '障害');
  assert.equal(races[3].distance, 2910);
});
test('JRAページが別日・形式不明・項目欠落の場合は推測せず失敗', () => {
  assert.throws(() => parseCalendar(fixture, '2026-11-23'), /開催日/);
  assert.throws(() => parseCalendar('<html>error</html>', '2026-11-22'));
  assert.throws(() => parseCalendar(fixture.replace('15時40分', '未定'), '2026-11-22'), /解析できません/);
  assert.throws(() => parseCalendar(fixture.replace('1,600', '1,60'), '2026-11-22'));
  assert.throws(() => parseCalendar(fixture.replace('>4<span>', '>11<span>'), '2026-11-22'), /重複/);
});
test('JRA固定URL・日付の検証とShift_JIS/UTF-8の復号', () => {
  assert.equal(calendarUrl('2026-11-22'), 'https://www.jra.go.jp/keiba/calendar2026/2026/11/1122.html');
  for (const bad of ['2026-02-30', '../../etc', 'https://example.com', null, '2101-01-01']) assert.throws(() => calendarUrl(bad));
  assert.equal(decodeCalendar(Buffer.from([0x93,0x8c,0x8b,0x9e]), 'text/html; charset=Shift_JIS'), '東京');
  assert.equal(decodeCalendar(Buffer.from(fixture)), fixture);
  assert.throws(() => decodeCalendar(Buffer.from([255]), 'text/html; charset=utf-8'));
});
test('取得はキャッシュ・同時要求をまとめ、取得時刻と予定情報の注意を返す', async () => {
  let calls = 0; let clock = Date.parse('2026-11-22T00:00:00Z');
  const provider = createJraProvider({ fetchImpl: async url => { calls++; assert.equal(url, calendarUrl('2026-11-22')); return htmlResponse(); }, now: () => clock, cacheMs: 1000 });
  const [first, second] = await Promise.all([provider.getSchedule('2026-11-22'), provider.getSchedule('2026-11-22')]);
  assert.equal(calls, 1); assert.deepEqual(first, second);
  assert.match(first.notice, /予定/); assert.equal(first.fetchedAt, '2026-11-22T00:00:00.000Z');
  first.races[0].name = 'changed';
  const cached = await provider.getSchedule('2026-11-22');
  assert.equal(cached.cached, true); assert.notEqual(cached.races[0].name, 'changed');
  clock += 1001; await provider.getSchedule('2026-11-22'); assert.equal(calls, 2);
});
test('未公開・ネットワークエラー・タイムアウトは明示し、失敗を成功キャッシュにしない', async () => {
  let calls = 0;
  const unavailable = createJraProvider({ fetchImpl: async () => { calls++; return new Response('', { status: 404 }); } });
  await assert.rejects(unavailable.getSchedule('2026-11-22'), /未公開/);
  await assert.rejects(unavailable.getSchedule('2026-11-22'), /未公開/); assert.equal(calls, 2);
  const disconnected = createJraProvider({ fetchImpl: async () => { throw new Error('fetch failed'); } });
  await assert.rejects(disconnected.getSchedule('2026-11-22'), /インターネット接続/);
  const timeout = createJraProvider({ timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(htmlResponse()), 200);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) });
  await assert.rejects(timeout.getSchedule('2026-11-22'), /タイムアウト/);
});
test('任意URLへのリダイレクト・過大な応答・非HTMLを拒否', async () => {
  let calls = 0;
  const redirect = createJraProvider({ fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1:8765/api/state' } }); } });
  await assert.rejects(redirect.getSchedule('2026-11-22'), /転送先/); assert.equal(calls, 1);
  const oversized = createJraProvider({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'text/html' } }) });
  await assert.rejects(oversized.getSchedule('2026-11-22'), /大きすぎる/);
  const wrongType = createJraProvider({ fetchImpl: async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(wrongType.getSchedule('2026-11-22'), /HTML以外/);
});
