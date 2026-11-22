import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from './storage.js';
import { applyAction, validateState } from './state.js';
import { exportCsv } from './export.js';
import { createJraProvider } from './jra.js';
import { createJraResultProvider } from './jra-result.js';
import { createWin5Provider } from './jra-win5.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function createApp({ dataDir = path.join(root, 'data'), jraProvider = createJraProvider(), jraResultProvider = createJraResultProvider(), win5Provider = createWin5Provider() } = {}) {
  const storage = new Storage(dataDir);
  let state = await storage.load();
  let queue = Promise.resolve();
  const clients = new Set();
  const undo = [];
  const emit = () => {
    const event = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
    for (const client of clients) { if (!client.write(event)) { client.destroy(); clients.delete(client); } }
  };
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (!allowed.includes(req.headers.host)) return json(403, { error: 'ローカルURLから接続してください' });
    if (req.headers.origin && !allowed.map(h => `http://${h}`).includes(req.headers.origin)) return json(403, { error: '外部ページからの操作はできません' });
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      // Links from another site are normal top-level navigation. Allow only
      // the read-only HTML entry pages; keep APIs and embedded requests private.
      const pageNavigation = (req.method === 'GET' || req.method === 'HEAD')
        && ['/', '/control', '/overlay'].includes(url.pathname)
        && req.headers['sec-fetch-mode'] === 'navigate'
        && req.headers['sec-fetch-dest'] === 'document';
      if (req.headers['sec-fetch-site'] === 'cross-site' && !pageNavigation) return json(403, { error: '外部ページからの接続はできません' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state);
      if (req.method === 'GET' && url.pathname === '/api/jra/races') return json(200, await jraProvider.getSchedule(url.searchParams.get('date')));
      if (req.method === 'GET' && url.pathname === '/api/jra/win5') {
        if ([...url.searchParams.keys()].join() !== 'date') return json(400, {error:'開催日だけを指定してください'});
        return json(200, await win5Provider.getResult(url.searchParams.get('date')));
      }
      if (req.method === 'GET' && url.pathname === '/api/jra/result') {
        const keys = ['date', 'venue', 'number'];
        if ([...url.searchParams.keys()].some(k => !keys.includes(k)) || keys.some(k => url.searchParams.getAll(k).length !== 1)) return json(400, {error:'開催日・開催場・レース番号を指定してください'});
        return json(200, await jraResultProvider.getResult({date:url.searchParams.get('date'),venue:url.searchParams.get('venue'),number:Number(url.searchParams.get('number'))}));
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 1000\nevent: state\ndata: ${JSON.stringify(state)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        res.setHeader('Content-Disposition', 'attachment; filename="keiba-backup.json"'); return json(200, state);
      }
      if (req.method === 'GET' && url.pathname === '/api/export.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="keiba-records.csv"' });
        res.end(exportCsv(state)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'JSON形式が必要です' });
        let body = ''; let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk, 'utf8');
          if (size > 4 * 1024 * 1024) { json(413, { error: 'データは4MB以内にしてください' }); req.resume(); return; }
          body += chunk;
        }
        // setEncoding preserves UTF-8 characters split across network chunks.
        let action = JSON.parse(body);
        if (action.type === 'race.importJra') {
          const schedule = await jraProvider.getSchedule(action.payload?.date);
          const fields = schedule.races.find(r => r.venue === action.payload?.venue && r.number === action.payload?.number);
          if (!fields) return json(400, { error: '取得結果に指定のレースがありません。再取得して選択してください' });
          action = { ...action, type: 'race.import', payload: { fields, source: { provider: 'jra-calendar', url: schedule.sourceUrl, fetchedAt: schedule.fetchedAt } } };
        }
        const task = queue.then(async () => {
          if (action.expectedRevision !== state.revision) return json(409, { error: '別の画面で更新されました。最新状態で操作をやり直してください', state });
          let next;
          if (action.type === 'undo') {
            if (!undo.length) return json(400, { error: '取り消せる操作がありません（再起動前の履歴は対象外）' });
            next = structuredClone(undo.at(-1)); next.revision = state.revision + 1; next.updatedAt = new Date().toISOString(); next.display.effect = null; next.display.pageStartedAt = Date.now();
            next = validateState(next);
          } else next = applyAction(state, action);
          await storage.save(next);
          if (action.type === 'undo') undo.pop();
          else { undo.push(state); if (undo.length > 20) undo.shift(); }
          state = next; emit(); json(200, state);
        });
        queue = task.catch(() => {});
        await task; return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { error: '未対応のメソッドです' });
      const routes = {
        '/': ['public/control.html', 'text/html'], '/control': ['public/control.html', 'text/html'],
        '/overlay': ['public/overlay.html', 'text/html'], '/control.js': ['public/control.js', 'text/javascript'],
        '/overlay.js': ['public/overlay.js', 'text/javascript'], '/shared.js': ['public/shared.js', 'text/javascript'],
        '/judgement.js': ['public/judgement.js', 'text/javascript'], '/jra-control.js': ['public/jra-control.js', 'text/javascript'],
        '/transport.js': ['public/transport.js', 'text/javascript'], '/export.js': ['src/export.js', 'text/javascript'],
        '/jra-client.js': ['src/jra-client.js', 'text/javascript'], '/calendar-url.js': ['src/calendar-url.js', 'text/javascript'],
        '/jra-result-data.js': ['src/jra-result-data.js', 'text/javascript'], '/jra-result-control.js': ['public/jra-result-control.js', 'text/javascript'],
        '/jra-win5-data.js': ['src/jra-win5-data.js', 'text/javascript'], '/result-poller.js': ['src/result-poller.js', 'text/javascript'],
        '/domain.js': ['src/domain.js', 'text/javascript'], '/style.css': ['public/style.css', 'text/css'],
      };
      const route = routes[url.pathname];
      if (!route) return json(404, { error: '見つかりません' });
      const content = await readFile(path.join(root, route[0]));
      res.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8` }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(error.code && ['EACCES', 'ENOSPC', 'EPERM', 'EIO'].includes(error.code) ? 500 : 400, { error: error.code ? `保存・読込に失敗しました (${error.code})。ディスクと権限を確認してください` : error.message });
      else res.end();
    }
  });
  server.prependListener('request', req => req.setEncoding('utf8'));
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
  heartbeat.unref();
  let closed = false;
  return {
    server,
    listen(port = 8765) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address()); }); }); },
    async close() {
      if (closed) return;
      closed = true; clearInterval(heartbeat); for (const client of clients) client.end();
      await queue; await new Promise(resolve => server.close(resolve));
    },
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22以降を使用してください');
  const port = Number(process.env.PORT ?? 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORTは1〜65535を指定してください');
  try {
    const app = await createApp({ dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined });
    await app.listen(port);
    console.log(`\n競馬配信コントロール\n操作: http://127.0.0.1:${port}/control\n配信: http://127.0.0.1:${port}/overlay\n保存: ${path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'))}\n終了: Ctrl+C\n`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
  } catch (error) { console.error(error.code === 'EADDRINUSE' ? `ポート${port}は使用中です。既存のサーバーを終了するかPORTを変更してください。` : error.message); process.exitCode = 1; }
}
