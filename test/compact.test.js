import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TYPES, horse, circledHorse, parseTickets, key, expandFormation, compactTicketRows, displayPages, currentDisplayPage, COMPACT_ROWS_PER_PAGE, raceBalance } from '../src/domain.js';
import { initialState, validateState, applyAction } from '../src/state.js';
import { sampleTickets } from './helpers.js';

const example = await readFile(new URL('./fixtures/paste-example-public.txt', import.meta.url), 'utf8');
const sample = parseTickets(example).filter(r => r.status === 'add').map(r => r.ticket);
const expandedKeys = rows => rows.flatMap(row => expandFormation(row.type, row.columns).map(numbers => `${key(row.type, numbers)}:${row.amount}`));
function assertExact(tickets, rows) {
  const expanded = expandedKeys(rows);
  assert.deepEqual([...expanded].sort(), tickets.map(t => `${key(t.type, t.numbers)}:${t.amount}`).sort());
  assert.equal(new Set(expanded).size, expanded.length);
  assert.ok(rows.every(r => r.notation.replace(/[①-⑱]/g, '00').length <= 32));
  assert.ok(rows.every(r => r.columns.filter(c => c.length > 1).length <= 1));
  assert.ok(rows.every(r => !r.notation.includes('BOX')));
  assert.equal(rows.reduce((s, r) => s + r.total, 0), tickets.reduce((s, t) => s + t.amount, 0));
}
test('2点を「① − ⑥ − ⑦ ⑧」の1行にまとめる', () => {
  const tickets = [[1,6,7], [1,6,8]].map(numbers => ({ type: 'trio', numbers, amount: 100 }));
  const rows = compactTicketRows(tickets);
  assert.equal(rows.length, 1); assert.equal(rows[0].notation, '① − ⑥ − ⑦ ⑧');
  assert.equal(rows[0].count, 2); assert.equal(rows[0].total, 200); assertExact(tickets, rows);
});
test('馬番①〜⑱を丸数字で表示し、入力・保存用の数字と貼付解析を保持', () => {
  const horses = Array.from({ length: 18 }, (_, i) => i + 1);
  assert.equal(horses.map(circledHorse).join(''), '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱');
  assert.deepEqual(horses.map(n => Number(circledHorse(n).normalize('NFKC'))), horses);
  assert.equal(horse(2), '02'); assert.equal(horse(14), '14');
  const parsed = parseTickets('ワイド\n②-⑭ 100円\n3連単\n⑱→⑭→② 200円').filter(r => r.status === 'add').map(r => r.ticket);
  assert.deepEqual(parsed.map(t => t.numbers), [[2,14], [18,14,2]]);
  assertExact(parsed, compactTicketRows(parsed));
});

test('ワイド・馬連の6点BOXも軸と相手を列挙して3行で表示', () => {
  for (const type of ['wide', 'quinella']) {
    const tickets = expandFormation(type, [[2,5,6,8], [2,5,6,8]]).map(numbers => ({ type, numbers, amount: 100 }));
    const rows = compactTicketRows(tickets);
    assert.deepEqual(rows.map(r => r.notation), ['② − ⑤ ⑥ ⑧', '⑤ − ⑥ ⑧', '⑥ − ⑧']);
    assert.deepEqual(rows.map(r => r.count), [3,2,1]); assertExact(tickets, rows);
    assert.deepEqual(compactTicketRows([...tickets].reverse()), rows);
  }
});

test('馬単・3連単も相手をまとめ、着順と金額を混同しない', () => {
  const tickets = [
    ...[5,6,8].map(n => ({ type: 'exacta', numbers: [2,n], amount: 100 })),
    { type: 'exacta', numbers: [5,2], amount: 100 },
    { type: 'exacta', numbers: [2,14], amount: 200 },
    ...[7,8,14].map(n => ({ type: 'trifecta', numbers: [1,6,n], amount: 100 })),
  ];
  const rows = compactTicketRows(tickets);
  assert.ok(rows.some(r => r.type === 'exacta' && r.notation === '② → ⑤ ⑥ ⑧' && r.count === 3 && r.amount === 100));
  assert.ok(rows.some(r => r.notation === '⑤ → ②' && r.count === 1));
  assert.ok(rows.some(r => r.notation === '② → ⑭' && r.amount === 200));
  assert.ok(rows.some(r => r.type === 'trifecta' && r.notation === '① → ⑥ → ⑦ ⑧ ⑭' && r.count === 3));
  assertExact(tickets, rows);
});

test('架空入力例31点を17行・3ページへ圧縮、全券種と8,000円を保持', () => {
  const before = structuredClone(sample);
  const rows = compactTicketRows(sample); const pages = displayPages(sample, 'compact');
  assert.equal(rows.length, 17); assert.equal(pages.length, 3);
  assert.deepEqual(pages.map(p => p.compact.length), [8,8,1]);
  assert.equal(COMPACT_ROWS_PER_PAGE, 8);
  assert.deepEqual(new Set(pages.flatMap(p => p.compact.map(r => r.type))), new Set(['wide', 'trio', 'trifecta']));
  assert.equal(rows.reduce((s, r) => s + r.count, 0), 31);
  assert.equal(rows.reduce((s, r) => s + r.total, 0), 8000);
  assert.ok(rows.some(r => r.type === 'wide' && r.notation === '③ − ⑦ ⑩ ⑯'));
  assertExact(sample, rows); assert.deepEqual(sample, before);
});
test('順序・金額違いを混ぜず、8点から1点欠けても増やさない', () => {
  const tickets = [
    { type: 'trifecta', numbers: [6,4,3], amount: 100 },
    { type: 'trifecta', numbers: [3,4,6], amount: 100 },
    { type: 'trifecta', numbers: [6,8,3], amount: 200 },
  ];
  const rows = compactTicketRows(tickets);
  assertExact(tickets, rows);
  // Reversed ordered bets can share columns only if expansion preserves both
  // orders exactly; their amounts must never be merged.
  assert.equal(rows.filter(r => r.amount === 100).reduce((sum, r) => sum + r.count, 0), 2);
  assert.equal(rows.filter(r => r.amount === 200).reduce((sum, r) => sum + r.count, 0), 1);
  for (let i = 0; i < 8; i++) {
    const remaining = sampleTickets().filter((_, j) => i !== j);
    assertExact(remaining, compactTicketRows(remaining));
  }
});
test('全券種・複数金額の部分集合でも圧縮前後が完全一致する', () => {
  let seed = 31;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (const type of Object.keys(TYPES)) {
    const combinations = expandFormation(type, Array.from({ length: TYPES[type].size }, () => [1,2,3,4,5,6]));
    for (let i = 0; i < 15; i++) {
      const tickets = combinations.filter(() => random() > .4).map(numbers => ({ type, numbers, amount: random() > .3 ? 100 : 200 }));
      assertExact(tickets, compactTicketRows(tickets));
    }
  }
});
test('18頭BOXや2000点でも長い文字列を分割し8行以内に収める', () => {
  const horses = Array.from({ length: 18 }, (_, i) => i + 1);
  for (const type of ['trio', 'trifecta']) {
    const tickets = expandFormation(type, [horses,horses,horses]).slice(0, 2000).map(numbers => ({ type, numbers, amount: 100 }));
    const pages = displayPages(tickets, 'compact');
    assert.ok(pages.every(p => p.compact.length <= 8));
    assertExact(tickets, pages.flatMap(p => p.compact));
  }
});
test('自動ページは10秒ごとに全ページを巡回し再読込・別画面でも一致', () => {
  const d = { page: 0, autoPage: true, ticketsVisible: true, pageStartedAt: 100000, pageInterval: 10 };
  const copy = structuredClone(d);
  assert.deepEqual([100000,109999,110000,120000,130000].map(now => currentDisplayPage(d, 3, now)), [0,0,1,2,0]);
  assert.equal(currentDisplayPage(structuredClone(d), 3, 120001), currentDisplayPage(d, 3, 120001));
  assert.equal(currentDisplayPage(d, 3, 99999), 0);
  assert.equal(currentDisplayPage(d, 0, 120000), 0); assert.equal(currentDisplayPage(d, 1, 120000), 0);
  assert.equal(currentDisplayPage({ ...d, autoPage: false, page: 2 }, 3, 190000), 2);
  assert.equal(currentDisplayPage({ ...d, ticketsVisible: false, page: 1 }, 3, 190000), 1);
  assert.deepEqual(d, copy);
});
test('旧データは一度だけまとめ表示・自動切替へ移行し、利用者の設定を保持', () => {
  const legacy = initialState(); legacy.display.mode = 'list';
  for (const field of ['autoPage', 'pageInterval', 'pageStartedAt']) delete legacy.display[field];
  const updated = validateState(legacy);
  assert.equal(updated.display.mode, 'compact'); assert.equal(updated.display.autoPage, true); assert.equal(updated.display.pageInterval, 10);
  const changed = applyAction(updated, { type: 'display.update', payload: { fields: { mode: 'list', autoPage: false, pageInterval: 20 } } });
  const restored = validateState(changed);
  assert.equal(restored.display.mode, 'list'); assert.equal(restored.display.autoPage, false); assert.equal(restored.display.pageInterval, 20);
  assert.deepEqual(updated.races, legacy.races);
  assert.throws(() => applyAction(updated, { type: 'display.update', payload: { fields: { pageInterval: 0 } } }));
});
test('切替・演出・自動巡回で購入記録と収支を変えず、演出はページ周期をリセットしない', () => {
  let s = applyAction(initialState(), { type: 'tickets.add', payload: { tickets: sample } });
  s.display.pageStartedAt = 1000;
  const tickets = structuredClone(s.races[0].tickets); const balance = raceBalance(s.races[0]);
  s = applyAction(s, { type: 'effect.play' }); assert.equal(s.display.pageStartedAt, 1000);
  for (let now = 1000; now < 100000; now += 1000) currentDisplayPage(s.display, 3, now);
  s = applyAction(s, { type: 'display.update', payload: { fields: { page: 2, autoPage: false } } });
  assert.ok(s.display.pageStartedAt > 1000);
  assert.deepEqual(s.races[0].tickets, tickets); assert.deepEqual(raceBalance(s.races[0]), balance);
});
