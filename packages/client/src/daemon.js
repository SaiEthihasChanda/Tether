// tetherd: the per-user background daemon. Owns the local database, the network, the
// timer (DESIGN §6.1) and the folder watchers (DESIGN §5.2).
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { tetherHome, ipcEndpoint, files } from './paths.js';
import { Config } from './config.js';
import { LocalDb } from './db.js';
import { Credentials } from './credentials.js';
import { Api, BlobCache, ApiError } from './api.js';
import { createTracker } from './platform/tracker.js';
import { Engine, UserError } from './engine.js';
import { listen } from './ipc.js';
import { VERSION } from './version.js';
import { latestVersion, isNewer } from './update.js';
import { Notifier } from './notifier.js';
import { fileURLToPath } from 'node:url';

export { VERSION };
const REALTIME_TICK_SECONDS = 3; // check cadence while a live session is involved
const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000;

export async function runDaemon() {
  const home = tetherHome();
  fs.mkdirSync(home, { recursive: true });
  process.chdir(home); // don't keep the folder we were started from in use
  const f = files(home);
  const recent = [];
  const logStream = fs.createWriteStream(f.log, { flags: 'a' });
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    recent.push(line);
    if (recent.length > 500) recent.shift();
    logStream.write(line + '\n');
  };

  const config = new Config(f.config);
  const db = new LocalDb(f.db);
  const credentials = new Credentials(f.credentials);
  const api = new Api({ config, credentials });
  const cache = new BlobCache(f.blobs);
  const tracker = await createTracker(config);
  const notifier = new Notifier({ setting: () => config.get('notifications'), consoleUrl: () => config.consoleUrl, log });
  const engine = new Engine({
    db, api, cache, tracker, config, log, home,
    notify: (e) => notifier.notify(e),
    cliPath: fileURLToPath(new URL('../bin/tether.js', import.meta.url)),
  });

  // ---- timer ----
  let timer = null;
  let quickTimer = null;
  let realtimeTimer = null;
  let stopping = false;
  let latest = null; // newest tether-sync on npm, checked daily

  async function runTick(opts) {
    try {
      await engine.locked(() => engine.tick(opts));
    } catch (e) {
      log(`tick failed: ${e.stack || e.message}`);
      notifier.notify({ kind: 'error', level: 'error', key: 'tick-failed', cooldownMs: 3600 * 1000, title: 'Tether hit an error', body: `${e.message}. Run "tether log" for details.` });
    }
    refreshWatchers();
    scheduleGrace();
    schedule(); // the cadence depends on what this pass saw (realtime sessions)
  }

  function schedule() {
    clearTimeout(timer);
    if (stopping) return;
    const seconds = engine.realtimeActive ? Math.min(config.get('tickSeconds'), REALTIME_TICK_SECONDS) : config.get('tickSeconds');
    timer = setTimeout(() => runTick(), seconds * 1000);
  }

  /** Pushes live edits about a second after the last change (debounced). */
  function realtimePass(delay = 1000) {
    if (stopping || !engine.realtimeInstances().length) return;
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(async () => {
      realtimeTimer = null;
      try {
        await engine.locked(async () => {
          await engine.locateAll();
          await engine.syncRealtime();
        });
      } catch (e) {
        log(`realtime push failed: ${e.message}`);
      }
    }, delay);
  }

  let notifiedVersion = null;
  async function checkForUpdate() {
    latest = (await latestVersion()) ?? latest;
    if (isNewer(latest, VERSION) && notifiedVersion !== latest) {
      notifiedVersion = latest;
      notifier.notify({ kind: 'update', level: 'info', title: 'Tether update available', body: `Version ${latest} is available (you have ${VERSION}). Run "tether update".` });
    }
  }

  /** A quick local pass (no network) after watcher events and when a grace window ends. */
  function quickPass(delay) {
    if (quickTimer || stopping) return;
    quickTimer = setTimeout(async () => {
      quickTimer = null;
      try {
        await engine.locked(() => engine.locateAll());
      } catch (e) {
        log(`locate failed: ${e.message}`);
      }
      refreshWatchers();
      scheduleGrace();
    }, delay);
  }

  function scheduleGrace() {
    if (engine.graceDue) quickPass(Math.max(50, engine.graceDue - Date.now() + 50));
  }

  // ---- watchers: parent folders of files, and managed folders (recursive) ----
  const watchers = new Map();
  let gitTimer = null;
  /** git just did something in a repository with managed files: look once it settles. */
  function gitPassSoon() {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(async () => {
      gitTimer = null;
      try {
        await engine.locked(async () => {
          engine.busyCache = new Map();
          await engine.locateAll();
          await engine.gitPass();
          await engine.enforceLocal();
        });
      } catch (e) {
        log(`git pass failed: ${e.message}`);
      }
    }, 600);
  }
  function refreshWatchers() {
    const want = new Map();
    for (const i of db.all()) {
      if (i.mode === 'orphaned') continue;
      if (i.gitDir && !want.has(i.gitDir)) want.set(i.gitDir, 'git');
      if (i.detached) continue;
      if (i.kind === 'folder') want.set(i.path, true);
      else if (!i.folderInstanceId) want.set(path.dirname(i.path), false);
    }
    for (const [dir, w] of watchers) {
      if (!want.has(dir)) {
        w.close();
        watchers.delete(dir);
      }
    }
    for (const [dir, kind] of want) {
      if (watchers.has(dir)) continue;
      try {
        const w = kind === 'git'
          ? fs.watch(dir, { persistent: false }, () => gitPassSoon())
          : fs.watch(dir, { recursive: kind, persistent: false }, () => {
            quickPass(250);
            realtimePass();
          });
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {
        // folder gone; the next tick will notice
      }
    }
  }

  // ---- browser login (DESIGN §9: console page + localhost redirect with a state nonce) ----
  const logins = new Map();
  async function startLogin() {
    const state = crypto.randomBytes(16).toString('hex');
    let settle;
    const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
    const srv = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') return res.writeHead(404).end();
      if (u.searchParams.get('state') !== state) return res.writeHead(400).end('state mismatch');
      try {
        const user = await api.exchangeCliCode(u.searchParams.get('code'));
        res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Tether</title><body style="font-family:sans-serif;padding:2rem"><h2>Tether CLI signed in</h2><p>You can close this tab.</p>');
        settle.resolve(user);
      } catch (e) {
        res.writeHead(400).end(e.message);
        settle.reject(e);
      } finally {
        setTimeout(() => srv.close(), 100);
      }
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const timeout = setTimeout(() => {
      srv.close();
      settle.reject(new UserError('login timed out'));
    }, 5 * 60 * 1000);
    done.finally(() => clearTimeout(timeout)).catch(() => {});
    logins.set(state, done);
    return { state, url: `${config.consoleUrl.replace(/\/$/, '')}/cli-login?port=${port}&state=${state}` };
  }

  const L = (fn) => (params) => engine.locked(() => fn(params));
  const soon = () => setTimeout(() => runTick(), 10);

  const handlers = {
    ping: () => ({ pid: process.pid, version: VERSION, home, tracker: tracker.name, server: config.get('server') }),
    async status(p) {
      const creds = await credentials.load();
      return {
        user: creds?.user ?? null, server: config.get('server'), offline: engine.offline, lastTick: engine.lastTick,
        version: VERSION, latest, instances: await L((x) => engine.status(x))(p),
      };
    },
    sync: async () => {
      await runTick();
      return { offline: engine.offline };
    },
    async 'login.password'({ email, password, signup }) {
      const user = await api.passwordLogin({ email, password, signup });
      soon();
      return user;
    },
    'login.start': () => startLogin(),
    async 'login.wait'({ state }) {
      const p = logins.get(state);
      if (!p) throw new UserError('no login in progress');
      try {
        const user = await p;
        soon();
        return user;
      } finally {
        logins.delete(state);
      }
    },
    logout: async () => api.logout(),
    whoami: () => api.call('GET', '/me'),
    manage: L((p) => engine.manage(p)),
    add: L((p) => engine.add(p)),
    pull: L((p) => engine.pull(p)),
    edit: async (p) => {
      const r = await L((x) => engine.edit(x))(p);
      schedule(); // switch to the realtime cadence right away
      return r;
    },
    unmanage: L((p) => engine.unmanage(p)),
    'git.mode': L((p) => engine.gitMode(p)),
    // Called by git hooks: answer at once so git is not held up; reconcile in the background.
    'git.sync': ({ repo }) => {
      engine.locked(() => engine.gitReconcile(path.resolve(repo))).catch((e) => log(`git sync failed: ${e.message}`));
      return { queued: true };
    },
    plan: L((p) => engine.plan(p)),
    resolve: L((p) => engine.resolve(p)),
    diff: L((p) => engine.diff(p)),
    locate: L((p) => engine.locate(p)),
    async history({ ref }) {
      return api.call('GET', `/artifacts/${await engine.resolveArtifact(ref)}/history`);
    },
    async rollback({ ref, toVersion }) {
      const r = await api.call('POST', `/artifacts/${await engine.resolveArtifact(ref)}/rollback`, { toVersion });
      soon();
      return r;
    },
    async delete({ ref }) {
      const r = await api.call('POST', `/artifacts/${await engine.resolveArtifact(ref)}/delete`);
      soon();
      return r;
    },
    async share({ ref, op }) {
      const id = await engine.resolveArtifact(ref);
      return op ? api.call('POST', `/artifacts/${id}/share`, op) : api.call('GET', `/artifacts/${id}/sharing`);
    },
    async info({ ref }) {
      return api.call('GET', `/artifacts/${await engine.resolveArtifact(ref)}`);
    },
    'repo.create': ({ name }) => api.call('POST', '/repos', { name }),
    'repo.list': () => api.call('GET', '/repos'),
    'repo.show': async ({ ref }) => api.call('GET', `/repos/${(await engine.findRepo(ref)).repoId}`),
    'repo.delete': async ({ ref }) => {
      const r = await api.call('DELETE', `/repos/${(await engine.findRepo(ref)).repoId}`);
      soon();
      return r;
    },
    'repo.transfer': async ({ ref, to }) => api.call('POST', `/repos/${(await engine.findRepo(ref)).repoId}/transfer`, { to }),
    'repo.eol': async ({ ref, glob, mode }) => {
      const repo = await engine.findRepo(ref);
      const rules = { ...repo.eolDefaults };
      if (mode === 'unset') delete rules[glob];
      else rules[glob] = mode;
      return api.call('PATCH', `/repos/${repo.repoId}`, { eolDefaults: rules });
    },
    'config.get': ({ key }) => (key ? { [key]: config.get(key) } : config.values),
    'config.set': ({ key, value }) => {
      config.set(key, value);
      if (key === 'tickSeconds') schedule();
      return { [key]: config.get(key) };
    },
    log: ({ lines = 50 }) => recent.slice(-lines),
    shutdown: () => {
      setTimeout(() => shutdown(0), 50);
      return { stopping: true };
    },
  };

  // Commands that change what is managed: start watching new folders and repositories at once.
  const CHANGES_WATCHED = new Set(['manage', 'add', 'pull', 'edit', 'unmanage', 'git.mode', 'resolve', 'locate']);

  async function handle(method, params) {
    const h = handlers[method];
    if (!h) throw new UserError(`unknown command ${method}`);
    try {
      const result = await h(params);
      if (CHANGES_WATCHED.has(method)) refreshWatchers();
      return result;
    } catch (e) {
      if (e instanceof ApiError || e instanceof UserError) throw e;
      if (e.name === 'OfflineError') throw e;
      log(`${method} failed: ${e.stack || e.message}`);
      throw e;
    }
  }

  const server = await listen(ipcEndpoint(home), handle);
  fs.writeFileSync(f.pid, String(process.pid));
  log(`tetherd ${VERSION} started (pid ${process.pid}, tracker ${tracker.name}, server ${config.get('server')})`);

  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    clearTimeout(quickTimer);
    clearTimeout(realtimeTimer);
    clearInterval(updateTimer);
    clearInterval(repoTimer);
    clearTimeout(gitTimer);
    for (const w of watchers.values()) w.close();
    server.close();
    engine.locked(() => db.close()).finally(() => {
      fs.rmSync(f.pid, { force: true });
      log('tetherd stopped');
      logStream.end(() => process.exit(code));
    });
  }
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await engine.locked(() => {
    engine.cleanupLegacyHooks();
    engine.detectNewRepos();
  }).catch((e) => log(`git setup: ${e.message}`));
  const repoTimer = setInterval(() => engine.locked(() => engine.detectNewRepos()).catch(() => {}), 60 * 60 * 1000);
  const updateTimer = setInterval(checkForUpdate, UPDATE_CHECK_MS);
  setTimeout(checkForUpdate, 5000);
  await runTick();
}
