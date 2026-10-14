import { startTestServer } from './server.js';
import { Machine } from './machine.js';

/** Starts a server and one signed-in machine per name. The first one creates repo "team". */
export async function setup(names, machineOpts = {}) {
  const srv = await startTestServer();
  const m = {};
  for (const n of names) {
    m[n] = await new Machine(srv.url, n, machineOpts[n] ?? {}).start();
    await m[n].run(['login', '--email', `${n}@example.com`, '--password', 'password123', '--signup']);
  }
  await m[names[0]].run(['repo', 'create', 'team']);
  return {
    srv,
    ...m,
    async teardown() {
      for (const n of names) await m[n]?.stop();
      await srv.stop();
    },
  };
}

/** `tether manage`, returning the share ID. */
export async function manage(machine, rel, ...extra) {
  const r = await machine.run(['manage', rel, '--repo', 'team', ...extra]);
  return r.stdout.match(/share ID: (\S+)/)[1];
}
