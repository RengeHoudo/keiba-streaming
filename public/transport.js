import { createJraClient } from './jra-client.js';
const jra = createJraClient({ endpoint: '/api/jra/races' });
export const getJraSchedule = date => jra.getSchedule(date);
export const BROWSER_MODE = false;
export const controlUrl = new URL('./control', import.meta.url).href;
export const overlayUrl = new URL('./overlay', import.meta.url).href;
export async function requestAction(action) {
  const response = await fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
  return { ok: response.ok, data: await response.json() };
}
export function connect(onState, onConnection = () => {}) {
  const source = new EventSource('/api/events');
  source.addEventListener('state', event => {
    try { onState(JSON.parse(event.data)); onConnection(true); }
    catch (error) { console.error('状態の読込に失敗しました', error); }
  });
  source.onerror = () => onConnection(false);
  return source;
}
