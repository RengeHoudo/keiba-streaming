import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JRA_API_URL } from '../public/jra-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const PAGE_FILES = ['index.html', 'control.html', 'overlay.html', 'style.css', 'control.js', 'overlay.js', 'shared.js', 'transport.js', 'judgement.js', 'jra-control.js', 'jra-result-control.js', 'jra-result-data.js', 'jra-client.js', 'jra-config.js', 'domain.js', 'state.js', 'calendar-url.js', 'browser-store.js', 'export.js', 'demo.js', '.nojekyll'];
export async function buildPages(output = path.join(root, 'dist')) {
  await mkdir(output, { recursive: true });
  const unexpected = (await readdir(output)).filter(file => !PAGE_FILES.includes(file));
  if (unexpected.length) throw new Error('公開先フォルダーに想定外のファイルがあります。公開を中止します。');
  const files = {};
  for (const name of ['style.css', 'control.js', 'overlay.js', 'shared.js', 'judgement.js', 'jra-control.js', 'jra-result-control.js', 'jra-config.js']) files[name] = await readFile(path.join(root, 'public', name), 'utf8');
  files['transport.js'] = await readFile(path.join(root, 'public/browser-transport.js'), 'utf8');
  for (const name of ['domain.js', 'state.js', 'calendar-url.js', 'browser-store.js', 'export.js', 'demo.js', 'jra-client.js', 'jra-result-data.js']) files[name] = await readFile(path.join(root, 'src', name), 'utf8');
  const api = new URL(JRA_API_URL);
  if (api.protocol !== 'https:' || api.username || api.password || api.port || api.pathname !== '/api/jra/races' || api.search || api.hash) throw new Error('公開JRA APIのURLが不正です');
  const policy = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${api.origin}; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'`;
  for (const name of ['control.html', 'overlay.html']) {
    let html = await readFile(path.join(root, 'public', name), 'utf8');
    html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer">`)
      .replaceAll('href="/style.css"', 'href="./style.css"').replaceAll('src="/control.js"', 'src="./control.js"').replaceAll('src="/overlay.js"', 'src="./overlay.js"')
      .replaceAll('href="/api/export"', 'href="#"').replaceAll('href="/api/export.csv"', 'href="#"').replaceAll('href="/overlay"', 'href="./overlay.html"');
    files[name] = html;
  }
  files['index.html'] = files['control.html']; files['.nojekyll'] = '';
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(output, name), content);
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`GitHub Pages build: ${await buildPages()} (${PAGE_FILES.length} files; no local records or design files)`);
}
