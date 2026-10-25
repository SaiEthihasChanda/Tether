// The sync engine (DESIGN §5–§7). One tick = locate every instance, check the server in
// one batched call, then apply incoming versions and revert local drift in normal mode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import { canonicalize, sha256, resolveEol, newInstanceId, nameError, relPathError, caseCollisionError, isBinary } from '@tether/shared';
import { ApiError, OfflineError, describeTransfer } from './api.js';
import { findRepo, gitBusy, removeHooks, GIT_MODES, gitBinary, head, changeFromGit, changesBetween, setKeep, isKept, restage, isAncestor, isTracked, fileBlob, blobAt, indexBlob } from './git.js';
import {
  readLocal, writeLocal, styleOf, LockedError, keepBothName, moveFile, pruneEmptyDirs, walkFiles,
  samePath, isUnder, canonicalPath, statOrNull,
} from './fsops.js';

export class UserError extends Error {}

const ACTIVE = (i) => i.mode !== 'orphaned';
const REPORT_EVERY_MS = 24 * 60 * 60 * 1000; // copies are reported on change, and at least this often
const FULL_CHECK_MS = 60 * 60 * 1000; // a full check at least this often, even when the change cursor says nothing moved

export class Engine {
  constructor({ db, api, cache, tracker, config, log = () => {}, notify = () => {}, home = null, cliPath = null }) {
    this.db = db;
    this.api = api;
    this.cache = cache;
    this.tracker = tracker;
    this.config = config;
    this.log = log;
    this.notify = notify;
    this.home = home;
    this.cliPath = cliPath;
    this.gitState = new Map(); // gitDir -> busy reason seen on the last pass
    this.busyCache = null;
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

  /** Downloads content not yet cached; `base` (content already here) lets only changed chunks travel. */
  async ensureBlobs(pairs) {
    const missing = pairs.filter((p) => p.sha && !this.cache.has(p.sha));
    if (missing.length) await this.api.fetchBlobs(this.cache, missing);
  }

  /** Uploads content (only chunks the server lacks) and returns the commit fields for it. */
  async uploadContent(local, artifactId) {
    await this.api.uploadBlobs([{ sha256: local.hash, bytes: local.canonical }], { artifactId });
    this.cache.put(local.hash, local.canonical);
    return { blob: local.hash, size: local.canonical.length, chunks: this.api.manifestFor(local.hash) };
  }

  /** ", sent 2 of 540 chunks, 17 KB" for log lines (empty when nothing is known). */
  sentNote(sha) {
    const t = describeTransfer(this.api.transfers.get(sha), 'sent');
    return t ? `; ${t}` : '';
  }

  /** Writes content for an instance at `p`; records the result for the quick change check. */
  writeInstance(inst, p, sha, eolMode = inst.eolMode, exec = inst.exec) {
    const style = inst.eolStyle ? { eol: inst.eolStyle, bom: !!inst.hasBom } : null;
    const st = writeLocal(p, this.blobFor(sha), eolMode, { exec, style });
    if (inst.gitMode === 'keep' && inst.gitRoot) {
      restage(inst.gitRoot, p); // keep git's view clean (see setKeep)
      const after = statOrNull(p);
      if (after) Object.assign(st, { size: after.size, mtimeMs: after.mtimeMs });
    }
    return st;
  }

  // ---------- tick ----------

  async tick({ remote = true } = {}) {
    this.busyCache = new Map();
    await this.locateAll();
    await this.gitPass();
    if (remote) {
      await this.checkRemote();
      await this.syncRealtime();
      await this.reportInstances();
    }
    await this.enforceLocal();
    this.lastTick = Date.now();
  }

  // ---------- git integration ----------

  isGitBusy(inst) {
    if (!inst.gitDir) return false;
    this.busyCache ??= new Map();
    if (!this.busyCache.has(inst.gitDir)) this.busyCache.set(inst.gitDir, gitBusy(inst.gitDir));
    return !!this.busyCache.get(inst.gitDir);
  }

  gitInstances() {
    return this.db.all().filter((i) => i.gitMode && i.gitRoot && i.mode !== 'orphaned');
  }

  /** Sets the git mode on an instance (and a folder's files). Throws if follow is not allowed. */
  applyGitMode(root, mode) {
    if (!root) return;
    if (!GIT_MODES.includes(mode)) throw new UserError(`git mode must be one of ${GIT_MODES.join(', ')}`);
    if (mode === 'follow' && root.role === 'viewer') throw new UserError('git follow mode needs editor access');
    if (mode === 'follow' && !gitBinary()) throw new UserError('git follow mode needs git to be installed');
    const repo = findRepo(root.path);
    if (!repo) throw new UserError(`${root.path} is not inside a git repository`);
    const fields = { gitMode: mode, gitRoot: repo.root, gitDir: repo.gitDir, gitWaiting: false };
    for (const i of [root, ...(root.kind === 'folder' ? this.db.childrenOf(root.instanceId) : [])]) {
      this.db.update(i.instanceId, fields);
      if (i.kind === 'file') setKeep(repo.root, i.path, mode === 'keep');
    }
  }

  /** Lets git see the file normally again (after unmanage, orphaning, or leaving keep mode). */
  releaseGit(inst) {
    if (inst.gitMode === 'keep' && inst.kind === 'file' && inst.gitRoot) setKeep(inst.gitRoot, inst.path, false);
  }

  /** `tether git <path> [--mode]`: show or change the git mode of managed files. */
  gitMode({ path: p, mode }) {
    const ts = this.targets(p);
    const folders = new Set(ts.filter((i) => i.kind === 'folder').map((i) => i.instanceId));
    // A managed folder carries the mode for its files; single files inside it cannot differ.
    if (mode) for (const i of ts.filter((x) => !x.folderInstanceId || !folders.has(x.folderInstanceId))) this.applyGitMode(i.folderInstanceId ? this.db.get(i.folderInstanceId) : i, mode);
    return this.targets(p).map((i) => ({ path: i.path, kind: i.kind, role: i.role, gitMode: this.db.get(i.instanceId)?.gitMode ?? null, gitRoot: this.db.get(i.instanceId)?.gitRoot ?? findRepo(i.path)?.root ?? null }));
  }

  /** Tether 0.2.0 used git hooks; they are no longer needed. */
  cleanupLegacyHooks() {
    const dirs = this.db.getMeta('gitHooks') ?? [];
    for (const dir of dirs) if (this.home) removeHooks(dir, this.home);
    if (dirs.length) this.db.setMeta('gitHooks', null);
  }

  /** Managed files that ended up inside a git repository later (git init, moved into one) get keep mode. */
  detectNewRepos() {
    for (const i of this.db.all().filter((x) => !x.gitMode && !x.folderInstanceId && x.mode !== 'orphaned' && !x.detached)) {
      const repo = findRepo(i.path);
      if (!repo) continue;
      this.applyGitMode(i, 'keep');
      this.log(`${i.path}: now inside the git repository ${repo.root}; using keep mode`);
      this.notify({ kind: 'git-new', level: 'info', short: path.basename(i.path), title: 'Managed file is now in a git repository', body: `${path.basename(i.path)} is inside ${repo.root}. Tether keeps it as the shared version and git ignores Tether's copy. Run "tether git ${path.basename(i.path)} --mode follow" to publish git's changes instead.` });
    }
  }

  /**
   * Runs after git may have changed files (watcher on the git directory, and every tick):
   * follows renames git made, brings back files git restored, keeps keep-mode files hidden from
   * git, and publishes follow-mode files whose content now matches git's committed or staged state.
   */
  async gitPass({ only } = {}) {
    const repos = new Map();
    for (const i of this.gitInstances()) if (!only || samePath(i.gitRoot, only)) repos.set(i.gitDir, i.gitRoot);
    if (!repos.size) return;
    const heads = this.db.getMeta('gitHeads') ?? {};
    const publish = [];
    for (const [gitDir, root] of repos) {
      if (gitBusy(gitDir)) continue; // wait until git is done
      const h = gitBinary() ? head(root) : null;
      const prev = heads[gitDir];
      const headMoved = !!h && h !== prev;
      if (h && prev && h !== prev) await this.followGitHistory(root, prev, h);
      if (h) heads[gitDir] = h;
      for (const i of this.gitInstances().filter((x) => x.gitDir === gitDir)) {
        if (i.kind !== 'file') continue;
        if (i.detached) {
          if (statOrNull(i.path)?.isFile()) {
            this.db.update(i.instanceId, { ...this.identity(i.path), detached: false, missingSince: null, size: null, mtimeMs: null });
            if (i.gitMode === 'keep') setKeep(root, i.path, true);
            this.log(`${i.path}: back (restored by git)`);
          }
          continue;
        }
        if (i.mode !== 'normal') continue;
        if (i.gitMode === 'keep') {
          // Make sure the filter is in place (and git's cache current) whenever git moved.
          if ((headMoved || !prev) && gitBinary() && !isKept(root, i.path)) setKeep(root, i.path, true);
          continue;
        }
        if (!gitBinary()) continue;
        let local;
        try {
          local = readLocal(i.path, i.eolMode);
        } catch {
          continue; // locked; next pass
        }
        if (i.gitOverlay) {
          // The overlay ends when the file matches git again: git changed it (git's version wins and
          // is published below) or git now has the same content (someone committed it).
          if (fileBlob(root, i.path) !== blobAt(root, 'HEAD', i.path)) continue;
          setKeep(root, i.path, false);
          this.db.update(i.instanceId, { gitOverlay: false });
          i.gitOverlay = false;
        }
        const folder = i.folderInstanceId ? this.folderOf(i) : null;
        const rel = folder ? this.localRel(i, folder) : null;
        const moved = folder && rel && rel !== i.relPath;
        const changed = local && local.hash !== i.baseHash;
        if (!changed && !moved) continue;
        const { fromGit, commit } = changed ? changeFromGit(root, i.path) : { fromGit: true, commit: null };
        if (fromGit) publish.push({ inst: i, local: changed ? local : null, commit, relPath: moved ? rel : undefined });
      }
    }
    this.db.setMeta('gitHeads', heads);
    if (publish.length) await this.publishGitChanges(publish);
  }

  /** Renames and new files git brought in between two commits. */
  async followGitHistory(root, from, to) {
    for (const c of changesBetween(root, from, to)) {
      if (c.status === 'R') {
        const inst = this.gitInstances().find((i) => i.kind === 'file' && samePath(i.path, c.from));
        if (inst && !statOrNull(c.from) && statOrNull(c.to)?.isFile()) {
          this.db.update(inst.instanceId, { path: canonicalPath(c.to), ...this.identity(c.to), detached: false, missingSince: null, size: null, mtimeMs: null });
          if (inst.gitMode === 'keep') {
            setKeep(root, c.from, false);
            setKeep(root, c.to, true);
          }
          this.log(`${c.from} -> ${c.to}: followed a rename made in git`);
        }
      } else if (c.status === 'A' && !this.instanceAt(c.to) && statOrNull(c.to)?.isFile()) {
        const folder = this.gitInstances().find((i) => i.kind === 'folder' && i.gitMode === 'follow' && isUnder(c.to, i.path) && !samePath(c.to, i.path));
        if (!folder) continue;
        const name = path.basename(c.to);
        if (folder.role === 'owner') {
          try {
            const r = await this.add({ path: c.to, gitCommit: to });
            this.log(`${c.to}: added to ${folder.path} (new in git)`);
            this.notify({ kind: 'git-published', level: 'info', short: name, title: "Published git's changes", body: `${r.relPath} is new in git and was added to ${path.basename(folder.path)} for everyone.` });
          } catch (e) {
            this.log(`${c.to}: could not add (${e.message})`);
          }
        } else {
          this.notify({ kind: 'git-new-file', level: 'info', short: name, title: 'New file in a managed folder', body: `git added ${name} inside ${path.basename(folder.path)}. Only the owner can add files to it, so it is not shared through Tether.` });
        }
      }
    }
  }

  /**
   * Publishes git's version of follow-mode files. If Tether already has exactly that content it is
   * adopted; if Tether moved on to something else, the file stays in editing mode for `tether done`.
   */
  async publishGitChanges(list) {
    let results;
    try {
      ({ results } = await this.api.call('POST', '/sync/check', { items: list.map(({ inst }) => ({ artifactId: inst.artifactId, version: inst.baseVersion })) }));
    } catch (e) {
      if (!(e instanceof OfflineError)) throw e;
      // Offline: hold git's version (editing) instead of reverting it; `tether done` pushes later.
      for (const { inst } of list) this.db.update(inst.instanceId, { mode: 'editing', lastError: 'git changed this file while offline; run `tether done` to publish it' });
      return;
    }
    for (const [k, { inst, local, commit, relPath }] of list.entries()) {
      const r = results[k];
      const name = path.basename(inst.path);
      const hash = local?.hash ?? inst.baseHash;
      if (r.status === 'gone' || r.state?.deleted || r.folderDeleted) {
        this.orphan(inst, r.reason ?? 'deleted');
        continue;
      }
      if (r.role === 'viewer') {
        this.db.update(inst.instanceId, { gitMode: 'keep', role: 'viewer' });
        setKeep(inst.gitRoot, inst.path, true);
        continue; // reverted by the normal pass
      }
      const conflict = () => {
        this.db.update(inst.instanceId, { mode: 'editing', lastError: 'conflict: git changed this file and Tether has a newer version; run `tether done` to resolve' });
        this.log(`${inst.path}: git changed it but Tether also has a newer version; left in editing mode`);
        this.notify({ kind: 'conflict', level: 'warn', title: 'Merge conflict (git and Tether)', body: `${name}: git changed it, but someone also pushed a newer version to Tether. Git's version is kept and the file is in editing mode; run "tether done" to choose.`, short: name, artifactId: inst.artifactId });
      };
      const adopt = (state) => {
        this.db.update(inst.instanceId, { baseVersion: state.version, remoteVersion: state.version, baseHash: state.blob, relPath: state.relPath ?? inst.relPath, gitWaiting: false, lastError: null, ...(local ? { size: local.size, mtimeMs: local.mtimeMs, ...styleOf(local) } : {}) });
        this.log(`${inst.path}: git's version is already on Tether (v${state.version})`);
      };
      if (r.status === 'changed') {
        if (r.state.blob === hash && (relPath === undefined || r.state.relPath === relPath)) adopt(r.state); // e.g. a teammate published the same commit
        else conflict();
        continue;
      }
      try {
        const change = { gitCommit: commit ?? null };
        if (local) Object.assign(change, await this.uploadContent(local, inst.artifactId));
        if (relPath !== undefined) change.relPath = relPath;
        const c = await this.api.call('POST', `/artifacts/${inst.artifactId}/commit`, { baseVersion: inst.baseVersion, change });
        this.db.update(inst.instanceId, {
          baseVersion: c.version, remoteVersion: c.version, baseHash: hash, relPath: relPath ?? inst.relPath, gitWaiting: false, lastError: null,
          ...(local ? { size: local.size, mtimeMs: local.mtimeMs, ...styleOf(local) } : {}),
        });
        const sent = local ? describeTransfer(this.api.transfers.get(local.hash), 'sent') : '';
        this.log(`${inst.path}: published git's version as v${c.version}${sent ? ` (${sent})` : ''}`);
        this.notify({ kind: 'git-published', level: 'info', title: "Published git's changes", body: `${name} is now v${c.version} for everyone who has it.`, short: name, artifactId: inst.artifactId });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) conflict();
        else if (e instanceof ApiError) {
          this.db.update(inst.instanceId, { mode: 'editing', lastError: `could not publish git's version: ${e.message}` });
          this.notify({ kind: 'push-failed', level: 'error', title: 'Push failed', body: `${name}: ${e.message}. Git's version is kept in editing mode.`, short: name, artifactId: inst.artifactId });
        } else throw e;
      }
    }
  }

  /** Hook calls from Tether 0.2.0 installs, and explicit syncs. */
  async gitReconcile(root) {
    await this.locateAll();
    await this.gitPass({ only: root });
  }

  // ---------- realtime editing ----------

  /** Files this client is editing live (every save is pushed). */
  realtimeInstances() {
    return this.db.all().filter((i) => i.realtime && i.mode === 'editing' && i.kind === 'file');
  }

  /** True while anything held here is being edited live, so the daemon checks more often. */
  get realtimeActive() {
    return this.db.all().some((i) => (i.realtime && i.mode === 'editing') || (i.remoteRealtime && i.mode !== 'orphaned'));
  }

  async releaseRealtime(inst) {
    this.db.update(inst.instanceId, { realtime: false });
    await this.api.call('POST', `/artifacts/${inst.artifactId}/realtime`, { action: 'stop' }).catch(() => {});
  }

  /**
   * Pushes live edits: renews the session, applies incoming versions when there is no local
   * change, pushes local changes when the server has not moved, and pauses on a conflict.
   */
  async syncRealtime() {
    const rts = this.realtimeInstances().filter((i) => !i.detached);
    if (!rts.length) return;
    let results;
    try {
      ({ results } = await this.api.call('POST', '/sync/check', { items: rts.map((i) => ({ artifactId: i.artifactId, version: i.baseVersion, realtime: true })) }));
    } catch (e) {
      if (e instanceof OfflineError) return (this.offline = e.message);
      throw e;
    }
    for (const [k, inst] of rts.entries()) {
      const r = results[k];
      const cur = this.db.get(inst.instanceId);
      if (!cur || cur.mode !== 'editing' || !cur.realtime) continue;
      if (r.status === 'gone' || r.state?.deleted || r.folderDeleted) {
        this.orphan(cur, r.reason ?? 'deleted');
        continue;
      }
      if (!r.realtime?.mine) {
        const why = r.role === 'viewer' ? 'you are no longer an editor' : r.realtime ? `taken over by ${r.realtime.email}` : 'it ended';
        this.db.update(cur.instanceId, { realtime: false, lastError: r.role === 'viewer' ? null : `realtime session lost (${why}); still editing, run \`tether done\` to push` });
        this.log(`${cur.path}: realtime session lost (${why})`);
        this.notify({ kind: 'realtime-lost', level: 'warn', title: 'Live editing stopped', body: `${path.basename(cur.path)}: your realtime session ${why}. Your changes are kept; run "tether done" to push them.`, short: path.basename(cur.path), artifactId: cur.artifactId });
        continue;
      }
      try {
        const local = readLocal(cur.path, cur.eolMode);
        if (r.status === 'changed') {
          if (!local || local.hash === cur.baseHash) {
            await this.ensureBlobs([{ artifactId: cur.artifactId, version: r.state.version, sha: r.state.blob, base: cur.baseHash }]);
            this.applyIncoming(cur, r.state);
          } else {
            if (!cur.lastError?.startsWith('conflict')) {
              this.log(`${cur.path}: someone else pushed while you were editing live; live pushing paused, run \`tether done\` to resolve`);
              this.notify({ kind: 'conflict', level: 'warn', title: 'Merge conflict', body: `${path.basename(cur.path)}: someone else pushed while you were editing live. Live pushing is paused; run "tether done" to choose what to keep.`, short: path.basename(cur.path), artifactId: cur.artifactId });
            }
            this.db.update(cur.instanceId, { lastError: 'conflict: the server changed; run `tether done` to resolve' });
          }
          continue;
        }
        if (!local || local.hash === cur.baseHash) continue;
        const content = await this.uploadContent(local, cur.artifactId);
        try {
          const c = await this.api.call('POST', `/artifacts/${cur.artifactId}/commit`, { baseVersion: cur.baseVersion, change: content });
          this.db.update(cur.instanceId, { baseVersion: c.version, remoteVersion: c.version, baseHash: local.hash, size: local.size, mtimeMs: local.mtimeMs, ...styleOf(local), lastError: null });
          this.log(`${cur.path}: pushed v${c.version} (realtime${this.sentNote(local.hash)})`);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 409)) throw e;
          this.db.update(cur.instanceId, { lastError: 'conflict: the server changed; run `tether done` to resolve' });
        }
      } catch (e) {
        if (!(e instanceof LockedError)) throw e;
        this.db.update(cur.instanceId, { lastError: e.message });
      }
    }
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
    if (inst.gitMode && inst.mode === 'normal') {
      // Inside a git repository a vanished file is usually a branch switch, a rename or git clean:
      // keep tracking it and pick it up again when git brings it back (or follow the rename).
      this.db.update(inst.instanceId, { detached: true, missingSince: null });
      this.log(`${inst.path}: removed (by git?); waiting for git to bring it back`);
    } else if (inst.mode === 'editing') {
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
    for (const t of targets) {
      this.releaseGit(t);
      this.db.update(t.instanceId, { mode: 'orphaned', orphanReason: reason });
    }
    const what = reason === 'revoked' ? 'access revoked' : reason === 'deleted' ? 'deleted on the server' : 'removed from the server';
    this.log(`${inst.path}: ${what}; file kept, no longer tracked`);
    this.notify({ kind: 'orphaned', level: 'warn', title: 'No longer synced', body: `${path.basename(inst.path)}: ${what}. Your copy stays on disk but Tether no longer keeps it up to date.`, short: path.basename(inst.path) });
  }

  /** What a check asks about; a change cursor is only valid for the same question. */
  checkKey(insts) {
    return insts.map((i) => `${i.artifactId}@${i.baseVersion}:${i.mode}`).join(',');
  }

  /**
   * The change cursor from the last full check, if it can be reused: same instances, nothing
   * pending, no live sessions, and a full check at least every FULL_CHECK_MS as a safety net.
   */
  reusableCursor(insts) {
    const f = this.feed;
    if (!f || this.realtimeActive || Date.now() - f.at > FULL_CHECK_MS) return undefined;
    return f.key === this.checkKey(insts) ? f.cursor : undefined;
  }

  /**
   * Keeps the server's cursor only when nothing is pending here: an incoming version held back
   * (editing, unmanaged, waiting for git) must be offered again by a full check once it can apply.
   */
  rememberCursor(cursor) {
    const insts = this.db.all().filter(ACTIVE);
    const settled = insts.every((i) => i.remoteVersion == null || i.remoteVersion === i.baseVersion);
    this.feed = cursor !== undefined && settled ? { cursor, key: this.checkKey(insts), at: Date.now() } : null;
  }

  // ---------- usage reporting (the owner's view of who holds copies) ----------

  /** This device's stable ID (created once) and the name owners see. */
  deviceId() {
    let id = this.db.getMeta('deviceId');
    if (!id) {
      id = 'd_' + crypto.randomUUID().replace(/-/g, '');
      this.db.setMeta('deviceId', id);
    }
    return id;
  }

  deviceName() {
    return this.config.get('deviceName') || os.hostname();
  }

  /**
   * Tells the server which shared files and folders this device holds: state and version only,
   * never paths. Sent when that changes (or the device name does), and once a day as a heartbeat.
   */
  async reportInstances({ force = false } = {}) {
    if (this.reportUnsupported) return;
    const instances = this.db.all().filter((i) => ACTIVE(i) && !i.folderInstanceId)
      .map((i) => ({ instanceId: i.instanceId, artifactId: i.artifactId, mode: i.mode, version: i.baseVersion }));
    const deviceName = this.deviceName();
    const key = JSON.stringify([deviceName, instances]);
    const last = this.db.getMeta('report') ?? {};
    const ack = [...(this.unmanageAcks ?? [])];
    if (!force && !ack.length && last.key === key && Date.now() - (last.at ?? 0) < REPORT_EVERY_MS) return;
    try {
      await this.api.call('POST', '/instances/report', { deviceId: this.deviceId(), deviceName, platform: process.platform, instances, ack });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.reportUnsupported = true; // an older server
      if (e instanceof ApiError || e instanceof OfflineError) return;
      throw e;
    }
    this.unmanageAcks = (this.unmanageAcks ?? []).filter((id) => !ack.includes(id));
    this.db.setMeta('report', { key, at: Date.now() });
  }

  /** The owner stopped syncing these copies: unmanage them (files kept), tell the user, confirm. */
  async applyOwnerUnmanage(instanceIds) {
    for (const id of instanceIds) {
      const inst = this.db.get(id);
      if (inst && ACTIVE(inst) && inst.mode !== 'unmanaged') {
        try {
          await this.unmanage({ path: inst.path });
          const name = path.basename(inst.path);
          this.log(`${inst.path}: the owner stopped syncing it on this device; file kept (\`tether track\` syncs it again)`);
          this.notify({
            kind: 'unmanaged-by-owner', level: 'warn', short: name, artifactId: inst.artifactId,
            title: 'The owner stopped syncing a file',
            body: `${name} is no longer kept in sync on this device. Your copy stays as it is. Run "tether track ${name}" to sync it again.`,
          });
        } catch (e) {
          if (!(e instanceof UserError)) throw e;
        }
      }
    }
    this.unmanageAcks = [...new Set([...(this.unmanageAcks ?? []), ...instanceIds])];
  }

  /** One batched call for all instances (DESIGN §6.1 step 2). */
  async checkRemote() {
    const insts = this.db.all().filter(ACTIVE);
    if (!insts.length) {
      this.offline = null;
      return;
    }
    let results, cursor;
    try {
      // `root`: a file's folder, so a change to the folder (sharing, layout) re-checks its files too
      const rootOf = (i) => (i.folderInstanceId ? this.db.get(i.folderInstanceId)?.artifactId : undefined);
      const items = insts.map((i) => ({ artifactId: i.artifactId, version: i.baseVersion, root: rootOf(i) }));
      const body = { items, cursor: this.reusableCursor(insts) };
      const res = await this.api.call('POST', '/sync/check', body);
      this.offline = null;
      if (res.unmanage?.length) await this.applyOwnerUnmanage(res.unmanage);
      if (res.unchanged) return; // nothing this user holds changed since the last full check
      ({ results, cursor } = res);
    } catch (e) {
      if (e instanceof OfflineError || (e instanceof ApiError && e.status === 401)) {
        this.offline = e.message;
        if (e instanceof ApiError) this.notify({ kind: 'auth', level: 'error', key: 'auth', cooldownMs: 6 * 3600 * 1000, title: 'Tether needs you to sign in', body: `${e.message}. Until then nothing syncs.` });
        return;
      }
      throw e;
    }
    const incoming = [];
    const folders = [];
    insts.forEach((inst, idx) => {
      const r = results[idx];
      if (!r) return; // partial answer: unchanged since the cursor
      const cur = this.db.get(inst.instanceId);
      if (!cur || cur.mode === 'orphaned') return;
      if (r.status === 'gone') return this.orphan(cur, r.reason);
      if (r.folderDeleted || r.state?.deleted) return this.orphan(cur, 'deleted');
      const patch = {
        role: r.role, canDelete: r.canDelete, remoteVersion: r.version,
        remoteRealtime: r.realtime && !r.realtime.mine ? JSON.stringify({ email: r.realtime.email, since: r.realtime.since }) : null,
      };
      if (cur.role && cur.role !== 'viewer' && r.role === 'viewer' && cur.mode === 'editing') {
        patch.mode = 'normal';
        patch.realtime = false;
        this.log(`${cur.path}: you are now a viewer; editing ended and local changes will be reverted`);
        this.notify({ kind: 'demoted', level: 'warn', title: 'You are now a viewer', body: `${path.basename(cur.path)}: your editor access was removed, so your unpushed changes are being reverted.`, short: path.basename(cur.path), artifactId: cur.artifactId });
      }
      if (cur.gitMode === 'follow' && r.role === 'viewer') {
        patch.gitMode = 'keep';
        this.notify({ kind: 'demoted', level: 'warn', title: 'Git follow mode turned off', body: `${path.basename(cur.path)}: you are no longer an editor, so git's changes to it will be reverted.`, short: path.basename(cur.path), artifactId: cur.artifactId });
      }
      const now = this.db.update(cur.instanceId, patch);
      if (r.status !== 'changed') return;
      if (now.mode !== 'normal') return; // editing: pending; unmanaged: ignored
      if (now.kind === 'folder') folders.push({ inst: now, state: r.state, children: r.children });
      else if (!now.detached) incoming.push({ inst: now, state: r.state });
    });

    const newChildren = [];
    const waiting = new Set(); // folders with new files that should arrive through git first
    for (const f of folders) {
      const have = new Set(this.db.childrenOf(f.inst.instanceId).map((c) => c.artifactId));
      for (const c of f.children) {
        if (c.deleted || have.has(c.artifactId)) continue;
        if (f.inst.gitMode === 'follow' && c.gitCommit && !isAncestor(f.inst.gitRoot, c.gitCommit)) {
          waiting.add(f.inst.instanceId); // creating it now would block the git pull that brings it
          continue;
        }
        newChildren.push({ folder: f.inst, child: c });
      }
    }
    try {
      await this.ensureBlobs([
        ...incoming.map(({ inst, state }) => ({ artifactId: state.artifactId, version: state.version, sha: state.blob, base: inst.baseHash })),
        ...newChildren.map(({ child }) => ({ artifactId: child.artifactId, version: child.version, sha: child.blob })),
      ]);
    } catch (e) {
      if (e instanceof OfflineError) return (this.offline = e.message);
      throw e;
    }
    for (const { inst, state } of incoming) {
      if (this.isGitBusy(inst)) continue;
      if (inst.gitMode === 'follow' && state.gitCommit && !isAncestor(inst.gitRoot, state.gitCommit)) {
        // Writing it now would make git see a local change and refuse the pull that brings it.
        if (!inst.gitWaiting) this.log(`${inst.path}: v${state.version} came from git commit ${state.gitCommit.slice(0, 8)}; it will arrive with your next git pull`);
        this.db.update(inst.instanceId, { gitWaiting: true });
        continue;
      }
      this.applyIncoming(inst, state);
    }
    for (const { folder, child } of newChildren) {
      this.db.insert({
        instanceId: newInstanceId(), artifactId: child.artifactId, kind: 'file', folderInstanceId: folder.instanceId,
        repoId: child.repoId, name: child.name, relPath: child.relPath, path: path.join(folder.path, ...child.relPath.split('/')),
        mode: 'normal', baseVersion: child.version, baseHash: child.blob, eolMode: child.eol, exec: child.exec,
        role: folder.role, canDelete: folder.canDelete, needsRestore: true,
      });
      this.log(`${folder.path}: new file ${child.relPath}`);
    }
    // A folder with files still waiting for git stays behind, so they are offered again next pass.
    for (const f of folders) if (!waiting.has(f.inst.instanceId)) this.db.update(f.inst.instanceId, { baseVersion: f.state.version });
    if (results.some((r) => r && r.status !== 'ok')) this.activityAt = Date.now();
    this.rememberCursor(cursor);
  }

  /** Normal mode: write an incoming version (content and/or layout). */
  applyIncoming(inst, state) {
    // Never recreate a file that is missing right now (deleted, or mid-rename by git): the
    // delete/rename handling decides what happens to it.
    if (!statOrNull(inst.path)) return;
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
      const patch = { path: p, relPath: state.relPath, baseVersion: state.version, baseHash: state.blob, eolMode: state.eol, exec: state.exec, lastError: null, gitWaiting: false };
      const localEdit = !this.matchesBase(inst, p) && readLocal(p, inst.eolMode)?.hash !== state.blob;
      if (state.blob !== inst.baseHash || localEdit) {
        Object.assign(patch, this.writeInstance(inst, p, state.blob, state.eol, state.exec));
        const got = describeTransfer(this.api.transfers.get(state.blob), 'received');
        this.api.transfers.delete(state.blob);
        this.log(`${p}: updated to version ${state.version}${localEdit ? ' (local change replaced)' : ''}${got ? ` (${got})` : ''}`);
        if (inst.gitMode === 'follow' && inst.gitRoot && !state.gitCommit && blobAt(inst.gitRoot, 'HEAD', p) !== fileBlob(inst.gitRoot, p)) {
          // A version that exists only in Tether: hide it from git (like keep mode) so it never
          // blocks a pull. When git next changes the file, git's version wins (follow).
          setKeep(inst.gitRoot, p, true);
          patch.gitOverlay = true;
          this.notify({ kind: 'git-overlay', level: 'info', short: path.basename(p), artifactId: inst.artifactId, title: 'Changed through Tether', body: `${path.basename(p)} now has Tether's v${state.version}, which is not in git. Git does not see this change; the next change to the file in git replaces it.` });
        }
        if (localEdit) {
          const name = path.basename(p);
          this.notify({
            kind: 'revert', level: 'info', short: name, artifactId: inst.artifactId,
            title: inst.gitMode === 'keep' ? 'Tether undid a git change' : 'Tether undid your change',
            body: `${name} is managed by Tether, so your local change was replaced with the shared version (v${state.version}). Run "tether edit ${name}" to change it.`,
          });
        }
      }
      this.db.update(inst.instanceId, patch);
    } catch (e) {
      if (!(e instanceof LockedError)) throw e;
      this.lockedNotice(inst, e);
    }
  }

  lockedNotice(inst, e) {
    if (!inst.lastError) this.notify({ kind: 'locked', level: 'warn', key: `locked:${inst.instanceId}`, cooldownMs: 3600 * 1000, title: 'File in use', body: `${path.basename(inst.path)} is open in another program, so Tether cannot update it yet. It will retry automatically.`, short: path.basename(inst.path) });
    this.db.update(inst.instanceId, { lastError: e.message });
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

  /**
   * Follow mode, just before a revert: is this content git's own (a git operation that started
   * after this pass checked, e.g. a cherry-pick between writing the file and moving HEAD)? Asks git
   * afresh, since the pass's busy check may be stale by now.
   */
  gitWroteIt(inst) {
    if (inst.gitMode !== 'follow' || !inst.gitRoot) return false;
    if (gitBusy(inst.gitDir)) return true;
    const blob = fileBlob(inst.gitRoot, inst.path);
    if (!blob) return false;
    if (blob === indexBlob(inst.gitRoot, inst.path) || blob === blobAt(inst.gitRoot, 'HEAD', inst.path)) {
      this.gitPassDue = true;
      return true;
    }
    return false;
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
      if (this.isGitBusy(inst)) continue; // never rewrite files under a running git operation
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
        if (this.gitWroteIt(cur)) continue; // git's version: the git pass publishes it
        this.db.update(cur.instanceId, { ...this.writeInstance(cur, cur.path, cur.baseHash), lastError: null });
        this.log(`${cur.path}: local change reverted (use \`tether edit\` to change it)`);
        const byGit = cur.gitMode === 'keep';
        this.notify({
          kind: 'revert', level: 'info', short: path.basename(cur.path), artifactId: cur.artifactId,
          title: byGit ? 'Tether undid a git change' : 'Tether undid your change',
          body: `${path.basename(cur.path)} is managed by Tether, so it was put back to the shared version. Run "tether edit ${path.basename(cur.path)}" to change it${byGit ? ', or "tether git <path> --mode follow" to accept git updates' : ''}.`,
        });
      } catch (e) {
        if (!(e instanceof LockedError)) throw e;
        this.lockedNotice(inst, e);
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
  /** `tether manage`, then apply the git mode chosen for a path inside a git repository. */
  async manage({ gitMode, ...opts }) {
    const r = await this.manageCore(opts);
    if (gitMode) this.applyGitMode(this.instanceAt(r.path), gitMode);
    return r;
  }

  async manageCore({ path: target, repo: repoRef, eol }) {
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
      const r = await this.api.call('POST', '/artifacts', { repoId: repo.repoId, kind: 'file', name, blob: f.sha256, size: f.size, chunks: this.api.manifestFor(f.sha256), eol: f.eol, exec: f.exec });
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
      files: prepared.map((f) => ({ relPath: f.rel, blob: f.sha256, size: f.size, chunks: this.api.manifestFor(f.sha256), eol: f.eol, exec: f.exec })),
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
  async add({ path: target, gitCommit }) {
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
    const child = await this.api.call('POST', `/artifacts/${folder.artifactId}/children`, { relPath: rel, blob: f.sha256, size: f.size, chunks: this.api.manifestFor(f.sha256), eol: f.eol, exec: f.exec, gitCommit });
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
  /** `tether pull`; with peek, only report where it would go and the caller's role. */
  async pull({ gitMode, peek, ...opts }) {
    if (peek) {
      const r = await this.api.call('POST', '/pull', { shareId: opts.shareId, peek: true });
      return { role: r.role, kind: r.artifact.kind, path: this.pullTarget(r.artifact, opts) };
    }
    const r = await this.pullCore(opts, gitMode);
    if (gitMode) this.applyGitMode(this.instanceAt(r.path), gitMode);
    return r;
  }

  pullTarget(a, { dest, cwd }) {
    const target = path.resolve(cwd, dest ?? a.name);
    return dest && statOrNull(target)?.isDirectory() && a.kind === 'file' ? path.join(target, a.name) : target;
  }

  async pullCore({ shareId, dest, cwd }, gitMode) {
    const r = await this.api.call('POST', '/pull', { shareId });
    const a = r.artifact;
    if (gitMode === 'follow' && r.role === 'viewer') throw new UserError('git follow mode needs editor access; you are a viewer (use --git keep)');
    const target = this.pullTarget(a, { dest, cwd });
    if (this.instanceAt(target)) throw new UserError(`${target} is already a managed copy`);
    const base = { repoId: a.repoId, role: r.role, canDelete: r.canDelete };

    if (a.kind === 'file') {
      await this.ensureBlobs([{ artifactId: a.artifactId, version: a.version, sha: a.blob }]);
      let existing = readLocal(target, a.eol);
      let mode = 'normal';
      let lastError = null;
      let note;
      if (existing && existing.hash !== a.blob) {
        const clash = this.gitClash(target, gitMode, a.relPath ?? a.name);
        if (clash === 'replace') {
          existing = null; // Tether's version wins; git still has its own
          note = "replaced git's version with Tether's (git still has it)";
        } else {
          mode = 'editing';
          lastError = "git's version differs from Tether's; run `tether done` to publish it or accept Tether's";
          note = "kept git's version; run `tether done` to publish it or accept Tether's";
        }
      }
      const st = existing ? { size: existing.size, mtimeMs: existing.mtimeMs, ...styleOf(existing) } : writeLocal(target, this.blobFor(a.blob), a.eol, { exec: a.exec });
      this.db.insert({
        ...base, instanceId: newInstanceId(), artifactId: a.artifactId, kind: 'file', name: a.name, path: canonicalPath(target),
        ...this.identity(target), mode, lastError, baseVersion: a.version, baseHash: a.blob, ...st, eolMode: a.eol, exec: a.exec, remoteVersion: a.version,
      });
      return { kind: 'file', path: canonicalPath(target), role: r.role, version: a.version, note };
    }

    const st = statOrNull(target);
    if (st && !st.isDirectory()) throw new UserError(`${target} exists and is not a folder`);
    await this.ensureBlobs(r.children.map((c) => ({ artifactId: c.artifactId, version: c.version, sha: c.blob })));
    const clashes = new Map(); // relPath -> 'replace' | 'keep-git'
    for (const c of r.children) {
      const p = path.join(target, ...c.relPath.split('/'));
      const ex = readLocal(p, c.eol);
      if (ex && ex.hash !== c.blob) clashes.set(c.relPath, this.gitClash(p, gitMode, c.relPath));
    }
    fs.mkdirSync(target, { recursive: true });
    const folderInst = this.db.insert({
      ...base, instanceId: newInstanceId(), artifactId: a.artifactId, kind: 'folder', name: a.name, path: canonicalPath(target),
      ...this.identity(target), mode: 'normal', baseVersion: a.version, remoteVersion: a.version,
    });
    for (const c of r.children) {
      const p = path.join(folderInst.path, ...c.relPath.split('/'));
      const clash = clashes.get(c.relPath);
      const ex = clash === 'replace' ? null : readLocal(p, c.eol);
      const cst = ex ? { size: ex.size, mtimeMs: ex.mtimeMs, ...styleOf(ex) } : writeLocal(p, this.blobFor(c.blob), c.eol, { exec: c.exec });
      this.db.insert({
        ...base, instanceId: newInstanceId(), artifactId: c.artifactId, kind: 'file', folderInstanceId: folderInst.instanceId, name: c.name,
        relPath: c.relPath, path: canonicalPath(p), ...this.identity(p), baseVersion: c.version, baseHash: c.blob, ...cst,
        mode: clash === 'keep-git' ? 'editing' : 'normal', lastError: clash === 'keep-git' ? "git's version differs from Tether's; run `tether done`" : null,
        eolMode: c.eol, exec: c.exec, remoteVersion: c.version,
      });
    }
    return { kind: 'folder', path: folderInst.path, role: r.role, files: r.children.length, version: a.version };
  }

  /**
   * A pulled file already exists with different content. Only allowed when git holds that
   * content safely (tracked, no uncommitted changes): keep mode replaces it with Tether's version,
   * follow mode keeps git's version in editing mode. Otherwise the pull is refused.
   */
  gitClash(p, gitMode, label) {
    const repo = gitMode && findRepo(p);
    if (repo && gitBinary() && isTracked(repo.root, p)) {
      const blob = fileBlob(repo.root, p);
      const clean = blob && (blob === blobAt(repo.root, 'HEAD', p) || blob === indexBlob(repo.root, p));
      if (clean) return gitMode === 'keep' ? 'replace' : 'keep-git';
      throw new UserError(`${label} differs from Tether's version and has uncommitted git changes; commit or stash them first`);
    }
    throw new UserError(`${p} already exists with different content; choose another destination`);
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

  /**
   * `tether edit [--realtime]`. Realtime claims a live session per file (editors only, one
   * holder per file). A plain edit warns about files someone else is editing live.
   */
  async edit({ path: p, realtime = false }) {
    const ts = this.targets(p);
    const unmanaged = ts.filter((i) => i.mode === 'unmanaged' && !i.detached);
    if (unmanaged.length === ts.length) throw new UserError('these files are unmanaged; use `tether track` first');
    const files = ts.filter((i) => i.kind === 'file' && ['normal', 'editing'].includes(i.mode) && !i.detached);
    if (realtime) {
      if (!files.length) throw new UserError('nothing here to edit');
      const viewerOf = files.find((i) => i.role === 'viewer');
      if (viewerOf) throw new UserError(`realtime editing needs editor access; you are a viewer of ${viewerOf.path}`);
      const claimed = [];
      for (const f of files) {
        try {
          await this.api.call('POST', `/artifacts/${f.artifactId}/realtime`, { action: 'start' });
          claimed.push(f);
        } catch (e) {
          for (const c of claimed) await this.releaseRealtime(c);
          if (e instanceof ApiError && e.status === 409 && e.body?.realtime) {
            const s = e.body.realtime;
            throw new UserError(`${f.path} is already being edited in realtime by ${s.email} (since ${new Date(s.since).toLocaleTimeString()}).\nYou can still run \`tether edit\` without --realtime, but expect merge conflicts.`);
          }
          throw e;
        }
      }
      this.setMode(p, 'editing', ['normal', 'editing']);
      for (const f of files) this.db.update(f.instanceId, { mode: 'editing', realtime: true, lastError: null });
      return { changed: files.map((f) => f.path), realtime: true };
    }
    const changed = this.setMode(p, 'editing', ['normal']);
    const warnings = [];
    if (files.length) {
      try {
        const { results } = await this.api.call('POST', '/sync/check', { items: files.map((i) => ({ artifactId: i.artifactId, version: i.baseVersion })) });
        results.forEach((r, k) => {
          if (r.realtime && !r.realtime.mine) warnings.push({ path: files[k].path, email: r.realtime.email, since: r.realtime.since });
        });
      } catch (e) {
        if (!(e instanceof OfflineError)) throw e;
      }
    }
    return { changed, warnings };
  }

  async unmanage({ path: p }) {
    for (const i of this.targets(p).filter((x) => x.realtime)) await this.releaseRealtime(i);
    for (const i of this.targets(p)) this.releaseGit(i);
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
    // Finished live sessions end on the server too.
    for (const i of this.db.all().filter((x) => x.realtime && x.mode !== 'editing')) await this.releaseRealtime(i);
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
        if (local && local.hash !== inst.baseHash) Object.assign(change, await this.uploadContent(local, inst.artifactId));
        if (folder) {
          const rel = this.localRel(inst, folder);
          if (rel && rel !== inst.relPath) change.relPath = rel;
        }
        const baseVersion = item.incoming ? item.serverVersion : inst.baseVersion;
        if (inst.gitMode === 'follow' && inst.gitRoot && change.blob) {
          const g = changeFromGit(inst.gitRoot, inst.path);
          if (g.fromGit && g.commit) change.gitCommit = g.commit; // teammates get it through git
        }
        const r = await this.api.call('POST', `/artifacts/${inst.artifactId}/commit`, { baseVersion, change });
        const state = r.state;
        this.db.update(inst.instanceId, {
          mode: 'normal', baseVersion: r.version, remoteVersion: r.version, baseHash: state?.blob ?? inst.baseHash,
          relPath: state?.relPath ?? inst.relPath, size: local?.size ?? null, mtimeMs: local?.mtimeMs ?? null, ...(local ? styleOf(local) : {}),
        });
        return { version: r.version, sent: change.blob ? describeTransfer(this.api.transfers.get(change.blob), 'sent') : '' };
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
    await this.ensureBlobs([{ artifactId: inst.artifactId, version: artifact.version, sha: artifact.blob, base: inst.baseHash }]);
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
      if (i.realtime && i.mode === 'editing') flags.push('realtime: your saves are pushed live');
      if (i.gitMode) flags.push(`git: ${i.gitMode}`);
      if (i.gitWaiting) flags.push('newer version arrives with your next git pull');
      if (i.gitOverlay) flags.push('Tether-only version (hidden from git)');
      if (i.remoteRealtime && i.mode !== 'orphaned') flags.push(`realtime edits by ${JSON.parse(i.remoteRealtime).email}`);
      return {
        instanceId: i.instanceId, artifactId: i.artifactId, kind: i.kind, path: i.path, relPath: i.relPath, mode: i.mode, role: i.role,
        version: i.baseVersion, folderInstanceId: i.folderInstanceId, flags,
        // the same facts as fields, for the desktop app
        name: i.name ?? path.basename(i.path), repoId: i.repoId, canDelete: !!i.canDelete,
        remoteVersion: i.remoteVersion ?? null, modified: flags.includes('modified'), locked: flags.includes('locked'),
        detached: !!i.detached, missing: !!i.missingSince, restoring: !!i.needsRestore, lastError: i.lastError ?? null,
        orphanReason: i.orphanReason ?? null, realtime: !!(i.realtime && i.mode === 'editing'),
        liveBy: i.remoteRealtime && i.mode !== 'orphaned' ? JSON.parse(i.remoteRealtime) : null,
        gitRoot: i.gitRoot ?? null, gitMode: i.gitMode ?? null, gitWaiting: !!i.gitWaiting, gitOverlay: !!i.gitOverlay,
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
