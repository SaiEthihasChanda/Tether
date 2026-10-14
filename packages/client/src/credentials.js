// Refresh-token storage. Windows: encrypted for the current user with DPAPI.
// Linux: a file only the user can read (Secret Service integration is a later addition).
import fs from 'node:fs';
import { isWindows } from './paths.js';

export class Credentials {
  constructor(file) {
    this.file = file;
  }

  async load() {
    try {
      const raw = fs.readFileSync(this.file);
      const json = isWindows ? (await import('./platform/win32.js')).unprotect(raw).toString() : raw.toString();
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  async save(creds) {
    const json = Buffer.from(JSON.stringify(creds));
    const data = isWindows ? (await import('./platform/win32.js')).protect(json) : json;
    fs.writeFileSync(this.file, data, { mode: 0o600 });
  }

  clear() {
    fs.rmSync(this.file, { force: true });
  }
}
