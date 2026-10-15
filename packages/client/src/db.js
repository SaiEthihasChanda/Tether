// Local map of instances (DESIGN §5.1). Only the daemon opens this database.
import { DatabaseSync } from 'node:sqlite';

const COLUMNS = {
  instanceId: 'TEXT PRIMARY KEY',
  artifactId: 'TEXT NOT NULL',
  kind: "TEXT NOT NULL DEFAULT 'file'",
  folderInstanceId: 'TEXT',
  repoId: 'TEXT',
  name: 'TEXT',
  relPath: 'TEXT', // server layout path inside the folder, at baseVersion
  path: 'TEXT NOT NULL', // last known absolute path
  volumeId: 'TEXT',
  fileId: 'TEXT',
  mode: "TEXT NOT NULL DEFAULT 'normal'", // normal | editing | unmanaged | lost | orphaned
  prevMode: 'TEXT', // mode to return to after `tether locate`
  baseVersion: 'INTEGER NOT NULL DEFAULT 0',
  baseHash: 'TEXT', // canonical sha256 at baseVersion (= server blob)
  size: 'INTEGER', // on-disk size at the last sync, for the quick change check
  mtimeMs: 'REAL',
  eolMode: "TEXT DEFAULT 'auto'",
  eolStyle: 'TEXT', // line endings this copy uses: lf | crlf (null = platform default)
  hasBom: 'INTEGER DEFAULT 0',
  exec: 'INTEGER DEFAULT 0',
  role: 'TEXT',
  canDelete: 'INTEGER DEFAULT 0',
  remoteVersion: 'INTEGER', // latest server version seen (pending incoming if > baseVersion)
  missingSince: 'REAL', // start of the atomic-save grace window
  detached: 'INTEGER DEFAULT 0', // file in a folder that the user deleted; restored by `tether track`
  needsRestore: 'INTEGER DEFAULT 0', // write a fresh copy at the expected path on the next tick
  orphanReason: 'TEXT',
  realtime: 'INTEGER DEFAULT 0', // this client holds a realtime session and pushes every save
  remoteRealtime: 'TEXT', // JSON { email, since } when someone else edits this file in realtime
  gitMode: 'TEXT', // inside a git repo: keep (Tether reverts git's changes) | follow (git's changes are published)
  gitRoot: 'TEXT',
  gitDir: 'TEXT',
  gitHooks: 'TEXT',
  lastError: 'TEXT',
  createdAt: 'REAL',
  updatedAt: 'REAL',
};

const BOOL = new Set(['realtime', 'hasBom', 'exec', 'canDelete', 'detached', 'needsRestore']);

export class LocalDb {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const cols = Object.entries(COLUMNS).map(([k, t]) => `"${k}" ${t}`).join(', ');
    this.db.exec(`CREATE TABLE IF NOT EXISTS instances (${cols})`);
    const have = new Set(this.db.prepare('PRAGMA table_info(instances)').all().map((c) => c.name));
    for (const [k, t] of Object.entries(COLUMNS)) {
      if (!have.has(k)) this.db.exec(`ALTER TABLE instances ADD COLUMN "${k}" ${t.replace('PRIMARY KEY', '').replace('NOT NULL', '')}`);
    }
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    this.db.exec('CREATE INDEX IF NOT EXISTS instances_folder ON instances(folderInstanceId)');
  }

  row(r) {
    if (!r) return null;
    const o = { ...r };
    for (const k of BOOL) o[k] = !!o[k];
    return o;
  }

  get(instanceId) {
    return this.row(this.db.prepare('SELECT * FROM instances WHERE instanceId = ?').get(instanceId));
  }

  all() {
    return this.db.prepare('SELECT * FROM instances ORDER BY createdAt').all().map((r) => this.row(r));
  }

  childrenOf(folderInstanceId) {
    return this.db.prepare('SELECT * FROM instances WHERE folderInstanceId = ? ORDER BY relPath').all(folderInstanceId).map((r) => this.row(r));
  }

  insert(inst) {
    const now = Date.now();
    const o = { createdAt: now, updatedAt: now, ...inst };
    const keys = Object.keys(o).filter((k) => k in COLUMNS);
    this.db.prepare(`INSERT INTO instances (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => this.val(o[k])));
    return this.get(o.instanceId);
  }

  update(instanceId, patch) {
    const keys = Object.keys(patch).filter((k) => k in COLUMNS && k !== 'instanceId');
    if (!keys.length) return this.get(instanceId);
    keys.push('updatedAt');
    patch = { ...patch, updatedAt: Date.now() };
    this.db.prepare(`UPDATE instances SET ${keys.map((k) => `"${k}" = ?`).join(', ')} WHERE instanceId = ?`).run(...keys.map((k) => this.val(patch[k])), instanceId);
    return this.get(instanceId);
  }

  remove(instanceId) {
    this.db.prepare('DELETE FROM instances WHERE instanceId = ?').run(instanceId);
  }

  val(v) {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  }

  getMeta(key) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return r ? JSON.parse(r.value) : null;
  }

  setMeta(key, value) {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  close() {
    this.db.close();
  }
}
