import { assert } from './domain.js';
import { calendarUrl } from './calendar-url.js';
import { decodeCalendar } from './jra.js';
import { validateWin5Result, validateWin5Source } from './jra-win5-data.js';
import { createJraResultProvider } from './jra-result.js';

const ENDPOINT = 'https://www.jra.go.jp/JRADB/access5.html';
const clean = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
export function parseWin5Result(html, date, sourceUrl, fetchedAt) {
  validateWin5Source(sourceUrl, date);
  html = clean(html);
  const heading = new RegExp(`${Number(date.slice(0,4))}年${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`);
  assert(heading.test(text(html.match(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi)?.find(h => heading.test(text(h))) ?? '')), 'WIN5ページの開催日が一致しません');
  const row = name => html.match(new RegExp(`<tr\\b[^>]*class=["']${name}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/tr>`, 'i'))?.[1] ?? '';
  const cells = value => [...value.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
  const times = cells(row('time')).map(c => {
    const m = text(c).match(/(\d{1,2})時(\d{2})分/);
    return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
  });
  const legs = cells(row('race')).map((c, i) => {
    const m = c.match(/<span\b[^>]*class=["']rc["'][^>]*>([^<]+)<\/span>\s*<span\b[^>]*class=["']num["'][^>]*>(\d+)<\/span>/i);
    return {venue:m?.[1], number:Number(m?.[2]), startTime:times[i]};
  });
  const block = name => text(html.match(new RegExp(`class=["']win5_data_unit ${name}["'][\\s\\S]*?class=["']main["'][^>]*>([\\s\\S]*?)<\\/div>`, 'i'))?.[1] ?? '');
  const hit = block('hit_mark'); const payout = block('harai');
  const base = {date,sourceUrl,fetchedAt,legs,available:false,notice:'WIN5の確定払戻金はまだ取得できません。'};
  if (!hit || !payout || /^[-ー－\s]*$/.test(hit)) return validateWin5Result(base,date);
  assert(/^\d{1,2}(?:\s*-\s*\d{1,2}){4}$/.test(hit) && /^(?:\d+|\d{1,3}(?:,\d{3})+)\s*円$/.test(payout), '同着・返還・的中票なし等のWIN5は公式結果を確認して手動払戻を使用してください');
  const order = hit.split(/\s*-\s*/).map(Number);
  const winners = cells(row('horse')).map(c => [...c.matchAll(/class=["']num["'][^>]*>\s*<span[^>]*>(\d+)<\/span>/g)].map(m => Number(m[1])));
  assert(winners.length === 5 && winners.every((n,i) => n.length === 1 && n[0] === order[i]), 'WIN5の勝馬と的中馬番が一致しません');
  return validateWin5Result({...base,available:true,order,dividend:Number(payout.replace(/[,\s円]/g,'')),notice:'JRA公式WIN5の対象レース・的中馬番・100円あたり確定払戻金です。'},date);
}
export function createWin5Provider({fetchImpl = fetch, now = Date.now, timeoutMs = 15000, cacheMs = 60000, legProvider = createJraResultProvider({fetchImpl, now, timeoutMs, cacheMs})} = {}) {
  const cache = new Map(); const pending = new Map();
  async function page(cname, signal) {
    const response = await fetchImpl(ENDPOINT, {method:'POST',body:new URLSearchParams({cname}),signal,redirect:'manual',headers:{Accept:'text/html','User-Agent':'KeibaStreaming/1.0 (public WIN5 results reader)'}});
    assert(response.ok && /text\/html/i.test(response.headers.get('content-type') ?? ''), 'JRAのWIN5結果を取得できません');
    const chunks=[];let size=0;
    for await (const chunk of response.body) {size+=chunk.length;assert(size<=2*1024*1024,'JRAの応答が大きすぎます');chunks.push(chunk);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return clean(decodeCalendar(bytes,response.headers.get('content-type')));
  }
  return {async getResult(date) {
    calendarUrl(date);
    const hit=cache.get(date);if(hit && now()-hit.at<cacheMs)return structuredClone(hit.value);
    if(!pending.has(date)) {
      assert(pending.size<4,'WIN5結果を取得中です。しばらくして再取得してください');
      pending.set(date,(async()=>{
        const signal=AbortSignal.timeout(timeoutMs);const fetchedAt=new Date(now()).toISOString();
        const index=await page('pw17hli000000/B3',signal);
        const pattern=new RegExp(`pw17hde\\d{2}${date.replaceAll('-','')}\\d/[A-F0-9]{2}`,'g');
        const links=[...new Set(index.match(pattern)??[])];
        assert(links.length<=1,'WIN5結果一覧に重複があります');
        const value=links.length ? parseWin5Result(await page(links[0],signal),date,`${ENDPOINT}?CNAME=${encodeURIComponent(links[0])}`,fetchedAt)
          : {date,available:false,fetchedAt,notice:'指定日のWIN5は結果一覧にまだ掲載されていません。'};
        // WIN5's summary alone does not identify refunded horses. Verify each
        // constituent race with the existing fail-closed normal-results reader.
        if (value.available) {
          for (const [i, leg] of value.legs.entries()) {
            const result = await legProvider.getResult({date,venue:leg.venue,number:leg.number});
            assert(result.available && result.order[0] === value.order[i], 'WIN5対象レースの通常確定結果を確認できません。返還・取消等は手動払戻を使用してください');
          }
        }
        cache.delete(date);cache.set(date,{at:now(),value});if(cache.size>16)cache.delete(cache.keys().next().value);
        return value;
      })().finally(()=>pending.delete(date)));
    }
    return structuredClone(await pending.get(date));
  }};
}
