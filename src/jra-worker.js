import { createJraProvider } from './jra.js';
import { calendarUrl } from './calendar-url.js';
import { createJraResultProvider } from './jra-result.js';
import { resultQuery } from './jra-result-data.js';
import { createWin5Provider } from './jra-win5.js';

export const PAGES_ORIGIN = 'https://rengehoudo.github.io';
export function createJraWorker({ provider = createJraProvider(), resultProvider = createJraResultProvider(), win5Provider = createWin5Provider(), now = Date.now } = {}) {
  const requests = new Map();
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const origin = request.headers.get('Origin');
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', Vary: 'Origin' });
      const json = (status, value) => new Response(JSON.stringify(value), { status, headers });
      // CORS is limited to the public app. It is not authentication: all
      // returned information is public race schedule data, never user records.
      if (origin && origin !== PAGES_ORIGIN && origin !== url.origin) return json(403, { error: 'このページからは利用できません' });
      if (origin) headers.set('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        headers.set('Access-Control-Max-Age', '600');
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== 'GET') { headers.set('Allow', 'GET, OPTIONS'); return json(405, { error: 'レース情報の読取専用APIです' }); }
      if (url.pathname === '/') return json(200, { service: 'keiba-streaming JRA API', app: `${PAGES_ORIGIN}/keiba-streaming/`, endpoint: '/api/jra/races?date=YYYY-MM-DD', resultEndpoint: '/api/jra/result?date=YYYY-MM-DD&venue=京都&number=11', note: 'JRA公式の予定情報・確定結果を読む非公式アプリです。購入記録・APIキーは扱いません。' });
      if (!['/api/jra/races', '/api/jra/result', '/api/jra/win5'].includes(url.pathname)) return json(404, { error: '見つかりません' });
      const isResult = url.pathname === '/api/jra/result';
      const date = url.searchParams.get('date');
      let query;
      try {
        const keys = isResult ? ['date', 'venue', 'number'] : ['date'];
        if ([...url.searchParams.keys()].some(k => !keys.includes(k)) || keys.some(k => url.searchParams.getAll(k).length !== 1)) throw new Error('開催日・開催場・レース番号以外は指定できません');
        calendarUrl(date);
        if (isResult) query = resultQuery({date, venue:url.searchParams.get('venue'), number:Number(url.searchParams.get('number'))});
      } catch (error) { return json(400, { error: error.message }); }
      // Bound per-isolate request accounting and upstream concurrency/cache.
      // Cloudflare supplies this IP header; request bodies are never read.
      const ip = request.headers.get('CF-Connecting-IP') ?? 'anonymous';
      const time = now();
      for (const [key, value] of requests) if (time - value.start >= 60000) requests.delete(key);
      let entry = requests.get(ip);
      if (!entry) {
        if (requests.size >= 1000) { headers.set('Retry-After', '60'); return json(429, { error: 'アクセスが集中しています。しばらくして再取得してください' }); }
        entry = { start: time, count: 0 }; requests.set(ip, entry);
      }
      if (++entry.count > 30) { headers.set('Retry-After', '60'); return json(429, { error: '取得回数が多いため、1分ほど待って再取得してください' }); }
      try { return json(200, isResult ? await resultProvider.getResult(query) : url.pathname === '/api/jra/win5' ? await win5Provider.getResult(date) : await provider.getSchedule(date)); }
      catch (error) { return json(502, { error: error.message || 'JRA情報を取得できませんでした。時間をおいて再取得してください' }); }
    },
  };
}
export default createJraWorker();
