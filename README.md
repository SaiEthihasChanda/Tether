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

## Use the hosted service

Production runs on Firebase (project `tether-b10cf`):

| | |
|---|---|
| Web console | https://tether-b10cf.web.app |
| API | Cloud Function `api` in asia-south1, reached through Hosting at `/v1/**` |
| Metadata | Firestore |
| File content | Cloud Storage |
| Sign-in | Firebase Auth (email and password) |

The CLI uses the hosted service by default:

```sh
npm install
npm link -w @tether/client           # puts `tether` on your PATH
tether login                         # browser sign-in; or: tether login --email you@x.com --password ... [--signup]
tether repo create team
tether manage .editorconfig --repo team     # prints a share ID
tether pull abcd-efgh-jkmn                  # on another machine or account
tether status
tether edit .editorconfig    # ...change it...    tether done .editorconfig
tether share .editorconfig --editor friend@example.com
tether daemon install        # start tetherd at login
tether edit notes.md --realtime   # editors: every save is pushed live until `tether done`
tether update                # install the latest tether-sync from npm
tether git repo/.eslintrc --mode follow   # in a git repo: publish git's changes instead of reverting them
tether config set notifications errors    # desktop notifications: all | errors | off
```

**Files inside git repositories.** When you `manage` or `pull` into a git repo, Tether asks how to share the file with git:
1. **keep:** Tether stays the mirror, so git's changes may be reverted.
2. **skip:** don't manage the file.
3. **follow** (editors only): after a git pull, checkout, switch, merge or rebase, git's version is accepted and published to Tether. Git hooks are added to the repo for this.

Use `--git keep|follow|skip` to skip the question. Change it later with `tether git <path> --mode`.

**Notifications.** The daemon shows desktop notifications (Windows toasts, or `notify-send` on Linux) for:
- reverted changes (grouped)
- conflicts and failed pushes
- live sessions that end
- revoked access
- sign-in problems
- available updates

Clicking one opens the console.

The CLI starts the background daemon automatically when needed. Run `tether --help` to see every command.

## Release the CLI

1. Bump the version in `packages/client/package.json` and `packages/client/src/version.js`. The build refuses to run if they differ.
2. Run `npm run build:cli`.
3. Run `cd dist/npm` and `npm publish`, entering the Authy code when asked.
4. Approve the staged release on npmjs.com.

`tether update` then picks up the new version.

## Deploy

```sh
npm run deploy      # builds the console and the functions bundle, then deploys functions, hosting and rules
```

This needs `firebase login` with access to the project. The function's service account needs `roles/iam.serviceAccountTokenCreator` on itself, which is already granted, so it can sign Storage URLs and custom login tokens.

## Run everything locally (development)

```sh
npm run console:build
npm run server                                  # http://127.0.0.1:8787, embedded MongoDB, local auth
tether config set server http://127.0.0.1:8787  # point the CLI at it
```

Local server settings are `TETHER_MONGO_URL`, `TETHER_PORT`, `TETHER_DATA_DIR`, and `TETHER_MAX_FILE_SIZE` (default 10 MB). For live reload, run `npm run console:dev` (port 5173, with the API proxied to :8787).

## Tests

```sh
npm test                 # 112 tests on the local backend (in-memory MongoDB), about 90 s
npm run test:firebase    # the same 112 tests on Firestore + Firebase Auth emulators (needs Java)
node test/prod-smoke.mjs            # two real clients against production (temporary accounts, deleted afterwards)
node test/prod-console-smoke.mjs    # console + browser login against production
```

- The end-to-end tests run several isolated clients (`TETHER_HOME` per simulated machine) against one server.
- The console tests drive the installed Edge or Chrome through `playwright-core`.
- The start-at-login test writes a `TetherTest` value under `HKCU\...\Run` and removes it again.

## Backends

The server has two backends. Both use the same rules in `service.js`.

| Part | `local` (dev, tests) | `firebase` (production) |
|---|---|---|
| Metadata | `store/mongo.js` (MongoDB) | `store/firestore.js` (Firestore; compare-and-set via transactions) |
| Content | `blobs/fs.js` (HMAC-signed URLs) | `blobs/gcs.js` (Cloud Storage v4 signed URLs: create-only, size-capped; sha256 verified on first use) |
| Sign-in | `auth/local.js` (email + password) | `auth/firebase.js` (ID tokens; custom tokens for the CLI browser login) |
| Runs as | `npm run server` | Cloud Function (`src/functions.js`, bundled to `firebase/functions/lib`) |

Firestore and Storage security rules deny all direct client access: every read and write goes through the API.

## Not done yet

- **Linux:** the `fanotify` root helper is not built (the trial is deferred). Linux uses the no-root scan tracker, which is tested on Windows via `TETHER_TRACKER=scan` but not yet on a Linux kernel.
- **Linux credentials** are stored in a file with mode 0600, not yet in Secret Service. Windows uses DPAPI.
- **Deferred in DESIGN §12:** polling cost, push notifications, delta sync, history retention, and blob garbage collection. Each client calls the function once per tick (30 s by default). That is fine at small scale; watch the Cloud Functions bill as usage grows.
- The console doesn't load Google Analytics, even though the Firebase snippet includes it.
