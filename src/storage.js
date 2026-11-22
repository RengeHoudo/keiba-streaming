import { mkdir, readFile, open, rename, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { initialState, validateState } from './state.js';

export class Storage {
  constructor(directory) { this.directory = directory; this.file = path.join(directory, 'state.json'); this.backup = path.join(directory, 'state.backup.json'); }
  async load() {
    await mkdir(this.directory, { recursive: true });
    try { return validateState(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') {
        const state = initialState(); await this.save(state); return state;
      }
      // Do not silently reset real purchase records on a corrupt file.
      let backup;
      try { backup = validateState(JSON.parse(await readFile(this.backup, 'utf8'))); }
      catch { throw new Error(`保存データを読み込めません。${this.file} とバックアップを確認してください。元データは変更していません。`); }
      const corrupt = `${this.file}.corrupt-${Date.now()}`;
      await rename(this.file, corrupt);
      await this.save(backup);
      console.warn(`保存データの破損を検出。${corrupt} に保全し、前回のバックアップを復元しました。`);
      return backup;
    }
  }
  async save(state) {
    const tmp = `${this.file}.tmp`;
    const handle = await open(tmp, 'w');
    try { await handle.writeFile(JSON.stringify(state, null, 2), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try { await copyFile(this.file, `${this.backup}.tmp`); await rename(`${this.backup}.tmp`, this.backup); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(tmp, this.file);
  }
}
