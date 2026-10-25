// MongoDB storage adapter. The service layer only uses the methods below, so a
// Firestore adapter can replace this one without touching the API logic.
import { MongoClient } from 'mongodb';

export class MongoStore {
  static async connect(url, dbName) {
    const client = new MongoClient(url);
    await client.connect();
    const store = new MongoStore(client, client.db(dbName));
    await store.init();
    return store;
  }

  constructor(client, db) {
    this.client = client;
    this.db = db;
    this.users = db.collection('users');
    this.sessions = db.collection('sessions');
    this.cliCodes = db.collection('cliCodes');
    this.repos = db.collection('repos');
    this.artifacts = db.collection('artifacts');
    this.versions = db.collection('versions');
    this.grants = db.collection('grants');
    this.feeds = db.collection('feeds');
    this.instances = db.collection('instances');
  }

  async init() {
    await this.users.createIndex({ email: 1 }, { unique: true });
    await this.sessions.createIndex({ uid: 1 });
    await this.cliCodes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.repos.createIndex({ ownerUid: 1, name: 1 }, { unique: true });
    await this.artifacts.createIndex({ shareId: 1 }, { unique: true, partialFilterExpression: { shareId: { $type: 'string' } } });
    await this.artifacts.createIndex({ repoId: 1 });
    await this.artifacts.createIndex({ parentFolderId: 1 });
    await this.versions.createIndex({ artifactId: 1, version: 1 }, { unique: true });
    await this.grants.createIndex({ artifactId: 1, uid: 1 }, { unique: true });
    await this.instances.createIndex({ rootId: 1 });
    await this.instances.createIndex({ uid: 1, deviceId: 1 });
  }

  close() {
    return this.client.close();
  }

  // users
  createUser(user) { return this.users.insertOne(user); }
  userByEmail(email) { return this.users.findOne({ email }); }
  userById(uid) { return this.users.findOne({ _id: uid }); }
  usersByIds(uids) { return this.users.find({ _id: { $in: uids } }).toArray(); }
  deleteUser(uid) { return this.users.deleteOne({ _id: uid }); }

  // sessions (refresh tokens, stored hashed) and one-time CLI login codes
  createSession(s) { return this.sessions.insertOne(s); }
  sessionByHash(hash) { return this.sessions.findOne({ _id: hash }); }
  deleteSession(hash) { return this.sessions.deleteOne({ _id: hash }); }
  deleteSessionsOf(uid) { return this.sessions.deleteMany({ uid }); }
  putCliCode(c) { return this.cliCodes.insertOne(c); }
  async takeCliCode(code) {
    const doc = await this.cliCodes.findOneAndDelete({ _id: code });
    return doc && doc.expiresAt > new Date() ? doc : null;
  }

  // repos
  createRepo(repo) { return this.repos.insertOne(repo); }
  repoById(id) { return this.repos.findOne({ _id: id }); }
  reposOf(uid) { return this.repos.find({ ownerUid: uid }).sort({ createdAt: 1 }).toArray(); }
  updateRepo(id, set) { return this.repos.updateOne({ _id: id }, { $set: set }); }
  deleteRepo(id) { return this.repos.deleteOne({ _id: id }); }

  // artifacts
  insertArtifacts(list) { return list.length ? this.artifacts.insertMany(list) : null; }
  artifactById(id) { return this.artifacts.findOne({ _id: id }); }
  artifactsByIds(ids) { return this.artifacts.find({ _id: { $in: ids } }).toArray(); }
  artifactByShareId(shareId) { return this.artifacts.findOne({ shareId }); }
  childrenOf(folderId) { return this.artifacts.find({ parentFolderId: folderId }).toArray(); }
  childrenOfMany(folderIds) { return this.artifacts.find({ parentFolderId: { $in: folderIds } }).toArray(); }
  artifactsInRepo(repoId) { return this.artifacts.find({ repoId }).toArray(); }
  artifactsWhereMember(uid) {
    return this.artifacts.find({ $or: [{ [`editors.${uid}`]: { $exists: true } }, { allowlist: uid }] }).toArray();
  }
  updateArtifact(id, update) { return this.artifacts.updateOne({ _id: id }, update); }
  updateArtifactsInRepo(repoId, update) { return this.artifacts.updateMany({ repoId }, update); }
  /** Compare-and-set on currentVersion. Returns true if this caller won. */
  async casArtifact(id, expectedVersion, set) {
    const r = await this.artifacts.updateOne({ _id: id, currentVersion: expectedVersion }, { $set: { ...set, currentVersion: expectedVersion + 1 } });
    return r.modifiedCount === 1;
  }
  /** Atomically bump a folder's layout version; returns the new version. */
  async bumpVersion(id) {
    const doc = await this.artifacts.findOneAndUpdate({ _id: id }, { $inc: { currentVersion: 1 }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
    return doc.currentVersion;
  }
  deleteArtifacts(ids) { return this.artifacts.deleteMany({ _id: { $in: ids } }); }
  /** Takes or renews a realtime lease unless someone else holds an unexpired one. */
  async claimRealtime(id, uid, session, now) {
    const r = await this.artifacts.updateOne(
      { _id: id, $or: [{ realtime: null }, { 'realtime.uid': uid }, { 'realtime.expiresAt': { $lt: now } }] },
      { $set: { realtime: session } },
    );
    return r.matchedCount === 1;
  }
  /** Ends a realtime lease (only the given holder's, unless uid is null). */
  releaseRealtime(id, uid) {
    return this.artifacts.updateOne({ _id: id, ...(uid ? { 'realtime.uid': uid } : {}) }, { $set: { realtime: null } });
  }

  // versions
  insertVersion(v) { return this.versions.insertOne(v); }
  versionsOf(artifactId) { return this.versions.find({ artifactId }).sort({ version: 1 }).toArray(); }
  version(artifactId, version) { return this.versions.findOne({ artifactId, version }); }
  deleteVersionsOf(ids) { return this.versions.deleteMany({ artifactId: { $in: ids } }); }

  // link-based access grants: who pulled an artifact with which share ID
  async addGrant(artifactId, uid, shareId) {
    await this.grants.updateOne({ artifactId, uid }, { $set: { shareId, at: new Date() } }, { upsert: true });
  }
  grant(artifactId, uid) { return this.grants.findOne({ artifactId, uid }); }
  deleteGrant(artifactId, uid) { return this.grants.deleteOne({ artifactId, uid }); }
  grantsOf(uid, artifactIds) { return this.grants.find({ uid, artifactId: { $in: artifactIds } }).toArray(); }
  deleteGrantsFor(ids) { return this.grants.deleteMany({ artifactId: { $in: ids } }); }
  deleteGrantsOfUser(uid) { return this.grants.deleteMany({ uid }); }
  async grantsFor(artifactId) { return (await this.grants.find({ artifactId }).toArray()).map((g) => g.uid); }

  // change feeds: per user, a counter and the counter value at which each artifact last changed
  async bumpFeeds(uids, ids) {
    if (!uids.length) return;
    const stamp = Object.fromEntries(ids.map((id) => [id, '$seq']));
    await this.feeds.bulkWrite(uids.map((uid) => ({
      updateOne: {
        filter: { _id: uid },
        update: [
          { $set: { seq: { $add: [{ $ifNull: ['$seq', 0] }, 1] }, floor: { $ifNull: ['$floor', 0] } } },
          { $set: { changed: { $mergeObjects: [{ $ifNull: ['$changed', {}] }, stamp] } } },
        ],
        upsert: true,
      },
    })));
  }
  async feed(uid) {
    const f = await this.feeds.findOne({ _id: uid });
    return { seq: f?.seq ?? 0, floor: f?.floor ?? 0, changed: f?.changed ?? {}, unmanage: f?.unmanage ?? {} };
  }
  /** Owner asked to stop syncing these instances; the holder's daemon reads them from its feed. */
  async requestUnmanage(uid, instanceIds) {
    if (!instanceIds.length) return;
    const now = Date.now();
    await this.feeds.updateOne({ _id: uid }, { $set: Object.fromEntries(instanceIds.map((id) => [`unmanage.${id}`, now])) }, { upsert: true });
  }
  async ackUnmanage(uid, instanceIds) {
    if (!instanceIds.length) return;
    await this.feeds.updateOne({ _id: uid }, { $unset: Object.fromEntries(instanceIds.map((id) => [`unmanage.${id}`, ''])) });
  }

  // instances: copies daemons hold of root artifacts (reported, for the owner's usage view)
  async replaceDeviceInstances(uid, deviceId, docs) {
    if (docs.length) {
      await this.instances.bulkWrite(docs.map(({ _id, ...d }) => ({ replaceOne: { filter: { _id }, replacement: d, upsert: true } })));
    }
    await this.instances.deleteMany({ uid, deviceId, _id: { $nin: docs.map((d) => d._id) } });
  }
  instancesOfRoot(rootId) { return this.instances.find({ rootId }).toArray(); }
  async markInstances(ids, set) {
    if (ids.length) await this.instances.updateMany({ _id: { $in: ids } }, { $set: set });
  }
  deleteInstancesFor(rootIds) { return this.instances.deleteMany({ rootId: { $in: rootIds } }); }
  deleteInstancesOfUser(uid) { return this.instances.deleteMany({ uid }); }
}
