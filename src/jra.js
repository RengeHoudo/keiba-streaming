import { assert, integer } from './domain.js';
import { calendarUrl } from './calendar-url.js';
export { calendarUrl } from './calendar-url.js';

export const JRA_NOTICE = 'JRA開催日程の事前発表情報（予定）です。当日の変更・中止・発走遅延や出走頭数は反映しません。最新の出馬表で確認してください。';
function plain(html) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, code) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()];
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  }).normalize('NFKC').replace(/\s+/g, ' ').trim();
}
function classText(html, tag, name) {
  for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))) {
    const classes = match[1].match(/\bclass\s*=\s*(["'])(.*?)\1/i)?.[2].split(/\s+/) ?? [];
    if (classes.includes(name)) return plain(match[2]);
  }
  return '';
}
// Read only the calendar's labelled cells. Never execute or return upstream HTML.
export function parseCalendar(html, date) {
  calendarUrl(date);
  assert(typeof html === 'string' && html.length <= 2 * 1024 * 1024, 'JRA応答サイズが不正です');
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const heading = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/gi)].map(match => plain(match[1])).find(value => /競馬番組/.test(value)) ?? '';
  const dateMatch = heading.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  assert(dateMatch && `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}` === date, 'JRAページの開催日を確認できません。情報は取り込みませんでした');
  const races = [];
  const seen = new Set();
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const caption = plain(table[1].match(/<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i)?.[1] ?? '').replaceAll(' ', '');
    const venue = caption.match(/^\d+回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d+日$/)?.[1];
    if (!venue) continue;
    let count = 0;
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const num = classText(row[1], 'th', 'num');
      const numberMatch = num.match(/^(\d{1,2})\s*(?:レース|R)$/);
      if (!numberMatch) {
        assert(!/<td\b/i.test(row[1]), `${venue}のレース番号を解析できません。情報は取り込みませんでした`);
        continue;
      }
      const number = integer(Number(numberMatch[1]), 1, 12, 'レース番号');
      const name = classText(row[1], 'p', 'stakes') || classText(row[1], 'p', 'race_class');
      const condition = classText(row[1], 'p', 'race_class');
      const distanceText = classText(row[1], 'span', 'dist');
      const course = classText(row[1], 'span', 'type');
      const time = classText(row[1], 'td', 'time').match(/^(\d{1,2})時\s*(\d{1,2})分$/);
      const surface = /障害/.test(condition) || /障/.test(course) ? '障害' : /芝/.test(course) ? '芝' : /ダ/.test(course) ? 'ダート' : null;
      assert(name && name.length <= 40 && surface && /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(distanceText) && time, `${venue}${number}Rのレース情報を解析できません。手入力をご利用ください`);
      const distance = integer(Number(distanceText.replaceAll(',', '')), 100, 10000, '距離');
      integer(Number(time[1]), 0, 23, '発走時'); integer(Number(time[2]), 0, 59, '発走分');
      const identity = `${venue}:${number}`;
      assert(!seen.has(identity), 'JRAページにレースの重複があります。情報は取り込みませんでした');
      seen.add(identity); count++;
      races.push({ date, venue, number, name, surface, distance, startTime: `${time[1].padStart(2, '0')}:${time[2].padStart(2, '0')}` });
    }
    assert(count > 0, `${venue}のレース情報が見つかりません`);
  }
  assert(races.length > 0 && races.length <= 36, 'レース情報が見つかりません。未公開・開催変更またはJRAページの形式変更の可能性があります');
  return races;
}
export function decodeCalendar(bytes, contentType = '') {
  const prefix = new TextDecoder('ascii').decode(bytes.subarray(0, 2048));
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
    ?? /charset\s*=\s*["']?([\w-]+)/i.exec(prefix)?.[1] ?? 'shift_jis';
  assert(/^(?:shift[_-]jis|sjis|windows-31j|utf-?8)$/i.test(charset), 'JRAページの文字コードに対応していません');
  return new TextDecoder(/utf/i.test(charset) ? 'utf-8' : 'shift_jis', { fatal: true }).decode(bytes);
}
export function createJraProvider({ fetchImpl = fetch, now = Date.now, timeoutMs = 12000, cacheMs = 5 * 60 * 1000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function download(date, sourceUrl) {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = sourceUrl;
    try {
      let response;
      for (let redirect = 0; redirect <= 3; redirect++) {
        response = await fetchImpl(url, { signal, redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'KeibaStreaming/1.0 (race schedule reader)' } });
        if (response.status < 300 || response.status >= 400) break;
        await response.body?.cancel();
        const target = new URL(response.headers.get('location') ?? '', url);
        const originalPath = new URL(sourceUrl).pathname;
        assert(redirect < 3 && target.protocol === 'https:' && ['www.jra.go.jp', 'jra.go.jp', 'www.jra.jp', 'jra.jp'].includes(target.hostname) && !target.port && !target.username && !target.password && target.pathname === originalPath && !target.search, 'JRAの想定外の転送先を拒否しました');
        url = target.href;
      }
      assert(response.status !== 404, 'この日の開催情報は見つかりません。開催がない日、または番組が未公開の可能性があります');
      assert(response.ok, `JRAから情報を取得できませんでした（HTTP ${response.status}）。時間をおいて再取得してください`);
      assert(/text\/html/i.test(response.headers.get('content-type') ?? ''), 'JRAからHTML以外の応答が返りました');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        assert(size <= 2 * 1024 * 1024, 'JRAの応答が大きすぎるため取得を中止しました');
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const races = parseCalendar(decodeCalendar(bytes, response.headers.get('content-type')), date);
      return { date, races, sourceUrl, fetchedAt: new Date(now()).toISOString(), notice: JRA_NOTICE };
    } catch (error) {
      if (signal.aborted) throw new Error('JRAへの接続がタイムアウトしました。時間をおいて再取得してください');
      if (error.message === 'fetch failed') throw new Error('JRAに接続できません。インターネット接続を確認するか、手入力をご利用ください');
      throw error;
    }
  }
  return {
    async getSchedule(date) {
      const url = calendarUrl(date);
      const hit = cache.get(date);
      if (hit && now() - hit.at < cacheMs) return structuredClone({ ...hit.data, cached: true });
      if (!pending.has(date)) {
        assert(pending.size < 3, 'JRA情報を取得中です。完了後に再度お試しください');
        pending.set(date, download(date, url).then(data => {
          cache.delete(date); cache.set(date, { at: now(), data });
          if (cache.size > 14) cache.delete(cache.keys().next().value);
          return data;
        }).finally(() => pending.delete(date)));
      }
      return structuredClone({ ...await pending.get(date), cached: false });
    },
  };
}
