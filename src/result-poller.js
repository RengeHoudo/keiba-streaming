import { raceBalance } from './domain.js';
import { JRA_VENUES } from './jra-result-data.js';

export const resultTarget = r => JSON.stringify([r.id, r.kind, r.date, r.venue, r.number, r.startTime, r.headCount]);
export function needsResult(r, now) {
  if (r.autoResult === false || !r.tickets.length || !raceBalance(r).pending) return false;
  if (r.kind !== 'win5' && !JRA_VENUES.includes(r.venue)) return false;
  const start = Date.parse(`${r.date}T${r.startTime || '00:00'}:00+09:00`);
  if (start > now || !Number.isFinite(start)) return false;
  return Boolean(r.startTime || r.kind === 'win5' || r.status !== 'before' || now - start >= 86400000);
}
// A fair queue independent of the selected race and tab visibility.
// Space requests to stay below the public API's 30 requests/minute limit.
export function createResultPoller({getState, check, now = Date.now, isBusy = () => false, onError = () => {}}) {
  const attempts = new Map(); let running = false; let lastRequest = -Infinity;
  return {async tick() {
    if (running || isBusy() || now() - lastRequest < 3000) return;
    const races = getState()?.races ?? [];
    const keys = new Set(races.map(resultTarget));
    for (const key of attempts.keys()) if (!keys.has(key)) attempts.delete(key);
    const targets = races.filter(r => needsResult(r, now()) && now() - (attempts.get(resultTarget(r)) ?? -Infinity) >= 60000)
      .sort((a,b) => (attempts.get(resultTarget(a)) ?? -Infinity) - (attempts.get(resultTarget(b)) ?? -Infinity));
    if (!targets.length) return;
    const target = structuredClone(targets[0]);
    running = true; lastRequest = now(); attempts.set(resultTarget(target), now());
    try { await check(target); } catch (error) { onError(error, target); }
    finally { running = false; }
  }};
}
