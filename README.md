# Tether

Tether keeps files and folders identical to a central source of truth, wherever they live on Windows or Linux. The full spec is in [DESIGN.md](DESIGN.md).

```
packages/
  shared/   line-ending normalization, name validation, IDs (used by server and client)
  server/   REST API: MongoDB metadata, filesystem blobs, local email/password auth
  client/   `tether` CLI + `tetherd` daemon (SQLite map, blob cache, trackers, sync engine)
  console/  React web console (served by the server once built)
test/       end-to-end tests: real server, real daemons, real files, real browser
```

## Requirements

- Node.js 22.13 or newer (24 recommended).
- Windows 10/11 on NTFS or ReFS, or Linux.
- Nothing else to install. The dev server downloads and runs its own MongoDB the first time it starts.

## Run it locally

```sh
npm install
npm run console:build      # build the web console (served by the server)
npm run server             # http://127.0.0.1:8787; data in ./.tether-dev/server
```

To use an existing MongoDB instead of the embedded one, set `TETHER_MONGO_URL=mongodb://...`. Other settings are `TETHER_PORT`, `TETHER_DATA_DIR`, and `TETHER_MAX_FILE_SIZE` (bytes; the default is 10 MB).

To use the CLI, run `npm link -w @tether/client` so `tether` is on your PATH, or use `npm run tether -- <args>`:

```sh
tether login                         # opens the console; or: tether login --email you@x.com --password ... --signup
tether repo create team
tether manage .editorconfig --repo team     # prints a share ID
tether pull abcd-efgh-jkmn                  # on another machine or account
tether status
tether edit .editorconfig    # ...change it...    tether done .editorconfig
tether share .editorconfig --editor friend@example.com
tether daemon install        # start tetherd at login
```

The CLI starts the daemon automatically when needed. Run `tether --help` to see every command.

The console is at http://127.0.0.1:8787. For live reload, run `npm run console:dev` (http://127.0.0.1:5173, with the API proxied to :8787).

## Tests

```sh
npm test            # 75 tests, about 90 s
```

- The server tests start an in-memory MongoDB.
- The end-to-end tests run several isolated clients (`TETHER_HOME` per simulated machine) against one server.
- The console tests drive the installed Edge or Chrome through `playwright-core`, and are skipped if neither is found.
- The start-at-login test writes a `TetherTest` value under `HKCU\...\Run` and removes it again.

## Moving to Firebase later

The server keeps storage, blobs and auth behind small adapters, so each can be replaced on its own:

| Local (now) | Firebase (later) | Where |
|---|---|---|
| `MongoStore` | Firestore (Admin SDK) | `packages/server/src/store/mongo.js` |
| `FsBlobStore` + HMAC-signed URLs | Cloud Storage signed URLs | `packages/server/src/blobs/fs.js` |
| `LocalAuth` (email + password) | Firebase Auth ID tokens | `packages/server/src/auth/local.js` |
| Express app | Cloud Functions (`onRequest`) | `packages/server/src/app.js` |

All rules live in `service.js`, and that file doesn't change. Version checks are compare-and-set on `currentVersion`, which maps to a Firestore transaction.

## Not done yet

- **Linux:** the `fanotify` root helper is not built (the trial is deferred). Linux uses the no-root scan tracker, which is tested on Windows via `TETHER_TRACKER=scan` but not yet on a Linux kernel.
- **Linux credentials** are stored in a file with mode 0600, not yet in Secret Service. Windows uses DPAPI.
- **Deferred in DESIGN §12:** polling cost, push notifications, delta sync, history retention, and blob garbage collection.
