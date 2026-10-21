// Builds the publishable CLI package (npm name: tether-sync) into dist/npm.
// The internal @tether/shared module is bundled in; koffi, commander, diff and firebase stay dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '..');
const out = path.resolve(client, '../../dist/npm');
const pkg = JSON.parse(fs.readFileSync(path.join(client, 'package.json'), 'utf8'));
const { VERSION } = await import(new URL('../src/version.js', import.meta.url));
if (VERSION !== pkg.version) throw new Error(`src/version.js (${VERSION}) and package.json (${pkg.version}) disagree`);

// Empty the folder rather than deleting it, so a shell sitting inside it does not break the build.
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true });
await build({
  entryPoints: [path.join(client, 'bin/tether.js'), path.join(client, 'bin/tetherd.js')],
  outdir: path.join(out, 'bin'),
  bundle: true,
  splitting: true, // shared code in chunks next to the entries, so ../bin/tetherd.js still resolves
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['koffi', 'commander', 'diff', 'firebase', 'firebase/*'],
  logLevel: 'warning',
});

const deps = Object.fromEntries(['koffi', 'commander', 'diff', 'firebase'].map((d) => [d, pkg.dependencies[d]]));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({
  name: 'tether-sync',
  version: pkg.version,
  description: 'Keep files identical to a central source of truth, wherever they live on your machine.',
  type: 'module',
  bin: { tether: 'bin/tether.js', tetherd: 'bin/tetherd.js' },
  files: ['bin', 'README.md'],
  engines: { node: '>=22.13' },
  os: ['win32', 'linux'],
  dependencies: deps,
  keywords: ['sync', 'config', 'dotfiles', 'cli', 'files'],
  homepage: 'https://tether-b10cf.web.app',
  repository: { type: 'git', url: 'git+https://github.com/SaiEthihasChanda/Tether.git' },
  license: pkg.license ?? 'UNLICENSED',
}, null, 2) + '\n');
fs.copyFileSync(path.join(here, 'README.md'), path.join(out, 'README.md'));
console.log(`built ${out}`);
