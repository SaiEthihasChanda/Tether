// CLI <-> daemon IPC: one JSON request and one JSON response per connection, over a
// named pipe (Windows) or Unix socket (Linux).
import net from 'node:net';
import fs from 'node:fs';
import { isWindows } from './paths.js';

export class IpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export async function listen(endpoint, handler) {
  if (!isWindows && fs.existsSync(endpoint)) {
    // A stale socket from a crashed daemon, unless another daemon answers on it.
    const alive = await call(endpoint, 'ping', {}, 1000).then(() => true, () => false);
    if (alive) throw new IpcError('another tetherd is already running', 'EADDRINUSE');
    fs.rmSync(endpoint, { force: true });
  }
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req;
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        socket.end(JSON.stringify({ error: { message: 'bad request' } }) + '\n');
        return;
      }
      buf = '';
      let res;
      try {
        res = { result: (await handler(req.method, req.params ?? {})) ?? null };
      } catch (e) {
        res = { error: { message: e.message, code: e.code ?? e.name, status: e.status } };
      }
      socket.end(JSON.stringify(res) + '\n');
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new IpcError('another tetherd is already running', 'EADDRINUSE') : e));
    server.listen(endpoint, resolve);
  });
  if (!isWindows) fs.chmodSync(endpoint, 0o600);
  return server;
}

export function call(endpoint, method, params = {}, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let buf = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new IpcError('the daemon did not answer in time', 'ETIMEDOUT'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('data', (c) => (buf += c));
    socket.on('error', (e) => {
      clearTimeout(timer);
      reject(new IpcError('the Tether daemon is not running', e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'ENODAEMON' : e.code));
    });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(buf);
        if (res.error) reject(new IpcError(res.error.message, res.error.code));
        else resolve(res.result);
      } catch {
        reject(new IpcError('invalid response from the daemon'));
      }
    });
  });
}
