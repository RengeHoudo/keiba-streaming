import { TYPES, STATUSES, displayPages, currentDisplayPage, dayBalance, yen, circledHorse as horse } from './domain.js';
import { $, escapeHTML as esc, setText, connect } from './shared.js';

let state = null;
let effectId = null;
let ticketPages = [];
let paintedPage = -1;
function scale() { $('#overlay-stage').style.transform = `scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`; }
addEventListener('resize', scale); scale();
function render(next) {
  if (state && next.revision < state.revision) return;
  state = next;
  const r = state.races.find(r => r.id === state.display.raceId);
  setText('#overlay-venue', r.kind === 'win5' ? 'WIN5' : `${r.venue} ${r.number}R`.trim());
  setText('#overlay-name', r.name);
  $('#overlay-meta').innerHTML = `${r.surface || r.distance ? `<span>${esc(r.surface)}${r.distance ? `${r.distance}m` : ''}</span>` : ''}${r.startTime ? `<span>${esc(r.startTime)}発走</span>` : ''}`;
  setText('#overlay-date', `${r.date.slice(5).replace('-', '/')} ${r.kind === 'win5' ? '5レース' : `${r.headCount}頭`}`);
  if (r.kind === 'win5') $('#overlay-meta').innerHTML = r.win5Legs.map((l,i) => `<span>${i+1}: ${esc(l.venue)}${l.number}R</span>`).join('');
  setText('#overlay-status', STATUSES[r.status]); $('#overlay-status').className = `race-status ${r.status}`;
  $('#overlay-picks').innerHTML = r.picks.map(p => `<span>${p.mark} ${horse(p.number)}</span>`).join('');
  $('#overlay-picks').classList.toggle('many', r.picks.length >= 4);
  $('#ticket-panel').hidden = !state.display.ticketsVisible;
  ticketPages = displayPages(r.tickets, state.display.mode); paintedPage = -1;
  const total = r.tickets.reduce((s, t) => s + t.amount, 0);
  setText('#overlay-total', `計${r.tickets.length}点　${yen(total)}`);
  $('#overlay-total').classList.toggle('compact-money', total >= 10000000 || r.tickets.length >= 1000);
  const balance = dayBalance(state.races, r.date);
  $('#balance-panel').hidden = !state.display.balanceVisible;
  setText('#balance-date', r.date.replaceAll('-', '.'));
  setText('#overlay-investment', yen(balance.investment)); setText('#overlay-payout', yen(balance.payout)); setText('#overlay-profit', yen(balance.profit));
  setText('#profit-label', balance.pending ? `暫定収支（${balance.pending}レース払戻待ち）` : '収支');
  tick();
}
function renderTicketPage() {
  const currentIndex = currentDisplayPage(state.display, ticketPages.length);
  if (paintedPage === currentIndex) return;
  paintedPage = currentIndex;
  const page = ticketPages[currentIndex];
  setText('#overlay-page', `${currentIndex + 1} / ${ticketPages.length || 1}${state.display.autoPage && ticketPages.length > 1 ? ' 自動' : ''}`);
  setText('#overlay-type', page?.compact ? '全券種・まとめて表示' : page ? TYPES[page.type].label : '');
  $('#overlay-tickets').className = `overlay-tickets${page?.compact ? ' compact-tickets' : ''}`;
  if (!page) $('#overlay-tickets').innerHTML = '<p class="empty-tickets">購入記録はありません</p>';
  else if (page.compact) $('#overlay-tickets').innerHTML = page.compact.map(row => `<div class="compact-entry"><div class="compact-entry-meta"><strong>${TYPES[row.type].label}</strong><span>${row.count === 1 ? yen(row.amount) : `${row.count}点・各${yen(row.amount)}`}</span></div><div class="compact-bet">${esc(row.notation)}</div></div>`).join('');
  else if (page.formation) {
    const f = page.formation;
    $('#overlay-tickets').classList.toggle('dense', f.type === 'win5' || f.columns.some(c => c.length > 7));
    $('#overlay-tickets').innerHTML = `<p class="formation-label">FORMATION / フォーメーション</p>${f.columns.map((column, i) => `<div class="formation-column"><span>${i + 1}${f.type === 'win5' ? 'レース' : '列目'}</span><div class="formation-numbers">${column.map(n => `<span class="formation-number">${horse(n)}</span>`).join('')}</div></div>`).join('')}<p class="formation-math"><span>${f.count}点 × ${yen(f.amount)}</span><strong>= ${yen(f.total)}</strong></p>`;
  } else $('#overlay-tickets').innerHTML = `${page.fallback ? '<p class="fallback-tag">正確な買い目を一覧で表示</p>' : ''}<table class="ticket-table ${page.fallback || page.tickets.some(t => t.amount >= 100000) ? 'compact' : ''}"><thead><tr><th>買い目</th><th>金額</th></tr></thead><tbody>${page.tickets.map(t => `<tr><td>${t.numbers.map(horse).join(TYPES[t.type].ordered ? ' → ' : ' − ')}</td><td>${yen(t.amount)}</td></tr>`).join('')}</tbody></table>`;
}
function tick() {
  if (!state) return;
  renderTicketPage();
  const r = state.races.find(r => r.id === state.display.raceId);
  const countdown = $('#overlay-countdown');
  countdown.hidden = !state.display.countdown || !r.startTime || r.status !== 'before';
  if (!countdown.hidden) {
    const remaining = Math.max(0, Math.ceil((new Date(`${r.date}T${r.startTime}:00+09:00`).getTime() - Date.now()) / 1000));
    countdown.textContent = remaining > 0 ? `発走予定まで ${Math.floor(remaining / 3600) ? Math.floor(remaining / 3600) + '時間 ' : ''}${String(Math.floor(remaining / 60) % 60).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}` : `発走予定時刻 ${r.startTime}`;
  }
  const effect = state.display.effect;
  const age = effect ? Date.now() - effect.startedAt : Infinity;
  const active = state.display.effectEnabled && effect && age >= 0 && age < 4000;
  const element = $('#win-effect');
  if (active && effectId !== effect.id) {
    element.hidden = true; void element.offsetWidth;
    element.style.animationDelay = `${-age}ms`; effectId = effect.id;
  }
  element.hidden = !active;
}
setInterval(tick, 100);
connect(render);
