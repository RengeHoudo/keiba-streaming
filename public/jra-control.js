import { today } from './domain.js';
import { $, escapeHTML as esc, getJraSchedule } from './shared.js';

export function setupJra({ getState, send, confirmAction, onImport }) {
  let schedule = null;
  let fetching = false;
  $('#jra-date').value = today();
  function selectedRace() { return schedule?.races[Number($('#jra-race').value)]; }
  function renderPreview() {
    const r = selectedRace(); $('#jra-import').disabled = !r || fetching;
    const existing = r && getState()?.races.find(x => x.date === r.date && x.venue === r.venue && x.number === r.number);
    $('#jra-import').textContent = existing ? '登録済みレースの情報を更新' : 'このレースを追加して選択';
    $('#jra-preview').textContent = r ? `${r.date} ${r.venue} ${r.number}R\n${r.name}\n${r.surface}${r.distance}m ／ 発走予定 ${r.startTime}\n出走頭数は取り込み後に手入力してください。` : '';
  }
  $('#jra-date').addEventListener('change', () => {
    schedule = null; $('#jra-selection').hidden = true; $('#jra-race').replaceChildren();
    $('#jra-message').textContent = '日付を変更しました。開催レースを取得してください。'; renderPreview();
  });
  $('#jra-race').addEventListener('change', renderPreview);
  $('#jra-fetch').addEventListener('click', async () => {
    if (fetching) return;
    const date = $('#jra-date').value;
    fetching = true; schedule = null; $('#jra-selection').hidden = true;
    $('#jra-fetch').disabled = true; $('#jra-date').disabled = true;
    $('#jra-message').textContent = 'JRAの開催日程を取得しています…'; renderPreview();
    try {
      const data = await getJraSchedule(date);
      schedule = data;
      $('#jra-race').innerHTML = data.races.map((r, i) => `<option value="${i}">${esc(`${r.venue} ${r.number}R ${r.startTime} ${r.name}`)}</option>`).join('');
      $('#jra-message').textContent = `${data.races.length}レース取得 · ${new Date(data.fetchedAt).toLocaleTimeString('ja-JP')}時点${data.cached ? '（5分間のキャッシュ）' : ''}`;
      $('#jra-source').href = data.sourceUrl;
      $('#jra-notice').textContent = data.notice;
      $('#jra-selection').hidden = false;
    } catch (error) {
      $('#jra-message').textContent = error.name === 'TimeoutError' ? '取得がタイムアウトしました。再取得するか、レース情報を手入力してください。' : ['Failed to fetch', 'fetch failed'].includes(error.message) ? 'レース情報の配信先に接続できません。接続状況を確認し、時間をおいて再取得してください。' : error.message;
    } finally { fetching = false; $('#jra-fetch').disabled = false; $('#jra-date').disabled = false; renderPreview(); }
  });
  $('#jra-import').addEventListener('click', async () => {
    const r = selectedRace(); if (!r || !getState()) return;
    const existing = getState().races.find(x => x.date === r.date && x.venue === r.venue && x.number === r.number);
    if (existing && !await confirmAction('レース情報を更新', `${r.date} ${r.venue} ${r.number}R\nレース名・コース・距離・発走予定時刻を取得情報で更新します。登録済みの購入馬券・着順・払戻は保持します。`)) return;
    if (await send('race.importJra', { date: r.date, venue: r.venue, number: r.number }, 'JRAの予定情報を取り込みました。出走頭数と当日の変更を確認してください')) onImport();
    renderPreview();
  });
  return { render: renderPreview };
}
