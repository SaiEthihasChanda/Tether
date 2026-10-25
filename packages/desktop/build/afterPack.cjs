// electron-builder never copies folders named node_modules from extraResources, so the background
// service's dependencies are put in place here, after packing and before the installer is made.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const src = path.join(__dirname, 'runtime', 'tether', 'node_modules');
  const dest = path.join(context.appOutDir, 'resources', 'tether', 'node_modules');
  if (!fs.existsSync(path.join(src, 'koffi'))) throw new Error(`background service dependencies missing at ${src}; run scripts/build.mjs`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
};
