import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { buildPages, PAGE_FILES } from '../scripts/build-pages.js';

test('Pages: 公開ファイルを限定し /keiba-streaming/ 配下でHTMLと全依存モジュールを配信', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'keiba-pages-test-'));
  await buildPages(output);
  assert.deepEqual((await readdir(output)).sort(), [...PAGE_FILES].sort());
  const server = http.createServer(async (req, res) => {
    try {
      const name = req.url.slice('/keiba-streaming/'.length) || 'index.html';
      if (!req.url.startsWith('/keiba-streaming/') || !PAGE_FILES.includes(name)) { res.writeHead(404).end(); return; }
      res.end(await readFile(path.join(output, name)));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/keiba-streaming/`;
  for (const name of PAGE_FILES) {
    const response = await fetch(base + name); assert.equal(response.status, 200, name);
    const content = await response.text();
    if (name.endsWith('.html')) {
      assert.doesNotMatch(content, /(?:src|href)="\//);
      for (const match of content.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) assert.equal((await fetch(new URL(match[1], base + name))).status, 200, match[1]);
    }
    if (name.endsWith('.js')) {
      assert.doesNotMatch(content, /from ['"]node:/);
      for (const match of content.matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
        assert.ok(match[1].startsWith('./'), match[1]);
        assert.equal((await fetch(new URL(match[1], base + name))).status, 200, match[1]);
      }
    }
  }
  assert.match(await readFile(path.join(output, 'transport.js'), 'utf8'), /BROWSER_MODE = true/);
  assert.doesNotMatch(await readFile(path.join(output, 'transport.js'), 'utf8'), /EventSource/);
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'self' https:\/\/keiba-streaming-jra-api\.iridescentpetal9\.chatgpt\.site;/);
});
test('Pages: 想定外のファイルが出力先に混入したら公開ビルドを停止', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'keiba-pages-leak-test-'));
  await writeFile(path.join(output, 'private-record.json'), '{}');
  await assert.rejects(buildPages(output), /想定外のファイル/);
  assert.equal(await readFile(path.join(output, 'private-record.json'), 'utf8'), '{}');
});
