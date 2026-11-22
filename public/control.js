import { TYPES, STATUSES, FALLBACK, yen, horse, circledHorse, today, parseTickets, parseDividends, normalize, validateAmount, displayPages, currentDisplayPage, raceBalance, dayBalance, isWinning } from './domain.js';
import { $, escapeHTML as esc, setText, connect, requestAction, BROWSER_MODE, controlUrl, overlayUrl } from './shared.js';
import { setupJudgement, verdictBadge } from './judgement.js';
import { setupJra } from './jra-control.js';
import { setupJraResult } from './jra-result-control.js';
import { exportCsv } from './export.js';

let state = null;
let busy = false;
let connected = false;
let selected = [];
let editing = null;
let preview = null;
let recordsPage = 0;
let checkedTickets = new Set();
let renderedRaceId = null;
let renderedRevision = -1;
let ticketPages = [];
const race = () => state?.races.find(r => r.id === state.display.raceId);
const judgementUI = setupJudgement({ getRace: race, send });
const jraUI = setupJra({ getState: () => state, send, confirmAction, onImport: () => { fillRaceForm(); fillResultForm(); openDetails('race-details'); } });
const jraResultUI = setupJraResult({ getState: () => state, send, onImport: () => { fillRaceForm(); fillResultForm(); } });
const fields = form => $(form).elements;
const formField = (form, name) => fields(form).namedItem(name);
const options = Object.entries(TYPES).map(([value, type]) => `<option value="${value}">${type.label}</option>`).join('');
$('#ticket-type').innerHTML = options;
$('#pick-fields').innerHTML = ['◎', '○', '▲', '△', '☆'].map((mark, i) => `<label>${mark}<input name="pick${i}" type="number" min="1" max="18" aria-label="予想印 ${mark} の馬番"></label>`).join('');
$('#control-url').value = controlUrl;
$('#overlay-url').value = overlayUrl;
$('#overlay-link').href = overlayUrl;
$('#browser-note').hidden = !BROWSER_MODE;
$('#history-date').value = today();

function notify(message, error = false) {
  const element = $('#notice'); element.textContent = message; element.className = `notice${error ? ' error' : ''}`; element.hidden = false;
}
function connectionStatus() {
  setText('#connection', busy ? '保存中…' : connected ? BROWSER_MODE ? 'このブラウザに保存済み' : '接続済み · 保存済み' : BROWSER_MODE ? 'ブラウザ保存領域を確認しています' : '再接続中 · 最後の状態を保持');
  $('#connection-dot').classList.toggle('connected', connected);
}
async function send(type, payload = {}, message = '保存しました') {
  if (!state) { notify('サーバーへの接続を待っています', true); return false; }
  if (busy) { notify('保存処理中です。完了後にもう一度操作してください'); return false; }
  busy = true; connectionStatus();
  try {
    const response = await requestAction({ type, payload, expectedRevision: state.revision });
    const result = response.data;
    if (!response.ok) {
      if (result.state) render(result.state);
      throw new Error(result.error || '保存できませんでした');
    }
    render(result); notify(message); return true;
  } catch (error) { notify(error.message === 'Failed to fetch' ? '接続できません。保存されていません。サーバーの起動を確認してください。' : error.message, true); return false; }
  finally { busy = false; connectionStatus(); }
}
function openDetails(id) { const element = document.getElementById(id); element.open = true; element.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function confirmAction(title, message) {
  return new Promise(resolve => {
    setText('#confirm-title', title); setText('#confirm-message', message);
    const dialog = $('#confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}
function invalidatePreview() {
  preview = null; $('#paste-results').replaceChildren(); $('#paste-confirm').checked = false;
  $('#paste-confirm-label').hidden = true; $('#paste-register').hidden = true; $('#paste-register').disabled = true;
}
function fillRaceForm() {
  const r = race();
  for (const name of ['date', 'venue', 'number', 'headCount', 'name', 'surface', 'distance', 'startTime']) formField('#race-form', name).value = r[name] ?? '';
  ['◎', '○', '▲', '△', '☆'].forEach((mark, i) => { const input = formField('#race-form', `pick${i}`); input.value = r.picks.find(p => p.mark === mark)?.number ?? ''; input.max = r.headCount; });
}
function fillResultForm() {
  const r = race(); const result = r.result;
  ['first', 'second', 'third'].forEach((name, i) => { formField('#result-form', name).value = result.order[i] ?? ''; formField('#result-form', name).max = r.headCount; });
  formField('#result-form', 'dividends').value = result.dividends.map(d => `${TYPES[d.type].label} ${d.numbers.map(horse).join('-')} ${yen(d.amount)}`).join('\n');
  for (const name of ['complete', 'confirmed']) formField('#result-form', name).checked = result[name];
  for (const name of ['manualPayout', 'note']) formField('#result-form', name).value = result[name] ?? '';
  judgementUI.render();
}
function render(next) {
  if (next.revision < renderedRevision) return;
  const previous = state;
  state = next;
  renderedRevision = next.revision;
  const r = race();
  const changedRace = renderedRaceId !== r.id;
  if (preview && preview.revision !== state.revision) invalidatePreview();
  $('#race-select').innerHTML = state.races.map(r => `<option value="${esc(r.id)}">${esc(`${r.date.slice(5)} ${r.venue || '未設定'} ${r.number}R ${r.name || 'レース名未入力'}`)}</option>`).join('');
  $('#race-select').value = r.id;
  setText('#race-meta', `${r.date} · ${r.surface}${r.distance ? r.distance + 'm' : ''} · ${r.headCount}頭${r.startTime ? ' · 発走 ' + r.startTime : ''}`);
  $('#race-source').hidden = !r.source;
  setText('#race-source', r.source ? 'JRA開催日程の予定情報 · 頭数・当日の変更は手動確認' : '');
  for (const button of document.querySelectorAll('[data-status]')) { const active = button.dataset.status === r.status; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); }
  for (const button of document.querySelectorAll('[data-mode]')) { const active = button.dataset.mode === state.display.mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', active); }
  for (const [id, field] of [['tickets-visible', 'ticketsVisible'], ['balance-visible', 'balanceVisible'], ['effect-enabled', 'effectEnabled'], ['countdown', 'countdown']]) $(`#${id}`).checked = state.display[field];
  $('#effect-play').disabled = !state.display.effectEnabled;
  const investment = r.tickets.reduce((sum, ticket) => sum + ticket.amount, 0);
  setText('#purchase-total', `${r.tickets.length}点 · ${yen(investment)}`);
  setText('#ticket-count', `${r.tickets.length}点`); setText('#records-count', `${r.tickets.length}点`);
  ticketPages = displayPages(r.tickets, state.display.mode);
  $('#auto-page').checked = state.display.autoPage;
  $('#page-interval').value = String(state.display.pageInterval);
  $('#compact-help').hidden = state.display.mode !== 'compact';
  renderPageControls();
  if (changedRace) {
    editing = null; selected = []; recordsPage = 0; checkedTickets.clear();
    fillRaceForm(); fillResultForm(); renderHorseButtons();
    $('#history-date').value = r.date;
    renderedRaceId = r.id;
  } else if (previous?.races.find(x => x.id === r.id)?.headCount !== r.headCount) renderHorseButtons();
  renderRecords(); renderBalances(); judgementUI.render(); jraUI.render(); jraResultUI.render();
  const balance = raceBalance(r);
  setText('#result-status', balance.pending ? '払戻未確定・未入力（0円確定ではありません）' : `確定払戻 ${yen(balance.payout)} ／ 収支 ${yen(balance.profit)}`);
  if (previous?.races.find(x => x.id === r.id)?.result.confirmed && !r.result.confirmed) formField('#result-form', 'confirmed').checked = false;
  $('#adjustments').innerHTML = r.result.adjustments.slice(-5).reverse().map(a => `<p>${esc(new Date(a.at).toLocaleString('ja-JP'))}：${esc(a.before === null ? '自動計算' : yen(a.before))} → ${esc(a.after === null ? '自動計算' : yen(a.after))}<br>${esc(a.note)}</p>`).join('');
  setText('#sync-time', new Date(state.updatedAt).toLocaleTimeString('ja-JP', { hour12: false }));
}
function renderPageControls() {
  if (!state) return;
  const page = currentDisplayPage(state.display, ticketPages.length);
  setText('#page-label', `${page + 1} / ${ticketPages.length || 1}${state.display.autoPage && ticketPages.length > 1 ? ' · 自動' : ''}`);
  for (const id of ['page-prev', 'page-next']) $(`#${id}`).disabled = ticketPages.length < 2;
  $('#formation-note').hidden = !ticketPages[page]?.fallback;
  setText('#formation-note', ticketPages[page]?.fallback ? FALLBACK : '');
}
function renderHorseButtons() {
  const type = $('#ticket-type').value;
  const config = TYPES[type];
  selected = selected.filter(n => n <= (race()?.headCount ?? 18)).slice(0, config.size);
  setText('#selection-help', config.ordered ? `${config.size}頭を着順どおりに選択してください（選択順を保存）` : `${config.size}頭を選択してください（順不同）`);
  $('#horse-buttons').innerHTML = Array.from({ length: 18 }, (_, i) => {
    const n = i + 1; const position = selected.indexOf(n);
    return `<button type="button" data-horse="${n}" aria-label="馬番 ${n}" aria-pressed="${position >= 0}" class="${position >= 0 ? 'selected' : ''}" ${n > (race()?.headCount ?? 18) ? 'disabled' : ''}>${circledHorse(n)}${position >= 0 && config.ordered ? `<small>${position + 1}着</small>` : ''}</button>`;
  }).join('');
  setText('#selected-horses', selected.length ? selected.map(circledHorse).join(config.ordered ? ' → ' : ' − ') : '馬番を選択');
  setText('#ticket-submit', editing ? '購入記録を更新' : '購入記録に追加'); $('#cancel-edit').hidden = !editing;
}
function renderRecords() {
  const tickets = race().tickets;
  checkedTickets = new Set([...checkedTickets].filter(id => tickets.some(t => t.id === id)));
  const pages = Math.max(1, Math.ceil(tickets.length / 20)); recordsPage = Math.min(recordsPage, pages - 1);
  $('#ticket-records').innerHTML = tickets.length ? tickets.slice(recordsPage * 20, recordsPage * 20 + 20).map(t => {
    const win = isWinning(t.type, t.numbers, race().result.order, race().headCount);
    const badge = verdictBadge(win === null ? 'pending' : win ? 'win' : 'lose');
    return `<div class="record"><input type="checkbox" data-select-ticket="${esc(t.id)}" aria-label="${esc(TYPES[t.type].label + ' ' + t.numbers.join('-'))}を一括編集に選択" ${checkedTickets.has(t.id) ? 'checked' : ''}><div><span class="record-label">${TYPES[t.type].label} ${badge}</span><strong>${t.numbers.map(circledHorse).join(TYPES[t.type].ordered ? ' → ' : ' − ')}</strong></div><div><div class="record-amount">${yen(t.amount)}</div><div class="record-actions"><button data-edit="${esc(t.id)}">編集</button><button data-delete="${esc(t.id)}" class="quiet danger">削除</button></div></div></div>`;
  }).join('') : '<p class="hint">まだ購入記録がありません。</p>';
  setText('#records-page', `${recordsPage + 1} / ${pages}`); $('#records-prev').disabled = recordsPage === 0; $('#records-next').disabled = recordsPage >= pages - 1;
}
function renderBalances() {
  const date = $('#history-date').value;
  const totals = dayBalance(state.races, date);
  $('#day-balance').innerHTML = `<div class="balance-grid"><div><span>投資</span><strong>${yen(totals.investment)}</strong></div><div><span>確定済み払戻</span><strong>${yen(totals.payout)}</strong></div><div><span>${totals.pending ? '暫定収支' : '収支'}</span><strong>${yen(totals.profit)}</strong></div><div><span>払戻待ち</span><strong>${totals.pending}レース</strong></div></div>`;
  $('#race-history').innerHTML = state.races.filter(r => r.date === date).map(r => {
    const b = raceBalance(r);
    return `<div class="history-row"><strong>${esc(`${r.venue || '未設定'} ${r.number}R ${r.name}`)}</strong><br><span>投資 ${yen(b.investment)} ／ 払戻 ${b.pending ? '未確定・未入力' : yen(b.payout)}</span></div>`;
  }).join('') || '<p class="hint">この日の記録はありません。</p>';
}
function wrap(fn) { return event => { try { Promise.resolve(fn(event)).catch(error => notify(error.message, true)); } catch (error) { notify(error.message, true); } }; }

document.addEventListener('click', wrap(async event => {
  const button = event.target.closest('button'); if (!button || !state) return;
  if (button.dataset.open) openDetails(button.dataset.open);
  if (button.dataset.status) await send('race.status', { status: button.dataset.status }, `レース表示を「${STATUSES[button.dataset.status]}」に変更しました`);
  if (button.dataset.mode) await send('display.update', { fields: { mode: button.dataset.mode } });
  if (button.dataset.horse) {
    const n = Number(button.dataset.horse);
    if (selected.includes(n)) selected = selected.filter(x => x !== n);
    else if (selected.length < TYPES[$('#ticket-type').value].size) selected.push(n);
    else notify('必要な頭数を選択済みです。変更する馬番をもう一度クリックして解除してください');
    renderHorseButtons();
  }
  if (button.dataset.edit) {
    const t = race().tickets.find(t => t.id === button.dataset.edit);
    editing = t.id; selected = [...t.numbers]; $('#ticket-type').value = t.type; $('#ticket-amount').value = t.amount;
    renderHorseButtons(); openDetails('ticket-details');
  }
  if (button.dataset.delete) {
    if (await send('ticket.delete', { id: button.dataset.delete }, '削除しました。「直前の操作を取り消す」で戻せます')) { if (editing === button.dataset.delete) { editing = null; selected = []; renderHorseButtons(); } }
  }
}));
$('#race-select').addEventListener('change', wrap(async () => { if (!await send('race.select', { raceId: $('#race-select').value })) $('#race-select').value = state.display.raceId; }));
$('#new-race').addEventListener('click', wrap(async () => { if (await send('race.create', { date: race().date }, '新しいレースを作成しました')) openDetails('race-details'); }));
for (const [id, field] of [['tickets-visible', 'ticketsVisible'], ['balance-visible', 'balanceVisible'], ['effect-enabled', 'effectEnabled'], ['countdown', 'countdown']]) {
  $(`#${id}`).addEventListener('change', wrap(async () => { if (!await send('display.update', { fields: { [field]: $(`#${id}`).checked } })) $(`#${id}`).checked = state.display[field]; }));
}
$('#effect-play').addEventListener('click', () => send('effect.play', {}, '的中演出を再生しました（収支は変わりません）'));
$('#effect-stop').addEventListener('click', () => send('effect.stop', {}, '演出を停止しました'));
async function turnPage(direction) {
  if (!state || !ticketPages.length) return;
  const page = currentDisplayPage(state.display, ticketPages.length);
  const next = (page + direction + ticketPages.length) % ticketPages.length;
  await send('display.update', { fields: { page: next } });
}
$('#page-prev').addEventListener('click', () => turnPage(-1)); $('#page-next').addEventListener('click', () => turnPage(1));
$('#auto-page').addEventListener('change', wrap(async () => {
  if (!state) return;
  if (!await send('display.update', { fields: { autoPage: $('#auto-page').checked, page: currentDisplayPage(state.display, ticketPages.length) } })) $('#auto-page').checked = state.display.autoPage;
}));
$('#page-interval').addEventListener('change', wrap(async () => {
  if (!state) return;
  if (!await send('display.update', { fields: { pageInterval: Number($('#page-interval').value), page: currentDisplayPage(state.display, ticketPages.length) } })) $('#page-interval').value = String(state.display.pageInterval);
}));
$('#race-form').addEventListener('submit', wrap(async event => {
  event.preventDefault();
  const data = new FormData(event.target);
  const values = Object.fromEntries(['date', 'venue', 'name', 'surface', 'startTime'].map(k => [k, data.get(k)]));
  for (const k of ['number', 'headCount']) values[k] = Number(data.get(k));
  values.distance = data.get('distance') === '' ? null : Number(data.get('distance'));
  values.picks = ['◎', '○', '▲', '△', '☆'].flatMap((mark, i) => data.get(`pick${i}`) ? [{ mark, number: Number(data.get(`pick${i}`)) }] : []);
  if (await send('race.update', { fields: values })) fillRaceForm();
}));
$('#delete-race').addEventListener('click', wrap(async () => {
  const r = race();
  if (await confirmAction('レースを削除', `${r.venue} ${r.number}R ${r.name}\nこのレースの購入記録・払戻も削除します。`)) await send('race.delete', { raceId: r.id });
}));
$('#ticket-type').addEventListener('change', () => { selected = []; renderHorseButtons(); });
$('#cancel-edit').addEventListener('click', () => { editing = null; selected = []; renderHorseButtons(); });
$('#ticket-form').addEventListener('submit', wrap(async event => {
  event.preventDefault(); const type = $('#ticket-type').value;
  const ticket = { type, numbers: normalize(type, selected, race().headCount), amount: validateAmount(Number($('#ticket-amount').value)), source: 'manual' };
  if (await send(editing ? 'ticket.update' : 'tickets.add', editing ? { id: editing, ticket } : { tickets: [ticket] }, '購入記録を保存しました')) { editing = null; selected = []; renderHorseButtons(); }
}));
for (const id of ['paste-text', 'paste-default']) $(`#${id}`).addEventListener('input', invalidatePreview);
$('#paste-preview').addEventListener('click', wrap(() => {
  if (!state) return;
  const rows = parseTickets($('#paste-text').value, { headCount: race().headCount, defaultAmount: Number($('#paste-default').value), existing: race().tickets });
  const additions = rows.filter(r => r.status === 'add');
  preview = { rows, raceId: race().id, revision: state.revision };
  const destination = `${race().date} ${race().venue || '開催場未設定'} ${race().number}R ${race().name}`;
  $('#paste-results').innerHTML = `<p class="preview-summary">登録先：${esc(destination)}<br>追加 ${additions.length}点・${yen(additions.reduce((sum, r) => sum + r.ticket.amount, 0))}<br>うち金額未記載 ${additions.filter(r => r.usesDefault).length}点（既定額を適用）<br>重複 ${rows.filter(r => r.status === 'duplicate').length} ／ 無視 ${rows.filter(r => r.status === 'ignored').length} ／ エラー ${rows.filter(r => r.status === 'error').length}</p><div class="preview-rows">${rows.map(r => `<div class="preview-row ${r.status}"><code>${r.line}: ${esc(r.raw)}</code>${esc(r.message)}</div>`).join('')}</div>`;
  $('#paste-confirm-label').hidden = !additions.length; $('#paste-register').hidden = !additions.length;
  $('#paste-confirm').checked = false; $('#paste-register').disabled = true;
}));
$('#paste-confirm').addEventListener('change', () => { $('#paste-register').disabled = !$('#paste-confirm').checked; });
$('#paste-register').addEventListener('click', wrap(async () => {
  if (!preview || !$('#paste-confirm').checked) return;
  if (preview.raceId !== race().id || preview.revision !== state.revision) { invalidatePreview(); throw new Error('状態が変わりました。再度プレビューしてください'); }
  const tickets = preview.rows.filter(r => r.status === 'add').map(r => r.ticket);
  if (await send('tickets.add', { tickets }, `${tickets.length}点を登録しました`)) { $('#paste-text').value = ''; invalidatePreview(); }
}));
$('#ticket-records').addEventListener('change', event => { if (event.target.dataset.selectTicket) { const id = event.target.dataset.selectTicket; event.target.checked ? checkedTickets.add(id) : checkedTickets.delete(id); } });
$('#records-prev').addEventListener('click', () => { recordsPage--; renderRecords(); }); $('#records-next').addEventListener('click', () => { recordsPage++; renderRecords(); });
$('#bulk-save').addEventListener('click', () => send('tickets.amount', { ids: [...checkedTickets], amount: Number($('#bulk-amount').value) }));
$('#undo').addEventListener('click', wrap(async () => { if (await send('undo', {}, '直前の操作を取り消しました')) { fillRaceForm(); fillResultForm(); editing = null; selected = []; renderHorseButtons(); } }));
$('#clear-tickets').addEventListener('click', wrap(async () => { const r = race(); if (await confirmAction('購入馬券を全削除', `${r.venue} ${r.number}R の ${r.tickets.length}点を削除します。結果の確定も解除されます。`)) await send('tickets.clear', { raceId: r.id }); }));
$('#result-form').addEventListener('submit', wrap(async event => {
  event.preventDefault(); const data = new FormData(event.target);
  const result = { order: judgementUI.readOrder(), dividends: parseDividends(data.get('dividends'), race().headCount), complete: data.has('complete'), confirmed: data.has('confirmed'), manualPayout: data.get('manualPayout') === '' ? null : Number(data.get('manualPayout')), note: data.get('note') };
  if (await send('result.save', { result }, '結果を保存しました。払戻の確認状態を確認してください')) fillResultForm();
}));
$('#history-date').addEventListener('change', () => { if (state) renderBalances(); });
$('#import-button').addEventListener('click', wrap(async () => {
  const file = $('#import-file').files[0]; if (!file) throw new Error('JSONバックアップを選択してください');
  if (file.size > 4 * 1024 * 1024) throw new Error('ファイルは4MB以内にしてください');
  const imported = JSON.parse(await file.text());
  if (imported.version !== 1 || !Array.isArray(imported.races)) throw new Error('このアプリのJSONバックアップを選択してください');
  const count = imported.races.reduce((sum, r) => sum + (r.tickets?.length ?? 0), 0);
  if (await confirmAction('バックアップから復元', `${imported.races.length}レース・${count}点の記録で現在の全データを置き換えます。必要なら先にJSON保存してください。`)) {
    if (await send('state.import', { state: imported }, 'バックアップを復元しました')) { fillRaceForm(); fillResultForm(); editing = null; selected = []; renderHorseButtons(); }
  }
}));
if (BROWSER_MODE) {
  for (const [id, filename, mime, content] of [
    ['export-json', 'keiba-backup.json', 'application/json', () => JSON.stringify(state, null, 2)],
    ['export-csv', 'keiba-records.csv', 'text/csv', () => exportCsv(state)],
  ]) {
    $(id === 'export-json' ? '#export-json' : '#export-csv').href = '#';
    $(`#${id}`).addEventListener('click', event => {
      event.preventDefault(); if (!state) return;
      const url = URL.createObjectURL(new Blob([content()], { type: `${mime};charset=utf-8` }));
      const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  $('#browser-demo').addEventListener('click', wrap(async () => {
    if (!state) return;
    if (!await confirmAction('架空のサンプルを読み込む', '現在のブラウザ版の記録をサンプルに置き換えます。必要な記録は先にJSON保存してください。「直前の操作を取り消す」で戻せます。')) return;
    const { demoState } = await import('./demo.js');
    if (await send('state.import', { state: demoState() }, '架空のサンプルを読み込みました')) { fillRaceForm(); fillResultForm(); }
  }));
}
renderHorseButtons();
setInterval(renderPageControls, 250);
connect(render, (value, error) => { connected = value; connectionStatus(); if (error) notify(error, true); });
