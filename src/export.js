import { TYPES, raceBalance } from './domain.js';

export function exportCsv(state) {
  const safe = value => `"${String(value).replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""')}"`;
  const rows = [['開催日', 'レースID', '開催場', 'R', 'レース名', '券種', '馬番', '購入額', '登録元', 'レース確定払戻', '払戻確認状態']];
  for (const r of state.races) {
    const b = raceBalance(r);
    (r.tickets.length ? r.tickets : [null]).forEach((t, i) => rows.push([r.date, r.id, r.venue, r.number, r.name, t ? TYPES[t.type].label : '', t?.numbers.join('-') ?? '', t?.amount ?? '', t?.source ?? '', i === 0 ? b.payout ?? '' : '', b.pending ? '未確定・未入力' : '確定']));
  }
  return '\uFEFF' + rows.map(row => row.map(safe).join(',')).join('\r\n');
}
