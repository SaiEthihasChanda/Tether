# Tether: Design Document

> Status: ideation / pre-implementation. Last updated 2026-10-13.
> Working name was "MicroManager".

## 1. What Tether is

Tether keeps files on users' machines identical to a central source of truth, **wherever the user puts them**.

An owner publishes files and folders into central repositories. Anyone who has an artifact's share ID can pull it with the `tether` CLI. From then on, the Tether client keeps that local copy in sync, follows it through renames and moves, and reverts local edits unless the user is deliberately editing.

It is closer to "desired-state configuration for files" than to Dropbox: drift gets corrected rather than merged.

**Primary users**
- Dev teams sharing config: lint configs, `.editorconfig`, `CLAUDE.md`/`AGENTS.md`, `.env.example`, compose files, scripts.
- Individuals syncing dotfiles across their own machines.
- Non-technical users sharing documents that should not drift (teaching material, templates, runbooks).

**Non-goals (for now)**
- Large binaries and datasets. A per-file size limit applies.
- External or removable drives and network shares.
- Real-time collaborative editing or merging.
- Preventing a user from keeping or modifying their own copy. Tether guarantees that unauthorized changes **never reach the source** and are **overwritten while tracked**, nothing more.

## 2. Glossary

| Term | Meaning |
|---|---|
| **Repository (repo)** | An owner-defined container on the server for organizing artifacts. |
| **Artifact** | A single managed file, identified by a permanent `artifactId`. |
| **Folder artifact** | An aggregate of file artifacts plus their relative layout. A folder is never synced as a blob; each file inside is its own artifact. |
| **Share ID** | The public, rotatable ID used to pull an artifact. It is separate from `artifactId` so that access can be revoked without breaking history. |
| **Instance** | One local copy of an artifact on one machine, identified by `instanceId`. The same artifact pulled twice gives two instances. |
| **Version** | An immutable entry in an artifact's history (content, rename, move, delete, or restore). |
| **Base version** | The version an instance last synced to. Used for conflict detection. |
| **Mode** | The local state of an instance: `normal`, `editing`, `unmanaged`, `lost`, `orphaned`. |

## 3. Roles and permissions

| Capability | Owner | Editor | Editor + delete | Viewer |
|---|:-:|:-:|:-:|:-:|
| Pull / track | ✓ | ✓ | ✓ | ✓ |
| Enter editing mode | ✓ | ✓ | ✓ | ✓ (changes can never be pushed) |
| Push content / rename / in-folder moves | ✓ | ✓ | ✓ | ✗ |
| Delete artifact for everyone | ✓ | ✗ | ✓ | ✗ |
| Add new files to a folder artifact (`tether add`) | ✓ | ✗ | ✗ | ✗ |
| Roll back to an earlier version | ✓ | ✗ | ✗ | ✗ |
| Manage editors, allowlist, visibility | ✓ | ✗ | ✗ | ✗ |
| Rotate share ID | ✓ | ✗ | ✗ | ✗ |
| Transfer ownership | ✓ | ✗ | ✗ | ✗ |

**Visibility**
- `link` (default): anyone with the current share ID can pull.
- `allowlist`: only listed users can pull, even if they hold the share ID.

**Enforcement happens on the server.** The client's checks are for user experience only. A modified client must not be able to push, delete, or read anything it couldn't through the official client.

**Demotion.** When an editor is demoted to viewer:
- The server rejects their pushes immediately.
- On the next tick, the client sees the role change, forces every editing-mode instance of that artifact back to `normal`, and reverts local work.
- An offline client only learns about the demotion when it reconnects. This is an accepted risk; it can never affect the source.

## 4. Local modes (state machine)

```
              tether pull / tether manage
                        │
                        ▼
   ┌──────────────── normal ◄───────────────┐
   │   (mirror: local changes are reverted, │
   │    incoming changes are applied)       │
   │                    │                   │
   │ tether edit        │ tether done       │ tether track
   ▼                    │ (resolve/push)    │ (prompt if diverged)
 editing ───────────────┘                   │
   │                                        │
   │ tether unmanage            unmanaged ──┘
   └──────────────────────────► (not synced; location still followed)

 Any mode ── file disappears (confirmed delete) ──► unmanaged (forgotten)
 Any mode ── identity lost (cannot be found) ────► lost  ── tether locate ──► previous mode
 Any mode ── artifact deleted / access revoked ──► orphaned (file stays on disk, untracked)
```

| Mode | Local changes | Incoming changes | Location tracked | Push |
|---|---|---|---|---|
| `normal` | Reverted on the next tick | Applied on the next tick | Yes | Never |
| `editing` | Kept | Not applied (recorded as pending) | Yes | Only when leaving editing (`tether done`) |
| `unmanaged` | Kept | Ignored | Yes | Never |
| `lost` | n/a | n/a | Searching | Never |
| `orphaned` | Kept | None (artifact gone) | No | Never |

**Normal mode is a mirror for everyone, owners and editors included.** Changes only reach the server through an explicit edit session, so accidental edits can never propagate.

**Editing vs unmanaged.** Editing is a temporary pause that resumes in place, and its changes may be pushed. Unmanaged lasts until `tether track`, and its changes are never pushed implicitly. Re-tracking runs the divergence prompt (§6.3).

Modes can be set on a single artifact or on a directory. A directory applies the mode to every instance under it.

## 5. Identity and tracking

### 5.1 The local map
Nothing is written into, or attached to, the user's files: no marker files, xattrs, or ADS. The client's local database is the only record of which files are artifacts.

Per instance it stores: `instanceId`, `artifactId`, `folderInstanceId?`, `path`, `volumeId`, `fileId`, `mode`, `baseVersion`, `baseHash`, `localHash`, `size`, `mtime`, `eolStyle`, `hasBom`, `lastSeenAt`.

- A **copy** of an artifact gets a new file ID, so it is not managed. Only the original instance is tracked.
- **Instance IDs** let the same artifact be pulled more than once on one machine.

### 5.2 Windows: `OpenFileById` + folder watchers (no admin rights)
1. **On every tick, and at startup:** for each instance, `OpenFileById(volume, fileId)`, then `GetFinalPathNameByHandle`. If the path changed, update the map.
   - Open with `FILE_READ_ATTRIBUTES` only, and share flags `READ | WRITE | DELETE`, so the handle never conflicts with Word, Excel, or other programs.
   - This also catches moves made while the client was not running.
2. **Folder watchers** (`ReadDirectoryChangesW`) on each instance's parent folder catch renames and atomic saves right away.
3. **When a tick finds an instance in a new folder,** start watching that folder at once. This narrows the "moved, then atomically saved before the next tick" gap.
4. Requires NTFS or ReFS. ReFS uses 128-bit IDs, so use `ExtendedFileIdType`.

### 5.3 Linux: `fanotify` (trial) + scan fallback
- A **small privileged helper** (root, kernel ≥ 5.17) uses `fanotify` with `FAN_REPORT_DFID_NAME | FAN_RENAME` on the relevant filesystems. It does nothing except forward rename, move, create, and delete events to the user-level client over a Unix socket. No networking, no file writes.
- **No-root fallback:** `inotify` watchers on instance parent folders, plus a scan.
- **Startup and catch-up scan:** `fanotify` keeps no history, so after downtime the client checks each last-known path, then scans (by default under `$HOME`) for a matching `(dev, inode)`, then for a matching content hash.
- Stability is to be evaluated in practice before committing to it.

### 5.4 Atomic saves are not deletes
Many editors save by writing a temp file and renaming it over the original (vim, VS Code, Office), which changes the file ID.
- When an instance's file disappears, start a **grace window (~2 s)** before treating it as deleted.
- If a file appears at the **same final path** within the window, re-link the instance to the new file ID. Match on the final path, not on editor-specific temp-file patterns, so Office's multi-rename sequence works too.
- Only after the window expires with no replacement is it a delete (§7).

### 5.5 The client's own writes
Writing a revert or an incoming version must not trigger the client's own change detection or change the file ID.
- **Write in place** (truncate + write), not temp-and-rename, to keep the file ID stable.
- Record a short "self-write" suppression entry so the watcher events it causes are ignored.
- If the file is locked by another process (common on Windows), skip and retry on the next tick. The instance shows `pending`.

### 5.6 Lost instances
If the file can't be found by ID, watcher events, or scan, the instance becomes `lost`. `tether locate <instance>` searches given folders by content hash (`baseHash`) and re-links on confirmation.

## 6. Sync algorithm

### 6.1 Each tick (default 30 s, configurable)
1. **Locate:** refresh the path and file ID for every instance (§5).
2. **Check remote (one call):** send `[(artifactId, baseVersion)]` for all instances and receive changed artifacts, role changes, deletions, and revocations. One batched request per tick, not one per file.
3. **Per instance, by mode:**
   - `normal`:
     - Incoming version → write it, set `baseVersion`.
     - Local change (§6.2) → revert to `baseVersion` from the **local blob cache** (works offline, no download).
   - `editing`: record pending incoming versions; touch nothing locally.
   - `unmanaged`: only follow the location.
4. Apply role changes (demotion → force back to normal) and deletions/revocations (→ `orphaned`).

### 6.2 Detecting a local change
1. Compare `size` and `mtime` with the stored values. If both match, it is unchanged.
2. Otherwise compute the **normalized** hash (§8) and compare with `baseHash`. A changed mtime with the same content is not a change.
3. For instances in a folder, also compare the relative path and name with the server layout.

### 6.3 Leaving editing mode (`tether done`) and re-tracking (`tether track`)

**Editors and owners:**
1. Build the change set: content changes, renames and moves within the folder, pending deletes.
2. Upload new blobs (content-addressed), then call `commit(artifactId, baseVersion, change)`.
3. The server checks, in a transaction, that `currentVersion == baseVersion` and that the user has the right role or permission.
   - **Accepted:** a new version is created, and `baseVersion` advances.
   - **Conflict (server moved on):** prompt per artifact:
     - **push**: overwrite the server version. Creates a new version; the overwritten one remains in history.
     - **accept incoming**: discard local changes.
     - **keep both**: save the local version as an unmanaged sibling (`name (local copy).ext`), then accept incoming.
     - **show diff**: show the diff, then ask again.
4. **Pending deletes** are listed and confirmed: *delete for everyone* (needs delete permission) or *just stop managing locally*.

**Viewers:** nothing can be pushed, so incoming changes must be resolved first. Offer **accept incoming**, **keep both**, **show diff**, or **cancel** (stay in editing). "Keep both" must always be available so no work is lost by surprise.

**Re-tracking** an unmanaged instance that diverged uses the same prompt.

## 7. Deletes and moves

| Situation | Result |
|---|---|
| Any user's file disappears (after the atomic-save grace window), including a move to another drive | Instance becomes **unmanaged / forgotten** locally. Nothing on the server changes. Pull again to get it back. |
| Viewer or editor moves/renames inside a tracked folder, in `normal` | Reverted: the file is moved back. |
| Editor moves/renames inside a tracked folder, in `editing` | Pushed as a layout change on `tether done`. |
| Editor moves a file **out of** the tracked folder, in `editing` | On `tether done`: with delete permission, it is removed from the shared folder for everyone (soft delete); without it, it is just unmanaged locally. |
| Viewer moves a file out of the folder, in `editing` | On `tether done`: **accept incoming** puts it back; **keep both** leaves their copy unmanaged and pulls a fresh one into the folder. |
| New file created inside a tracked folder | Ignored: it is a normal file. Only owners can add files (`tether add`). |
| Editor with delete permission deletes, then `tether done` | Asked: delete for everyone, or just stop managing locally. |

**Server-side deletes are soft deletes:** they are recorded as a version, and the owner can restore them. Hard purge happens only on repo or account deletion, or by retention policy.

**Repo deletion and account deletion purge server data only.** Every client instance becomes `orphaned`, and the files stay on disk. Tether never deletes files on another user's machine. A client that is offline keeps its copy indefinitely; this is accepted for now.

## 8. Cross-platform file content

### 8.1 Line endings and BOM
- **Text vs binary detection:** a file is binary if there is a NUL byte in the first 8 KB, same as git.
- **Text is normalized for hashing and comparison:** CRLF → LF, and a UTF-8 BOM is stripped. A line-ending or BOM difference alone is never a change.
- **The server stores canonical LF without BOM.**
- **On write,** each instance keeps the line ending and BOM style it already had. A fresh pull uses the platform default (CRLF on Windows, LF on Linux).
- **Per-repo or per-artifact override:** `eol: auto | lf | crlf | binary` (`binary` = exact bytes, no normalization). E.g. `*.sh → lf`, `*.bat → crlf`.

### 8.2 Name validation (server-side, at upload, rename, or add)
Reject anything that couldn't exist on both Windows and Linux:
- Names in the same folder that differ only by case (`README.md` vs `Readme.md`).
- Reserved Windows names: `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without an extension.
- The characters `< > : " / \ | ? *`, control characters, and a trailing dot or space.
- Paths beyond a safe length (a relative path under ~200 chars inside a folder artifact).

Case-only renames are allowed: the file ID is stable on NTFS and the change is pushed like any rename.

### 8.3 Other metadata
- **Symlinks:** not supported; rejected at upload.
- **Executable bit:** stored as metadata and applied on Linux only.
- **Size limit:** per file, enforced server-side (value TBD, §13).

## 9. Architecture

```
 ┌──────────── user machine ────────────┐        ┌────────────── Firebase ──────────────┐
 │                                      │        │                                      │
 │  tether (CLI) ── IPC ──► tetherd     │ HTTPS  │  Cloud Functions (API)               │
 │                 (named pipe /        │ ─────► │   - all writes, permission checks,   │
 │                  unix socket)        │        │     version transactions, validation │
 │                  │                   │        │  Firestore (metadata)                │
 │                  ├─ local DB (SQLite)│        │  Cloud Storage (blobs)               │
 │                  ├─ blob cache       │        │  Auth                                │
 │                  └─ watchers         │        │  Hosting ── React console            │
 │  [Linux] tether-helper (root,        │        │                                      │
 │          fanotify only)              │        └──────────────────────────────────────┘
 └──────────────────────────────────────┘
```

**Client (Rust)**
- `tether`: the CLI.
- `tetherd`: a per-user background daemon.
  - **Windows:** starts at login (Task Scheduler / Run key) as the user. No admin needed with the `OpenFileById` approach.
  - **Linux:** a `systemd --user` unit, plus an optional system unit for `tether-helper`.
- Likely crates: `clap`, `tokio`, `reqwest`, `rusqlite`, `notify`, `windows`, `nix`/`libc` (fanotify), `keyring`, `sha2`, `similar` (diffs).
- The daemon and CLI talk over local IPC. The CLI never touches the network directly.

**Server**
- **Clients never write directly to Firestore or Storage.** Security Rules deny client writes. Every mutation goes through Cloud Functions, which use the Admin SDK and do role checks, version-check transactions, name validation, and size limits in one trusted place. This also avoids needing a Firebase client SDK in Rust.
- **Blob transfer:** Functions issue short-lived signed URLs for upload and download.
- **Console:** React on Firebase Hosting. Repo management, sharing, history and rollback, ownership transfer.

**CLI auth:** `tether login` opens the browser to the console's `/cli-login` page, which signs in with Firebase Auth and returns a token to a localhost redirect (with a `state` nonce). The refresh token goes into the OS keychain (Windows Credential Manager / Secret Service).

## 10. Data model (Firestore + Storage)

```
users/{uid}
  displayName, email, createdAt

repos/{repoId}
  ownerUid, name, createdAt, eolDefaults{glob: mode}

artifacts/{artifactId}
  repoId, ownerUid
  kind: "file" | "folder"
  parentFolderId?          # for files inside a folder artifact
  relPath?                 # layout inside the folder (synced)
  name
  currentVersion: int
  currentBlob: sha256?     # files only
  deleted: bool
  shareId                  # rotatable; lookup via shareIds/{shareId}
  visibility: "link" | "allowlist"
  editors: { uid: { canDelete: bool } }
  allowlist: [uid]
  eol?: "auto" | "lf" | "crlf" | "binary"
  exec?: bool

artifacts/{artifactId}/versions/{version}
  type: "content" | "rename" | "move" | "delete" | "restore" | "rollback"
  blob?: sha256, name?, relPath?
  authorUid, createdAt
  basedOn: int             # the version the author edited from

shareIds/{shareId} → { artifactId }

Storage: blobs/{sha256}    # content-addressed; dedups identical versions;
                           # rename-only versions need no new blob
```

**Rollback is forward-only.** It creates a new version whose blob, name, and path are copied from the chosen old version. Clients just see an incoming change.

**ID rotation:** issue a new `shareId` and delete the old mapping. Old links stop working (see §13 for the effect on existing instances).

## 11. CLI surface (draft)

```
tether login | logout | whoami

tether repo create <name>
tether repo list
tether repo delete <repo>
tether repo transfer <repo> --to <user>

tether manage <path> --repo <repo> [--as <relPath>]   # upload; caller becomes owner
tether add <path> --to <folderArtifact>[/<relPath>]   # owner only
tether pull <shareId> [<dest>]
tether status [<path>]                                # modes, pending, conflicts, lost

tether edit <path|dir>                                # → editing
tether done <path|dir>                                # editing → normal (push / resolve)
tether unmanage <path|dir>
tether track <path|dir>                               # unmanaged → normal (prompt if diverged)
tether locate <instance> [--in <dir>...]

tether diff <path>
tether history <artifact>
tether rollback <artifact> --to <version>             # owner
tether delete <artifact>                              # owner / editor with delete permission

tether share <artifact> --editor <user> [--can-delete]
tether share <artifact> --revoke <user>
tether share <artifact> --visibility link|allowlist [--allow <user>...]
tether share <artifact> --rotate-id

tether daemon install | start | stop | status
tether config get|set <key> [<value>]                 # tick interval, eol defaults, scan roots
```

## 12. Deferred

- **Polling cost and Firebase quotas/pricing:** cost of a 30 s tick per client, function invocations, Storage egress. Cloud Storage now effectively requires the Blaze plan; check current pricing before launch. The batched per-tick call (§6.1) is the first mitigation.
- **Push notifications instead of polling:** e.g. an FCM or long-poll channel.
- **Delta sync** for larger files.
- **History retention policy** and storage growth.

## 12a. Implementation notes (2026-10-14)

The first build follows this document with these substitutions:
- **Client in Node.js, not Rust.**
  - Win32 is called through `koffi`; the local map uses `node:sqlite`.
  - The daemon IPC is a named pipe or Unix socket, as designed.
- **Firebase in production (2026-10-14):**
  - Firestore for metadata.
  - Cloud Storage for content.
  - Firebase Auth for sign-in.
  - The API runs as one Cloud Function (`api`, asia-south1) behind Hosting rewrites.
- **Local backend kept for development and tests:** MongoDB, filesystem blobs, local auth.
- **Cloud Storage does not check sha256**, so upload URLs are create-only and a blob is downloaded and hashed the first time an artifact references it. A mismatching blob is deleted.
- **Linux runs the no-root scan tracker.** The `fanotify` helper is deferred.

The build answered the open questions below as follows. Each is easy to change.

| # | Question | What the build does |
|---|---|---|
| 1 | Size limit | 10 MB per file (`TETHER_MAX_FILE_SIZE`). No per-repo limit yet. |
| 2 | Share ID rotation | Link-based access is revoked: pulls are recorded as grants tied to the share ID. Editors and allowlisted users keep access. |
| 3 | Empty folders | Ignored. Only files are artifacts. |
| 4 | Repo delete grace period | None: the purge is immediate. The CLI asks for confirmation, or `--yes`. |
| 5 | Read-only flag in normal mode | Not implemented. The hard revert applies. |
| 7 | Keep-both naming | `name (local copy).ext` next to the original, numbered if taken. |
| 8 | Offline clients and purges | Orphaned on reconnect (`gone: purged`). |

Behaviours the build had to settle where the design was silent:
- **File moved out of a folder in normal mode:** the moved file is left where the user put it, as an ordinary file, and the folder gets a fresh copy, so the folder stays a mirror.
- **File deleted inside a folder in normal mode:** it stops being managed (`deleted locally`). `tether track <folder>` restores it.
- **File deleted for everyone:** other users' copies are orphaned and kept on disk. Tether never deletes files on another machine.
- **Deleting to the Recycle Bin counts as a delete.** The file keeps its ID inside `$Recycle.Bin`, so trash paths are excluded from tracking.
- **Backup-rename saves (vim):** the original is renamed aside in the same folder and a new file is written at the old path. Tether follows the path, not the old ID.
- **Line endings:** each copy's own style is recorded per instance. A revert restores that style, not the style of the tampered file.
- **Repo transfer:** the previous owner stays on as an editor with delete permission.
- **`tether share --demote`** turns an editor into an allowlisted viewer.

## 12b. Realtime editing (2026-10-15)

`tether edit <path> --realtime` is for editors and owners.

- **Live pushes.** Every save is pushed about a second later, with no `tether done` needed. The base-version check still applies to each push.
- **One live editor per file.** The server holds a lease per file (`realtime: {uid, email, since, expiresAt}` on the artifact). The holder's client renews it with every check. It expires after 5 minutes without a renewal, so a crashed or offline machine cannot lock a file forever. A lease whose holder is no longer an editor is ignored and cleared.
- **Another editor's `--realtime` is refused.** The refusal names the holder. A plain `tether edit` is allowed but warns that the file is being edited live and to expect merge conflicts.
- **Faster checks during a session.** Clients that hold the file see the session in their check results and check every 3 s instead of every 30 s while it lasts. The first switch can take up to one normal interval.
- **Conflicts pause live pushing.** If someone else pushes while the live editor has unsent changes, live pushing stops and `tether done` resolves it with the usual prompt.
- **Ending a session.** `tether done` or `tether unmanage` ends it. The owner can end someone else's session from the console.
- **History grows faster.** Each live save is a version, so history grows with it. This is one more reason for the deferred history retention policy.

`tether update` checks npm for a newer `tether-sync`. It stops the daemon, which holds native files open on Windows, reinstalls into the same npm prefix, and restarts the daemon. A development checkout refuses to self-update. The daemon checks for updates once a day and `tether status` mentions when one is available.

## 12c. Git repositories and notifications (2026-10-15, revised for 0.3.0)

**Choosing a mode.** `manage` and `pull` detect a surrounding git repository and ask:
1. **keep:** Tether is the mirror.
2. **skip:** don't manage the file.
3. **follow:** git's changes are published to Tether. Editors and owners only.

`--git keep|follow|skip` answers without the prompt; a non-interactive run defaults to keep. `tether git <path> --mode` changes it later. A managed file that later ends up inside a repository (`git init`, or moved into one) is switched to keep, with a notification. This is checked at startup and every hour.

**No hooks; the daemon decides by content.** The daemon watches each repository's git directory (`HEAD`, the index, refs, lock files) and re-checks shortly after git settles, and again on every sync.
- A follow-mode file whose content now matches what git has committed (`HEAD`) or staged (the index) was changed by git. That version is published, tagged with the commit when it matches `HEAD`.
- Any other change is a manual edit and is reverted, as in normal mode.
- This covers `pull`, `merge`, `rebase`, `checkout`/`switch`, `restore`, `reset`, `stash`, `cherry-pick`, `revert` and `am`, including in GUI clients and repositories that use `core.hooksPath` or husky.
- Nothing is written into the repository except git's own local configuration, described below.

**Keep mode never blocks git.** A local *clean filter* is written into `.git/info/attributes` (never committed) together with `filter.tether-keep.clean`. It makes git read the kept file as exactly what git already has. After Tether writes the file, it re-stages it so git's size and time cache matches; this is a content no-op.
- `git status` stays clean and `git add` stages nothing.
- `pull`, `merge` and `checkout` go through even when they change the file.
- git writes its own version and Tether puts the shared one back, with a notification.

**Teams in follow mode.**
- **Versions from git wait for git.** A version published from a commit (`gitCommit`) is not written by teammates' clients until that commit is in their `HEAD`; the status shows "newer version arrives with your next git pull". Writing it first would make git refuse the pull that brings it. New files in follow-mode folders wait the same way. When the pull arrives, the client sees that Tether already has exactly that content and adopts it, with no conflict.
- **Tether-only versions become an overlay.** A version that exists only in Tether, for example edited from a copy outside git, is applied as a hidden *overlay* through the same filter, so it never dirties the working tree. When git next changes the file, git's version wins and the overlay ends. `tether done` from inside a repository tags its push with the commit when the content is exactly git's.

**Conflicts, deletes and renames.**
- If git changed a follow-mode file while Tether also moved on to different content, git's version is kept in editing mode, with a notification. `tether done` resolves it.
- Nothing is rewritten while git is busy: `index.lock`, or a merge, rebase, cherry-pick or revert in progress.
- A managed file that vanishes inside a repository is kept and waits, in both modes. This covers branch switches and `git clean`. The file is picked up again when git restores it.
- Renames made in git are followed commit by commit, so a rename that was later edited is still recognised.
- Files git adds to a follow-mode folder are published by the owner. For editors they are reported, since only owners can add files.
- Deletions made in git are never published as deletes for everyone.

**Git without PATH.** Git is looked up on PATH, then in Git for Windows' default locations and GitHub Desktop's bundled copy. Without any git executable, repositories are still detected by reading `.git`, but only keep mode is available.

**Hooks from 0.2.0** are removed automatically on startup.

**Notifications.**
- **Mechanism:** Windows toasts under the app ID `Tether.Sync`. The daemon creates the Start-menu shortcut that carries this ID, without which Windows only files toasts in the Notification Center. On Linux, `notify-send`.
- **Events:**
  - reverted local or git changes, and replaced local changes
  - conflicts (live editing, or git with Tether)
  - failed pushes
  - lost live sessions
  - demotion
  - revoked or deleted artifacts
  - files locked by other programs
  - sign-in expiry
  - Tether-only overlays
  - new files that only owners can add
  - failed sync passes
  - available updates
- **Grouping:** events are grouped over 3 seconds ("(+2 more)"), and repeats are rate-limited.
- **Clicking:** opens the artifact or the console.
- **Setting:** `notifications` = `all` | `errors` | `off`.

## 13. Open questions

1. **Size limit:** what per-file (and per-repo) maximum?
2. **Share ID rotation vs existing instances:** after a rotation, do users who pulled via the old link keep access (only new pulls are blocked), or are their instances orphaned unless they are editors or on the allowlist? (Leaning: revoke link-based access; keep explicit editors and allowlisted users.)
3. **Empty folders** inside a folder artifact: tracked as layout or ignored?
4. **Owner deleting a repo:** a grace period / trash before the hard purge?
5. **Optional read-only flag** on `normal`-mode files, to reduce accidental edits before the revert, on top of the hard revert?
6. **Linux `fanotify`:** go/no-go after a stability trial; is the no-root fallback good enough as the default?
7. **Keep-both naming** convention and where the copy is placed.
8. **Offline clients and account purge:** any way to tell a long-offline client that its artifacts are gone, beyond orphaning on reconnect?
