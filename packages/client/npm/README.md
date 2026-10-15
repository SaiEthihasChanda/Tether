# tether-sync

Keep files and folders identical to a central source of truth, wherever they live on your machine.

```sh
npm install -g tether-sync
tether login                              # opens the browser to sign in
tether pull <share-id>                    # get a managed copy of a file or folder
tether status
```

Owners publish files with `tether manage <path> --repo <repo>` and share the printed share ID. A managed copy:
- follows the file when you move or rename it
- reverts local edits until you run `tether edit <path>`
- pushes your changes with `tether done <path>` (if you are an editor)

Editors can also run `tether edit <path> --realtime` to push every save live, one live editor per file. `tether update` installs the latest version.

Inside a git repository, Tether asks whether git's changes should be reverted (keep), or accepted and published after pull, checkout and merge (follow, for editors). Change it with `tether git <path> --mode`.

Desktop notifications cover reverted changes, conflicts, lost live sessions and revoked access. Set them with `tether config set notifications all|errors|off`.

Run `tether --help` for every command. The web console is at https://tether-b10cf.web.app.

Requires Node.js 22.13 or newer. Windows (NTFS/ReFS) is fully supported; Linux support is experimental.

Source: https://github.com/SaiEthihasChanda/Tether
