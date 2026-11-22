import { assert, integer } from './domain.js';

export function calendarUrl(date) {
  assert(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date, '取得する開催日が不正です');
  const [year, month, day] = date.split('-');
  integer(Number(year), 2000, 2100, '取得年');
  return `https://www.jra.go.jp/keiba/calendar${year}/${year}/${month}/${month}${day}.html`;
}
