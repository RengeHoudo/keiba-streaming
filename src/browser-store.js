import { initialState, validateState, applyAction } from './state.js';

// One read/write transaction serializes updates from separate tabs. Nothing is
// sent to GitHub or a third party; BroadcastChannel only announces a revision.
export function createBrowserStore({ indexedDB = globalThis.indexedDB, name = 'keiba-streaming', makeChannel = n => new BroadcastChannel(n) } = {}) {
  let dbPromise;
  const listeners = new Set();
  const channel = makeChannel?.(name);
  function notify(state, error) {
    for (const listener of listeners) { try { listener(state, error); } catch (failure) { console.error('画面更新に失敗しました', failure); } }
  }
  function database() {
    return dbPromise ??= new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('このブラウザでは記録を保存できません。ローカル版をご利用ください。')); return; }
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('records');
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new Error('ブラウザ保存領域を開けません。プライベートモードや保存設定を確認してください。'));
      request.onblocked = () => reject(new Error('他のタブを閉じて再読み込みしてください。'));
    });
  }
  async function transact(action) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('records', 'readwrite');
      const records = tx.objectStore('records');
      const request = records.get('current');
      let result; let failure;
      request.onsuccess = () => {
        try {
          const record = request.result;
          // Invalid saved data is never silently overwritten by an empty state.
          const current = record ? validateState(record.state) : initialState();
          if (!action) {
            if (!record) records.put({ state: current, undo: [] }, 'current');
            result = current; return;
          }
          if (action.expectedRevision !== current.revision) {
            const error = new Error('別の画面で更新されました。最新状態で操作をやり直してください');
            error.status = 409; error.state = current; throw error;
          }
          const history = record?.undo ?? [];
          let next;
          if (action.type === 'undo') {
            if (!history.length) throw new Error('取り消せる操作がありません');
            next = validateState({ ...structuredClone(history.at(-1)), revision: current.revision + 1, updatedAt: new Date().toISOString() });
            next.display.effect = null; next.display.pageStartedAt = Date.now();
          } else next = applyAction(current, action);
          records.put({ state: next, undo: action.type === 'undo' ? history.slice(0, -1) : [...history, current].slice(-20) }, 'current');
          result = next;
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? new Error('保存に失敗しました。ブラウザの保存容量・設定を確認してください。'));
      tx.onerror = () => { /* onabort reports the failure once */ };
    });
  }
  async function refresh() {
    try { notify(await transact()); }
    catch (error) { notify(null, error); }
  }
  if (channel) channel.onmessage = () => refresh();
  return {
    read: () => transact(),
    async action(action) {
      const state = await transact(action);
      notify(state);
      channel?.postMessage({ revision: state.revision });
      return state;
    },
    subscribe(listener) { listeners.add(listener); refresh(); return () => listeners.delete(listener); },
    async close() { channel?.close(); listeners.clear(); if (dbPromise) (await dbPromise).close(); },
  };
}
