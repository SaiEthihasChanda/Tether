// Builds the Windows app:
//   1. the window's interface (Vite) -> renderer/dist
//   2. the main process, bundled with the client code it uses and electron-updater -> main-dist
//   3. the background service: the npm CLI package (dist/npm) with its production dependencies
//      installed -> build/runtime/tether (shipped as resources/tether, run by the app's own Electron)
//   4. electron-builder -> dist-app (installer + win-unpacked). `--dir` skips the installer.
// Usage: node scripts/build.mjs [--dir] [--publish]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(here, '../..');
const run = (cmd, cwd = here) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
const args = process.argv.slice(2);

console.log('1/4 interface');
run('npx vite build');

console.log('2/4 main process');
fs.rmSync(path.join(here, 'main-dist'), { recursive: true, force: true });
await build({
  entryPoints: [path.join(here, 'main/main.js')],
  outfile: path.join(here, 'main-dist/main.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  external: ['electron'], logLevel: 'warning',
});
fs.copyFileSync(path.join(here, 'main/preload.cjs'), path.join(here, 'main-dist/preload.cjs'));

console.log('3/4 background service');
run('npm run build:cli', repo);
const runtime = path.join(here, 'build/runtime/tether');
// Install outside this repository: inside it, npm treats the folder as part of the workspace
// and puts the packages in the repository's node_modules instead (the app would then only work here).
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-runtime-'));
fs.cpSync(path.join(repo, 'dist/npm'), staging, { recursive: true });
run('npm install --omit=dev --no-audit --no-fund', staging);
if (!fs.existsSync(path.join(staging, 'node_modules', 'koffi'))) throw new Error('runtime dependencies were not installed');
fs.rmSync(runtime, { recursive: true, force: true });
fs.cpSync(staging, runtime, { recursive: true });
fs.rmSync(staging, { recursive: true, force: true });

console.log('4/4 package');
const v = JSON.parse(fs.readFileSync(path.join(repo, 'packages/client/package.json'), 'utf8')).version;
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
if (pkg.version !== v) {
  pkg.version = v; // the app's version follows the client's
  fs.writeFileSync(path.join(here, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
}
run(`npx electron-builder --win --x64 ${args.includes('--dir') ? '--dir' : ''} --publish ${args.includes('--publish') ? 'always' : 'never'}`);
console.log('built', path.join(here, 'dist-app'));
