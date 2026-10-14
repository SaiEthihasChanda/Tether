// File identity trackers (DESIGN §5.2, §5.3).
//   WindowsTracker: OpenFileById by (volume serial, 128-bit file ID). Moves anywhere on the
//                   volume are found directly, including moves made while the daemon was off.
//   ScanTracker:    portable fallback using (dev, inode): checks the last known path, then
//                   scans the configured roots. Used on Linux until the fanotify helper exists.
// find() results: { status: 'found', path } | { status: 'gone' } | { status: 'unavailable' }
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from '../paths.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.npm', '.cargo', '.rustup', 'proc', 'sys']);
const MAX_SCAN_ENTRIES = 300_000;

export class WindowsTracker {
  constructor(win32) {
    this.w = win32;
    this.name = 'windows-fileid';
  }

  identify(p) {
    return this.w.fileIdentity(p);
  }

  isTrash(p) {
    return this.w.isTrashPath(p);
  }

  async findAll(instances) {
    const out = new Map();
    for (const inst of instances) {
      if (!inst.fileId) {
        out.set(inst.instanceId, { status: 'gone' });
        continue;
      }
      // Fast path: still at the last known path with the same ID.
      const here = this.identify(inst.path);
      if (here && here.fileId === inst.fileId && here.volumeId === inst.volumeId) {
        // Same file; report its true letter case so case-only renames are seen.
        let real = inst.path;
        try {
          real = fs.realpathSync.native(inst.path);
        } catch {
          // keep the last known path
        }
        out.set(inst.instanceId, { status: 'found', path: real });
        continue;
      }
      const root = path.parse(inst.path).root;
      if (!fs.existsSync(root)) {
        out.set(inst.instanceId, { status: 'unavailable' });
        continue;
      }
      const p = this.w.pathById(inst.volumeId, inst.fileId, inst.path);
      if (p === null && !this.w.fileIdentity(root)) out.set(inst.instanceId, { status: 'unavailable' });
      else if (p === null || this.isTrash(p)) out.set(inst.instanceId, { status: 'gone' });
      else out.set(inst.instanceId, { status: 'found', path: p });
    }
    return out;
  }
}

export class ScanTracker {
  constructor({ scanRoots }) {
    this.scanRoots = scanRoots;
    this.name = 'scan';
  }

  identify(p) {
    try {
      const s = fs.statSync(p, { bigint: true });
      return { volumeId: s.dev.toString(16), fileId: s.ino.toString(16) };
    } catch {
      return null;
    }
  }

  isTrash(p) {
    return /[\\/](\.local[\\/]share[\\/]Trash|\.Trash(-\d+)?|\$Recycle\.Bin)[\\/]/i.test(p);
  }

  async findAll(instances, hintDirs = []) {
    const out = new Map();
    const want = new Map(); // "vol:file" -> instance
    for (const inst of instances) {
      const here = this.identify(inst.path);
      if (here && here.fileId === inst.fileId && here.volumeId === inst.volumeId) out.set(inst.instanceId, { status: 'found', path: inst.path });
      else if (inst.fileId) want.set(`${inst.volumeId}:${inst.fileId}`, inst);
      else out.set(inst.instanceId, { status: 'gone' });
    }
    if (want.size) {
      // Watched folders first (cheap), then the scan roots.
      const dirs = [...new Set([...hintDirs, ...[...want.values()].map((i) => path.dirname(i.path))])];
      this.scan(dirs, want, out, 1);
      if (want.size) this.scan(this.scanRoots, want, out, Infinity);
    }
    for (const inst of want.values()) out.set(inst.instanceId, { status: 'gone' });
    return out;
  }

  scan(roots, want, out, maxDepth) {
    let budget = MAX_SCAN_ENTRIES;
    const queue = roots.filter((r) => fs.existsSync(r)).map((r) => [r, 0]);
    const seen = new Set();
    while (queue.length && want.size && budget > 0) {
      const [dir, depth] = queue.shift();
      if (seen.has(dir) || this.isTrash(dir + path.sep)) continue;
      seen.add(dir);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (--budget <= 0) break;
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        const id = this.identify(p);
        const key = id && `${id.volumeId}:${id.fileId}`;
        if (key && want.has(key)) {
          out.set(want.get(key).instanceId, { status: 'found', path: p });
          want.delete(key);
        }
        if (e.isDirectory() && depth + 1 < maxDepth && !SKIP_DIRS.has(e.name)) queue.push([p, depth + 1]);
      }
    }
  }
}

export async function createTracker(config) {
  const choice = process.env.TETHER_TRACKER || (isWindows ? 'windows' : 'scan');
  if (choice === 'windows') return new WindowsTracker(await import('./win32.js'));
  return new ScanTracker({ scanRoots: config.get('scanRoots') });
}
