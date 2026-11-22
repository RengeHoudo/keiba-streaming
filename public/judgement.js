import { TYPES, judgeTickets, circledHorse as horse, yen } from './domain.js';
import { $, escapeHTML as esc } from './shared.js';

export const VERDICTS = { win: '的中', lose: '不的中', pending: '未判定' };
export function verdictBadge(verdict) { return `<span class="verdict ${verdict}">${VERDICTS[verdict]}</span>`; }
export function setupJudgement({ getRace, send }) {
  let page = 0;
  const orderFields = ['first', 'second', 'third'].map(name => $('#result-form').elements.namedItem(name));
  function readOrder() {
    const raw = orderFields.map(input => input.value);
    if (orderFields.some(input => input.validity.badInput)) throw new Error('着順の馬番は整数で入力してください');
    if (raw.some((value, i) => value !== '' && raw.slice(0, i).some(v => v === ''))) throw new Error('着順は1着から順に入力してください');
    const order = raw.filter(v => v !== '').map(Number);
    if (order.some(n => !Number.isInteger(n) || n < 1 || n > getRace().headCount)) throw new Error(`馬番は1〜${getRace().headCount}の整数で入力してください`);
    if (new Set(order).size !== order.length) throw new Error('同じ馬番が重複しています。同着・返還等は手動払戻で対応してください');
    return order;
  }
  function render() {
    const race = getRace(); if (!race) return;
    let order = []; let error = '';
    try { order = readOrder(); } catch (e) { error = e.message; }
    const judgement = judgeTickets(race.tickets, order, race.headCount);
    const saved = !error && JSON.stringify(order) === JSON.stringify(race.result.order);
    const label = error || (order.length !== 3 ? '1〜3着の馬番を入力すると判定します' : `的中 ${judgement.wins}点 ／ 不的中 ${judgement.losses}点`);
    $('#judgement-summary').textContent = `${label}${error || order.length !== 3 ? '' : saved ? '（保存済み着順）' : '（入力中・未保存）'}`;
    $('#judgement-summary').classList.toggle('invalid', Boolean(error));
    $('#save-order').disabled = Boolean(error) || (order.length !== 3 && order.length !== 0);
    const filter = $('#judgement-filter').value;
    const items = judgement.items.filter(t => filter === 'all' || t.verdict === filter);
    const pages = Math.max(1, Math.ceil(items.length / 20)); page = Math.min(page, pages - 1);
    $('#judgement-tickets').innerHTML = items.slice(page * 20, page * 20 + 20).map(t => `<div class="judgement-ticket"><div><span class="muted">${TYPES[t.type].label} · ${yen(t.amount)}</span><strong>${t.numbers.map(horse).join(TYPES[t.type].ordered ? ' → ' : ' − ')}</strong></div>${verdictBadge(t.verdict)}</div>`).join('') || '<p class="hint">対象の購入記録はありません。</p>';
    $('#judgement-page').textContent = `${page + 1} / ${pages}`;
    $('#judgement-prev').disabled = page === 0; $('#judgement-next').disabled = page >= pages - 1;
  }
  for (const input of orderFields) input.addEventListener('input', () => { page = 0; render(); });
  $('#judgement-filter').addEventListener('change', () => { page = 0; render(); });
  $('#judgement-prev').addEventListener('click', () => { page--; render(); });
  $('#judgement-next').addEventListener('click', () => { page++; render(); });
  $('#save-order').addEventListener('click', async () => {
    if (!getRace()) return;
    try {
      if (await send('result.order', { raceId: getRace().id, order: readOrder() }, '着順を保存して的中判定しました。払戻は別途入力・確定してください')) {
        $('#result-form').elements.namedItem('confirmed').checked = getRace().result.confirmed;
        $('#result-form').elements.namedItem('complete').checked = getRace().result.complete;
      }
    } catch (error) { $('#judgement-summary').textContent = error.message; }
  });
  return { render, readOrder };
}
