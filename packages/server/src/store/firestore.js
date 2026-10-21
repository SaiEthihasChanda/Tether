// Firestore storage adapter: same methods and semantics as MongoStore.
// Collections: users, sessions, cliCodes, repos, artifacts, versions, grants, feeds.
// Only the server (Admin SDK) touches Firestore; security rules deny all client access.
import { Timestamp, FieldValue } from 'firebase-admin/firestore';

const CHUNK = 30; // Firestore 'in' query limit
const BATCH = 400;

const duplicate = (msg) => Object.assign(new Error(msg), { code: 11000 });

function fromDoc(snap) {
  if (!snap.exists) return null;
  const data = snap.data();
  for (const [k, v] of Object.entries(data)) if (v instanceof Timestamp) data[k] = v.toDate();
  return { ...data, _id: snap.id };
}

function toDoc(obj) {
  const { _id, ...rest } = obj;
  for (const [k, v] of Object.entries(rest)) if (v === undefined) delete rest[k];
  return rest;
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  o[keys.at(-1)] = value;
}
function unsetPath(obj, dotted) {
  const keys = dotted.split('.');
  const parent = getPath(obj, keys.slice(0, -1).join('.')) ?? (keys.length === 1 ? obj : null);
  if (parent) delete parent[keys.at(-1)];
}

/** Applies a Mongo-style update ($set, $unset, $pull, $inc with dotted paths) to a plain object. */
export function applyUpdate(doc, update) {
  const out = structuredClone(doc);
  for (const [k, v] of Object.entries(update.$set ?? {})) setPath(out, k, v);
  for (const k of Object.keys(update.$unset ?? {})) unsetPath(out, k);
  for (const [k, v] of Object.entries(update.$pull ?? {})) setPath(out, k, (getPath(out, k) ?? []).filter((x) => x !== v));
  for (const [k, v] of Object.entries(update.$inc ?? {})) setPath(out, k, (getPath(out, k) ?? 0) + v);
  return out;
}

/** Everyone listed on an artifact, for the "shared with me" query. */
const withMembers = (a) => ({ ...a, memberUids: [...new Set([...Object.keys(a.editors ?? {}), ...(a.allowlist ?? [])])] });

export class FirestoreStore {
  constructor(db) {
    this.db = db;
    this.c = (name) => db.collection(name);
  }

  async init() {}
  async close() {}

  async all(query) {
    return (await query.get()).docs.map(fromDoc);
  }

  async getMany(name, ids) {
    if (!ids.length) return [];
    const snaps = await this.db.getAll(...ids.map((id) => this.c(name).doc(id)));
    return snaps.map(fromDoc).filter(Boolean);
  }

  async inQuery(name, field, values) {
    const out = [];
    for (const part of chunks(values, CHUNK)) out.push(...(await this.all(this.c(name).where(field, 'in', part))));
    return out;
  }

  async deleteWhere(name, field, op, value) {
    const snap = await this.c(name).where(field, op, value).get();
    for (const part of chunks(snap.docs, BATCH)) {
      const b = this.db.batch();
      for (const d of part) b.delete(d.ref);
      await b.commit();
    }
  }

  // users
  async createUser(user) {
    await this.c('users').doc(user._id).create(toDoc(user));
  }
  async userByEmail(email) {
    return (await this.all(this.c('users').where('email', '==', email).limit(1)))[0] ?? null;
  }
  async userById(uid) {
    return fromDoc(await this.c('users').doc(uid).get());
  }
  usersByIds(uids) {
    return this.getMany('users', [...new Set(uids)]);
  }
  async deleteUser(uid) {
    await this.c('users').doc(uid).delete();
  }

  // sessions and CLI login codes
  async createSession(s) {
    await this.c('sessions').doc(s._id).set(toDoc(s));
  }
  async sessionByHash(hash) {
    return fromDoc(await this.c('sessions').doc(hash).get());
  }
  async deleteSession(hash) {
    await this.c('sessions').doc(hash).delete();
  }
  deleteSessionsOf(uid) {
    return this.deleteWhere('sessions', 'uid', '==', uid);
  }
  async putCliCode(c) {
    await this.c('cliCodes').doc(c._id).set(toDoc(c));
  }
  takeCliCode(code) {
    const ref = this.c('cliCodes').doc(code);
    return this.db.runTransaction(async (tx) => {
      const doc = fromDoc(await tx.get(ref));
      if (!doc) return null;
      tx.delete(ref);
      return doc.expiresAt > new Date() ? doc : null;
    });
  }

  // repos (name unique per owner, like the Mongo unique index)
  createRepo(repo) {
    return this.db.runTransaction(async (tx) => {
      const mine = await tx.get(this.c('repos').where('ownerUid', '==', repo.ownerUid));
      if (mine.docs.some((d) => d.get('name') === repo.name)) throw duplicate('repo name taken');
      tx.create(this.c('repos').doc(repo._id), toDoc(repo));
    });
  }
  async repoById(id) {
    return fromDoc(await this.c('repos').doc(id).get());
  }
  async reposOf(uid) {
    return (await this.all(this.c('repos').where('ownerUid', '==', uid))).sort((a, b) => a.createdAt - b.createdAt);
  }
  updateRepo(id, set) {
    const ref = this.c('repos').doc(id);
    return this.db.runTransaction(async (tx) => {
      const cur = fromDoc(await tx.get(ref));
      if (!cur) return;
      const owner = set.ownerUid ?? cur.ownerUid;
      const name = set.name ?? cur.name;
      if (set.name !== undefined || set.ownerUid !== undefined) {
        const theirs = await tx.get(this.c('repos').where('ownerUid', '==', owner));
        if (theirs.docs.some((d) => d.id !== id && d.get('name') === name)) throw duplicate('repo name taken');
      }
      tx.update(ref, set);
    });
  }
  async deleteRepo(id) {
    await this.c('repos').doc(id).delete();
  }

  // artifacts
  async insertArtifacts(list) {
    for (const part of chunks(list, BATCH)) {
      const b = this.db.batch();
      for (const a of part) b.create(this.c('artifacts').doc(a._id), toDoc(withMembers(a)));
      await b.commit();
    }
  }
  async artifactById(id) {
    return fromDoc(await this.c('artifacts').doc(id).get());
  }
  artifactsByIds(ids) {
    return this.getMany('artifacts', [...new Set(ids)]);
  }
  async artifactByShareId(shareId) {
    return (await this.all(this.c('artifacts').where('shareId', '==', shareId).limit(1)))[0] ?? null;
  }
  childrenOf(folderId) {
    return this.all(this.c('artifacts').where('parentFolderId', '==', folderId));
  }
  childrenOfMany(folderIds) {
    return this.inQuery('artifacts', 'parentFolderId', folderIds);
  }
  artifactsInRepo(repoId) {
    return this.all(this.c('artifacts').where('repoId', '==', repoId));
  }
  artifactsWhereMember(uid) {
    return this.all(this.c('artifacts').where('memberUids', 'array-contains', uid));
  }
  updateArtifact(id, update) {
    const ref = this.c('artifacts').doc(id);
    return this.db.runTransaction(async (tx) => {
      const cur = fromDoc(await tx.get(ref));
      if (!cur) return;
      tx.set(ref, toDoc(withMembers(applyUpdate(cur, update))));
    });
  }
  async updateArtifactsInRepo(repoId, update) {
    for (const a of await this.artifactsInRepo(repoId)) await this.updateArtifact(a._id, update);
  }
  /** Compare-and-set on currentVersion, in a transaction. Returns true if this caller won. */
  casArtifact(id, expectedVersion, set) {
    const ref = this.c('artifacts').doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('currentVersion') !== expectedVersion) return false;
      tx.update(ref, { ...set, currentVersion: expectedVersion + 1 });
      return true;
    });
  }
  bumpVersion(id) {
    const ref = this.c('artifacts').doc(id);
    return this.db.runTransaction(async (tx) => {
      const v = (await tx.get(ref)).get('currentVersion') + 1;
      tx.update(ref, { currentVersion: v, updatedAt: new Date() });
      return v;
    });
  }
  /** Takes or renews a realtime lease unless someone else holds an unexpired one. */
  claimRealtime(id, uid, session, now) {
    const ref = this.c('artifacts').doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const cur = snap.get('realtime');
      if (cur && cur.uid !== uid && cur.expiresAt >= now) return false;
      tx.update(ref, { realtime: session });
      return true;
    });
  }
  /** Ends a realtime lease (only the given holder's, unless uid is null). */
  releaseRealtime(id, uid) {
    const ref = this.c('artifacts').doc(id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if (!uid || snap.get('realtime')?.uid === uid) tx.update(ref, { realtime: null });
    });
  }

  async deleteArtifacts(ids) {
    for (const part of chunks(ids, BATCH)) {
      const b = this.db.batch();
      for (const id of part) b.delete(this.c('artifacts').doc(id));
      await b.commit();
    }
  }

  // versions (doc id artifactId__version, so a duplicate version cannot be created)
  async insertVersion(v) {
    await this.c('versions').doc(`${v.artifactId}__${v.version}`).create(toDoc(v));
  }
  async versionsOf(artifactId) {
    return (await this.all(this.c('versions').where('artifactId', '==', artifactId))).sort((a, b) => a.version - b.version);
  }
  async version(artifactId, version) {
    return fromDoc(await this.c('versions').doc(`${artifactId}__${version}`).get());
  }
  async deleteVersionsOf(ids) {
    for (const id of ids) await this.deleteWhere('versions', 'artifactId', '==', id);
  }

  // link grants
  async addGrant(artifactId, uid, shareId) {
    await this.c('grants').doc(`${artifactId}__${uid}`).set({ artifactId, uid, shareId, at: new Date() });
  }
  async grant(artifactId, uid) {
    return fromDoc(await this.c('grants').doc(`${artifactId}__${uid}`).get());
  }
  async deleteGrant(artifactId, uid) {
    await this.c('grants').doc(`${artifactId}__${uid}`).delete();
  }
  grantsOf(uid, artifactIds) {
    return this.getMany('grants', artifactIds.map((a) => `${a}__${uid}`));
  }
  async deleteGrantsFor(ids) {
    for (const id of ids) await this.deleteWhere('grants', 'artifactId', '==', id);
  }
  deleteGrantsOfUser(uid) {
    return this.deleteWhere('grants', 'uid', '==', uid);
  }
  async grantsFor(artifactId) {
    return (await this.c('grants').where('artifactId', '==', artifactId).get()).docs.map((d) => d.get('uid'));
  }

  // change feeds: one counter per user, bumped whenever something they may hold changes
  async bumpFeeds(uids) {
    for (const part of chunks(uids, BATCH)) {
      const b = this.db.batch();
      for (const uid of part) b.set(this.c('feeds').doc(uid), { seq: FieldValue.increment(1) }, { merge: true });
      await b.commit();
    }
  }
  async feedSeq(uid) {
    return (await this.c('feeds').doc(uid).get()).get('seq') ?? 0;
  }
}
