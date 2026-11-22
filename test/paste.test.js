import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseTickets, normalizeText, key, raceBalance } from '../src/domain.js';
import { initialState, applyAction } from '../src/state.js';

const example = await readFile(new URL('./fixtures/paste-example-public.txt', import.meta.url), 'utf8');
const additions = rows => rows.filter(r => r.status === 'add');

test('架空の貼り付け例：31点追加・重複5行・既定額26点・8,000円', () => {
  const rows = parseTickets(example, { defaultAmount: 100 });
  assert.equal(rows.length, example.split(/\r?\n/).filter(line => line.trim()).length);
  assert.equal(rows.filter(r => r.status === 'error').length, 0);
  assert.equal(rows.filter(r => r.status === 'context').length, 7);
  assert.equal(rows.filter(r => r.status === 'ignored').length, 5);
  assert.equal(rows.filter(r => r.status === 'duplicate').length, 5);
  const added = additions(rows);
  assert.equal(added.length, 31);
  assert.equal(added.filter(r => r.usesDefault).length, 26);
  assert.equal(added.reduce((sum, r) => sum + r.ticket.amount, 0), 8000);
  assert.equal(added.filter(r => r.ticket.type === 'trio').length, 9);
  assert.equal(added.filter(r => r.ticket.type === 'wide').length, 6);
  assert.equal(added.filter(r => r.ticket.type === 'trifecta').length, 16);
  for (const [numbers, amount] of [[[2,8,11], 1500], [[4,8,15], 2500], [[7,11,13], 800]]) {
    assert.equal(added.find(r => key(r.ticket.type, r.ticket.numbers) === key('trio', numbers)).ticket.amount, amount);
  }
});
test('長音は日本語見出しを壊さず、数字間だけを馬番区切りにする', () => {
  assert.equal(normalizeText('レース フォーメーション'), 'レース フォーメーション');
  assert.equal(normalizeText('０１ ー ０６ｰ０８'), '01 - 06-08');
  const rows = parseTickets('３連複 フォーメーション 1組\n０１ ー ０６ｰ０８ ２００円');
  assert.equal(rows[0].status, 'context');
  assert.deepEqual(rows[1].ticket.numbers, [1,6,8]);
  assert.equal(rows[1].ticket.amount, 200);
});
test('右矢印の3連単・馬単は入力順を保持し、逆順を別の買い目にする', () => {
  const rows = parseTickets('３連単 １・３着ながしマルチ 2組\n06→04→03 100円\n03→04→06 200\n馬単 ボックス 2組\n06->04 100円\n04⇒06 100円');
  assert.equal(additions(rows).length, 4);
  assert.deepEqual(additions(rows).map(r => r.ticket.numbers), [[6,4,3], [3,4,6], [6,4], [4,6]]);
  assert.equal(parseTickets('3連単\n06←04←03 100円')[1].status, 'error');
});
test('ながし・BOX・マルチの見出しから買い目を自動展開しない', () => {
  for (const header of ['3連複 軸2頭ながし 3組', '3連複 ボックス 4組', '3連複 BOX 4点', '3連単 1・3着ながし 4組', '3連単 1・3着ながしマルチ 24組', '3連単 3着ながし 12組']) {
    const rows = parseTickets(`${header}\n01-04-08`, { defaultAmount: 300 });
    assert.equal(rows[0].status, 'context', header);
    assert.equal(additions(rows).length, 1, header);
    assert.equal(additions(rows)[0].ticket.amount, 300);
    assert.equal(additions(rows)[0].usesDefault, true);
    assert.equal(additions(parseTickets(header)).length, 0);
  }
});
test('金額省略への対応後も不正な金額・周辺情報・券種不明を拒否', () => {
  const rows = parseTickets('3連複\n01-04-08 1,00\n01-05-08 150\n01-06-08 0\n01-07-08 100.0\n締切時刻 16:19\nオッズ 01-06-08 1000\n投票セット 1\n場名\n京都(日)\nレース\n12R 醍醐ステークス\n01-06-08 100円');
  assert.equal(additions(rows).length, 0);
  assert.equal(rows.filter(r => r.status === 'error').length, 5);
  assert.match(rows.at(-1).message, /券種が不明/);
  assert.equal(rows.filter(r => r.status === 'ignored').length, 7);
});
test('架空入力例からの購入登録で31点を保持し、再貼付は全36行を重複として表示', () => {
  const tickets = additions(parseTickets(example)).map(r => r.ticket);
  const state = applyAction(initialState(), { type: 'tickets.add', payload: { tickets } });
  const race = state.races[0];
  assert.equal(race.tickets.length, 31); assert.equal(raceBalance(race).investment, 8000);
  const repeat = parseTickets(example, { existing: race.tickets });
  assert.equal(additions(repeat).length, 0);
  assert.equal(repeat.filter(r => r.status === 'duplicate').length, 36);
  assert.equal(repeat.filter(r => r.status === 'error').length, 0);
  assert.equal(raceBalance(race).investment, 8000);
});
