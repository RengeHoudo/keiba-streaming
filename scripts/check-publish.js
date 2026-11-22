import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { PAGE_FILES } from './build-pages.js';

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('公開予定ファイルがGitに登録されていません');
const forbidden = /(^|\/)(?:design|data|\.qa-data|node_modules|dist|\.git|\.aws|\.codex|\.agents|\.openai)(\/|$)|(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials|hosts\.yml)$|\.(?:pem|key|pfx|p12|log|zip)$/i;
const secretPatterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['API key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['AWS key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['assigned secret', /(?:api[_-]?key|client[_-]?secret|password|access[_-]?token)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+\/-]{16,}["']/i],
];
const failures = [];
function scan(name, content) { for (const [label, pattern] of secretPatterns) if (pattern.test(content)) failures.push(`${name}: ${label}`); }
for (const name of files) {
  if (forbidden.test(name) || name === 'test/fixtures/paste-example.txt') failures.push(`${name}: excluded local file`);
  const info = await lstat(name); if (!info.isFile() || info.isSymbolicLink()) { failures.push(`${name}: unsupported file type`); continue; }
  // Inspect exactly what Git will commit, not just the working copy.
  scan(name, execFileSync('git', ['show', `:${name}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
}
const output = await readdir('dist');
for (const name of output) {
  if (!PAGE_FILES.includes(name)) { failures.push(`dist/${name}: not in the publication allowlist`); continue; }
  if (!(await lstat(`dist/${name}`)).isFile()) { failures.push(`dist/${name}: unsupported file type`); continue; }
  scan(`dist/${name}`, await readFile(`dist/${name}`, 'utf8'));
}
if (output.length !== PAGE_FILES.length) failures.push('dist: missing publication files');
if (process.argv.includes('--with-jra-api')) scan('JRA API bundle', await readFile('.qa-data/jra-api-site/worker/index.js', 'utf8'));
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`公開前チェック: OK (${files.length} tracked files + ${output.length} Pages files). design・購入記録・認証情報のファイル除外、既知の秘密情報パターンを確認。`);
