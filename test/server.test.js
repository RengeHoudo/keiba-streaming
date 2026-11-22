import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { Storage } from '../src/storage.js';
import { sampleTickets } from './helpers.js';
import { createJraProvider } from '../src/jra.js';
import { judgeTickets, raceBalance, parseTickets, displayPages, currentDisplayPage } from '../src/domain.js';

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'renge-keiba-test-'));
  const app = await createApp({ ...options, dataDir: directory }); const address = await app.listen(0);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const state = () => fetch(`${base}/api/state`).then(r => r.json());
  const action = async (type, payload = {}, revision) => {
    const response = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ type, payload, expectedRevision: revision ?? (await state()).revision }) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, app, base, state, action };
}
// Native HTTP preserves Fetch Metadata verbatim; fetch() sets its own mode.
function request(base, route, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, res => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function stream(base) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let buffer = '';
  return {
    close() { controller.abort(); },
    async next() {
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        while (true) {
          const end = buffer.indexOf('\n\n');
          if (end !== -1) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = event.split('\n').find(line => line.startsWith('data: '));
            if (data) return JSON.parse(data.slice(6));
          } else { const chunk = await reader.read(); if (chunk.done) throw new Error('SSE ended'); buffer += decoder.decode(chunk.value, { stream: true }); }
        }
      } finally { clearTimeout(timeout); }
    },
  };
}
test('購入記録を安全に保存し、別サーバー起動で復元・バックアップを保持', async t => {
  const { directory, app, action, state } = await setup(t);
  assert.equal((await action('tickets.add', { tickets: sampleTickets() })).status, 200);
  const saved = await state();
  await app.close();
  const restarted = await createApp({ dataDir: directory });
  const address = await restarted.listen(0); t.after(() => restarted.close());
  const restored = await fetch(`http://127.0.0.1:${address.port}/api/state`).then(r => r.json());
  assert.deepEqual(restored, saved);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'state.backup.json'), 'utf8')).races[0].tickets.length, 0);
});
test('SSEの複数オーバーレイを即時同期、再接続で最新状態を送信', async t => {
  const { base, action } = await setup(t);
  const one = await stream(base); const two = await stream(base);
  t.after(() => { one.close(); two.close(); });
  assert.equal((await one.next()).revision, 0); assert.equal((await two.next()).revision, 0);
  const update = await action('tickets.add', { tickets: sampleTickets() });
  const [a, b] = await Promise.all([one.next(), two.next()]);
  assert.deepEqual(a, update.body); assert.deepEqual(b, update.body);
  one.close();
  await action('race.status', { status: 'live' });
  const reconnected = await stream(base); t.after(() => reconnected.close());
  assert.equal((await reconnected.next()).races[0].status, 'live');
});
test('架空入力例のまとめ表示・自動切替設定をHTTPで更新し、SSE同期・停止・再起動で保持', async t => {
  const { directory, app, base, action, state } = await setup(t);
  const example = await readFile(new URL('./fixtures/paste-example-public.txt', import.meta.url), 'utf8');
  const tickets = parseTickets(example).filter(r => r.status === 'add').map(r => r.ticket);
  assert.equal((await action('tickets.add', { tickets })).status, 200);
  const streamClient = await stream(base); t.after(() => streamClient.close());
  const initial = await streamClient.next();
  assert.equal(initial.display.mode, 'compact'); assert.equal(initial.display.autoPage, true);
  const pages = displayPages(initial.races[0].tickets, initial.display.mode);
  assert.deepEqual(pages.map(p => p.compact.length), [8,8,1]);
  const update = await action('display.update', { fields: { pageInterval: 5, page: 0 } });
  assert.equal(update.status, 200);
  const synced = await streamClient.next(); assert.deepEqual(synced, update.body);
  assert.deepEqual([0,5000,10000,15000].map(elapsed => currentDisplayPage(synced.display, pages.length, synced.display.pageStartedAt + elapsed)), [0,1,2,0]);
  const pause = await action('display.update', { fields: { autoPage: false, page: 2 } });
  assert.equal(pause.status, 200);
  assert.equal(currentDisplayPage(pause.body.display, 3, pause.body.display.pageStartedAt + 60000), 2);
  const saved = await state();
  assert.deepEqual(saved.races, initial.races); assert.equal(raceBalance(saved.races[0]).investment, 8000);
  streamClient.close(); await app.close();
  const restarted = await createApp({ dataDir: directory }); t.after(() => restarted.close());
  const address = await restarted.listen(0);
  const restored = await fetch(`http://127.0.0.1:${address.port}/api/state`).then(r => r.json());
  assert.deepEqual(restored, saved);
});

test('競合する同時更新の片方を409で拒否し、重複購入を防止', async t => {
  const { action, state } = await setup(t);
  const revision = (await state()).revision;
  const updates = await Promise.all([action('tickets.add', { tickets: sampleTickets() }, revision), action('tickets.add', { tickets: sampleTickets() }, revision)]);
  assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
  assert.equal((await state()).races[0].tickets.length, 8);
  assert.equal((await action('tickets.add', { tickets: sampleTickets() })).status, 400);
  assert.equal((await state()).races[0].tickets.length, 8);
});
test('削除の取り消し、JSON復元、CSVの式注入防止', async t => {
  const { base, action, state } = await setup(t);
  await action('tickets.add', { tickets: sampleTickets() });
  await action('race.update', { fields: { name: '=HYPERLINK("x")' } });
  const backup = await fetch(`${base}/api/export`).then(r => r.json());
  const csv = await fetch(`${base}/api/export.csv`).then(r => r.text());
  assert.ok(csv.includes("'=HYPERLINK"));
  await action('tickets.clear'); assert.equal((await state()).races[0].tickets.length, 0);
  await action('undo'); assert.equal((await state()).races[0].tickets.length, 8);
  await action('tickets.clear');
  await action('state.import', { state: backup }); assert.equal((await state()).races[0].tickets.length, 8);
});
test('ローカル限定・Origin/Host/Content-Type検証・静的ファイルの限定', async t => {
  const { base, app } = await setup(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/data/state.json`)).status, 404);
  assert.equal((await fetch(`${base}/src/storage.js`)).status, 404);
  assert.equal((await fetch(`${base}/control`)).status, 200);
  assert.equal((await fetch(`${base}/overlay`)).status, 200);
  const status = await new Promise(resolve => { http.get(base + '/api/state', { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); });
  assert.equal(status, 403);
});
test('外部ページのリンクから操作画面・オーバーレイへ直接移動できる', async t => {
  const { base, state } = await setup(t);
  const before = await state();
  const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const route of ['/', '/control', '/overlay']) {
    const response = await request(base, route, { headers });
    assert.equal(response.status, 200, route);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.match(response.body, /<!doctype html>/i);
  }
  assert.equal((await request(base, '/control', { method: 'HEAD', headers })).status, 200);
  assert.deepEqual(await state(), before);
});
test('画面への移動を許可しても外部のAPI・埋め込み・スクリプト・POSTは拒否', async t => {
  const { base, state } = await setup(t);
  const before = await state();
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  for (const route of ['/api/state', '/api/events', '/api/export', '/api/export.csv', '/api/jra/races?date=2026-11-22', '/control.js', '/judgement.js', '/jra-control.js']) {
    assert.equal((await request(base, route, { headers: navigation })).status, 403, route);
  }
  for (const headers of [
    { ...navigation, 'Sec-Fetch-Dest': 'iframe' },
    { ...navigation, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' },
    { ...navigation, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { ...navigation, Host: 'attacker.invalid' },
  ]) assert.equal((await request(base, '/control', { headers })).status, 403);
  for (const route of ['/control', '/api/action']) {
    assert.equal((await request(base, route, {
      method: 'POST', headers: { ...navigation, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'race.status', payload: { status: 'live' }, expectedRevision: before.revision }),
    })).status, 403);
  }
  assert.equal((await request(base, '/api/state', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.deepEqual(await state(), before);
});
test('ネットワークチャンク境界の日本語UTF-8が壊れない', async t => {
  const { base, state } = await setup(t);
  const body = Buffer.from(JSON.stringify({ type: 'race.update', payload: { fields: { venue: '京都', name: '宝土蓮華' } }, expectedRevision: 0 }));
  const result = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    for (let i = 0; i < body.length; i++) req.write(body.subarray(i, i + 1));
    req.end();
  });
  assert.equal(result, 200); assert.equal((await state()).races[0].name, '宝土蓮華');
});
test('破損ファイルを上書き破棄せず、前回バックアップを復元', async t => {
  const { directory, action } = await setup(t);
  await action('tickets.add', { tickets: sampleTickets() });
  await action('race.status', { status: 'live' });
  await writeFile(path.join(directory, 'state.json'), 'broken', 'utf8');
  const restored = await new Storage(directory).load();
  assert.equal(restored.races[0].tickets.length, 8);
  assert.equal(restored.races[0].status, 'before');
});
test('保存に失敗した操作は状態変更・SSE通知を行わない', async t => {
  const { directory, action, state } = await setup(t);
  const before = await state();
  // A directory in place of the temporary file makes atomic-write fail on all OSes.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(directory, 'state.json.tmp'));
  const response = await action('tickets.add', { tickets: sampleTickets() });
  assert.notEqual(response.status, 200);
  assert.deepEqual(await state(), before);
});
test('JRA取得・取り込み・着順のみ保存をHTTP経由で実行し永続化', async t => {
  const html = await readFile(new URL('./fixtures/jra-calendar.html', import.meta.url), 'utf8');
  let calls = 0;
  const jraProvider = createJraProvider({ fetchImpl: async () => { calls++; return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); } });
  const { base, directory, action, state } = await setup(t, { jraProvider });
  const schedule = await fetch(`${base}/api/jra/races?date=2026-11-22`).then(r => r.json());
  assert.equal(schedule.races.length, 4);
  assert.equal((await action('race.importJra', { date: '2026-11-22', venue: '京都', number: 11 })).status, 200);
  let saved = await state();
  const imported = saved.races.find(r => r.id === saved.display.raceId);
  assert.equal(imported.startTime, '15:40'); assert.equal(imported.venue, '京都');
  await action('tickets.add', { tickets: sampleTickets() });
  assert.equal((await action('result.order', { order: [6,7,9] })).status, 200);
  assert.equal((await action('race.importJra', { date: '2026-11-22', venue: '京都', number: 11 })).status, 200);
  assert.equal(calls, 1);
  saved = await state(); assert.equal(saved.races.length, 2);
  const r = saved.races.find(r => r.id === saved.display.raceId);
  assert.equal(r.tickets.length, 8); assert.equal(judgeTickets(r.tickets, r.result.order).wins, 1);
  assert.equal(raceBalance(r).payout, null); assert.equal(saved.display.effect, null);
  const restored = await new Storage(directory).load(); assert.deepEqual(restored, saved);
  for (const route of ['/judgement.js', '/jra-control.js']) assert.equal((await fetch(base + route)).status, 200);
  assert.equal((await fetch(`${base}/api/jra/races?date=bad`)).status, 400);
  assert.equal((await action('race.importJra', { date: '2026-11-22', venue: '大井', number: 11 })).status, 400);
  assert.equal(calls, 1);
});
test('JRA取得失敗は既存状態を変更しない', async t => {
  const jraProvider = createJraProvider({ fetchImpl: async () => new Response('', { status: 503 }) });
  const { base, action, state } = await setup(t, { jraProvider });
  const before = await state();
  const response = await fetch(`${base}/api/jra/races?date=2026-11-22`);
  assert.equal(response.status, 400); assert.match((await response.json()).error, /503/);
  assert.equal((await action('race.importJra', { date: '2026-11-22', venue: '京都', number: 11 })).status, 400);
  assert.deepEqual(await state(), before);
});
