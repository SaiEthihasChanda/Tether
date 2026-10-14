import fs from 'node:fs';
import os from 'node:os';

export const DEFAULTS = {
  server: 'http://127.0.0.1:8787',
  consoleUrl: '', // defaults to the server URL
  tickSeconds: 30,
  graceMs: 2000,
  scanRoots: [os.homedir()],
};

const NUMERIC = new Set(['tickSeconds', 'graceMs']);

export class Config {
  constructor(file) {
    this.file = file;
    this.values = { ...DEFAULTS };
    try {
      Object.assign(this.values, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // first run: defaults
    }
    if (process.env.TETHER_SERVER) this.values.server = process.env.TETHER_SERVER;
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`unknown config key "${key}" (known: ${Object.keys(DEFAULTS).join(', ')})`);
    if (NUMERIC.has(key)) {
      value = Number(value);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive number`);
    }
    if (key === 'scanRoots' && typeof value === 'string') value = value.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    this.values[key] = value;
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2));
  }

  get consoleUrl() {
    return this.values.consoleUrl || this.values.server;
  }
}
