import { createBrowserStore } from './browser-store.js';
import { createJraClient } from './jra-client.js';
import { JRA_API_URL } from './jra-config.js';

const jra = createJraClient({ endpoint: JRA_API_URL });
export const getJraSchedule = date => jra.getSchedule(date);
export const BROWSER_MODE = true;
export const controlUrl = new URL('./index.html', import.meta.url).href;
export const overlayUrl = new URL('./overlay.html', import.meta.url).href;
const store = createBrowserStore({ name: `keiba-streaming:${new URL('./', import.meta.url).pathname}` });
export async function requestAction(action) {
  try {
    const resolved = action.type === 'race.importJra' ? await jra.resolveImport(action) : action;
    return { ok: true, data: await store.action(resolved) };
  }
  catch (error) { return { ok: false, data: { error: error.message, ...(error.state ? { state: error.state } : {}) } }; }
}
export function connect(onState, onConnection = () => {}) {
  const unsubscribe = store.subscribe((state, error) => {
    if (error) { onConnection(false, error.message); return; }
    onState(state); onConnection(true);
  });
  // A foreground refresh also recovers when a background tab missed a message.
  const refresh = () => { if (!document.hidden) store.read().then(onState).catch(() => onConnection(false)); };
  document.addEventListener('visibilitychange', refresh);
  return { close() { unsubscribe(); document.removeEventListener('visibilitychange', refresh); } };
}
