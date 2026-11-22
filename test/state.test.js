import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyAction, validateState } from '../src/state.js';
import { raceBalance, dayBalance, judgeTickets } from '../src/domain.js';
import { calendarUrl } from '../src/jra.js';
import { sampleState, sampleTickets } from './helpers.js';
const act = (s, type, payload = {}) => applyAction(s, { type, payload });

test('安全な初期値：収支非表示、購入記録なし、払戻未確定', () => {
  const state = initialState();
  assert.equal(state.display.balanceVisible, false);
  assert.equal(state.races[0].tickets.length, 0);
  assert.equal(raceBalance(state.races[0]).payout, null);
  assert.deepEqual(validateState(state), state);
});
test('4段階のレース状態を保存・復元でき、切替だけでは馬券や払戻を変更しない', () => {
  let s = sampleState();
  const tickets = structuredClone(s.races[0].tickets);
  const result = structuredClone(s.races[0].result);
  for (const status of ['before', 'live', 'pending', 'final']) {
    s = act(s, 'race.status', { status });
    s = act(s, 'state.import', { state: JSON.parse(JSON.stringify(s)) });
    assert.equal(s.races[0].status, status);
    assert.deepEqual(s.races[0].tickets, tickets);
    assert.deepEqual(s.races[0].result, result);
    assert.equal(raceBalance(s.races[0]).payout, null);
  }
  assert.throws(() => act(s, 'race.status', { status: 'unknown' }), /状態が不正/);
});
test('重複のバッチは全体を拒否し、既存の金額を勝手に統合しない', () => {
  const s = sampleState(); const original = structuredClone(s);
  assert.throws(() => act(s, 'tickets.add', { tickets: [{ type: 'win', numbers: [1], amount: 100 }, ...sampleTickets()] }), /登録済み/);
  assert.deepEqual(s, original);
});
test('表示モード・非表示中の的中演出・停止・再実行は記録と収支を変更しない', () => {
  let s = sampleState(); const tickets = structuredClone(s.races[0].tickets); const balance = raceBalance(s.races[0]);
  s = act(s, 'display.update', { fields: { mode: 'formation' } });
  s = act(s, 'effect.play'); const id = s.display.effect.id;
  assert.equal(s.display.balanceVisible, false);
  s = act(s, 'effect.play'); assert.notEqual(s.display.effect.id, id);
  s = act(s, 'effect.stop'); assert.equal(s.display.effect, null);
  s = act(s, 'display.update', { fields: { balanceVisible: true, effectEnabled: false } });
  assert.throws(() => act(s, 'effect.play'), /OFF/);
  assert.deepEqual(s.races[0].tickets, tickets); assert.deepEqual(raceBalance(s.races[0]), balance);
});
test('確定結果の修正は上書きで二重計上しない・手動修正履歴・購入編集で再確認', () => {
  let s = sampleState();
  const result = { ...s.races[0].result, confirmed: true, manualPayout: 1000, note: '公式払戻で確認' };
  s = act(s, 'result.save', { result }); assert.equal(raceBalance(s.races[0]).payout, 1000);
  result.manualPayout = 1300; result.note = '返還分を含む修正';
  s = act(s, 'result.save', { result });
  assert.equal(dayBalance(s.races, s.races[0].date).profit, 500);
  assert.equal(s.races[0].result.adjustments.length, 2);
  s = act(s, 'tickets.amount', { ids: [s.races[0].tickets[0].id], amount: 200 });
  assert.equal(s.races[0].result.confirmed, false);
  assert.equal(raceBalance(s.races[0]).payout, null);
});
test('複数レース・日付別の記録を保持し、馬券を選択レースに対応づける', () => {
  let s = sampleState(); const first = s.races[0].id;
  s = act(s, 'race.update', { fields: { date: '2026-11-21' } });
  s = act(s, 'race.create', { date: '2026-11-22' });
  s = act(s, 'tickets.add', { tickets: [{ type: 'win', numbers: [1], amount: 300 }] });
  assert.equal(s.races.length, 2);
  assert.equal(dayBalance(s.races, '2026-11-21').investment, 800);
  assert.equal(dayBalance(s.races, '2026-11-22').investment, 300);
  s = act(s, 'race.select', { raceId: first });
  assert.equal(s.races.find(r => r.id === s.display.raceId).tickets.length, 8);
});
test('頭数変更で複勝対象が変わると結果は再確認になる', () => {
  let s = initialState();
  s = act(s, 'race.update', { fields: { headCount: 8 } });
  s = act(s, 'tickets.add', { tickets: [{ type: 'place', numbers: [3], amount: 100 }] });
  s = act(s, 'result.save', { result: { ...s.races[0].result, order: [1,2,3], complete: true, confirmed: true, dividends: [{ type: 'place', numbers: [3], amount: 150 }] } });
  assert.equal(raceBalance(s.races[0]).payout, 150);
  s = act(s, 'race.update', { fields: { headCount: 7 } });
  assert.equal(raceBalance(s.races[0]).payout, null);
});
test('入力・インポートの検証：頭数、金額、日付、不正項目、重複', () => {
  const s = sampleState();
  assert.throws(() => act(s, 'race.update', { fields: { headCount: 8 } }), /馬番/);
  assert.throws(() => act(s, 'race.update', { fields: { date: '2026-02-30' } }), /開催日/);
  assert.throws(() => act(s, 'race.update', { fields: { tickets: [] } }));
  assert.throws(() => act(s, 'tickets.add', { tickets: [{ type: 'win', numbers: [1], amount: 1.5 }] }));
  assert.throws(() => act(s, 'display.update', { fields: { balanceVisible: 'false' } }));
  assert.throws(() => act(s, 'result.save', { result: { ...s.races[0].result, manualPayout: 0, note: '' } }), /変更理由/);
  const invalid = structuredClone(s); invalid.races[0].tickets.push(invalid.races[0].tickets[0]);
  assert.throws(() => act(s, 'state.import', { state: invalid }), /重複/);
  assert.throws(() => act(s, 'race.delete'));
  let large = act(initialState(), 'tickets.add', { tickets: [{ type: 'win', numbers: [1], amount: 100000000 }] });
  assert.throws(() => act(large, 'result.save', { result: { ...large.races[0].result, confirmed: true, complete: true, order: [1,2,3], dividends: [{ type: 'win', numbers: [1], amount: 1000000000 }] } }), /保存上限/);
});
test('着順のみ保存でき、着順修正時は払戻の確定を解除する', () => {
  let s = sampleState();
  s = act(s, 'result.order', { order: [6,7,9] });
  assert.equal(judgeTickets(s.races[0].tickets, s.races[0].result.order).wins, 1);
  assert.equal(raceBalance(s.races[0]).payout, null); assert.equal(s.display.effect, null);
  s = act(s, 'result.save', { result: { ...s.races[0].result, confirmed: true, complete: true, dividends: [{ type: 'trio', numbers: [6,7,9], amount: 1000 }] } });
  s = act(s, 'result.order', { order: [6,7,9] });
  assert.equal(raceBalance(s.races[0]).payout, 1000);
  s = act(s, 'result.order', { order: [6,7,11] });
  assert.equal(s.races[0].result.confirmed, false); assert.equal(s.races[0].result.complete, false);
  assert.equal(s.races[0].result.dividends.length, 1); assert.equal(raceBalance(s.races[0]).payout, null);
  assert.throws(() => act(s, 'result.order', { order: [6,6,11] }), /重複/);
});
test('JRA情報は同じ開催日・場・Rを更新し購入記録や結果・頭数を維持する', () => {
  let s = sampleState();
  const fields = { date: '2026-11-22', venue: '京都', number: 11, name: 'サンプル', surface: '芝', distance: 1600, startTime: '15:40' };
  s = act(s, 'race.update', { fields });
  s = act(s, 'result.order', { order: [6,7,9] });
  const before = structuredClone(s.races[0]);
  const source = { provider: 'jra-calendar', url: calendarUrl(fields.date), fetchedAt: '2026-11-22T00:00:00Z' };
  s = act(s, 'race.import', { fields: { ...fields, name: '取得したレース名' }, source });
  assert.equal(s.races.length, 1); assert.equal(s.races[0].name, '取得したレース名');
  assert.deepEqual(s.races[0].tickets, before.tickets); assert.deepEqual(s.races[0].result, before.result);
  assert.equal(s.races[0].headCount, before.headCount); assert.deepEqual(s.races[0].source, source);
  s = act(s, 'race.import', { fields: { ...fields, number: 10 }, source });
  assert.equal(s.races.length, 2); assert.equal(s.display.raceId, s.races[1].id);
  assert.equal(s.races[1].tickets.length, 0);
  s = act(s, 'race.update', { fields: { startTime: '15:45' } });
  assert.equal(s.races[1].source, null);
  const old = structuredClone(s); old.races.forEach(r => delete r.source);
  assert.ok(validateState(old)); // Existing v1 backups remain valid.
});
