// All server-side rules live here: roles, version compare-and-set, validation, purges.
// The HTTP layer only parses requests and calls these methods (DESIGN §3, §6.3, §7, §8.2, §10).
import path from 'node:path';
import { newArtifactId, newRepoId, newShareId, nameError, relPathError, caseCollisionError, EOL_MODES, sha256, CHUNK_MAX } from '@tether/shared';

const HASH = /^[0-9a-f]{64}$/;
const FETCH_LIMIT = 8 * 1024 * 1024; // bytes per chunk fetch response

/** Runs fn over items with limited concurrency. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}
import { badRequest, forbidden, notFound, conflict, tooLarge } from './errors.js';
import { publicUser } from './auth/local.js';

/** State of an artifact as clients see it. */
export function view(a) {
  return {
    artifactId: a._id,
    kind: a.kind,
    repoId: a.repoId,
    parentFolderId: a.parentFolderId ?? null,
    name: a.name,
    relPath: a.relPath ?? null,
    version: a.currentVersion,
    blob: a.blob ?? null,
    size: a.size ?? 0,
    deleted: !!a.deleted,
    eol: a.eol ?? 'auto',
    exec: !!a.exec,
    gitCommit: a.gitCommit ?? null, // set when this version was published from a git commit
    updatedAt: a.updatedAt ?? a.createdAt ?? null,
  };
}

/** Sharing settings, visible to the owner only. */
function sharingView(a) {
  return { shareId: a.shareId, visibility: a.visibility, editors: a.editors ?? {}, allowlist: a.allowlist ?? [] };
}

export class TetherService {
  constructor({ store, blobs, maxFileSize, realtimeTtlMs = 5 * 60 * 1000 }) {
    this.store = store;
    this.blobs = blobs;
    this.maxFileSize = maxFileSize;
    this.realtimeTtlMs = realtimeTtlMs;
  }

  // ---- realtime edit sessions ----
  // One editor at a time may push a file live (`tether edit --realtime`). The session is a
  // lease: renewed by that editor's client on every check, gone after realtimeTtlMs without one.

  /** The live session on an artifact, if it is unexpired and its holder can still edit. */
  activeRealtime(a, root, now = Date.now()) {
    const s = a.realtime;
    if (!s || s.expiresAt < now) return null;
    if (root.ownerUid !== s.uid && !root.editors?.[s.uid]) return null;
    return s;
  }

  realtimeView(s, uid) {
    return s ? { email: s.email, since: s.since, mine: s.uid === uid } : null;
  }

  async startRealtime(uid, artifactId) {
    const { artifact: a, root, role } = await this.access(uid, artifactId);
    if (role === 'viewer') throw forbidden('realtime editing needs editor access');
    if (a.kind !== 'file') throw badRequest('realtime sessions are per file');
    if (a.deleted || root.deleted) throw conflict('artifact has been deleted');
    const now = Date.now();
    const cur = this.activeRealtime(a, root, now);
    if (cur && cur.uid !== uid) throw conflict(`being edited in realtime by ${cur.email}`, { realtime: this.realtimeView(cur, uid) });
    // A stored lease whose holder can no longer edit (demoted, removed) is stale: clear it.
    if (!cur && a.realtime && a.realtime.uid !== uid) await this.store.releaseRealtime(a._id, a.realtime.uid);
    const user = await this.store.userById(uid);
    const session = { uid, email: user?.email ?? uid, since: cur?.uid === uid ? cur.since : now, expiresAt: now + this.realtimeTtlMs };
    if (!(await this.store.claimRealtime(a._id, uid, session, now))) {
      const fresh = await this.store.artifactById(a._id);
      throw conflict(`being edited in realtime by ${fresh.realtime?.email}`, { realtime: this.realtimeView(fresh.realtime, uid) });
    }
    if (cur?.uid !== uid) await this.touch(root);
    return { realtime: this.realtimeView(session, uid) };
  }

  /** Ends the caller's session. The owner may also end someone else's (force). */
  async stopRealtime(uid, artifactId, { force = false } = {}) {
    const { role, root } = await this.access(uid, artifactId);
    if (force && role !== 'owner') throw forbidden('only the owner can end someone else\'s realtime session');
    await this.store.releaseRealtime(artifactId, force ? null : uid);
    await this.touch(root);
    return { ok: true };
  }

  // ---- roles ----

  roleOf(uid, root, grant) {
    if (root.ownerUid === uid) return { role: 'owner', canDelete: true };
    const ed = root.editors?.[uid];
    if (ed) return { role: 'editor', canDelete: !!ed.canDelete };
    if (root.allowlist?.includes(uid)) return { role: 'viewer', canDelete: false };
    if (root.visibility === 'link' && grant && grant.shareId === root.shareId) return { role: 'viewer', canDelete: false };
    return { role: null, canDelete: false };
  }

  /** Loads an artifact and the caller's role on it. Throws 404 if the caller has no access. */
  async access(uid, artifactId) {
    const artifact = await this.store.artifactById(artifactId);
    if (!artifact) throw notFound('artifact not found');
    const root = artifact.parentFolderId ? await this.store.artifactById(artifact.parentFolderId) : artifact;
    if (!root) throw notFound('artifact not found');
    const grant = await this.store.grant(root._id, uid);
    const r = this.roleOf(uid, root, grant);
    if (!r.role) throw notFound('artifact not found or access revoked');
    return { artifact, root, ...r };
  }

  // ---- change feeds ----
  // Each user has a counter that goes up whenever something they may hold a copy of changes.
  // A client that saw counter N on its last full check, and still sees N, has nothing to fetch:
  // its check costs one read instead of a few per file (see checkSince).

  /** Everyone who may hold a copy of root: owner, editors, allowlist and link grants. */
  async audience(root) {
    return [root.ownerUid, ...Object.keys(root.editors ?? {}), ...(root.allowlist ?? []), ...(await this.store.grantsFor(root._id))];
  }

  /** Bumps the feeds of everyone who may hold root (plus `also`). Never fails the change itself. */
  async touch(root, also = []) {
    try {
      const uids = [...new Set([...(root ? await this.audience(root) : []), ...also])].filter(Boolean);
      await this.store.bumpFeeds(uids);
    } catch (e) {
      console.error('feed bump failed', e);
    }
  }

  async requireOwner(uid, artifactId) {
    const ctx = await this.access(uid, artifactId);
    if (ctx.role !== 'owner') throw forbidden('only the owner can do this');
    return ctx;
  }

  async requireRepoOwner(uid, repoId) {
    const repo = await this.store.repoById(repoId);
    if (!repo || repo.ownerUid !== uid) throw notFound('repo not found');
    return repo;
  }

  // ---- validation ----

  async checkBlob(sha, size) {
    if (!/^[0-9a-f]{64}$/.test(String(sha))) throw badRequest('invalid blob hash');
    if (size > this.maxFileSize) throw tooLarge(`file is larger than the ${this.maxFileSize} byte limit`);
    const actual = await this.blobs.size(sha);
    if (actual === null) throw badRequest(`blob ${sha.slice(0, 12)} has not been uploaded`);
    return actual;
  }

  /**
   * Validates a file's content reference: a chunk list (delta sync) or, from older clients,
   * a whole uploaded blob. Returns { size, chunks } to store. `known` chunks (from the current
   * version) are already stored and are not checked again.
   */
  async checkContent(sha, size, chunks, known = []) {
    if (!chunks) return { size: await this.checkBlob(sha, size), chunks: null };
    if (!HASH.test(String(sha))) throw badRequest('invalid content hash');
    if (!Array.isArray(chunks)) throw badRequest('invalid chunk list');
    if (size > this.maxFileSize) throw tooLarge(`file is larger than the ${this.maxFileSize} byte limit`);
    let total = 0;
    const list = chunks.map((c) => {
      if (!HASH.test(String(c?.h)) || !Number.isInteger(c.s) || c.s < 0 || c.s > CHUNK_MAX) throw badRequest('invalid chunk');
      total += c.s;
      return { h: c.h, s: c.s };
    });
    if (total !== size) throw badRequest('chunk sizes do not add up to the file size');
    const have = new Set(known.map((c) => c.h));
    const missing = await this.missingChunks([...new Set(list.map((c) => c.h))].filter((h) => !have.has(h)));
    if (missing.length) throw badRequest(`${missing.length} chunk(s) have not been uploaded`);
    return { size, chunks: list };
  }

  async missingChunks(hashes) {
    const present = await mapLimit(hashes, 64, (h) => (this.blobs.hasHere ? this.blobs.hasHere(h) : this.blobs.has(h)));
    return hashes.filter((_, i) => !present[i]);
  }

  /** The chunk list of a stored version; content from older clients is one whole-file chunk. */
  manifestOf(state) {
    if (state.chunks) return state.chunks;
    return state.blob ? [{ h: state.blob, s: state.size ?? 0 }] : [];
  }

  async versionState(a, version) {
    if (version === undefined || version === null || Number(version) === a.currentVersion) return { version: a.currentVersion, blob: a.blob, size: a.size, chunks: a.chunks };
    const v = await this.store.version(a._id, Number(version));
    if (!v) throw notFound(`version ${version} not found`);
    return { version: v.version, blob: v.blob, size: v.size, chunks: v.chunks };
  }

  /** Whole content of a stored version (reassembled from its chunks). */
  async assemble(state) {
    const parts = await mapLimit(this.manifestOf(state), 64, (c) => this.blobs.read(c.h));
    const bytes = Buffer.concat(parts);
    if (state.blob && sha256(bytes) !== state.blob) throw new Error('stored content does not match its hash');
    return bytes;
  }

  checkEol(eol) {
    if (eol && !EOL_MODES.includes(eol)) throw badRequest(`eol must be one of ${EOL_MODES.join(', ')}`);
    return eol || 'auto';
  }

  checkLayout(relPaths) {
    for (const p of relPaths) {
      const e = relPathError(p);
      if (e) throw badRequest(e);
    }
    const e = caseCollisionError(relPaths);
    if (e) throw badRequest(e);
  }

  async liveSiblingPaths(folderId, exceptId) {
    const kids = await this.store.childrenOf(folderId);
    return kids.filter((k) => !k.deleted && k._id !== exceptId).map((k) => k.relPath);
  }

  // ---- repos ----

  async createRepo(uid, { name, eolDefaults }) {
    const e = nameError(String(name || ''));
    if (e) throw badRequest(`repo name: ${e}`);
    const repo = { _id: newRepoId(), ownerUid: uid, name, eolDefaults: this.checkRules(eolDefaults), createdAt: new Date() };
    try {
      await this.store.createRepo(repo);
    } catch (err) {
      if (err.code === 11000) throw conflict(`you already have a repo named "${name}"`);
      throw err;
    }
    return this.repoView(repo);
  }

  checkRules(rules = {}) {
    for (const [glob, mode] of Object.entries(rules)) {
      if (!glob) throw badRequest('empty glob');
      this.checkEol(mode);
    }
    return rules;
  }

  repoView(repo) {
    return { repoId: repo._id, name: repo.name, ownerUid: repo.ownerUid, eolDefaults: repo.eolDefaults ?? {}, createdAt: repo.createdAt };
  }

  async listRepos(uid) {
    return (await this.store.reposOf(uid)).map((r) => this.repoView(r));
  }

  async getRepo(uid, repoId) {
    const repo = await this.requireRepoOwner(uid, repoId);
    const all = await this.store.artifactsInRepo(repoId);
    const tops = all.filter((a) => !a.parentFolderId).map((a) => ({
      ...view(a),
      ...sharingView(a),
      fileCount: a.kind === 'folder' ? all.filter((c) => c.parentFolderId === a._id && !c.deleted).length : 1,
    }));
    return { ...this.repoView(repo), artifacts: tops };
  }

  async updateRepo(uid, repoId, { name, eolDefaults }) {
    await this.requireRepoOwner(uid, repoId);
    const set = {};
    if (name !== undefined) {
      const e = nameError(String(name));
      if (e) throw badRequest(`repo name: ${e}`);
      set.name = name;
    }
    if (eolDefaults !== undefined) set.eolDefaults = this.checkRules(eolDefaults);
    try {
      await this.store.updateRepo(repoId, set);
    } catch (err) {
      if (err.code === 11000) throw conflict(`you already have a repo named "${name}"`);
      throw err;
    }
    return this.repoView(await this.store.repoById(repoId));
  }

  async purgeArtifacts(ids) {
    if (!ids.length) return;
    await this.store.deleteVersionsOf(ids);
    await this.store.deleteGrantsFor(ids);
    await this.store.deleteArtifacts(ids);
  }

  /** Hard purge of server data. Client instances become orphaned; local files are never touched. */
  async deleteRepo(uid, repoId) {
    await this.requireRepoOwner(uid, repoId);
    const all = await this.store.artifactsInRepo(repoId);
    const holders = (await Promise.all(all.filter((a) => !a.parentFolderId).map((a) => this.audience(a)))).flat();
    const ids = all.map((a) => a._id);
    await this.purgeArtifacts(ids);
    await this.store.deleteRepo(repoId);
    await this.touch(null, holders);
    return { purgedArtifacts: ids.length };
  }

  /** The new owner takes over; the previous owner stays on as an editor with delete permission. */
  async transferRepo(uid, repoId, toEmail) {
    const repo = await this.requireRepoOwner(uid, repoId);
    const to = await this.store.userByEmail(String(toEmail || '').toLowerCase());
    if (!to) throw notFound(`no user with email ${toEmail}`);
    if (to._id === uid) throw badRequest('you already own this repo');
    const clash = (await this.store.reposOf(to._id)).find((r) => r.name === repo.name);
    if (clash) throw conflict(`${toEmail} already has a repo named "${repo.name}"`);
    await this.store.updateRepo(repoId, { ownerUid: to._id });
    await this.store.updateArtifactsInRepo(repoId, {
      $set: { ownerUid: to._id, [`editors.${uid}`]: { canDelete: true } },
      $unset: { [`editors.${to._id}`]: '' },
    });
    for (const a of await this.store.artifactsInRepo(repoId)) if (!a.parentFolderId) await this.touch(a, [uid]);
    return this.repoView(await this.store.repoById(repoId));
  }

  // ---- artifacts ----

  /** `tether manage`: upload a file or folder; the caller becomes the owner. */
  async manage(uid, { repoId, kind, name, blob, size, eol, exec, files, chunks }) {
    await this.requireRepoOwner(uid, repoId);
    const e = nameError(String(name || ''));
    if (e) throw badRequest(e);
    const now = new Date();
    const base = { repoId, ownerUid: uid, createdAt: now };
    const root = {
      ...base,
      _id: newArtifactId(),
      kind,
      name,
      parentFolderId: null,
      relPath: null,
      currentVersion: 1,
      deleted: false,
      shareId: newShareId(),
      visibility: 'link',
      editors: {},
      allowlist: [],
    };
    const children = [];
    if (kind === 'file') {
      Object.assign(root, { blob, ...(await this.checkContent(blob, size, chunks)), eol: this.checkEol(eol), exec: !!exec });
    } else if (kind === 'folder') {
      if (!Array.isArray(files)) throw badRequest('files required for a folder');
      this.checkLayout(files.map((f) => f.relPath));
      for (const f of files) {
        children.push({
          ...base,
          _id: newArtifactId(),
          kind: 'file',
          parentFolderId: root._id,
          relPath: f.relPath,
          name: path.posix.basename(f.relPath),
          currentVersion: 1,
          deleted: false,
          blob: f.blob,
          ...(await this.checkContent(f.blob, f.size, f.chunks)),
          eol: this.checkEol(f.eol),
          exec: !!f.exec,
        });
      }
    } else throw badRequest('kind must be file or folder');
    await this.store.insertArtifacts([root, ...children]);
    for (const a of [root, ...children]) {
      await this.store.insertVersion({ ...this.snapshot(a), artifactId: a._id, version: 1, type: 'create', authorUid: uid, createdAt: now, basedOn: 0 });
    }
    return { artifact: { ...view(root), ...sharingView(root) }, children: children.map(view), role: 'owner', canDelete: true };
  }

  snapshot(a) {
    return { blob: a.blob ?? null, size: a.size ?? 0, chunks: a.chunks ?? null, relPath: a.relPath ?? null, deleted: !!a.deleted, gitCommit: a.gitCommit ?? null };
  }

  /** `tether add`: owner adds a new file to a folder artifact. */
  async addChild(uid, folderId, { relPath, blob, size, eol, exec, gitCommit, chunks }) {
    if (gitCommit != null && !/^[0-9a-f]{40,64}$/.test(String(gitCommit))) throw badRequest('invalid git commit');
    const { artifact: folder } = await this.requireOwner(uid, folderId);
    if (folder.kind !== 'folder') throw badRequest('not a folder artifact');
    if (folder.deleted) throw badRequest('folder has been deleted');
    this.checkLayout([...(await this.liveSiblingPaths(folderId)), relPath]);
    const now = new Date();
    const child = {
      _id: newArtifactId(),
      repoId: folder.repoId,
      ownerUid: folder.ownerUid,
      createdAt: now,
      kind: 'file',
      parentFolderId: folderId,
      relPath,
      name: path.posix.basename(relPath),
      currentVersion: 1,
      deleted: false,
      blob,
      ...(await this.checkContent(blob, size, chunks)),
      eol: this.checkEol(eol),
      exec: !!exec,
      gitCommit: gitCommit ?? null,
    };
    await this.store.insertArtifacts([child]);
    await this.store.insertVersion({ ...this.snapshot(child), artifactId: child._id, version: 1, type: 'create', authorUid: uid, createdAt: now, basedOn: 0 });
    await this.bumpFolder(folderId, uid, { type: 'add', childId: child._id, relPath });
    await this.touch(folder);
    return view(child);
  }

  async bumpFolder(folderId, uid, detail) {
    const version = await this.store.bumpVersion(folderId);
    await this.store.insertVersion({ artifactId: folderId, version, ...detail, authorUid: uid, createdAt: new Date(), basedOn: version - 1 });
    return version;
  }

  /** `tether pull <shareId>`. Records a link grant so rotation can revoke it later. */
  async pull(uid, shareId, { peek = false } = {}) {
    const root = await this.store.artifactByShareId(String(shareId || '').trim());
    if (!root) throw notFound('no artifact with that share ID (it may have been rotated)');
    if (root.deleted) throw notFound('that artifact has been deleted');
    let r = this.roleOf(uid, root, { shareId: root.shareId });
    if (!r.role) throw forbidden('this artifact is restricted to an allowlist and you are not on it');
    if (!peek && r.role === 'viewer' && root.visibility === 'link') await this.store.addGrant(root._id, uid, root.shareId);
    const children = root.kind === 'folder' ? (await this.store.childrenOf(root._id)).filter((c) => !c.deleted).map(view) : [];
    return { artifact: view(root), children, role: r.role, canDelete: r.canDelete };
  }

  async getArtifact(uid, artifactId) {
    const { artifact, root, role, canDelete } = await this.access(uid, artifactId);
    const out = { artifact: view(artifact), role, canDelete, realtime: this.realtimeView(this.activeRealtime(artifact, root), uid) };
    if (role === 'owner' && !artifact.parentFolderId) Object.assign(out.artifact, sharingView(artifact));
    if (artifact.kind === 'folder') out.children = (await this.store.childrenOf(artifact._id)).map(view);
    if (artifact.parentFolderId) out.folder = view(root);
    return out;
  }

  /**
   * The tick's check with a change cursor: when the caller's feed has not moved since `cursor`
   * (the value its last full check returned), nothing it holds changed, and the answer costs one
   * read. Realtime items always take the full path (their leases are renewed by checks).
   */
  async checkSince(uid, items, cursor) {
    if (!Array.isArray(items)) throw badRequest('items required');
    const seq = await this.store.feedSeq(uid); // read before the data, so a later change bumps past it
    if (cursor !== undefined && cursor !== null && Number(cursor) === seq && !items.some((i) => i.realtime)) return { unchanged: true, cursor: seq };
    return { results: await this.check(uid, items), cursor: seq };
  }

  /**
   * One batched call per tick (DESIGN §6.1): items are [{artifactId, version}].
   * Returns per item: ok | changed (with state) | gone (purged or access revoked), plus the role.
   */
  async check(uid, items) {
    if (!Array.isArray(items)) throw badRequest('items required');
    const ids = [...new Set(items.map((i) => i.artifactId))];
    const arts = new Map((await this.store.artifactsByIds(ids)).map((a) => [a._id, a]));
    const parentIds = [...new Set([...arts.values()].map((a) => a.parentFolderId).filter((p) => p && !arts.has(p)))];
    for (const p of await this.store.artifactsByIds(parentIds)) arts.set(p._id, p);
    const rootIds = [...new Set([...arts.values()].map((a) => a.parentFolderId || a._id))];
    const grants = new Map((await this.store.grantsOf(uid, rootIds)).map((g) => [g.artifactId, g]));
    const changedFolders = items.filter((i) => arts.get(i.artifactId)?.kind === 'folder' && arts.get(i.artifactId).currentVersion !== i.version).map((i) => i.artifactId);
    const kids = changedFolders.length ? await this.store.childrenOfMany(changedFolders) : [];
    const now = Date.now();
    const user = items.some((i) => i.realtime) ? await this.store.userById(uid) : null;
    const results = [];
    for (const { artifactId, version, realtime } of items) {
      const a = arts.get(artifactId);
      if (!a) {
        results.push({ artifactId, status: 'gone', reason: 'purged' });
        continue;
      }
      const root = a.parentFolderId ? arts.get(a.parentFolderId) : a;
      if (!root) {
        results.push({ artifactId, status: 'gone', reason: 'purged' });
        continue;
      }
      const { role, canDelete } = this.roleOf(uid, root, grants.get(root._id));
      if (!role) {
        results.push({ artifactId, status: 'gone', reason: 'revoked' });
        continue;
      }
      let rt = a.kind === 'file' ? this.activeRealtime(a, root, now) : null;
      // The holder's client renews its lease with every check (re-claiming it if it lapsed and nobody took it).
      if (realtime && role !== 'viewer' && (!rt || rt.uid === uid) && !a.deleted) {
        if (!rt && a.realtime && a.realtime.uid !== uid) await this.store.releaseRealtime(a._id, a.realtime.uid);
        const session = { uid, email: user?.email ?? uid, since: rt?.since ?? now, expiresAt: now + this.realtimeTtlMs };
        if (await this.store.claimRealtime(a._id, uid, session, now)) {
          if (!rt) await this.touch(root);
          rt = session;
        }
      }
      const out = { artifactId, role, canDelete, version: a.currentVersion, folderDeleted: !!(a.parentFolderId && root.deleted), realtime: this.realtimeView(rt, uid) };
      if (a.currentVersion === version) {
        results.push({ ...out, status: 'ok' });
        continue;
      }
      out.status = 'changed';
      out.state = view(a);
      if (a.kind === 'folder') out.children = kids.filter((k) => k.parentFolderId === a._id).map(view);
      results.push(out);
    }
    return results;
  }

  /**
   * Push a change from an edit session (DESIGN §6.3). Compare-and-set on the base version:
   * 409 with the current state if the server has moved on.
   * change: { blob, size } and/or { relPath } (files in folders) and/or { deleted: true }.
   */
  async commit(uid, artifactId, { baseVersion, change = {} }) {
    const { artifact: a, root, role, canDelete } = await this.access(uid, artifactId);
    if (role === 'viewer') throw forbidden('viewers cannot push changes');
    if (change.deleted && !canDelete) throw forbidden('you do not have delete permission');
    if (a.deleted) throw conflict('artifact has been deleted', { current: view(a) });
    if (a.currentVersion !== baseVersion) throw conflict('the artifact changed on the server', { current: view(a) });
    const set = {};
    const types = [];
    if (change.blob !== undefined && change.blob !== a.blob) {
      if (a.kind !== 'file') throw badRequest('folders have no content');
      set.blob = change.blob;
      Object.assign(set, await this.checkContent(change.blob, change.size, change.chunks, a.chunks ?? []));
      types.push('content');
    }
    if (change.relPath !== undefined && change.relPath !== a.relPath) {
      if (!a.parentFolderId) throw badRequest('only files inside a folder have a synced path');
      this.checkLayout([...(await this.liveSiblingPaths(a.parentFolderId, a._id)), change.relPath]);
      set.relPath = change.relPath;
      set.name = path.posix.basename(change.relPath);
      types.push('move');
    }
    if (change.deleted) {
      set.deleted = true;
      types.push('delete');
    }
    if (!types.length) return { version: a.currentVersion, unchanged: true };
    if (change.gitCommit !== undefined && change.gitCommit !== null && !/^[0-9a-f]{40,64}$/.test(String(change.gitCommit))) throw badRequest('invalid git commit');
    set.gitCommit = change.gitCommit ?? null;
    set.updatedAt = new Date();
    if (!(await this.store.casArtifact(a._id, baseVersion, set))) {
      throw conflict('the artifact changed on the server', { current: view(await this.store.artifactById(a._id)) });
    }
    const next = { ...a, ...set };
    await this.store.insertVersion({ ...this.snapshot(next), artifactId: a._id, version: baseVersion + 1, type: types.join('+'), authorUid: uid, createdAt: new Date(), basedOn: baseVersion });
    if (a.parentFolderId && (set.relPath || set.deleted)) {
      await this.bumpFolder(a.parentFolderId, uid, { type: set.deleted ? 'delete' : 'move', childId: a._id, relPath: next.relPath });
    }
    await this.touch(root);
    return { version: baseVersion + 1, state: view({ ...next, currentVersion: baseVersion + 1 }) };
  }

  /** Forward-only rollback (owner): a new version copies an old version's state. Also restores deletes. */
  async rollback(uid, artifactId, toVersion) {
    const { artifact: a, root } = await this.requireOwner(uid, artifactId);
    if (a.kind !== 'file') throw badRequest('roll back individual files inside a folder');
    const v = await this.store.version(a._id, Number(toVersion));
    if (!v) throw notFound(`version ${toVersion} not found`);
    const set = { blob: v.blob, size: v.size, chunks: v.chunks ?? null, deleted: !!v.deleted, gitCommit: null, updatedAt: new Date() };
    if (a.parentFolderId) {
      set.relPath = v.relPath;
      set.name = path.posix.basename(v.relPath);
      if (!set.deleted) this.checkLayout([...(await this.liveSiblingPaths(a.parentFolderId, a._id)), v.relPath]);
    }
    if (!(await this.store.casArtifact(a._id, a.currentVersion, set))) throw conflict('the artifact changed while rolling back');
    const version = a.currentVersion + 1;
    await this.store.insertVersion({ ...this.snapshot({ ...a, ...set }), artifactId: a._id, version, type: a.deleted && !set.deleted ? 'restore' : 'rollback', rolledBackTo: v.version, authorUid: uid, createdAt: new Date(), basedOn: a.currentVersion });
    if (a.parentFolderId && (set.relPath !== a.relPath || set.deleted !== !!a.deleted)) {
      await this.bumpFolder(a.parentFolderId, uid, { type: set.deleted ? 'delete' : 'restore', childId: a._id, relPath: set.relPath });
    }
    await this.touch(root);
    return view({ ...a, ...set, currentVersion: version });
  }

  /** Soft-delete for everyone (owner, or editor with delete permission). */
  async deleteArtifact(uid, artifactId) {
    const { artifact: a, canDelete } = await this.access(uid, artifactId);
    if (!canDelete) throw forbidden('you do not have delete permission');
    if (a.deleted) return view(a);
    if (a.kind === 'folder') {
      await this.store.casArtifact(a._id, a.currentVersion, { deleted: true });
      await this.store.insertVersion({ artifactId: a._id, version: a.currentVersion + 1, type: 'delete', deleted: true, authorUid: uid, createdAt: new Date(), basedOn: a.currentVersion });
      await this.touch(a);
      return view({ ...a, deleted: true, currentVersion: a.currentVersion + 1 });
    }
    return (await this.commit(uid, artifactId, { baseVersion: a.currentVersion, change: { deleted: true } })).state;
  }

  /** Restore a soft-deleted folder (owner). Files are restored with rollback. */
  async restoreFolder(uid, artifactId) {
    const { artifact: a } = await this.requireOwner(uid, artifactId);
    if (a.kind !== 'folder' || !a.deleted) throw badRequest('not a deleted folder');
    await this.store.casArtifact(a._id, a.currentVersion, { deleted: false });
    await this.store.insertVersion({ artifactId: a._id, version: a.currentVersion + 1, type: 'restore', deleted: false, authorUid: uid, createdAt: new Date(), basedOn: a.currentVersion });
    await this.touch(a);
    return view({ ...a, deleted: false, currentVersion: a.currentVersion + 1 });
  }

  async history(uid, artifactId) {
    await this.access(uid, artifactId);
    const versions = await this.store.versionsOf(artifactId);
    const users = new Map((await this.store.usersByIds([...new Set(versions.map((v) => v.authorUid))])).map((u) => [u._id, u]));
    return versions.map(({ _id, artifactId: _, chunks: __, ...v }) => ({ ...v, author: users.get(v.authorUid)?.email ?? '(deleted user)' }));
  }

  // ---- sharing ----

  async resolveUser(email) {
    const u = await this.store.userByEmail(String(email || '').trim().toLowerCase());
    if (!u) throw notFound(`no Tether user with email ${email}`);
    return u;
  }

  /**
   * Owner-only sharing changes. op is one of:
   * { addEditor: email, canDelete } | { revoke: email } | { visibility, allow: [email] } | { rotate: true }
   */
  async share(uid, artifactId, op) {
    const { artifact: a } = await this.requireOwner(uid, artifactId);
    if (a.parentFolderId) throw badRequest('share the folder, not a file inside it');
    const update = { $set: {}, $unset: {} };
    if (op.addEditor) {
      const u = await this.resolveUser(op.addEditor);
      if (u._id === uid) throw badRequest('you are the owner');
      update.$set[`editors.${u._id}`] = { canDelete: !!op.canDelete };
    } else if (op.revoke) {
      const u = await this.resolveUser(op.revoke);
      update.$unset[`editors.${u._id}`] = '';
      update.$set.allowlist = (a.allowlist ?? []).filter((x) => x !== u._id);
      await this.store.deleteGrant(a._id, u._id);
    } else if (op.demote) {
      const u = await this.resolveUser(op.demote);
      if (!a.editors?.[u._id]) throw badRequest(`${op.demote} is not an editor`);
      update.$unset[`editors.${u._id}`] = '';
      update.$set.allowlist = [...new Set([...(a.allowlist ?? []), u._id])];
    } else if (op.visibility) {
      if (!['link', 'allowlist'].includes(op.visibility)) throw badRequest('visibility must be link or allowlist');
      update.$set.visibility = op.visibility;
      if (op.allow) update.$set.allowlist = [...new Set([...(a.allowlist ?? []), ...(await Promise.all(op.allow.map((e) => this.resolveUser(e)))).map((u) => u._id)])];
    } else if (op.allow) {
      update.$set.allowlist = [...new Set([...(a.allowlist ?? []), ...(await Promise.all(op.allow.map((e) => this.resolveUser(e)))).map((u) => u._id)])];
    } else if (op.rotate) {
      update.$set.shareId = newShareId();
    } else throw badRequest('unknown share operation');
    if (!Object.keys(update.$unset).length) delete update.$unset;
    if (!Object.keys(update.$set).length) delete update.$set;
    const before = await this.audience(a);
    await this.store.updateArtifact(a._id, update);
    await this.touch(await this.store.artifactById(a._id), before);
    return this.sharing(uid, artifactId);
  }

  async sharing(uid, artifactId) {
    const { artifact: a } = await this.requireOwner(uid, artifactId);
    const ids = [...Object.keys(a.editors ?? {}), ...(a.allowlist ?? [])];
    const users = new Map((await this.store.usersByIds(ids)).map((u) => [u._id, u]));
    const label = (id) => users.get(id)?.email ?? id;
    return {
      shareId: a.shareId,
      visibility: a.visibility,
      editors: Object.entries(a.editors ?? {}).map(([id, e]) => ({ uid: id, email: label(id), canDelete: !!e.canDelete })),
      allowlist: (a.allowlist ?? []).map((id) => ({ uid: id, email: label(id) })),
    };
  }

  /** Artifacts other people shared with the caller as an editor or by allowlist. */
  async sharedWithMe(uid) {
    return (await this.store.artifactsWhereMember(uid)).map((a) => ({ ...view(a), role: a.editors?.[uid] ? 'editor' : 'viewer' }));
  }

  // ---- blobs ----

  async blobsToUpload(blobs) {
    const out = [];
    for (const { sha256: sha, size } of blobs ?? []) {
      if (!/^[0-9a-f]{64}$/.test(String(sha))) throw badRequest('invalid blob hash');
      if (size > this.maxFileSize) throw tooLarge(`file is larger than the ${this.maxFileSize} byte limit`);
      if (!(await this.blobs.has(sha))) out.push({ sha256: sha, ...(await this.blobs.uploadTarget(sha, size)) });
    }
    return out;
  }

  async receiveBlob(sha, query, bytes) {
    if (!this.blobs.verify('put', sha, query)) throw forbidden('upload URL invalid or expired');
    if (bytes.length > this.maxFileSize) throw tooLarge('file too large');
    if (bytes.length !== Number(query.size)) throw badRequest('size does not match');
    if (sha256(bytes) !== sha) throw badRequest('content does not match its hash');
    await this.blobs.put(sha, bytes);
  }

  /** Signed download URLs for (artifactId, version?) pairs the caller can read. */
  /** File content for the console's preview (served by the API: browsers cannot read Storage directly). */
  async content(uid, artifactId, version) {
    const { artifact: a } = await this.access(uid, artifactId);
    if (a.kind !== 'file') throw badRequest('folders have no content');
    const state = await this.versionState(a, version);
    if (!state.blob) throw notFound('this version has no content');
    return { name: a.name, bytes: state.chunks ? await this.assemble(state) : await this.blobs.read(state.blob) };
  }

  // ---- chunks (delta sync) ----

  /** Which chunks still need uploading. With artifactId, chunks of its current version are known to exist. */
  async chunksMissing(uid, hashes, artifactId) {
    if (!Array.isArray(hashes) || hashes.length > 20000 || !hashes.every((h) => HASH.test(String(h)))) throw badRequest('invalid chunk hashes');
    let known = new Set();
    if (artifactId) {
      const { artifact: a } = await this.access(uid, artifactId);
      known = new Set(this.manifestOf(a).map((c) => c.h));
    }
    return this.missingChunks([...new Set(hashes)].filter((h) => !known.has(h)));
  }

  /** Stores uploaded chunks: entries [{h, s}] describe consecutive slices of body. */
  async putChunks(entries, body) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw badRequest('invalid chunk list');
    let offset = 0;
    const parts = entries.map(({ h, s }) => {
      if (!HASH.test(String(h)) || !Number.isInteger(s) || s < 0 || s > CHUNK_MAX) throw badRequest('invalid chunk');
      const bytes = body.subarray(offset, offset + s);
      offset += s;
      if (bytes.length !== s || sha256(bytes) !== h) throw badRequest('chunk content does not match its hash');
      return { h, bytes };
    });
    if (offset !== body.length) throw badRequest('body size does not match the chunk list');
    await mapLimit(parts, 48, ({ h, bytes }) => this.blobs.put(h, bytes));
    return { stored: parts.length };
  }

  /** Chunk lists for versions the caller can read. */
  async manifests(uid, items) {
    if (!Array.isArray(items) || items.length > 500) throw badRequest('items required');
    const out = [];
    for (const { artifactId, version } of items) {
      const { artifact: a } = await this.access(uid, artifactId);
      if (a.kind !== 'file') throw badRequest('folders have no content');
      const s = await this.versionState(a, version);
      out.push({ artifactId, version: s.version, blob: s.blob, size: s.size ?? 0, chunks: this.manifestOf(s) });
    }
    return out;
  }

  /** Bytes of the requested chunks of one version, concatenated in request order. */
  async fetchChunks(uid, { artifactId, version, hashes }) {
    const { artifact: a } = await this.access(uid, artifactId);
    const s = await this.versionState(a, version);
    const inManifest = new Map(this.manifestOf(s).map((c) => [c.h, c.s]));
    if (!Array.isArray(hashes) || !hashes.length) throw badRequest('hashes required');
    let total = 0;
    for (const h of hashes) {
      if (!inManifest.has(h)) throw forbidden('chunk is not part of this version');
      total += inManifest.get(h);
    }
    if (total > FETCH_LIMIT && hashes.length > 1) throw tooLarge('request fewer chunks at a time');
    return Buffer.concat(await mapLimit(hashes, 64, (h) => this.blobs.read(h)));
  }

  async downloadUrls(uid, items) {
    const out = [];
    for (const { artifactId, version } of items ?? []) {
      const { artifact: a } = await this.access(uid, artifactId);
      const s = await this.versionState(a, version);
      const sha = s.blob;
      if (!sha) throw badRequest('nothing to download');
      // Older clients download whole files: assemble chunked content once, on demand.
      if (s.chunks && !(await this.blobs.has(sha))) await this.blobs.put(sha, await this.assemble(s));
      out.push({ artifactId, version: s.version, sha256: sha, url: await this.blobs.downloadUrl(sha) });
    }
    return out;
  }

  // ---- account ----

  async me(uid) {
    const u = await this.store.userById(uid);
    if (!u) throw notFound('account not found');
    return publicUser(u);
  }

  /** Account deletion: purge owned repos (server only) and remove the user from others' sharing. */
  async deleteAccount(uid) {
    for (const repo of await this.store.reposOf(uid)) await this.deleteRepo(uid, repo._id);
    for (const a of await this.store.artifactsWhereMember(uid)) {
      await this.store.updateArtifact(a._id, { $unset: { [`editors.${uid}`]: '' }, $pull: { allowlist: uid } });
    }
    await this.store.deleteGrantsOfUser(uid);
    await this.store.deleteSessionsOf(uid);
    await this.store.deleteUser(uid);
  }
}
