// A simulated client machine: its own state directory, daemon, and working folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ipcEndpoint } from '../../packages/client/src/paths.js';
import { call } from '../../packages/client/src/ipc.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(root, 'packages/client/bin/tether.js');
const DAEMON = path.join(root, 'packages/client/bin/tetherd.js');

export class Machine {
  constructor(serverUrl, name, { tickSeconds = 3600, graceMs = 300, tracker } = {}) {
    this.name = name;
    this.home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `tether-${name}-home-`)));
    this.dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `tether-${name}-work-`)));
    // Notifications go to a file in tests instead of popping up on the desktop.
    this.env = { ...process.env, TETHER_HOME: this.home, TETHER_SERVER: serverUrl, TETHER_NOTIFY_LOG: path.join(this.home, 'notify.log'), TETHER_MIN_TICK_SECONDS: '1' };
    if (tracker) this.env.TETHER_TRACKER = tracker;
    fs.writeFileSync(path.join(this.home, 'config.json'), JSON.stringify({ server: serverUrl, tickSeconds, graceMs, scanRoots: [this.dir] }));
  }

  async start() {
    this.proc = spawn(process.execPath, [DAEMON], { env: this.env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => (this.stderr += d));
    for (let i = 0; i < 100; i++) {
      try {
        await this.ipc('ping');
        return this;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error(`daemon ${this.name} did not start: ${this.stderr}`);
  }

  ipc(method, params) {
    return call(ipcEndpoint(this.home), method, params);
  }

  /** Runs the CLI; resolves { code, stdout, stderr }. Throws on failure unless allowFail. */
  run(args, { allowFail = false, cwd = this.dir, input } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [CLI, ...args], { env: this.env, cwd, timeout: 60000 }, (err, stdout, stderr) => {
        const r = { code: err ? (err.code ?? 1) : 0, stdout, stderr };
        if (r.code !== 0 && !allowFail) reject(new Error(`tether ${args.join(' ')} failed (${r.code}):\n${stderr}${stdout}`));
        else resolve(r);
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  p(...parts) {
    return path.join(this.dir, ...parts);
  }

  write(rel, text) {
    fs.mkdirSync(path.dirname(this.p(rel)), { recursive: true });
    fs.writeFileSync(this.p(rel), text);
  }

  read(rel) {
    return fs.readFileSync(this.p(rel), 'utf8');
  }

  exists(rel) {
    return fs.existsSync(this.p(rel));
  }

  async sync() {
    await this.run(['sync']);
  }

  async status(p) {
    return JSON.parse((await this.run(['status', '--json', ...(p ? [p] : [])])).stdout);
  }

  /** Notifications shown so far: [{ title, body, url, level }]. */
  notifications() {
    try {
      return fs.readFileSync(path.join(this.home, 'notify.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async log() {
    return (await this.ipc('log', { lines: 500 })).join('\n');
  }

  async stop() {
    try {
      await this.ipc('shutdown');
    } catch {
      // already stopped
    }
    await new Promise((r) => {
      if (this.proc.exitCode !== null) return r();
      this.proc.on('exit', r);
      setTimeout(() => {
        this.proc.kill();
        r();
      }, 3000);
    });
    // A daemon started by the CLI is not our child process: wait until it stops answering.
    for (let i = 0; i < 50; i++) {
      try {
        await call(ipcEndpoint(this.home), 'ping', {}, 500);
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    for (const d of [this.home, this.dir]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns truthy (or throws on timeout). */
export async function eventually(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${message}${last ? `: ${last.message}` : ''}`);
    await sleep(interval);
  }
}
