import { assert, integer, normalize } from './domain.js';
import { calendarUrl } from './calendar-url.js';
import { JRA_VENUES } from './jra-result-data.js';

export function validateWin5Source(value, date) {
  const url = new URL(value);
  const code = /^pw17hde\d{2}(\d{8})\d\/[A-F0-9]{2}$/.exec(url.searchParams.get('CNAME') ?? '');
  assert(url.origin === 'https://www.jra.go.jp' && !url.username && !url.password && !url.hash
    && url.pathname === '/JRADB/access5.html' && [...url.searchParams.keys()].join() === 'CNAME'
    && code?.[1] === date.replaceAll('-', ''), 'WIN5結果の取得元・開催日が一致しません');
  return url.href;
}
export function validateWin5Legs(legs) {
  assert(Array.isArray(legs) && legs.length === 5, 'WIN5の対象5レースを確認できません');
  const result = legs.map(l => {
    assert(JRA_VENUES.includes(l.venue), 'WIN5の開催場が不正です');
    assert(typeof l.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(l.startTime), 'WIN5の発走時刻が不正です');
    return { venue: l.venue, number: integer(l.number, 1, 12, 'WIN5のR番号'), startTime: l.startTime };
  });
  assert(new Set(result.map(l => `${l.venue}:${l.number}`)).size === 5, 'WIN5対象レースが重複しています');
  return result;
}
export function validateWin5Result(input, date) {
  calendarUrl(date);
  assert(input && input.date === date && typeof input.available === 'boolean', 'WIN5結果の開催日が一致しません');
  assert(typeof input.fetchedAt === 'string' && input.fetchedAt.length < 40 && !Number.isNaN(Date.parse(input.fetchedAt)), 'WIN5の取得日時が不正です');
  assert(typeof input.notice === 'string' && input.notice.length <= 500, 'WIN5の注記が不正です');
  const base = {date, available: input.available, fetchedAt: input.fetchedAt, notice: input.notice};
  if (!input.sourceUrl && !input.available) return base;
  base.sourceUrl = validateWin5Source(input.sourceUrl, date);
  base.legs = validateWin5Legs(input.legs);
  if (!input.available) return base;
  const order = normalize('win5', input.order);
  const amount = integer(input.dividend, 1, 600000000, 'WIN5の100円あたり払戻金');
  return {...base, order, dividend: amount};
}
