#!/usr/bin/env node
// tetherd [--home <dir>]
process.removeAllListeners('warning'); // node:sqlite is still flagged experimental
const i = process.argv.indexOf('--home');
if (i > 0 && process.argv[i + 1]) process.env.TETHER_HOME = process.argv[i + 1];

const { runDaemon } = await import('../src/daemon.js');
runDaemon().catch((e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('tetherd is already running');
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});
