import { assert, integer } from './domain.js';
import { decodeCalendar } from './jra.js';
import { JRA_VENUES, resultQuery, resultIdentity, sameRace, validateJraResult } from './jra-result-data.js';

const ENDPOINT = 'https://www.jra.go.jp/JRADB/accessS.html';
const NOTICE = 'JRA公式の確定着順・100円あたり払戻金です。通常の単勝・複勝・馬連・ワイド・馬単・3連複・3連単に対応します。';
const UNAVAILABLE = '指定レースの確定結果はまだ取得できません。未確定・開催なし・JRAの直近結果一覧の対象外の可能性があります。記録は変更していません。';
const clean = html => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
function cells(html, tag, name) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class=["'](?:[^"']*\\s)?${name}(?:\\s[^"']*)?["'][^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))]
    .map(m => plain(m[1]));
}
export function parseJraResult(html, query, sourceUrl, fetchedAt) {
  query = resultQuery(query); html = clean(html);
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]).find(t => /<th\b[^>]*class=["']place["']/i.test(t));
  assert(table, 'JRAの着順表を確認できません。記録は変更していません');
  const caption = table.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? '';
  const heading = plain(caption);
  const date = heading.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  const venue = heading.match(/\d+回(札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)\d+日/)?.[1];
  const number = Number(caption.match(/race_number_main\/race_num_(\d{1,2})\.png/)?.[1]);
  assert(date && sameRace({date:`${date[1]}-${date[2].padStart(2,'0')}-${date[3].padStart(2,'0')}`,venue,number}, query), 'JRA結果ページのレースが一致しません');
  const finishers = [];
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const places = cells(row[1], 'td', 'place');
    if (!places.length) continue;
    const nums = cells(row[1], 'td', 'num');
    assert(places.length === 1 && nums.length === 1 && /^\d+$/.test(places[0]) && /^\d+$/.test(nums[0]), '取消・除外・競走中止等のあるレースは自動確定できません。JRA公式を確認して手動払戻を使用してください');
    finishers.push({ rank: integer(Number(places[0]),1,18,'着順'), number:integer(Number(nums[0]),1,18,'馬番') });
  }
  const headCount = integer(finishers.length, 3, 18, '出走頭数');
  assert(new Set(finishers.map(r => r.number)).size === headCount && finishers.every((r,i) => r.rank === i+1)
    && finishers.every(r => r.number <= headCount), '同着・取消等のあるレースは自動確定できません。JRA公式を確認して手動払戻を使用してください');
  const refund = html.slice(html.search(/<div\b[^>]*class=["']refund_area\b/i));
  assert(/<h2[^>]*>\s*払戻金\s*<\/h2>/.test(refund), '確定払戻金はまだ取得できません');
  const mapping = {win:'win',place:'place',umaren:'quinella',wide:'wide',umatan:'exacta',trio:'trio',tierce:'trifecta'};
  const dividends = [];
  for (const li of refund.matchAll(/<li\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const type = mapping[li[1]]; if (!type) continue;
    const nums = cells(li[2], 'div', 'num'); const amounts = cells(li[2], 'div', 'yen');
    assert(nums.length > 0 && nums.length === amounts.length, '確定払戻金を解析できません');
    nums.forEach((num,i) => {
      assert(/^\d+(?:\s*-\s*\d+){0,2}$/.test(num) && /^(?:\d+|\d{1,3}(?:,\d{3})+)\s*円$/.test(amounts[i]), '特別払戻・返還等は手動払戻を使用してください');
      dividends.push({type,numbers:num.split(/\s*-\s*/).map(Number),amount:Number(amounts[i].replace(/[,\s円]/g,''))});
    });
  }
  return validateJraResult({...query,available:true,headCount,order:finishers.slice(0,3).map(r=>r.number),dividends,sourceUrl,fetchedAt,notice:NOTICE},query);
}
export function createJraResultProvider({ fetchImpl = fetch, now = Date.now, timeoutMs = 15000, cacheMs = 60000 } = {}) {
  const cache = new Map(); const pending = new Map();
  async function page(cname, signal, detail = false) {
    const url = detail ? `${ENDPOINT}?CNAME=${encodeURIComponent(cname)}` : ENDPOINT;
    const response = await fetchImpl(url, {signal,redirect:'manual',method:detail?'GET':'POST',
      ...(detail?{}:{body:new URLSearchParams({cname})}), headers:{Accept:'text/html','User-Agent':'KeibaStreaming/1.0 (public race results reader)'}});
    assert(response.status < 300 || response.status >= 400, 'JRA結果の想定外の転送先を拒否しました');
    assert(response.ok && /text\/html/i.test(response.headers.get('content-type') ?? ''), 'JRAの結果ページを取得できません');
    const chunks=[];let size=0;
    for await (const chunk of response.body) {size+=chunk.length;assert(size<=2*1024*1024,'JRAの応答が大きすぎます');chunks.push(chunk);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return clean(decodeCalendar(bytes,response.headers.get('content-type')));
  }
  async function cached(key, work) {
    const hit=cache.get(key);if(hit && now()-hit.at<cacheMs)return structuredClone(hit.value);
    if(!pending.has(key)) {
      assert(pending.size<8,'JRA結果を取得中です。しばらくして再取得してください');
      pending.set(key,work().then(value=>{cache.delete(key);cache.set(key,{at:now(),value});if(cache.size>16)cache.delete(cache.keys().next().value);return value;}).finally(()=>pending.delete(key)));
    }
    return structuredClone(await pending.get(key));
  }
  return {async getResult(input) {
    const query=resultQuery(input);const id=JSON.stringify(query);
    return cached(id,async()=>{
      const signal=AbortSignal.timeout(timeoutMs);
      const fetchedAt=new Date(now()).toISOString();
      const unavailable=()=>({...query,available:false,fetchedAt,notice:UNAVAILABLE});
      try {
        const index=await cached('index',()=>page('pw01sli00/AF',signal));
        const code=String(JRA_VENUES.indexOf(query.venue)+1).padStart(2,'0');
        const ymd=query.date.replaceAll('-','');
        const pattern=new RegExp(`pw01srl\\d{2}${code}${ymd.slice(0,4)}\\d{4}${ymd}/[A-F0-9]{2}`,'g');
        const days=[...new Set(index.match(pattern)??[])];assert(days.length<=1,'開催一覧に重複があります');
        if(!days.length)return unavailable();
        const listing=await cached(days[0],()=>page(days[0],signal));
        const links=[...new Set(listing.match(/pw01sde\d{22}\/[A-F0-9]{2}/g)??[])].filter(c=>sameRace(resultIdentity(c),query));
        assert(links.length<=1,'レース結果一覧に重複があります');if(!links.length)return unavailable();
        const html=await page(links[0],signal,true);
        return parseJraResult(html,query,`${ENDPOINT}?CNAME=${encodeURIComponent(links[0])}`,fetchedAt);
      } catch(error) {
        if(signal.aborted)throw new Error('JRA結果の取得がタイムアウトしました。時間をおいて再取得してください');
        if(error.message==='fetch failed')throw new Error('JRA結果に接続できません。時間をおいて再取得してください');
        throw error;
      }
    });
  }};
}
