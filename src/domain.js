// Shared by the server, control UI and overlay. Money is always integer yen.
export const TYPES = {
  win: { label: '単勝', size: 1, ordered: false },
  place: { label: '複勝', size: 1, ordered: false },
  quinella: { label: '馬連', size: 2, ordered: false },
  wide: { label: 'ワイド', size: 2, ordered: false },
  exacta: { label: '馬単', size: 2, ordered: true },
  trio: { label: '3連複', size: 3, ordered: false },
  trifecta: { label: '3連単', size: 3, ordered: true },
  win5: { label: 'WIN5', size: 5, ordered: true },
};
export const STATUSES = { before: '発走前', live: 'レース中', pending: '確定待ち', final: '確定' };
export const FALLBACK = 'この買い目はフォーメーションに正確に変換できないため、一覧表示します';
export const yen = n => `${n.toLocaleString('ja-JP')}円`;
export const horse = n => String(n).padStart(2, '0');
export const circledHorse = n => Number.isInteger(n) && n >= 1 && n <= 18 ? String.fromCodePoint(0x245f + n) : horse(n);
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function integer(value, min, max, label) {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `${label}は${min}〜${max}の整数で入力してください`);
  return value;
}
export function normalize(type, numbers, headCount = 18) {
  assert(Object.hasOwn(TYPES, type), '券種が不正です');
  assert(Array.isArray(numbers) && numbers.length === TYPES[type].size, `${TYPES[type].label}は${TYPES[type].size}頭を指定してください`);
  numbers.forEach(n => integer(n, 1, headCount, '馬番'));
  assert(type === 'win5' || new Set(numbers).size === numbers.length, '同じ馬番は1つの買い目に指定できません');
  return TYPES[type].ordered ? [...numbers] : [...numbers].sort((a, b) => a - b);
}
export function key(type, numbers) { return `${type}:${normalize(type, numbers).join('-')}`; }
export function validateAmount(amount) {
  integer(amount, 100, 100000000, '購入額');
  assert(amount % 100 === 0, '購入額は100円単位で入力してください');
  return amount;
}
export function normalizeText(text) {
  // Keep Japanese long vowels in レース / フォーメーション intact.
  // A long-vowel mark is a separator only when it appears between horse numbers.
  return text.normalize('NFKC').replace(/[‐‑‒–—―−－]/g, '-').replace(/(\d)(\s*)ー(?=\s*\d)/g, '$1$2-').replace(/\u3000/g, ' ').trim();
}
const typeAliases = Object.entries(TYPES).map(([type, info]) => [info.label, type]);
const ticketMethods = '(?:通常|フォーメーション|ボックス|BOX|(?:(?:軸[12]頭|[123](?:[・･][123])*着)\\s*)?(?:ながし|流し)(?:\\s*マルチ)?|マルチ)';
const ticketVenue = '(?:札幌|函館|福島|新潟|東京|中山|中京|京都|阪神|小倉)';
const raceMetadata = new RegExp(`^(?:(?:場名|開催場|レース|レース名)(?:\\s*[:：])?|(?:場名\\s*[:：]?\\s*)?${ticketVenue}(?:\\s*\\([月火水木金土日祝]\\))?|(?:レース\\s*[:：]?\\s*)?(?:[1-9]|1[0-2])R(?:\\s+.+)?)$`, 'i');

// Strict whole-line grammar: nearby odds/times are never interpreted as tickets.
export function parseTickets(text, { headCount = 18, defaultAmount = 100, existing = [] } = {}) {
  assert(typeof text === 'string' && text.length <= 100000, '貼付テキストは10万文字以内にしてください');
  validateAmount(defaultAmount);
  let contextType = null;
  const seen = new Set(existing.map(t => key(t.type, t.numbers)));
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const line = normalizeText(raw).replace(/win5/gi, 'WIN5');
    if (!line) return [];
    const row = { line: index + 1, raw, status: 'error', message: '' };
    const alias = typeAliases.find(([label]) => line.includes(label));
    if (/^(?:締切|オッズ|投票セット|受付|購入合計|合計金額|発走|受付番号|投票内容)/.test(line)) {
      return [{ ...row, status: 'ignored', message: '周辺情報（登録しません）' }];
    }
    if (alias && new RegExp(`^(?:[一-龯ぁ-んァ-ヶA-Za-z]+(?:\\s*\\([^)]*\\))?\\s*\\d{1,2}R\\s*)?${alias[0]}(?:\\s*${ticketMethods})?(?:\\s*\\d+\\s*(?:組|点))?$`, 'i').test(line)) {
      contextType = alias[1];
      return [{ ...row, status: 'context', message: `券種：${TYPES[contextType].label}（記載された買い目だけを解析。見出しからの自動展開はしません）` }];
    }
    if (raceMetadata.test(line)) {
      contextType = null;
      return [{ ...row, status: 'ignored', message: 'レースの案内情報（登録先は操作画面で選択中のレースです）' }];
    }
    let candidate = line;
    let type = contextType;
    if (alias && line.startsWith(alias[0])) {
      type = alias[1];
      candidate = line.slice(alias[0].length).trim();
    }
    // Right arrows describe the entered order; never reverse or expand it.
    candidate = candidate.replace(/->|[→⇒➜➡]/g, '-');
    const match = candidate.match(/^(\d{1,2}(?:\s*-\s*\d{1,2}){0,4})(?:\s+([\d,]+)\s*円?)?$/);
    if (!match) {
      // An unsupported new header must not leave the preceding bet type active.
      if (alias) contextType = null;
      return [{ ...row, message: '認識できません。券種・馬番・金額の書式を確認してください' }];
    }
    if (!type) return [{ ...row, message: '券種が不明です。先頭に「3連複」等を入力してください' }];
    try {
      const numbers = normalize(type, match[1].split(/\s*-\s*/).map(Number), headCount);
      if (match[2] && !/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(match[2])) throw new Error('金額の桁区切りが不正です');
      const amount = match[2] ? Number(match[2].replaceAll(',', '')) : defaultAmount;
      validateAmount(amount);
      const ticket = { type, numbers, amount, source: 'paste' };
      const id = key(type, numbers);
      const duplicate = seen.has(id);
      seen.add(id);
      return [{ ...row, ticket, status: 'add', duplicate, usesDefault: !match[2], message: `${duplicate ? '同じ買い目を別の購入記録として追加。' : ''}${match[2] ? '追加' : `金額未記載：既定額${yen(amount)}を適用（確認必須）`}` }];
    } catch (error) { return [{ ...row, message: error.message }]; }
  });
}

export function expandFormation(type, columns) {
  assert(Object.hasOwn(TYPES, type), '券種が不正です');
  assert(Array.isArray(columns) && columns.length === TYPES[type].size, '列数が不正です');
  columns.forEach(c => {
    assert(Array.isArray(c) && c.length > 0 && c.length <= 18, '列の馬番が不正です');
    c.forEach(n => integer(n, 1, 18, '馬番'));
  });
  const result = new Map();
  function visit(prefix, index) {
    if (index === columns.length) {
      if (type !== 'win5' && new Set(prefix).size !== prefix.length) return;
      const numbers = normalize(type, prefix);
      result.set(key(type, numbers), numbers);
      return;
    }
    for (const n of columns[index]) visit([...prefix, n], index + 1);
  }
  visit([], 0);
  return [...result.values()];
}
const perms = a => a.length < 2 ? [a] : a.flatMap((n, i) => perms(a.filter((_, j) => j !== i)).map(rest => [n, ...rest]));

// A bounded search for compact rectangles. Every candidate is expanded and
// compared with the original set; failing to find one is always safe to list.
export function toFormation(tickets) {
  if (!tickets.length) return null;
  const { type, amount } = tickets[0];
  if (tickets.some(t => t.type !== type || t.amount !== amount)) return null;
  const target = new Set(tickets.map(t => key(type, t.numbers)));
  if (target.size !== tickets.length) return null;
  const size = TYPES[type].size;
  const candidates = [];
  const sortedUnique = values => [...new Set(values)].sort((a, b) => a - b);
  const all = sortedUnique(tickets.flatMap(t => t.numbers));
  if (type !== 'win5') candidates.push(Array.from({ length: size }, () => all)); // BOX
  if (TYPES[type].ordered) candidates.push(Array.from({ length: size }, (_, i) => sortedUnique(tickets.map(t => t.numbers[i]))));
  else {
    candidates.push(Array.from({ length: size }, (_, i) => sortedUnique(tickets.map(t => normalize(type, t.numbers)[i]))));
    // Color horses into column roles, seeding at most six orientations.
    for (const seed of perms(tickets[0].numbers)) {
      const roles = new Map(seed.map((n, i) => [n, i]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const ticket of tickets) {
          const known = ticket.numbers.filter(n => roles.has(n));
          const missing = ticket.numbers.filter(n => !roles.has(n));
          if (missing.length === 1 && new Set(known.map(n => roles.get(n))).size === size - 1) {
            const role = Array.from({ length: size }, (_, i) => i).find(i => !known.some(n => roles.get(n) === i));
            roles.set(missing[0], role); changed = true;
          }
        }
      }
      if (roles.size === all.length) candidates.push(Array.from({ length: size }, (_, i) => all.filter(n => roles.get(n) === i)));
    }
    // Common axes plus BOX on remaining horses covers common racing slips.
    const common = all.filter(n => tickets.every(t => t.numbers.includes(n)));
    if (common.length && common.length < size) {
      const rest = all.filter(n => !common.includes(n));
      candidates.push([...common.map(n => [n]), ...Array.from({ length: size - common.length }, () => rest)]);
    }
  }
  const valid = candidates.filter(cols => cols.every(c => c.length)).filter(cols => {
    if (type === 'win5' && cols.reduce((total, column) => total * column.length, 1) !== target.size) return false;
    const expanded = expandFormation(type, cols);
    return expanded.length === target.size && expanded.every(n => target.has(key(type, n)));
  });
  valid.sort((a, b) => a.reduce((s, c) => s + c.length, 0) - b.reduce((s, c) => s + c.length, 0) || a[0].length - b[0].length || a[1]?.length - b[1]?.length || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return valid.length ? { type, columns: valid[0], count: target.size, amount, total: target.size * amount } : null;
}
export function ticketGroups(tickets) {
  const groups = new Map();
  for (const t of tickets) {
    const id = `${t.type}:${t.amount}`;
    if (!groups.has(id)) groups.set(id, { id, type: t.type, amount: t.amount, tickets: [] });
    groups.get(id).tickets.push(t);
  }
  return [...groups.values()].sort((a, b) => Object.keys(TYPES).indexOf(a.type) - Object.keys(TYPES).indexOf(b.type) || a.amount - b.amount);
}
export const COMPACT_ROWS_PER_PAGE = 8;
const COMPACT_TEXT_LIMIT = 32;
export function compactNotation(type, columns) {
  return columns.map(column => column.map(circledHorse).join(' ')).join(TYPES[type].ordered ? ' → ' : ' − ');
}
// Circled glyphs are full-width even though each is one Unicode character.
// Budget them as two digits so changing the glyph cannot overflow a row.
const compactWidth = columns => columns.map(column => column.map(horse).join(' ')).join(' − ').length;
function mergeCompactColumns(columnsList, type) {
  const size = TYPES[type].size;
  let rows = columnsList;
  // Each pass only joins rows that differ in ONE column. Their Cartesian union
  // is therefore exact. Bounded passes avoid exhaustive combination searching.
  for (let pass = 0; pass < 6; pass++) {
    const before = rows.length;
    // Prefer fixed horses on the left and opponents on the right.
    for (let column = size - 1; column >= 0; column--) {
      const buckets = new Map();
      for (const row of rows) {
        const signature = JSON.stringify(row.map((c, i) => i === column ? null : c));
        if (!buckets.has(signature)) buckets.set(signature, []);
        const bucket = buckets.get(signature);
        const previous = bucket.at(-1);
        const merged = previous && row.map((c, i) => i === column ? [...new Set([...previous[i], ...c])].sort((a, b) => a - b) : [...c]);
        // The display uses full-width rows; longer expressions remain separate.
        // Keep a single opponent column per row, instead of BOX or several
        // variable columns that obscure which combinations were purchased.
        if (merged && merged.filter(c => c.length > 1).length <= 1 && compactWidth(merged) <= COMPACT_TEXT_LIMIT) bucket[bucket.length - 1] = merged;
        else bucket.push(row);
      }
      rows = [...buckets.values()].flat();
    }
    if (rows.length === before) break;
  }
  return rows;
}
export function compactTicketRows(tickets) {
  return ticketGroups(tickets).flatMap(group => {
    const { type, amount } = group;
    const target = new Set(group.tickets.map(t => key(type, t.numbers)));
    if (target.size < group.tickets.length) {
      const layers = []; const occurrences = new Map();
      for (const ticket of group.tickets) {
        const id = key(type, ticket.numbers); const index = occurrences.get(id) ?? 0;
        (layers[index] ??= []).push(ticket); occurrences.set(id, index + 1);
      }
      return layers.flatMap(compactTicketRows);
    }
    const canonical = group.tickets.map(t => normalize(type, t.numbers)).sort((a, b) => a[0] - b[0] || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0));
    const frequency = new Map();
    canonical.flat().forEach(n => frequency.set(n, (frequency.get(n) ?? 0) + 1));
    const arrangements = [canonical];
    if (!TYPES[type].ordered) arrangements.push(canonical.map(numbers => [...numbers].sort((a, b) => frequency.get(b) - frequency.get(a) || a - b)));
    const candidates = arrangements.map(rows => mergeCompactColumns(rows.map(numbers => numbers.map(n => [n])), type));
    // Validate the final partition: no extra bets, no duplicates across rows,
    // and no omissions. Amounts are grouped before any merging takes place.
    const exact = candidates.filter(rows => {
      const expanded = rows.flatMap(columns => expandFormation(type, columns).map(n => key(type, n)));
      return expanded.length === group.tickets.length && new Set(expanded).size === target.size && expanded.every(k => target.has(k));
    });
    exact.sort((a, b) => a.length - b.length || a.reduce((s, c) => s + compactNotation(type, c).length, 0) - b.reduce((s, c) => s + compactNotation(type, c).length, 0));
    const best = exact[0] ?? canonical.map(numbers => numbers.map(n => [n]));
    return best.map(original => {
      const columns = TYPES[type].ordered ? original : [...original].sort((a, b) => a.length - b.length || a[0] - b[0]);
      const count = expandFormation(type, columns).length;
      return { type, amount, columns, count, total: count * amount, notation: compactNotation(type, columns) };
    });
  });
}
export function currentDisplayPage(display, pageCount, now = Date.now()) {
  if (pageCount < 1) return 0;
  const base = display.page % pageCount;
  if (!display.autoPage || !display.ticketsVisible) return base;
  const elapsed = Math.max(0, now - display.pageStartedAt);
  return (base + Math.floor(elapsed / (display.pageInterval * 1000))) % pageCount;
}
export function displayPages(tickets, mode) {
  if (mode === 'compact') {
    const rows = compactTicketRows(tickets);
    const pages = [];
    for (let i = 0; i < rows.length; i += COMPACT_ROWS_PER_PAGE) pages.push({ compact: rows.slice(i, i + COMPACT_ROWS_PER_PAGE) });
    return pages;
  }
  return ticketGroups(tickets).flatMap(group => {
    const formation = mode === 'formation' ? toFormation(group.tickets) : null;
    if (formation) return [{ ...group, formation }];
    const pages = [];
    for (let i = 0; i < group.tickets.length; i += 6) pages.push({ ...group, tickets: group.tickets.slice(i, i + 6), fallback: mode === 'formation' });
    return pages;
  });
}
export function isWinning(type, numbers, order, headCount = 18) {
  if (type === 'win5') {
    if (!Array.isArray(order) || order.length !== 5 || order.some(n => !Number.isInteger(n) || n < 1 || n > 18)) return null;
    return normalize(type, numbers).every((n, i) => n === order[i]);
  }
  if (!Array.isArray(order) || order.length !== 3 || new Set(order).size !== order.length) return null;
  if (order.some(n => !Number.isInteger(n) || n < 1 || n > headCount)) return null;
  const n = normalize(type, numbers, headCount);
  switch (type) {
    case 'win': return n[0] === order[0];
    case 'place': return order.slice(0, headCount <= 7 ? 2 : 3).includes(n[0]);
    case 'quinella': return key(type, n) === key(type, order.slice(0, 2));
    case 'wide': return n.every(x => order.slice(0, 3).includes(x));
    case 'exacta': return n.every((x, i) => x === order[i]);
    case 'trio': return key(type, n) === key(type, order.slice(0, 3));
    case 'trifecta': return n.every((x, i) => x === order[i]);
    default: return null;
  }
}
export function judgeTickets(tickets, order, headCount = 18) {
  const items = tickets.map(ticket => {
    const win = isWinning(ticket.type, ticket.numbers, order, headCount);
    return { ...ticket, verdict: win === null ? 'pending' : win ? 'win' : 'lose' };
  });
  return { items, wins: items.filter(t => t.verdict === 'win').length, losses: items.filter(t => t.verdict === 'lose').length, pending: items.filter(t => t.verdict === 'pending').length };
}
export function parseDividends(text, headCount = 18) {
  return text.split(/\r?\n/).flatMap((raw, index) => {
    const line = normalizeText(raw).replace(/win5/gi, 'WIN5');
    if (!line) return [];
    const alias = typeAliases.find(([label]) => line.startsWith(label));
    assert(alias, `配当${index + 1}行目：券種を入力してください`);
    const match = line.slice(alias[0].length).trim().match(/^(\d{1,2}(?:\s*-\s*\d{1,2}){0,4})\s+(\d+|\d{1,3}(?:,\d{3})+)\s*円$/);
    assert(match, `配当${index + 1}行目：「3連複 06-07-09 1,200円」の形式で入力してください`);
    return [{ type: alias[1], numbers: normalize(alias[1], match[1].split(/\s*-\s*/).map(Number), headCount), amount: integer(Number(match[2].replaceAll(',', '')), 1, 1000000000, '配当') }];
  });
}
export function raceBalance(race) {
  const investment = race.tickets.reduce((sum, t) => sum + t.amount, 0);
  const r = race.result;
  if (!r.confirmed) return { investment, payout: null, profit: null, pending: true };
  if (r.manualPayout !== null) return { investment, payout: r.manualPayout, profit: r.manualPayout - investment, pending: false };
  if (!r.complete || r.order.length !== (race.kind === 'win5' ? 5 : 3)) return { investment, payout: null, profit: null, pending: true };
  let payout = 0;
  for (const t of race.tickets) {
    const win = isWinning(t.type, t.numbers, r.order, race.headCount);
    if (win === null) return { investment, payout: null, profit: null, pending: true };
    if (!win) continue;
    const dividend = r.dividends.find(d => key(d.type, d.numbers) === key(t.type, t.numbers));
    if (!dividend) return { investment, payout: null, profit: null, pending: true };
    payout += dividend.amount * (t.amount / 100);
    assert(Number.isSafeInteger(payout) && payout <= 1000000000000, '算出したレース払戻が保存上限（1兆円）を超えています。購入額・配当を確認してください');
  }
  return { investment, payout, profit: payout - investment, pending: false };
}
export function dayBalance(races, date) {
  const balances = races.filter(r => r.date === date).map(raceBalance);
  const investment = balances.reduce((s, r) => s + r.investment, 0);
  const payout = balances.reduce((s, r) => s + (r.payout ?? 0), 0);
  const pending = balances.filter(r => r.pending && r.investment > 0).length;
  return { investment, payout, profit: payout - investment, pending };
}
