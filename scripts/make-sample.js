import { readFile, writeFile } from 'node:fs/promises';
import { initialState, applyAction } from '../src/state.js';
import { parseTickets } from '../src/domain.js';
let state = initialState();
state = applyAction(state, { type: 'race.update', payload: { fields: {
  date: '2026-11-22', venue: '京都', number: 11, name: 'サンプルステークス', surface: '芝', distance: 1600, startTime: '15:40',
  picks: [{ mark: '◎', number: 6 }, { mark: '○', number: 7 }, { mark: '▲', number: 18 }],
} } });
const text = await readFile(new URL('../examples/sample-tickets.txt', import.meta.url), 'utf8');
state = applyAction(state, { type: 'tickets.add', payload: { tickets: parseTickets(text).filter(r => r.status === 'add').map(r => r.ticket) } });
state = applyAction(state, { type: 'race.status', payload: { status: 'live' } });
state = applyAction(state, { type: 'display.update', payload: { fields: { mode: 'formation' } } });
await writeFile(new URL('../examples/sample-state.json', import.meta.url), JSON.stringify(state, null, 2) + '\n', 'utf8');
console.log('examples/sample-state.json を作成しました（架空の検証用データ）');
