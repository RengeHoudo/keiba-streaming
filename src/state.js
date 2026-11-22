import { TYPES, STATUSES, assert, integer, normalize, key, validateAmount, today, raceBalance } from './domain.js';
import { calendarUrl } from './calendar-url.js';
import { validateJraResult, validateResultSource, sameRace } from './jra-result-data.js';

const randomUUID = () => globalThis.crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const text = (value, max, name) => {
  assert(typeof value === 'string' && value.length <= max, `${name}は${max}文字以内で入力してください`);
  return value.trim();
};
function date(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, '開催日が不正です');
  return value;
}
function id(value) {
  assert(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value), 'IDが不正です');
  return value;
}
function bool(value, name) { assert(typeof value === 'boolean', `${name}が不正です`); return value; }
function iso(value) { assert(typeof value === 'string' && value.length < 40 && !Number.isNaN(Date.parse(value)), '日時が不正です'); return value; }
export const emptyResult = () => ({ confirmed: false, order: [], dividends: [], complete: false, manualPayout: null, note: '', adjustments: [] });
export function newRace() {
  return { id: randomUUID(), date: today(), venue: '', number: 1, name: '', surface: '芝', distance: null, startTime: '', headCount: 18, status: 'before', picks: [], tickets: [], result: emptyResult(), source: null };
}
export function initialState() {
  const race = newRace();
  return { version: 1, revision: 0, updatedAt: timestamp(), races: [race], display: { raceId: race.id, ticketsVisible: true, mode: 'compact', page: 0, autoPage: true, pageInterval: 10, pageStartedAt: Date.now(), balanceVisible: false, countdown: false, effectEnabled: true, effect: null } };
}
function validateResult(result, headCount, identity) {
  assert(result && typeof result === 'object', '結果が不正です');
  assert(Array.isArray(result.order) && result.order.length <= 3, '着順は上位3頭までです');
  result.order.forEach(n => integer(n, 1, headCount, '着順の馬番'));
  assert(new Set(result.order).size === result.order.length, '着順に重複があります。同着等は手動払戻を使用してください');
  assert(Array.isArray(result.dividends) && result.dividends.length <= 100, '配当明細は100件以内です');
  const seen = new Set();
  const dividends = result.dividends.map(d => {
    const numbers = normalize(d.type, d.numbers, headCount);
    const k = key(d.type, numbers);
    assert(!seen.has(k), '配当明細に重複があります'); seen.add(k);
    return { type: d.type, numbers, amount: integer(d.amount, 1, 1000000000, '100円あたり配当') };
  });
  const manualPayout = result.manualPayout === null ? null : integer(result.manualPayout, 0, 1000000000000, '手動払戻');
  let source = null;
  if (result.source != null) {
    assert(result.source.provider === 'jra-result' && identity && sameRace(result.source, identity), '結果のレースが一致しません');
    source = {provider:'jra-result',date:identity.date,venue:identity.venue,number:identity.number,url:validateResultSource(result.source.url, identity),fetchedAt:iso(result.source.fetchedAt)};
    validateJraResult({...identity,available:true,headCount,order:result.order,dividends,sourceUrl:source.url,fetchedAt:source.fetchedAt,notice:''},identity);
  }
  assert(Array.isArray(result.adjustments) && result.adjustments.length <= 1000, '修正履歴が不正です');
  return {
    confirmed: bool(result.confirmed, '結果確定'), order: [...result.order], dividends,
    complete: bool(result.complete, '配当確認'), manualPayout, ...(source ? {source} : {}),
    note: text(result.note, 300, '補足'),
    adjustments: result.adjustments.map(a => ({ at: iso(a.at), before: a.before === null ? null : integer(a.before, 0, 1000000000000, '修正前払戻'), after: a.after === null ? null : integer(a.after, 0, 1000000000000, '修正後払戻'), note: text(a.note, 300, '修正理由') })),
  };
}
function validateRace(r) {
  assert(r && typeof r === 'object', 'レースが不正です');
  const headCount = integer(r.headCount, 3, 18, '頭数');
  assert(Object.hasOwn(STATUSES, r.status), '状態が不正です');
  assert(['芝', 'ダート', '障害', ''].includes(r.surface), 'コース種別が不正です');
  assert(r.startTime === '' || (typeof r.startTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(r.startTime)), '発走時刻が不正です');
  assert(Array.isArray(r.picks) && r.picks.length <= 5, '予想印は5件までです');
  const picks = r.picks.map(p => {
    assert(['◎', '○', '▲', '△', '☆'].includes(p.mark), '予想印が不正です');
    return { mark: p.mark, number: integer(p.number, 1, headCount, '予想馬番') };
  });
  assert(new Set(picks.map(p => p.mark)).size === picks.length && new Set(picks.map(p => p.number)).size === picks.length, '予想印・馬番が重複しています');
  assert(Array.isArray(r.tickets) && r.tickets.length <= 2000, '1レースの購入記録は2000点までです');
  const seen = new Set();
  const ids = new Set();
  const tickets = r.tickets.map(t => {
    const numbers = normalize(t.type, t.numbers, headCount);
    const k = key(t.type, numbers);
    assert(!seen.has(k), '買い目が重複しています'); seen.add(k);
    assert(!ids.has(t.id), '馬券IDが重複しています'); ids.add(t.id);
    assert(['manual', 'paste'].includes(t.source), '登録元が不正です');
    return { id: id(t.id), type: t.type, numbers, amount: validateAmount(t.amount), source: t.source, createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt) };
  });
  let source = null;
  if (r.source != null) {
    assert(r.source.provider === 'jra-calendar' && r.source.url === calendarUrl(r.date), 'レース情報の取得元が不正です');
    source = { provider: 'jra-calendar', url: r.source.url, fetchedAt: iso(r.source.fetchedAt) };
  }
  return {
    id: id(r.id), date: date(r.date), venue: text(r.venue, 16, '開催場'), number: integer(r.number, 1, 12, 'R番号'),
    name: text(r.name, 40, 'レース名'), surface: r.surface, distance: r.distance === null ? null : integer(r.distance, 100, 10000, '距離'),
    startTime: r.startTime, headCount, status: r.status, picks, tickets, result: validateResult(r.result, headCount, r), source,
  };
}
export function validateState(input) {
  assert(input && input.version === 1, '対応していないデータ形式です');
  assert(Array.isArray(input.races) && input.races.length >= 1 && input.races.length <= 200, 'レース数は1〜200件です');
  const races = input.races.map(validateRace);
  races.forEach(raceBalance); // Reject totals that cannot be represented safely.
  assert(new Set(races.map(r => r.id)).size === races.length, 'レースIDが重複しています');
  const d = input.display;
  assert(d && races.some(r => r.id === d.raceId), '選択レースが存在しません');
  assert(['list', 'formation', 'compact'].includes(d.mode), '表示モードが不正です');
  // Existing v1 files adopt the requested compact, automatic display once.
  // After that, explicitly chosen display settings survive every restart.
  const legacyDisplay = d.autoPage === undefined;
  let effect = null;
  if (d.effect !== null) {
    assert(d.effect && typeof d.effect === 'object', '演出が不正です');
    effect = { id: id(d.effect.id), startedAt: integer(d.effect.startedAt, 0, Number.MAX_SAFE_INTEGER - 10000, '演出時刻') };
  }
  return { version: 1, revision: integer(input.revision, 0, Number.MAX_SAFE_INTEGER - 1, '更新番号'), updatedAt: iso(input.updatedAt), races, display: {
    raceId: d.raceId, ticketsVisible: bool(d.ticketsVisible, '馬券表示'), mode: legacyDisplay ? 'compact' : d.mode, page: integer(d.page, 0, 2000, 'ページ'),
    autoPage: legacyDisplay ? true : bool(d.autoPage, '自動ページ切替'),
    pageInterval: d.pageInterval === undefined ? 10 : integer(d.pageInterval, 5, 60, 'ページ切替間隔'),
    pageStartedAt: d.pageStartedAt === undefined ? Date.now() : integer(d.pageStartedAt, 0, Number.MAX_SAFE_INTEGER, 'ページ切替基準時刻'),
    balanceVisible: bool(d.balanceVisible, '収支表示'), countdown: bool(d.countdown, 'カウントダウン'), effectEnabled: bool(d.effectEnabled, '演出設定'), effect,
  } };
}
export function applyAction(current, action) {
  assert(action && typeof action.type === 'string', '操作が不正です');
  let state = structuredClone(current);
  const p = action.payload ?? {};
  const race = state.races.find(r => r.id === (p.raceId ?? state.display.raceId));
  assert(race, 'レースが見つかりません');
  switch (action.type) {
    case 'race.create': {
      const next = newRace();
      if (p.date !== undefined) next.date = date(p.date);
      state.races.push(next); state.display.raceId = next.id; state.display.page = 0; break;
    }
    case 'race.select': state.display.raceId = race.id; state.display.page = 0; break;
    case 'race.import': {
      const f = p.fields;
      assert(f && Object.keys(f).every(k => ['date', 'venue', 'number', 'name', 'surface', 'distance', 'startTime'].includes(k)), '取り込むレース情報が不正です');
      assert(['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'].includes(f.venue), '中央競馬の開催場を選択してください');
      const existing = state.races.find(r => r.date === f.date && r.venue === f.venue && r.number === f.number);
      const target = existing ?? newRace();
      Object.assign(target, f, { source: p.source });
      if (!existing) state.races.push(target);
      state.display.raceId = target.id; state.display.page = 0; break;
    }
    case 'race.update': {
      const allowed = ['date', 'venue', 'number', 'name', 'surface', 'distance', 'startTime', 'headCount', 'picks'];
      assert(p.fields && typeof p.fields === 'object', 'レース情報がありません');
      assert(Object.keys(p.fields).every(k => allowed.includes(k)), '更新できない項目です');
      if ('headCount' in p.fields && p.fields.headCount !== race.headCount) race.result.confirmed = false;
      if (['date', 'venue', 'number', 'headCount'].some(k => k in p.fields && p.fields[k] !== race[k])) {
        delete race.result.source; race.result.confirmed = false;
      }
      if (['date', 'venue', 'number', 'name', 'surface', 'distance', 'startTime'].some(k => k in p.fields && p.fields[k] !== race[k])) race.source = null;
      Object.assign(race, p.fields); break;
    }
    case 'race.status': race.status = p.status; break;
    case 'race.delete':
      assert(state.races.length > 1, '最後のレースは削除できません');
      state.races = state.races.filter(r => r.id !== race.id);
      if (state.display.raceId === race.id) state.display.raceId = state.races[0].id;
      state.display.page = 0; break;
    case 'display.update': {
      assert(p.fields && typeof p.fields === 'object', '表示設定がありません');
      const allowed = ['ticketsVisible', 'mode', 'page', 'autoPage', 'pageInterval', 'balanceVisible', 'countdown', 'effectEnabled'];
      assert(Object.keys(p.fields).every(k => allowed.includes(k)), '表示設定が不正です');
      Object.assign(state.display, p.fields);
      if ('mode' in p.fields) state.display.page = 0;
      if (!state.display.effectEnabled) state.display.effect = null;
      break;
    }
    case 'effect.play':
      assert(state.display.effectEnabled, '的中演出がOFFです');
      state.display.effect = { id: randomUUID(), startedAt: Date.now() }; break;
    case 'effect.stop': state.display.effect = null; break;
    case 'tickets.add': {
      assert(Array.isArray(p.tickets) && p.tickets.length > 0 && p.tickets.length <= 2000, '登録する買い目を指定してください');
      const seen = new Set(race.tickets.map(t => key(t.type, t.numbers)));
      for (const t of p.tickets) {
        const numbers = normalize(t.type, t.numbers, race.headCount);
        const k = key(t.type, numbers);
        assert(!seen.has(k), `${TYPES[t.type].label} ${numbers.join('-')} は登録済みです。既存の金額を編集してください`);
        seen.add(k);
        race.tickets.push({ id: randomUUID(), type: t.type, numbers, amount: validateAmount(t.amount), source: t.source ?? 'manual', createdAt: timestamp(), updatedAt: timestamp() });
      }
      race.result.confirmed = false; break;
    }
    case 'ticket.update': {
      const t = race.tickets.find(t => t.id === p.id);
      assert(t, '購入記録が見つかりません');
      t.type = p.ticket.type; t.numbers = normalize(t.type, p.ticket.numbers, race.headCount); t.amount = validateAmount(p.ticket.amount); t.updatedAt = timestamp();
      race.result.confirmed = false; break;
    }
    case 'tickets.amount': {
      assert(Array.isArray(p.ids) && p.ids.length > 0 && p.ids.every(id => race.tickets.some(t => t.id === id)), '対象の買い目が不正です');
      const amount = validateAmount(p.amount);
      for (const t of race.tickets.filter(t => p.ids.includes(t.id))) { t.amount = amount; t.updatedAt = timestamp(); }
      race.result.confirmed = false; break;
    }
    case 'ticket.delete':
      assert(race.tickets.some(t => t.id === p.id), '購入記録が見つかりません');
      race.tickets = race.tickets.filter(t => t.id !== p.id); race.result.confirmed = false; break;
    case 'tickets.clear': race.tickets = []; race.result.confirmed = false; state.display.page = 0; break;
    case 'result.order': {
      const changed = JSON.stringify(race.result.order) !== JSON.stringify(p.order);
      race.result = validateResult({ ...race.result, source: changed ? null : race.result.source, order: p.order, confirmed: changed ? false : race.result.confirmed, complete: changed ? false : race.result.complete }, race.headCount, race);
      break;
    }
    case 'result.import': {
      const data = validateJraResult(p.data, race);
      assert(data.available, '確定結果はまだ取得できません');
      assert(race.tickets.every(t => t.numbers.every(n => n <= data.headCount)) && race.picks.every(pick => pick.number <= data.headCount), '購入馬番・予想印とJRAの出走頭数が一致しません。レース設定を確認してください');
      const adjustments = [...race.result.adjustments];
      if (race.result.manualPayout !== null) adjustments.push({at:timestamp(),before:race.result.manualPayout,after:null,note:'JRA確定払戻金の取得による自動計算へ変更'});
      race.headCount = data.headCount;
      race.result = {...emptyResult(),confirmed:true,complete:true,order:data.order,dividends:data.dividends,adjustments,
        source:{provider:'jra-result',date:race.date,venue:race.venue,number:race.number,url:data.sourceUrl,fetchedAt:data.fetchedAt}};
      race.status = 'final';
      break;
    }
    case 'result.save': {
      const before = race.result.manualPayout;
      const next = validateResult({ ...p.result, adjustments: race.result.adjustments }, race.headCount);
      if (before !== next.manualPayout) {
        assert(next.note.length > 0, '手動払戻の変更理由を入力してください');
        next.adjustments.push({ at: timestamp(), before, after: next.manualPayout, note: next.note });
      }
      race.result = next; break;
    }
    case 'state.import': state = validateState(p.state); state.display.effect = null; break;
    default: throw new Error('未対応の操作です');
  }
  if (['race.create', 'race.select', 'race.delete', 'race.import', 'tickets.add', 'ticket.update', 'tickets.amount', 'ticket.delete', 'tickets.clear', 'state.import'].includes(action.type)
    || (action.type === 'display.update' && ['mode', 'page', 'autoPage', 'pageInterval', 'ticketsVisible'].some(k => k in p.fields))) state.display.pageStartedAt = Date.now();
  state.revision = current.revision + 1;
  state.updatedAt = timestamp();
  return validateState(state);
}
