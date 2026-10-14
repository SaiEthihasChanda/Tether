// The sync engine (DESIGN §5–§7). One tick = locate every instance, check the server in
// one batched call, then apply incoming versions and revert local drift in normal mode.
import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { canonicalize, sha256, resolveEol, newInstanceId, nameError, relPathError, caseCollisionError, isBinary } from '@tether/shared';
import { ApiError, OfflineError } from './api.js';
import {
  readLocal, writeLocal, styleOf, LockedError, keepBothName, moveFile, pruneEmptyDirs, walkFiles,
  samePath, isUnder, canonicalPath, statOrNull,
} from './fsops.js';

export class UserError extends Error {}

const ACTIVE = (i) => i.mode !== 'orphaned';

export class Engine {
  constructor({ db, api, cache, tracker, config, log = () => {} }) {
    this.db = db;
    this.api = api;
    this.cache = cache;
    this.tracker = tracker;
    this.config = config;
    this.log = log;
    this.offline = null;
    this.lastTick = null;
    this.graceDue = null; // timestamp when a pending atomic-save grace window expires
    this.queue = Promise.resolve();
  }

  /** Serializes everything that touches instances (ticks, watcher passes, commands). */
  locked(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---------- helpers ----------

  folderOf(inst) {
    return inst.folderInstanceId ? this.db.get(inst.folderInstanceId) : null;
  }

  expectedPath(child, folder = this.folderOf(child)) {
    return path.join(folder.path, ...child.relPath.split('/'));
  }

  /** Current relative path of a child inside its folder, or null if it was moved out. */
  localRel(child, folder = this.folderOf(child)) {
    if (!isUnder(child.path, folder.path) || samePath(child.path, folder.path)) return null;
    return path.relative(folder.path, child.path).split(path.sep).join('/');
  }

  identity(p) {
    const id = this.tracker.identify(p);
    if (!id) throw new Error(`cannot read the file ID of ${p}`);
    return id;
  }

  blobFor(sha) {
    if (!this.cache.has(sha)) throw new Error(`content ${sha.slice(0, 12)} is not in the local cache`);
    return this.cache.get(sha);
  }

  async ensureBlobs(pairs) {
    const missing = pairs.filter((p) => p.sha && !this.cache.has(p.sha));
    if (missing.length) await this.api.fetchBlobs(this.cache, missing.map(({ artifactId, version }) => ({ artifactId, version })));
  }

  /** Writes content for an instance at `p`; records the result for the quick change check. */
  writeInstance(inst, p, sha, eolMode = inst.eolMode, exec = inst.exec) {
    const style = inst.eolStyle ? { eol: inst.eolStyle, bom: !!inst.hasBom } : null;
    return writeLocal(p, this.blobFor(sha), eolMode, { exec, style });
  }

  // ---------- tick ----------

  async tick({ remote = true } = {}) {
    await this.locateAll();
    if (remote) await this.checkRemote();
    await this.enforceLocal();
    this.lastTick = Date.now();
  }

  /** Refresh path and file ID of every tracked instance (DESIGN §5). */
  async locateAll() {
    const graceMs = this.config.get('graceMs');
    const all = this.db.all().filter((i) => ACTIVE(i) && !i.detached && !i.needsRestore && i.fileId);
    all.sort((a, b) => (a.kind === 'folder' ? -1 : 0) - (b.kind === 'folder' ? -1 : 0));
    const hints = [...new Set(all.map((i) => path.dirname(i.path)))];
    const found = await this.tracker.findAll(all, hints);
    const now = Date.now();
    this.graceDue = null;
    for (const inst of all) {
      const cur = this.db.get(inst.instanceId);
      if (!cur || cur.mode === 'orphaned' || cur.detached) continue; // removed by a folder disappearing
      const r = found.get(inst.instanceId);
      if (r.status === 'found') {
        if (cur.mode === 'lost') {
          this.db.update(cur.instanceId, { mode: cur.prevMode || 'normal', prevMode: null, missingSince: null, path: r.path });
          this.log(`${r.path}: found again`);
          continue;
        }
        if (!samePath(r.path, cur.path) || r.path !== cur.path) {
          // Backup-rename atomic save (e.g. vim): original renamed aside in the same folder and a
          // new file written at the original path. Follow the path, not the old ID.
          const idAtOld = cur.kind === 'file' && path.dirname(r.path) === path.dirname(cur.path) && !samePath(r.path, cur.path) ? this.tracker.identify(cur.path) : null;
          if (idAtOld && idAtOld.fileId !== cur.fileId && statOrNull(cur.path)?.isFile()) {
            this.db.update(cur.instanceId, { ...idAtOld, missingSince: null });
            this.log(`${cur.path}: re-linked after an atomic save`);
          } else {
            this.db.update(cur.instanceId, { path: r.path, missingSince: null });
            if (!samePath(r.path, cur.path)) this.log(`${cur.path} -> ${r.path}: followed move`);
          }
        } else if (cur.missingSince) this.db.update(cur.instanceId, { missingSince: null });
        continue;
      }
      if (r.status === 'unavailable') {
        if (cur.mode !== 'lost') {
          this.db.update(cur.instanceId, { mode: 'lost', prevMode: cur.mode });
          this.log(`${cur.path}: volume unavailable, instance is lost`);
        }
        continue;
      }
      // gone: the ID no longer exists on the volume (or is in the trash).
      const st = statOrNull(cur.path);
      if (st && (cur.kind === 'folder' ? st.isDirectory() : st.isFile())) {
        // Atomic save: a new file at the same final path within the grace window.
        this.db.update(cur.instanceId, { ...this.identity(cur.path), missingSince: null });
        this.log(`${cur.path}: re-linked after an atomic save`);
        continue;
      }
      if (!cur.missingSince) {
        this.db.update(cur.instanceId, { missingSince: now });
        this.graceDue = Math.min(this.graceDue ?? Infinity, now + graceMs);
      } else if (now - cur.missingSince >= graceMs) {
        this.disappeared(cur);
      } else {
        this.graceDue = Math.min(this.graceDue ?? Infinity, cur.missingSince + graceMs);
      }
    }
  }

  /** The file is gone for good (after the grace window). DESIGN §7. */
  disappeared(inst) {
    if (inst.kind === 'folder') {
      for (const c of this.db.childrenOf(inst.instanceId)) this.db.remove(c.instanceId);
      this.db.remove(inst.instanceId);
      this.log(`${inst.path}: folder deleted locally; no longer managed here`);
      return;
    }
    if (inst.mode === 'editing') {
      this.db.update(inst.instanceId, { detached: true, missingSince: null });
      this.log(`${inst.path}: deleted while editing; resolve with \`tether done\``);
    } else if (inst.folderInstanceId) {
      this.db.update(inst.instanceId, { detached: true, mode: 'unmanaged', missingSince: null });
      this.log(`${inst.path}: deleted locally; stopped managing it (\`tether track\` restores it)`);
    } else {
      this.db.remove(inst.instanceId);
      this.log(`${inst.path}: deleted locally; forgotten (pull again to get it back)`);
    }
  }

  orphan(inst, reason) {
    const targets = inst.kind === 'folder' ? [inst, ...this.db.childrenOf(inst.instanceId)] : [inst];
    for (const t of targets) this.db.update(t.instanceId, { mode: 'orphaned', orphanReason: reason });
    this.log(`${inst.path}: ${reason === 'revoked' ? 'access revoked' : reason === 'deleted' ? 'deleted on the server' : 'removed from the server'}; file kept, no longer tracked`);
  }

  /** One batched call for all instances (DESIGN §6.1 step 2). */
  async checkRemote() {
    const insts = this.db.all().filter(ACTIVE);
    if (!insts.length) {
      this.offline = null;
      return;
    }
    let results;
    try {
      ({ results } = await this.api.call('POST', '/sync/check', { items: insts.map((i) => ({ artifactId: i.artifactId, version: i.baseVersion })) }));
      this.offline = null;
    } catch (e) {
      if (e instanceof OfflineError || (e instanceof ApiError && e.status === 401)) {
        this.offline = e.message;
        return;
      }
      throw e;
    }
    const incoming = [];
    const folders = [];
    insts.forEach((inst, idx) => {
      const r = results[idx];
      const cur = this.db.get(inst.instanceId);
      if (!cur || cur.mode === 'orphaned') return;
      if (r.status === 'gone') return this.orphan(cur, r.reason);
      if (r.folderDeleted || r.state?.deleted) return this.orphan(cur, 'deleted');
      const patch = { role: r.role, canDelete: r.canDelete, remoteVersion: r.version };
      if (cur.role && cur.role !== 'viewer' && r.role === 'viewer' && cur.mode === 'editing') {
        patch.mode = 'normal';
        this.log(`${cur.path}: you are now a viewer; editing ended and local changes will be reverted`);
      }
      const now = this.db.update(cur.instanceId, patch);
      if (r.status !== 'changed') return;
      if (now.mode !== 'normal') return; // editing: pending; unmanaged: ignored
      if (now.kind === 'folder') folders.push({ inst: now, state: r.state, children: r.children });
      else if (!now.detached) incoming.push({ inst: now, state: r.state });
    });

    const newChildren = [];
    for (const f of folders) {
      const have = new Set(this.db.childrenOf(f.inst.instanceId).map((c) => c.artifactId));
      for (const c of f.children) if (!c.deleted && !have.has(c.artifactId)) newChildren.push({ folder: f.inst, child: c });
    }
    try {
      await this.ensureBlobs([
        ...incoming.map(({ state }) => ({ artifactId: state.artifactId, version: state.version, sha: state.blob })),
        ...newChildren.map(({ child }) => ({ artifactId: child.artifactId, version: child.version, sha: child.blob })),
      ]);
    } catch (e) {
      if (e instanceof OfflineError) return (this.offline = e.message);
      throw e;
    }
    for (const { inst, state } of incoming) this.applyIncoming(inst, state);
    for (const { folder, child } of newChildren) {
      this.db.insert({
        instanceId: newInstanceId(), artifactId: child.artifactId, kind: 'file', folderInstanceId: folder.instanceId,
        repoId: child.repoId, name: child.name, relPath: child.relPath, path: path.join(folder.path, ...child.relPath.split('/')),
        mode: 'normal', baseVersion: child.version, baseHash: child.blob, eolMode: child.eol, exec: child.exec,
        role: folder.role, canDelete: folder.canDelete, needsRestore: true,
      });
      this.log(`${folder.path}: new file ${child.relPath}`);
    }
    for (const f of folders) this.db.update(f.inst.instanceId, { baseVersion: f.state.version });
  }

  /** Normal mode: write an incoming version (content and/or layout). */
  applyIncoming(inst, state) {
    try {
      let p = inst.path;
      if (inst.folderInstanceId && state.relPath !== inst.relPath) {
        const folder = this.folderOf(inst);
        const to = path.join(folder.path, ...state.relPath.split('/'));
        this.makeRoom(to, inst);
        moveFile(inst.path, to);
        pruneEmptyDirs(path.dirname(inst.path), folder.path);
        p = to;
        this.log(`${inst.path} -> ${to}: moved by the server`);
      }
      const patch = { path: p, relPath: state.relPath, baseVersion: state.version, baseHash: state.blob, eolMode: state.eol, exec: state.exec, lastError: null };
      if (state.blob !== inst.baseHash || !this.matchesBase(inst, p)) {
        Object.assign(patch, this.writeInstance(inst, p, state.blob, state.eol, state.exec));
        this.log(`${p}: updated to version ${state.version}`);
      }
      this.db.update(inst.instanceId, patch);
    } catch (e) {
      if (!(e instanceof LockedError)) throw e;
      this.db.update(inst.instanceId, { lastError: e.message });
    }
  }

  /** If `to` is occupied by something that isn't this instance, move it aside (keep both). */
  makeRoom(to, inst) {
    const st = statOrNull(to);
    if (!st) return;
    const id = this.tracker.identify(to);
    if (id && id.fileId === inst.fileId) return;
    const aside = keepBothName(to);
    fs.renameSync(to, aside);
    this.log(`${to}: existing file kept as ${path.basename(aside)}`);
  }

  matchesBase(inst, p) {
    const st = statOrNull(p);
    if (!st) return false;
    if (st.size === inst.size && st.mtimeMs === inst.mtimeMs) return true;
    const local = readLocal(p, inst.eolMode);
    return local?.hash === inst.baseHash;
  }

  /** Normal mode: restore missing files, put moved files back, revert local edits. */
  async enforceLocal() {
    const restores = this.db.all().filter((i) => ACTIVE(i) && i.needsRestore && i.mode === 'normal');
    try {
      await this.ensureBlobs(restores.map((i) => ({ artifactId: i.artifactId, version: i.baseVersion, sha: i.baseHash })));
    } catch (e) {
      if (!(e instanceof OfflineError)) throw e;
      this.offline = e.message;
    }
    for (const inst of this.db.all()) {
      if (inst.mode !== 'normal' || inst.kind !== 'file' || inst.detached) continue;
      try {
        if (inst.needsRestore) {
          if (this.cache.has(inst.baseHash)) this.restore(inst);
          continue;
        }
        let cur = inst;
        if (cur.folderInstanceId) cur = this.enforceLayout(cur);
        if (!cur) continue;
        const st = statOrNull(cur.path);
        if (!st) continue; // handled by locate's grace window
        if (st.size === cur.size && st.mtimeMs === cur.mtimeMs) continue;
        const local = readLocal(cur.path, cur.eolMode);
        if (!local) continue;
        if (local.hash === cur.baseHash) {
          this.db.update(cur.instanceId, { size: local.size, mtimeMs: local.mtimeMs, lastError: null });
          continue;
        }
        if (!this.cache.has(cur.baseHash)) continue; // offline and not cached yet
        this.db.update(cur.instanceId, { ...this.writeInstance(cur, cur.path, cur.baseHash), lastError: null });
        this.log(`${cur.path}: local change reverted (use \`tether edit\` to change it)`);
      } catch (e) {
        if (!(e instanceof LockedError)) throw e;
        this.db.update(inst.instanceId, { lastError: e.message });
      }
    }
  }

  /** Normal-mode layout inside a folder: moves inside are reverted; a file moved out is left
   *  where it is as an ordinary file and the folder gets a fresh copy. */
  enforceLayout(inst) {
    const folder = this.folderOf(inst);
    if (!folder || folder.mode === 'orphaned') return inst;
    const rel = this.localRel(inst, folder);
    const expected = this.expectedPath(inst, folder);
    if (rel === null) {
      this.log(`${inst.path}: moved out of ${folder.path}; left there unmanaged, restoring the folder copy`);
      const next = this.db.update(inst.instanceId, { path: expected, fileId: null, volumeId: null, needsRestore: true });
      if (this.cache.has(next.baseHash)) this.restore(next);
      return null;
    }
    if (rel === inst.relPath) return inst;
    this.makeRoom(expected, inst);
    moveFile(inst.path, expected);
    pruneEmptyDirs(path.dirname(inst.path), folder.path);
    this.log(`${inst.path}: move reverted to ${inst.relPath}`);
    return this.db.update(inst.instanceId, { path: expected });
  }

  /** Writes a fresh copy at the instance's expected path (new folder files, restores). */
  restore(inst) {
    const p = inst.folderInstanceId ? this.expectedPath(inst) : inst.path;
    const existing = readLocal(p, inst.eolMode);
    if (existing && existing.hash !== inst.baseHash) this.makeRoom(p, inst);
    const st = existing && existing.hash === inst.baseHash ? { size: existing.size, mtimeMs: existing.mtimeMs, ...styleOf(existing) } : this.writeInstance(inst, p, inst.baseHash);
    this.db.update(inst.instanceId, { ...st, ...this.identity(p), path: canonicalPath(p), needsRestore: false, detached: false, missingSince: null, lastError: null });
  }

  // ---------- commands ----------

  async findRepo(ref) {
    const repos = await this.api.call('GET', '/repos');
    const r = repos.find((x) => x.repoId === ref || x.name === ref);
    if (!r) throw new UserError(`no repo "${ref}" (create it with \`tether repo create ${ref}\`)`);
    return r;
  }

  instanceAt(p) {
    return this.db.all().find((i) => ACTIVE(i) && samePath(i.path, p));
  }

  checkOverlap(p) {
    for (const i of this.db.all().filter(ACTIVE)) {
      if (samePath(i.path, p)) throw new UserError(`${p} is already managed`);
      if (i.kind === 'folder' && isUnder(p, i.path)) throw new UserError(`${p} is inside the managed folder ${i.path}; use \`tether add\``);
      if (isUnder(i.path, p)) throw new UserError(`${p} contains the managed path ${i.path}`);
    }
  }

  prepareFile(abs, relForEol, rules, eol) {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) throw new UserError(`${abs} is a symlink; symlinks are not supported`);
    const bytes = fs.readFileSync(abs);
    const eolMode = resolveEol(relForEol, rules, eol);
    const canonical = canonicalize(bytes, eolMode).bytes;
    return { abs, bytes: canonical, sha256: sha256(canonical), size: canonical.length, eol: eolMode, exec: process.platform !== 'win32' && !!(st.mode & 0o111), stat: st };
  }

  /** `tether manage <path> --repo <repo>`: upload; the caller becomes the owner. */
  async manage({ path: target, repo: repoRef, eol }) {
    const abs = canonicalPath(path.resolve(target));
    const st = statOrNull(abs);
    if (!st) throw new UserError(`${abs} does not exist`);
    this.checkOverlap(abs);
    const repo = await this.findRepo(repoRef);
    const rules = repo.eolDefaults ?? {};
    const name = path.basename(abs);
    const nErr = nameError(name);
    if (nErr) throw new UserError(nErr);

    if (st.isFile()) {
      const f = this.prepareFile(abs, name, rules, eol);
      await this.api.uploadBlobs([f]);
      const r = await this.api.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name, blob: f.sha256, size: f.size, eol: f.eol, exec: f.exec });
      this.cache.put(f.sha256, f.bytes);
      const local = readLocal(abs, f.eol);
      this.db.insert({
        instanceId: newInstanceId(), artifactId: r.artifact.artifactId, kind: 'file', repoId: repo.repoId, name, path: abs,
        ...this.identity(abs), mode: 'normal', baseVersion: 1, baseHash: f.sha256, size: local.size, mtimeMs: local.mtimeMs, ...styleOf(local),
        eolMode: f.eol, exec: f.exec, role: 'owner', canDelete: true, remoteVersion: 1,
      });
      return { artifactId: r.artifact.artifactId, shareId: r.artifact.shareId, kind: 'file', path: abs, files: 1 };
    }

    const { files, symlinks } = walkFiles(abs);
    if (!files.length) throw new UserError(`${abs} has no files`);
    for (const f of files) {
      const e = relPathError(f.rel);
      if (e) throw new UserError(e);
    }
    const c = caseCollisionError(files.map((f) => f.rel));
    if (c) throw new UserError(c);
    const prepared = files.map((f) => ({ ...this.prepareFile(f.abs, f.rel, rules), rel: f.rel }));
    await this.api.uploadBlobs(prepared);
    const r = await this.api.call('POST', '/artifacts', {
      repoId: repo.repoId, kind: 'folder', name,
      files: prepared.map((f) => ({ relPath: f.rel, blob: f.sha256, size: f.size, eol: f.eol, exec: f.exec })),
    });
    const folderInst = this.db.insert({
      instanceId: newInstanceId(), artifactId: r.artifact.artifactId, kind: 'folder', repoId: repo.repoId, name, path: abs,
      ...this.identity(abs), mode: 'normal', baseVersion: 1, role: 'owner', canDelete: true, remoteVersion: 1,
    });
    const byRel = new Map(r.children.map((ch) => [ch.relPath, ch]));
    for (const f of prepared) {
      this.cache.put(f.sha256, f.bytes);
      const ch = byRel.get(f.rel);
      const local = readLocal(f.abs, f.eol);
      this.db.insert({
        instanceId: newInstanceId(), artifactId: ch.artifactId, kind: 'file', folderInstanceId: folderInst.instanceId, repoId: repo.repoId,
        name: ch.name, relPath: f.rel, path: canonicalPath(f.abs), ...this.identity(f.abs), mode: 'normal', baseVersion: 1, baseHash: f.sha256,
        size: local.size, mtimeMs: local.mtimeMs, ...styleOf(local), eolMode: f.eol, exec: f.exec, role: 'owner', canDelete: true, remoteVersion: 1,
      });
    }
    return { artifactId: r.artifact.artifactId, shareId: r.artifact.shareId, kind: 'folder', path: abs, files: files.length, skippedSymlinks: symlinks };
  }

  /** `tether add <path>`: owner adds a new file inside a managed folder. */
  async add({ path: target }) {
    const abs = canonicalPath(path.resolve(target));
    if (!statOrNull(abs)?.isFile()) throw new UserError(`${abs} is not a file`);
    if (this.instanceAt(abs)) throw new UserError(`${abs} is already managed`);
    const folder = this.db.all().find((i) => ACTIVE(i) && i.kind === 'folder' && isUnder(abs, i.path));
    if (!folder) throw new UserError(`${abs} is not inside a managed folder`);
    if (folder.role !== 'owner') throw new UserError('only the owner can add files to a folder');
    const rel = path.relative(folder.path, abs).split(path.sep).join('/');
    const e = relPathError(rel);
    if (e) throw new UserError(e);
    const repo = (await this.api.call('GET', '/repos')).find((r) => r.repoId === folder.repoId);
    const f = this.prepareFile(abs, rel, repo?.eolDefaults ?? {});
    await this.api.uploadBlobs([f]);
    const child = await this.api.call('POST', `/artifacts/${folder.artifactId}/children`, { relPath: rel, blob: f.sha256, size: f.size, eol: f.eol, exec: f.exec });
    this.cache.put(f.sha256, f.bytes);
    const local = readLocal(abs, f.eol);
    this.db.insert({
      instanceId: newInstanceId(), artifactId: child.artifactId, kind: 'file', folderInstanceId: folder.instanceId, repoId: folder.repoId,
      name: child.name, relPath: rel, path: abs, ...this.identity(abs), mode: 'normal', baseVersion: 1, baseHash: f.sha256,
      size: local.size, mtimeMs: local.mtimeMs, ...styleOf(local), eolMode: f.eol, exec: f.exec, role: 'owner', canDelete: true, remoteVersion: 1,
    });
    return { artifactId: child.artifactId, relPath: rel, folder: folder.path };
  }

  /** `tether pull <shareId> [dest]`. Never overwrites existing user files. */
  async pull({ shareId, dest, cwd }) {
    const r = await this.api.call('POST', '/pull', { shareId });
    const a = r.artifact;
    let target = path.resolve(cwd, dest ?? a.name);
    if (dest && statOrNull(target)?.isDirectory() && a.kind === 'file') target = path.join(target, a.name);
    if (this.instanceAt(target)) throw new UserError(`${target} is already a managed copy`);
    const base = { repoId: a.repoId, role: r.role, canDelete: r.canDelete };

    if (a.kind === 'file') {
      await this.ensureBlobs([{ artifactId: a.artifactId, version: a.version, sha: a.blob }]);
      const existing = readLocal(target, a.eol);
      if (existing && existing.hash !== a.blob) throw new UserError(`${target} already exists with different content; choose another destination`);
      const st = existing ? { size: existing.size, mtimeMs: existing.mtimeMs, ...styleOf(existing) } : writeLocal(target, this.blobFor(a.blob), a.eol, { exec: a.exec });
      this.db.insert({
        ...base, instanceId: newInstanceId(), artifactId: a.artifactId, kind: 'file', name: a.name, path: canonicalPath(target),
        ...this.identity(target), mode: 'normal', baseVersion: a.version, baseHash: a.blob, ...st, eolMode: a.eol, exec: a.exec, remoteVersion: a.version,
      });
      return { kind: 'file', path: canonicalPath(target), role: r.role, version: a.version };
    }

    const st = statOrNull(target);
    if (st && !st.isDirectory()) throw new UserError(`${target} exists and is not a folder`);
    await this.ensureBlobs(r.children.map((c) => ({ artifactId: c.artifactId, version: c.version, sha: c.blob })));
    const clashes = [];
    for (const c of r.children) {
      const p = path.join(target, ...c.relPath.split('/'));
      const ex = readLocal(p, c.eol);
      if (ex && ex.hash !== c.blob) clashes.push(c.relPath);
    }
    if (clashes.length) throw new UserError(`${target} already has different files: ${clashes.join(', ')}; choose another destination`);
    fs.mkdirSync(target, { recursive: true });
    const folderInst = this.db.insert({
      ...base, instanceId: newInstanceId(), artifactId: a.artifactId, kind: 'folder', name: a.name, path: canonicalPath(target),
      ...this.identity(target), mode: 'normal', baseVersion: a.version, remoteVersion: a.version,
    });
    for (const c of r.children) {
      const p = path.join(folderInst.path, ...c.relPath.split('/'));
      const ex = readLocal(p, c.eol);
      const cst = ex ? { size: ex.size, mtimeMs: ex.mtimeMs, ...styleOf(ex) } : writeLocal(p, this.blobFor(c.blob), c.eol, { exec: c.exec });
      this.db.insert({
        ...base, instanceId: newInstanceId(), artifactId: c.artifactId, kind: 'file', folderInstanceId: folderInst.instanceId, name: c.name,
        relPath: c.relPath, path: canonicalPath(p), ...this.identity(p), mode: 'normal', baseVersion: c.version, baseHash: c.blob, ...cst,
        eolMode: c.eol, exec: c.exec, remoteVersion: c.version,
      });
    }
    return { kind: 'folder', path: folderInst.path, role: r.role, files: r.children.length, version: a.version };
  }

  /** Instances addressed by a path: a file, a managed folder (with its files), or any directory. */
  targets(p) {
    const abs = canonicalPath(path.resolve(p));
    const all = this.db.all().filter(ACTIVE);
    let hits = all.filter((i) => samePath(i.path, abs) || isUnder(i.path, abs));
    for (const f of hits.filter((i) => i.kind === 'folder')) hits.push(...this.db.childrenOf(f.instanceId).filter(ACTIVE));
    // A deleted (detached) file is addressed by its old path.
    hits = [...new Map(hits.map((i) => [i.instanceId, i])).values()];
    if (!hits.length) throw new UserError(`nothing managed at ${abs}`);
    return hits;
  }

  setMode(p, mode, from) {
    const changed = [];
    for (const i of this.targets(p)) {
      if (!from.includes(i.mode)) continue;
      this.db.update(i.instanceId, { mode, ...(mode === 'editing' ? {} : {}) });
      changed.push(i.path);
    }
    return changed;
  }

  edit({ path: p }) {
    const ts = this.targets(p);
    const unmanaged = ts.filter((i) => i.mode === 'unmanaged' && !i.detached);
    if (unmanaged.length === ts.length) throw new UserError('these files are unmanaged; use `tether track` first');
    return { changed: this.setMode(p, 'editing', ['normal']) };
  }

  unmanage({ path: p }) {
    return { changed: this.setMode(p, 'unmanaged', ['normal', 'editing']) };
  }

  /**
   * Plans `tether done` (editing -> normal) or `tether track` (unmanaged -> normal).
   * Returns items needing a decision (options) or with an automatic action (auto).
   */
  async plan({ path: p, from }) {
    await this.locateAll();
    const ts = this.targets(p).filter((i) => i.mode === from || (from === 'unmanaged' && i.mode === 'normal' && i.kind === 'folder'));
    if (!ts.length) throw new UserError(from === 'editing' ? 'nothing here is in editing mode' : 'nothing here is unmanaged');
    const files = ts.filter((i) => i.kind === 'file');
    const { results } = files.length ? await this.api.call('POST', '/sync/check', { items: files.map((i) => ({ artifactId: i.artifactId, version: i.baseVersion })) }) : { results: [] };
    const items = [];
    files.forEach((inst, idx) => {
      const r = results[idx];
      const item = { instanceId: inst.instanceId, path: inst.path, relPath: inst.relPath, folder: inst.folderInstanceId ? this.folderOf(inst).path : null };
      if (r.status === 'gone' || r.state?.deleted || r.folderDeleted) {
        items.push({ ...item, auto: 'orphan', reason: r.reason ?? 'deleted' });
        return;
      }
      const role = r.role;
      const canPush = role === 'owner' || role === 'editor';
      const incoming = r.status === 'changed';
      item.serverVersion = r.version;
      item.incoming = incoming;
      item.role = role;
      if (inst.detached) {
        if (from === 'unmanaged') items.push({ ...item, change: 'missing', auto: 'restore' });
        else if (canPush && r.canDelete) items.push({ ...item, change: 'deleted', options: ['delete', 'stop'] });
        else items.push({ ...item, change: 'deleted', auto: 'stop' });
        return;
      }
      const folder = this.folderOf(inst);
      const rel = folder ? this.localRel(inst, folder) : undefined;
      if (folder && rel === null) {
        if (canPush && r.canDelete) items.push({ ...item, change: 'moved-out', options: ['delete', 'stop'] });
        else if (canPush) items.push({ ...item, change: 'moved-out', auto: 'stop' });
        else items.push({ ...item, change: 'moved-out', options: ['accept', 'keep-both', 'cancel'] });
        return;
      }
      const local = readLocal(inst.path, inst.eolMode);
      const contentChanged = !!local && local.hash !== inst.baseHash;
      const moved = folder ? rel !== inst.relPath : false;
      const changes = [contentChanged && 'content', moved && `moved to ${rel}`].filter(Boolean);
      if (!changes.length) {
        items.push({ ...item, auto: incoming ? 'accept' : 'clean' });
        return;
      }
      item.change = changes.join(', ');
      if (local && r.state && local.hash === r.state.blob && (!folder || rel === r.state.relPath)) {
        items.push({ ...item, auto: 'adopt', state: r.state }); // already identical to the server
      } else if (!canPush) {
        items.push({ ...item, options: ['accept', 'keep-both', 'diff', 'cancel'] });
      } else if (!incoming && from === 'editing') {
        items.push({ ...item, auto: 'push' });
      } else {
        items.push({ ...item, conflict: incoming, options: ['push', 'accept', 'keep-both', 'diff', 'cancel'] });
      }
    });
    return { from, items };
  }

  /** Applies a plan with the user's choices: { instanceId: option }. */
  async resolve({ path: p, from, items, choices = {} }) {
    const out = [];
    for (const item of items) {
      const choice = item.auto ?? choices[item.instanceId];
      if (!choice) throw new UserError(`no choice for ${item.path}`);
      const inst = this.db.get(item.instanceId);
      if (!inst) continue;
      try {
        out.push({ path: item.path, action: choice, ...(await this.applyChoice(inst, item, choice)) });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          out.push({ path: item.path, action: choice, error: 'the server changed again; run the command again to resolve' });
        } else if (e instanceof ApiError || e instanceof LockedError || e instanceof UserError) {
          out.push({ path: item.path, action: choice, error: e.message });
        } else throw e;
      }
    }
    // Folders leave the mode once none of their files are left in it.
    for (const f of this.targets(p).filter((i) => i.kind === 'folder' && i.mode === from)) {
      if (!this.db.childrenOf(f.instanceId).some((c) => c.mode === from && !c.detached)) this.db.update(f.instanceId, { mode: 'normal' });
    }
    await this.tick();
    return { results: out };
  }

  async applyChoice(inst, item, choice) {
    const folder = this.folderOf(inst);
    switch (choice) {
      case 'clean':
        this.db.update(inst.instanceId, { mode: 'normal' });
        return {};
      case 'orphan':
        this.orphan(inst, item.reason);
        return {};
      case 'adopt':
        this.db.update(inst.instanceId, { mode: 'normal', baseVersion: item.state.version, baseHash: item.state.blob, relPath: item.state.relPath ?? inst.relPath, size: null, mtimeMs: null });
        return {};
      case 'restore':
        this.db.update(inst.instanceId, { mode: 'normal', detached: false, needsRestore: true });
        return {};
      case 'cancel':
        return { kept: inst.mode };
      case 'accept': {
        if (folder && item.change === 'moved-out') {
          const to = this.expectedPath(inst, folder);
          this.makeRoom(to, inst);
          moveFile(inst.path, to);
          this.db.update(inst.instanceId, { path: to, mode: 'normal' });
          return {};
        }
        // Make the next tick overwrite local content and layout with the server's version.
        this.db.update(inst.instanceId, { mode: 'normal', size: null, mtimeMs: null });
        return {};
      }
      case 'keep-both': {
        if (folder && item.change === 'moved-out') {
          this.db.update(inst.instanceId, { mode: 'normal', path: this.expectedPath(inst, folder), fileId: null, volumeId: null, needsRestore: true });
          return { keptAs: inst.path };
        }
        const copy = keepBothName(inst.path);
        fs.copyFileSync(inst.path, copy);
        this.db.update(inst.instanceId, { mode: 'normal', size: null, mtimeMs: null });
        return { keptAs: copy };
      }
      case 'push': {
        const local = readLocal(inst.path, inst.eolMode);
        const change = {};
        if (local && local.hash !== inst.baseHash) {
          await this.api.uploadBlobs([{ sha256: local.hash, bytes: local.canonical }]);
          this.cache.put(local.hash, local.canonical);
          Object.assign(change, { blob: local.hash, size: local.canonical.length });
        }
        if (folder) {
          const rel = this.localRel(inst, folder);
          if (rel && rel !== inst.relPath) change.relPath = rel;
        }
        const baseVersion = item.incoming ? item.serverVersion : inst.baseVersion;
        const r = await this.api.call('POST', `/artifacts/${inst.artifactId}/commit`, { baseVersion, change });
        const state = r.state;
        this.db.update(inst.instanceId, {
          mode: 'normal', baseVersion: r.version, remoteVersion: r.version, baseHash: state?.blob ?? inst.baseHash,
          relPath: state?.relPath ?? inst.relPath, size: local?.size ?? null, mtimeMs: local?.mtimeMs ?? null, ...(local ? styleOf(local) : {}),
        });
        return { version: r.version };
      }
      case 'delete': {
        await this.api.call('POST', `/artifacts/${inst.artifactId}/commit`, { baseVersion: item.serverVersion, change: { deleted: true } });
        this.db.remove(inst.instanceId);
        return { deletedForEveryone: true };
      }
      case 'stop': {
        if (item.change === 'moved-out') {
          this.db.update(inst.instanceId, { mode: 'normal', path: this.expectedPath(inst, folder), fileId: null, volumeId: null, needsRestore: true });
          return { released: inst.path };
        }
        if (folder) this.db.update(inst.instanceId, { mode: 'unmanaged', detached: true });
        else this.db.remove(inst.instanceId);
        return {};
      }
      default:
        throw new UserError(`unknown choice "${choice}"`);
    }
  }

  /** Unified diff between the server's current version and the local file. */
  async diff({ path: p, instanceId }) {
    const inst = instanceId ? this.db.get(instanceId) : this.targets(p).find((i) => i.kind === 'file' && samePath(i.path, canonicalPath(path.resolve(p))));
    if (!inst || inst.kind !== 'file') throw new UserError('diff needs a managed file');
    const { artifact } = await this.api.call('GET', `/artifacts/${inst.artifactId}`);
    if (artifact.deleted) throw new UserError('the artifact has been deleted on the server');
    await this.ensureBlobs([{ artifactId: inst.artifactId, version: artifact.version, sha: artifact.blob }]);
    const server = this.cache.get(artifact.blob);
    const local = inst.detached ? null : readLocal(inst.path, inst.eolMode);
    const label = path.basename(inst.path);
    if (isBinary(server) || (local && isBinary(local.canonical))) {
      return { text: local?.hash === artifact.blob ? '' : `Binary files differ (server v${artifact.version} vs local)\n` };
    }
    return {
      text: createTwoFilesPatch(`${label} (server v${artifact.version})`, `${label} (local)`, server.toString('utf8'), local ? local.canonical.toString('utf8') : '', '', '', { context: 3 }),
      serverVersion: artifact.version,
    };
  }

  status({ path: p } = {}) {
    let list = this.db.all();
    if (p) list = this.targets(p).concat(list.filter((i) => i.mode === 'orphaned' && isUnder(i.path, canonicalPath(path.resolve(p)))));
    return list.map((i) => {
      const flags = [];
      if (i.remoteVersion && i.remoteVersion > i.baseVersion && i.kind === 'file') flags.push(`incoming v${i.remoteVersion}`);
      if (i.detached) flags.push('deleted locally');
      if (i.needsRestore) flags.push('restoring');
      if (i.missingSince) flags.push('missing');
      if (i.lastError) flags.push(i.lastError);
      if (i.kind === 'file' && ['editing', 'unmanaged'].includes(i.mode) && !i.detached) {
        try {
          const local = readLocal(i.path, i.eolMode);
          if (local && local.hash !== i.baseHash) flags.push('modified');
        } catch {
          flags.push('locked');
        }
      }
      if (i.orphanReason) flags.push(i.orphanReason);
      return {
        instanceId: i.instanceId, artifactId: i.artifactId, kind: i.kind, path: i.path, relPath: i.relPath, mode: i.mode, role: i.role,
        version: i.baseVersion, folderInstanceId: i.folderInstanceId, flags,
      };
    });
  }

  /** `tether locate`: re-link a lost instance by explicit path, or search folders by content. */
  async locate({ instanceId, dirs = [], file }) {
    const inst = this.db.get(instanceId) ?? this.db.all().find((i) => i.instanceId.startsWith(instanceId));
    if (!inst) throw new UserError(`no instance ${instanceId}`);
    if (file) {
      const abs = canonicalPath(path.resolve(file));
      const st = statOrNull(abs);
      if (!st || (inst.kind === 'folder') !== st.isDirectory()) throw new UserError(`${abs} is not a ${inst.kind}`);
      this.db.update(inst.instanceId, { path: abs, ...this.identity(abs), mode: inst.mode === 'lost' ? inst.prevMode || 'normal' : inst.mode, prevMode: null, missingSince: null, detached: false });
      return { linked: abs };
    }
    if (inst.kind !== 'file') throw new UserError('pass the folder with --file');
    const candidates = [];
    for (const dir of dirs) {
      if (!statOrNull(dir)?.isDirectory()) continue;
      for (const f of walkFiles(path.resolve(dir)).files) {
        try {
          if (readLocal(f.abs, inst.eolMode)?.hash === inst.baseHash) candidates.push(f.abs);
        } catch {
          // unreadable file
        }
        if (candidates.length >= 20) break;
      }
    }
    return { candidates };
  }

  async resolveArtifact(ref) {
    if (/^a_/.test(ref)) return ref;
    const abs = canonicalPath(path.resolve(ref));
    // Orphaned copies count too, so an owner can still roll back a deleted file by its path.
    const inst = this.instanceAt(abs) ?? this.db.all().find((i) => samePath(i.path, abs));
    if (inst) return inst.artifactId;
    throw new UserError(`"${ref}" is not a managed path or an artifact ID`);
  }
}
