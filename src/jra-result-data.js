import { assert, integer, normalize, key, isWinning, TYPES } from './domain.js';
import { calendarUrl } from './calendar-url.js';

export const JRA_VENUES = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];
export function resultQuery(query) {
  const { date, venue, number } = query ?? {};
  calendarUrl(date);
  assert(JRA_VENUES.includes(venue), '中央競馬の開催場を指定してください');
  integer(number, 1, 12, 'レース番号');
  return { date, venue, number };
}
export function resultIdentity(cname) {
  const m = /^pw01sde\d{2}(\d{2})(\d{4})\d{4}(\d{2})(\d{8})\/[A-F0-9]{2}$/.exec(cname ?? '');
  if (!m || m[2] !== m[4].slice(0, 4)) return null;
  return { date: `${m[4].slice(0,4)}-${m[4].slice(4,6)}-${m[4].slice(6,8)}`, venue: JRA_VENUES[Number(m[1]) - 1], number: Number(m[3]) };
}
export const sameRace = (a, b) => a?.date === b?.date && a?.venue === b?.venue && a?.number === b?.number;
export function validateResultSource(sourceUrl, query) {
  const url = new URL(sourceUrl);
  assert(url.origin === 'https://www.jra.go.jp' && !url.username && !url.password && !url.hash && url.pathname === '/JRADB/accessS.html'
    && [...url.searchParams.keys()].join() === 'CNAME' && sameRace(resultIdentity(url.searchParams.get('CNAME')), query), '結果の取得元・レースが一致しません');
  return url.href;
}
export function validateJraResult(input, query) {
  query = resultQuery(query);
  assert(input && sameRace(input, query) && typeof input.available === 'boolean', '結果の開催日・開催場・レース番号を確認できません');
  assert(typeof input.fetchedAt === 'string' && input.fetchedAt.length < 40 && !Number.isNaN(Date.parse(input.fetchedAt)), '結果の取得日時が不正です');
  assert(typeof input.notice === 'string' && input.notice.length <= 500, '結果の注記が不正です');
  const base = { ...query, available: input.available, fetchedAt: input.fetchedAt, notice: input.notice };
  if (!input.available) return base;
  const sourceUrl = validateResultSource(input.sourceUrl, query);
  const headCount = integer(input.headCount, 3, 18, '出走頭数');
  assert(Array.isArray(input.order) && input.order.length === 3 && new Set(input.order).size === 3, '上位3着を確認できません');
  const order = input.order.map(n => integer(n, 1, headCount, '着順の馬番'));
  assert(Array.isArray(input.dividends) && input.dividends.length === (headCount <= 7 ? 10 : 11), '全券種の確定払戻金を確認できません');
  const seen = new Set();
  const dividends = input.dividends.map(d => {
    const numbers = normalize(d.type, d.numbers, headCount);
    const k = key(d.type, numbers);
    assert(!seen.has(k) && isWinning(d.type, numbers, order, headCount) === true, '払戻金と着順が一致しません。同着などは手動確認してください');
    seen.add(k);
    return { type: d.type, numbers, amount: integer(d.amount, 1, 1000000000, '100円あたり払戻金') };
  });
  for (const type of Object.keys(TYPES).filter(type => type !== 'win5')) {
    const count = type === 'place' ? (headCount <= 7 ? 2 : 3) : type === 'wide' ? 3 : 1;
    assert(dividends.filter(d => d.type === type).length === count, '券種ごとの確定払戻金が不足しています');
  }
  return { ...base, sourceUrl, headCount, order, dividends };
}
