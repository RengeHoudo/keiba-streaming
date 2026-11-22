import { $, getJraResult } from './shared.js';
import { JRA_VENUES, sameRace } from './jra-result-data.js';

export function setupJraResult({ getState, send, onImport }) {
  let loading = false;
  let watched = null;
  let timer = null;
  let generation = 0;
  const race = () => { const state = getState(); return state?.races.find(r => r.id === state.display.raceId); };
  function stop() { generation++; clearTimeout(timer); timer = null; watched = null; $('#jra-result-auto').checked = false; }
  function render() {
    const r = race();
    if (watched && (!r || watched.id !== r.id || !sameRace(watched,r))) stop();
    const supported = r && JRA_VENUES.includes(r.venue);
    $('#jra-result-fetch').disabled = loading || !supported;
    $('#jra-result-auto').disabled = !supported;
    $('#jra-result-target').textContent = supported ? `${r.date} ${r.venue} ${r.number}R の確定結果を取得します。` : '先にレース設定で開催日・JRA競馬場・レース番号を保存してください。';
    const source = r?.result.source;
    $('#jra-result-source').hidden = !source;
    if (source) {
      $('#jra-result-source').href = source.url;
      $('#jra-result-source').textContent = `取得元のJRA結果（${new Date(source.fetchedAt).toLocaleString('ja-JP')}取得）`;
    }
  }
  async function check() {
    if (loading || !race()) return;
    if (document.hidden) { schedule(); return; }
    const before = getState(); const target = {...race()}; const requestGeneration = generation;
    loading = true; render();
    $('#jra-result-message').textContent = 'JRA公式の着順・確定払戻金を確認しています…';
    try {
      const data = await getJraResult({date:target.date,venue:target.venue,number:target.number});
      if (generation !== requestGeneration) return;
      if (getState().revision !== before.revision || race()?.id !== target.id) {
        stop(); throw new Error('取得中に記録が更新されました。内容を確認して再取得してください');
      }
      if (!data.available) { $('#jra-result-message').textContent = `${data.notice}${watched ? ' 60秒後に再確認します。' : ''}`; }
      else {
        stop();
        if (await send('result.import', {raceId:target.id,data}, 'JRAの確定着順・払戻金を保存し、購入馬券の払戻額と収支を計算しました')) {
          onImport(); $('#jra-result-message').textContent = '取得・保存しました。登録済みの購入金額で自動計算しています。';
        } else $('#jra-result-message').textContent = '保存できませんでした。画面上部のメッセージを確認して再取得してください。';
      }
    } catch(error) { stop(); $('#jra-result-message').textContent = `${error.message} 自動確認を停止しました。`; }
    finally { loading = false; render(); schedule(); }
  }
  function schedule() { clearTimeout(timer); if (watched) timer = setTimeout(check,60000); }
  $('#jra-result-fetch').addEventListener('click',check);
  $('#jra-result-auto').addEventListener('change',() => {
    if (!$('#jra-result-auto').checked) { stop(); return; }
    watched = {...race()}; check();
  });
  return { render };
}
