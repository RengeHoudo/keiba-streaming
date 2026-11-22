// Optional live integration check; never reads or writes the user's data/.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { parseTickets, judgeTickets, raceBalance, today } from '../src/domain.js';

const date = process.argv[2] ?? today();
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'renge-jra-live-'));
const app = await createApp({ dataDir });
try {
  const address = await app.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/jra/races?date=${encodeURIComponent(date)}`);
  const schedule = await response.json();
  assert.equal(response.status, 200, schedule.error);
  const target = schedule.races.find(r => r.venue === '京都' && r.number === 11) ?? schedule.races[0];
  let state = await fetch(`${base}/api/state`).then(r => r.json());
  async function action(type, payload) {
    const res = await fetch(`${base}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, payload, expectedRevision: state.revision }) });
    state = await res.json(); assert.equal(res.status, 200, state.error);
  }
  await action('race.importJra', { date, venue: target.venue, number: target.number });
  const example = '3連複\n06-07-09 100円\n06-07-11 100円';
  await action('tickets.add', { tickets: parseTickets(example).filter(r => r.status === 'add').map(r => r.ticket) });
  await action('result.order', { order: [6,7,9] });
  const race = state.races.find(r => r.id === state.display.raceId);
  assert.equal(judgeTickets(race.tickets, race.result.order).wins, 1);
  assert.equal(raceBalance(race).payout, null);
  console.log(JSON.stringify({ result: 'PASS', source: schedule.sourceUrl, raceCount: schedule.races.length, imported: target, syntheticJudgement: '的中1点・不的中1点、払戻は未確定', dataDir }, null, 2));
} finally { await app.close(); }
