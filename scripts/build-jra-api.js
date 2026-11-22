import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(new URL('../.qa-data/jra-api-site/worker/', import.meta.url), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['src/jra-worker.js'], outfile: '.qa-data/jra-api-site/worker/index.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: false, legalComments: 'none' });
console.log('JRA API Worker bundle generated (public code only).');
