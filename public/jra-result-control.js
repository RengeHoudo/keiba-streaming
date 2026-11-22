import { $, getJraResult, getWin5Result } from './shared.js';
import { JRA_VENUES } from './jra-result-data.js';
import { createResultPoller, resultTarget, needsResult } from './result-poller.js';

export function setupJraResult({ getState, send, onImport, isBusy }) {
  let loading = false;
  const messages = new Map();
  const race = () => { const s = getState(); return s?.races.find(r => r.id === s.display.raceId); };
  function render() {
    const r = race(); if (!r) return;
    const supported = r.kind === 'win5' || JRA_VENUES.includes(r.venue);
    $('#jra-result-fetch').disabled = loading || !supported;
    $('#jra-result-auto').disabled = !supported;
    $('#jra-result-auto').checked = r.autoResult !== false;
    const waiting = getState().races.filter(r => needsResult(r, Date.now())).length;
    $('#jra-result-target').textContent = (supported ? `${r.date} ${r.kind === 'win5' ? 'WIN5' : `${r.venue} ${r.number}R`} の情報を取得します。` : '先に開催日・JRA競馬場・レース番号を保存してください。')
      + ` 購入済みの自動確認対象：${waiting}件。`;
    $('#jra-result-message').textContent = messages.get(resultTarget(r)) ?? '購入済みのレースを発走後に自動確認します。レース切替・一時的な取得エラー後も継続します。';
    const source = r.result.source;
    $('#jra-result-source').hidden = !source;
    if (source) {
      $('#jra-result-source').href = source.provider === 'jra-win5' ? 'https://www.jra.go.jp/kouza/win5/' : source.url;
      $('#jra-result-source').textContent = `JRA公式${source.provider === 'jra-win5' ? 'WIN5' : '結果'}（${new Date(source.fetchedAt).toLocaleString('ja-JP')}取得）`;
    }
  }
  async function check(target, automatic = true) {
    if (loading) return;
    loading = true; render();
    const key = resultTarget(target); const expectedResult = JSON.stringify(target.result);
    try {
      const data = target.kind === 'win5' ? await getWin5Result(target.date) : await getJraResult({date:target.date,venue:target.venue,number:target.number});
      const current = getState().races.find(r => r.id === target.id);
      if (!current || resultTarget(current) !== key || JSON.stringify(current.result) !== expectedResult || (automatic && current.autoResult === false)) return;
      if (data.available || (target.kind === 'win5' && data.legs && JSON.stringify(current.win5Legs) !== JSON.stringify(data.legs))) {
        const saved = await send(target.kind === 'win5' ? 'win5.import' : 'result.import', {raceId:target.id,data,expectedResult}, 'JRA情報を保存しました', {quiet:automatic});
        if (saved) { onImport(target.id); messages.set(resultTarget(getState().races.find(r => r.id === target.id)), data.available ? '確定結果を保存し、購入額に応じた払戻・収支を計算しました。' : `${data.notice} 対象5レースを保存しました。`); }
        else messages.set(key,'保存できませんでした。自動確認がONなら次回再試行します。');
      } else messages.set(key,`${data.notice} 自動確認がONの購入済みレースは約60秒後に再確認します。`);
    } catch(error) { messages.set(key,`${error.message} 自動確認がONなら約60秒後に再試行します。`); }
    finally { loading = false; render(); }
  }
  const poller = createResultPoller({getState, check, isBusy:() => loading || isBusy()});
  const tick = () => {
    if (navigator.locks) navigator.locks.request('keiba-result-poll', {ifAvailable:true}, lock => lock ? poller.tick() : undefined).catch(() => {});
    else void poller.tick();
  };
  setInterval(tick, 3000);
  $('#jra-result-fetch').addEventListener('click',() => { if (race()) void check(structuredClone(race()),false); });
  $('#jra-result-auto').addEventListener('change',async () => {
    await send('race.update',{raceId:race().id,fields:{autoResult:$('#jra-result-auto').checked}},'このレースの自動確認設定を保存しました');
    render(); tick();
  });
  return { render };
}
