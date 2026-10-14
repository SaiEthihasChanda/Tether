#!/usr/bin/env node
// Local development server.
//   TETHER_MONGO_URL   MongoDB URL; if unset, an embedded MongoDB is started (mongodb-memory-server)
//   TETHER_PORT        default 8787
//   TETHER_DATA_DIR    default ./.tether-dev/server (blobs, signing secret, embedded DB files)
//   TETHER_MAX_FILE_SIZE  bytes, default 10 MB
import path from 'node:path';
import fs from 'node:fs';
import { startServer, DEFAULT_MAX_FILE_SIZE } from './index.js';

const dataDir = path.resolve(process.env.TETHER_DATA_DIR ?? '.tether-dev/server');
let mongoUrl = process.env.TETHER_MONGO_URL;
let embedded;

if (!mongoUrl) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const dbPath = path.join(dataDir, 'mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  embedded = await MongoMemoryServer.create({ instance: { dbPath, storageEngine: 'wiredTiger', port: 27827 } });
  mongoUrl = embedded.getUri();
  console.log(`embedded MongoDB at ${mongoUrl} (data in ${dbPath})`);
}

const server = await startServer({
  port: Number(process.env.TETHER_PORT ?? 8787),
  mongoUrl,
  dataDir,
  maxFileSize: Number(process.env.TETHER_MAX_FILE_SIZE ?? DEFAULT_MAX_FILE_SIZE),
});
console.log(`tether server listening on ${server.url}`);

async function shutdown() {
  await server.close();
  if (embedded) await embedded.stop({ doCleanup: false });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
