// `tether update`: find the latest tether-sync on npm and reinstall this copy in place.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isWindows } from './paths.js';

export const PACKAGE = 'tether-sync';
const registry = () => (process.env.TETHER_UPDATE_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');

/** Latest published version, or null when the registry cannot be reached. */
export async function latestVersion() {
  try {
    const res = await fetch(`${registry()}/${PACKAGE}/latest`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return (await res.json()).version ?? null;
  } catch {
    return null;
  }
}

/** True if version a is newer than b (x.y.z; a pre-release sorts before its release). */
export function isNewer(a, b) {
  if (!a || !b) return false;
  const parse = (v) => {
    const [core, pre] = v.split('-');
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0);
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre > y.pre;
}

/** Folder of the installed tether-sync package this code runs from, or null for a development copy. */
export function installDir(from = fileURLToPath(import.meta.url)) {
  const dir = path.resolve(path.dirname(from), '..');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === PACKAGE ? dir : null;
  } catch {
    return null;
  }
}

/** The npm prefix a global package was installed under (…/node_modules/pkg or …/lib/node_modules/pkg). */
export function prefixOf(pkgDir, windows = isWindows) {
  const parent = path.dirname(path.dirname(pkgDir));
  return !windows && path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
}

/** Runs `npm install -g` for `spec` into `prefix`; returns the exit code. */
export function npmInstall(spec, prefix) {
  const args = ['install', '-g', '--prefix', prefix, spec];
  const bin = path.dirname(process.execPath);
  const npmCli = [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((p) => fs.existsSync(p));
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit' })
    : spawnSync(isWindows ? 'npm.cmd' : 'npm', args.map((a) => (isWindows ? `"${a}"` : a)), { stdio: 'inherit', shell: isWindows });
  return r.status ?? 1;
}
