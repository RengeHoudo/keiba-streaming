import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TYPES, normalize, key, parseTickets, parseDividends, expandFormation, toFormation, ticketGroups, displayPages, isWinning, raceBalance, dayBalance, judgeTickets } from '../src/domain.js';
import { sampleNumbers, sampleTickets, sampleState } from './helpers.js';

test('順不同の券種だけを正規化し、馬単・3連単は着順を保持', () => {
  for (const type of ['quinella', 'wide', 'trio']) {
    const numbers = TYPES[type].size === 3 ? [9, 6, 7] : [9, 6];
    assert.equal(key(type, numbers), key(type, [...numbers].reverse()));
  }
  for (const type of ['exacta', 'trifecta']) {
    const numbers = TYPES[type].size === 3 ? [9, 6, 7] : [9, 6];
    assert.notEqual(key(type, numbers), key(type, [...numbers].reverse()));
    assert.deepEqual(normalize(type, numbers), numbers);
  }
  assert.throws(() => normalize('trio', [6, 6, 9]));
  assert.throws(() => normalize('win', [19]));
  assert.throws(() => normalize('win', [9], 8));
});
test('日本語の8点サンプルを正規化し800円でプレビュー', async () => {
  const rows = parseTickets(await readFile(new URL('../examples/sample-tickets.txt', import.meta.url), 'utf8'));
  assert.equal(rows.filter(r => r.status === 'add').length, 8);
  assert.equal(rows.filter(r => r.status === 'error').length, 0);
  assert.equal(rows.filter(r => r.status === 'add').reduce((s, r) => s + r.ticket.amount, 0), 800);
});
test('金額未記載・周辺情報・不正行・重複が静かに消えない', () => {
  const rows = parseTickets('京都（日）１１Ｒ３連複\n０６ － ０７ ー ０９　１００円\n06-09-18\n09-07-06 200円\n締切時刻 15:40\nオッズ 06-07-09 100円\n投票セット 01\n06-07-19 100円\n06-07-11 150円\n06-07-13 1,00円\n06-06-09 100円\n不明な文字', { defaultAmount: 200 });
  assert.equal(rows.length, 12);
  assert.equal(rows.filter(r => r.status === 'add').length, 2);
  assert.equal(rows.find(r => r.usesDefault).ticket.amount, 200);
  assert.equal(rows.filter(r => r.status === 'ignored').length, 3);
  assert.equal(rows.filter(r => r.status === 'duplicate').length, 1);
  assert.equal(rows.filter(r => r.status === 'error').length, 5);
  assert.equal(parseTickets('06-07-09 100円')[0].status, 'error');
  assert.equal(parseTickets('3連複\n06-07-09 100円', { existing: sampleTickets() })[1].status, 'duplicate');
  assert.equal(parseTickets('馬単 06-07 100円\n馬単 07-06 100円').filter(r => r.status === 'add').length, 2);
  const unsupported = parseTickets('馬単\n3連複 未対応の購入方式\n06-07 100円');
  assert.equal(unsupported[2].status, 'error');
  assert.match(unsupported[2].message, /券種が不明/);
});
test('必須の3連複8点を 06 / 07,18 / 09,11,13,16 に完全一致変換', () => {
  const formation = toFormation(sampleTickets());
  assert.deepEqual(formation.columns, [[6], [7, 18], [9, 11, 13, 16]]);
  assert.equal(formation.count, 8); assert.equal(formation.total, 800);
  assert.deepEqual(new Set(expandFormation('trio', formation.columns).map(n => key('trio', n))), new Set(sampleNumbers.map(n => key('trio', n))));
});
test('8点から1点を欠く各ケースで余分な組み合わせを生成しない', () => {
  for (let i = 0; i < 8; i++) {
    const tickets = sampleTickets().filter((_, j) => i !== j);
    const f = toFormation(tickets);
    assert.ok(f === null || (f.count === 7 && expandFormation(f.type, f.columns).every(n => tickets.some(t => key(t.type, t.numbers) === key(f.type, n)))));
    assert.ok(displayPages(tickets, 'formation').every(p => !p.formation || p.formation.count !== 8));
  }
});
test('全券種のフォーメーション展開は順序規則を守る', () => {
  assert.equal(expandFormation('quinella', [[1,2],[1,2]]).length, 1);
  assert.equal(expandFormation('wide', [[1,2],[1,2]]).length, 1);
  assert.equal(expandFormation('exacta', [[1,2],[1,2]]).length, 2);
  assert.equal(expandFormation('trio', [[1,2,3],[1,2,3],[1,2,3]]).length, 1);
  assert.equal(expandFormation('trifecta', [[1,2,3],[1,2,3],[1,2,3]]).length, 6);
  for (const type of Object.keys(TYPES)) {
    const columns = Array.from({ length: TYPES[type].size }, (_, i) => [i + 1, i + 4]);
    const tickets = expandFormation(type, columns).map(numbers => ({ type, numbers, amount: 100 }));
    const f = toFormation(tickets);
    assert.ok(f); assert.equal(f.count, tickets.length);
  }
});
test('金額が異なる買い目は別グループ。ページ切替で元の購入記録を変更しない', () => {
  const tickets = sampleTickets(); tickets[0].amount = 300;
  const original = structuredClone(tickets);
  assert.equal(toFormation(tickets), null);
  assert.equal(ticketGroups(tickets).length, 2);
  for (const mode of ['list', 'formation']) {
    const pages = displayPages(tickets, mode);
    assert.ok(pages.every(p => p.formation || p.tickets.length <= 6));
  }
  assert.deepEqual(tickets, original);
});
test('候補の完全一致を全券種の決定的な部分集合で検証', () => {
  let seed = 19;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (const type of Object.keys(TYPES)) {
    const combinations = expandFormation(type, Array.from({ length: TYPES[type].size }, () => [1,2,3,4,5,6]));
    for (let i = 0; i < 30; i++) {
      const tickets = combinations.filter(() => random() > .5).map(numbers => ({ type, numbers, amount: 100 }));
      const f = toFormation(tickets);
      if (f) assert.deepEqual(new Set(expandFormation(type, f.columns).map(n => key(type, n))), new Set(tickets.map(t => key(type, t.numbers))));
    }
  }
});
test('的中判定：着順不足・重複は未判定、順序ありとなしを区別', () => {
  assert.equal(isWinning('trifecta', [6,7,9], [6,7]), null);
  assert.equal(isWinning('win', [6], [6,6,7]), null);
  assert.equal(isWinning('exacta', [7,6], [6,7,9]), false);
  assert.equal(isWinning('quinella', [7,6], [6,7,9]), true);
  assert.equal(isWinning('trifecta', [9,7,6], [6,7,9]), false);
  assert.equal(isWinning('trio', [9,7,6], [6,7,9]), true);
  assert.equal(isWinning('place', [3], [1,2,3], 7), false);
  assert.equal(isWinning('place', [3], [1,2,3], 8), true);
  assert.equal(isWinning('wide', [3,1], [1,2,3], 8), true);
});
test('払戻未入力は0円確定にしない。必要な配当、結果確認、整数金額を使用', () => {
  const r = sampleState().races[0];
  assert.equal(raceBalance(r).payout, null);
  r.result.confirmed = true; r.result.order = [6,7,9];
  assert.equal(raceBalance(r).payout, null);
  r.result.complete = true;
  assert.equal(raceBalance(r).payout, null);
  r.result.dividends = parseDividends('３連複 ０６－０７－０９ 1,235円');
  assert.deepEqual(raceBalance(r), { investment: 800, payout: 1235, profit: 435, pending: false });
  r.result.manualPayout = 0;
  assert.equal(raceBalance(r).payout, 0);
  r.result.manualPayout = 900;
  assert.equal(raceBalance(r).payout, 900);
  assert.equal(dayBalance([r], r.date).profit, 100);
  assert.equal(dayBalance([r], '2000-01-01').investment, 0);
  assert.throws(() => parseDividends('3連複 6-7-9 1,00円'));
});
test('着順だけで各購入馬券の的中・不的中を判定し、金額・収支を変更しない', () => {
  const race = sampleState().races[0]; const before = structuredClone(race);
  const result = judgeTickets(race.tickets, [6,7,9], 18);
  assert.equal(result.wins, 1); assert.equal(result.losses, 7); assert.equal(result.pending, 0);
  assert.equal(result.items[0].verdict, 'win');
  assert.deepEqual(race, before); assert.equal(raceBalance(race).payout, null);
  for (const order of [[], [6], [6,7], [6,6,9], [6,7,19], [6,7,9,11]]) {
    const incomplete = judgeTickets(race.tickets, order, 18);
    assert.equal(incomplete.pending, 8); assert.equal(incomplete.losses, 0);
  }
  const ordered = [{ type: 'exacta', numbers: [7,6], amount: 100 }, { type: 'quinella', numbers: [7,6], amount: 100 }, { type: 'trifecta', numbers: [9,7,6], amount: 100 }];
  assert.deepEqual(judgeTickets(ordered, [6,7,9]).items.map(t => t.verdict), ['lose', 'win', 'lose']);
});
