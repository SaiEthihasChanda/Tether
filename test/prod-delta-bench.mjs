// Delta sync benchmark against production: a large file, then a one-line edit.
// Usage: node test/prod-delta-bench.mjs [serverUrl] [sizeMB]   (temporary accounts, deleted afterwards)
import { Machine } from './helpers/machine.js';

const SERVER = process.argv[2] ?? 'https://tether-b10cf.web.app';
const MB = Number(process.argv[3] ?? 5);
const tag = Date.now().toString(36);
const accounts = { owner: `bench-owner-${tag}@example.com`, viewer: `bench-viewer-${tag}@example.com` };
const PASSWORD = `Bench-${tag}-pw!`;

function bigText(bytes) {
  let x = Date.now() % 1000003; // unique content per run, so nothing is already stored
  const lines = [];
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const l = `line ${i}: ${x.toString(36)} ${(x >> 9).toString(36)} the quick brown fox jumps over the lazy dog`;
    lines.push(l);
    n += l.length + 1;
  }
  return lines.join('\n') + '\n';
}
const time = async (fn) => {
  const t = Date.now();
  const r = await fn();
  return [Date.now() - t, r];
};
const lastNote = (text, verb) => [...text.matchAll(new RegExp(`${verb} \\d+ of \\d+ chunks?, [\\d.]+ [KM]?B`, 'g'))].at(-1)?.[0] ?? '(no transfer note)';

const owner = await new Machine(SERVER, 'bench-owner').start();
const viewer = await new Machine(SERVER, 'bench-viewer').start();
try {
  await owner.run(['login', '--email', accounts.owner, '--password', PASSWORD, '--signup']);
  await viewer.run(['login', '--email', accounts.viewer, '--password', PASSWORD, '--signup']);
  await owner.run(['repo', 'create', 'bench']);
  const text = bigText(MB * 1024 * 1024);
  owner.write('big.txt', text);
  const [tManage, m] = await time(() => owner.run(['manage', 'big.txt', '--repo', 'bench']));
  const id = m.stdout.match(/share ID: (\S+)/)[1];
  const [tPull] = await time(() => viewer.run(['pull', id]));
  console.log(`${MB} MB file: first upload ${tManage} ms, first pull ${tPull} ms (whole file both ways)`);

  for (let round = 1; round <= 3; round++) {
    await owner.run(['edit', 'big.txt']);
    const cur = owner.read('big.txt').replace(/\r\n/g, '\n');
    const at = cur.indexOf(`line ${round * 10000}:`);
    owner.write('big.txt', cur.slice(0, at) + `line ${round * 10000}: EDIT ${round}\n` + cur.slice(cur.indexOf('\n', at) + 1));
    const [tPush, r] = await time(() => owner.run(['done', 'big.txt']));
    const [tSync] = await time(() => viewer.sync());
    console.log(`edit ${round}: push ${tPush} ms (${lastNote(r.stdout, 'sent')}), viewer sync ${tSync} ms (${lastNote(await viewer.log(), 'received')})`);
  }
  await owner.run(['repo', 'delete', 'bench', '--yes']);
} finally {
  const { apiKey } = await (await fetch(`${SERVER}/v1/config`)).json();
  for (const email of Object.values(accounts)) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    }).then((x) => x.json());
    if (r.idToken) await fetch(`${SERVER}/v1/me`, { method: 'DELETE', headers: { authorization: `Bearer ${r.idToken}` } });
  }
  await owner.stop();
  await viewer.stop();
}
