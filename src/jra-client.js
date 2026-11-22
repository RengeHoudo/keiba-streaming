import { assert, integer } from './domain.js';
import { calendarUrl } from './calendar-url.js';
import { resultQuery, validateJraResult } from './jra-result-data.js';
import { validateWin5Result } from './jra-win5-data.js';

export function validateSchedule(input, date) {
  const sourceUrl = calendarUrl(date);
  assert(input && input.date === date && input.sourceUrl === sourceUrl, '取得情報の開催日・出典を確認できません');
  assert(typeof input.fetchedAt === 'string' && input.fetchedAt.length < 40 && !Number.isNaN(Date.parse(input.fetchedAt)), '取得日時が不正です');
  assert(typeof input.notice === 'string' && input.notice.length <= 500, '取得情報の注記が不正です');
  assert(Array.isArray(input.races) && input.races.length > 0 && input.races.length <= 36, 'レース情報が不正です');
  const keys = new Set();
  const races = input.races.map(r => {
    assert(r.date === date && ['札幌','函館','福島','新潟','東京','中山','中京','京都','阪神','小倉'].includes(r.venue), 'レースの開催日・開催場が不正です');
    integer(r.number, 1, 12, 'レース番号'); integer(r.distance, 100, 10000, '距離');
    assert(typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 40, 'レース名が不正です');
    assert(['芝','ダート','障害'].includes(r.surface) && typeof r.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.startTime), 'コース・発走予定時刻が不正です');
    const key = `${r.venue}:${r.number}`; assert(!keys.has(key), 'レース情報が重複しています'); keys.add(key);
    return { date, venue: r.venue, number: r.number, name: r.name, surface: r.surface, distance: r.distance, startTime: r.startTime };
  });
  return { date, sourceUrl, fetchedAt: input.fetchedAt, notice: input.notice, cached: input.cached === true, races };
}
export function createJraClient({ endpoint, fetchImpl = fetch } = {}) {
  return {
    async getWin5Result(date) {
      calendarUrl(date);
      const response = await fetchImpl(`${endpoint.replace(/\/races$/, '/win5')}?date=${encodeURIComponent(date)}`, {signal:AbortSignal.timeout(20000),credentials:'omit',redirect:'error',headers:{Accept:'application/json'}});
      assert(/application\/json/i.test(response.headers.get('Content-Type') ?? ''), 'WIN5の配信先から正しい応答がありません');
      const text = await response.text(); assert(text.length <= 100000, 'WIN5の応答が大きすぎます');
      const data = JSON.parse(text);
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0,500) : 'WIN5結果を取得できませんでした');
      return validateWin5Result(data,date);
    },
    async getResult(query) {
      query = resultQuery(query);
      const params = new URLSearchParams({ ...query, number: String(query.number) });
      const response = await fetchImpl(`${endpoint.replace(/\/races$/, '/result')}?${params}`, { signal: AbortSignal.timeout(20000), credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
      assert(/application\/json/i.test(response.headers.get('Content-Type') ?? ''), 'JRA結果の配信先から正しい応答がありません');
      const text = await response.text(); assert(text.length <= 100000, 'JRA結果の応答が大きすぎます');
      const data = JSON.parse(text);
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : 'JRA結果を取得できませんでした');
      return validateJraResult(data, query);
    },
    async getSchedule(date) {
      calendarUrl(date);
      const response = await fetchImpl(`${endpoint}?date=${encodeURIComponent(date)}`, { signal: AbortSignal.timeout(18000), credentials: 'omit', redirect: 'error', headers: { Accept: 'application/json' } });
      assert(/application\/json/i.test(response.headers.get('Content-Type') ?? ''), 'レース情報の配信先から正しい応答がありません');
      const text = await response.text(); assert(text.length <= 100000, 'レース情報の応答が大きすぎます');
      const data = JSON.parse(text);
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error.slice(0, 500) : 'レース情報を取得できませんでした');
      return validateSchedule(data, date);
    },
    async resolveImport(action) {
      const data = await this.getSchedule(action.payload?.date);
      const fields = data.races.find(r => r.venue === action.payload?.venue && r.number === action.payload?.number);
      assert(fields, '取得結果に指定のレースがありません。再取得して選択してください');
      return { ...action, type: 'race.import', payload: { fields, source: { provider: 'jra-calendar', url: data.sourceUrl, fetchedAt: data.fetchedAt } } };
    },
  };
}
