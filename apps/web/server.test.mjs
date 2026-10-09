import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebServer, upstreamOrigin } from './server.mjs';
let backend, gateway, origin, directory;
const sockets = new Set();
function track(server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  );
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'playqube-gateway-'));
  await writeFile(path.join(directory, 'index.html'), '<h1>PlayQube</h1>');
  await writeFile(path.join(directory, 'app.js'), 'console.log("app")');
  await writeFile(path.join(directory, 'app-recovery.js'), '/* pre-entry recovery */');
  backend = http.createServer((req, res) => {
    if (req.url === '/api/v1/auth/login') {
      res.setHeader('Set-Cookie', [
        'sp_access_token=disposable; HttpOnly; Secure; SameSite=None; Path=/',
        'sp_refresh_token=test-refresh; HttpOnly; Secure; SameSite=None; Path=/',
      ]);
      res.end('logged in');
    } else if (req.url === '/api/v1/auth/me') {
      res.statusCode = req.headers.cookie?.includes('sp_access_token=disposable') ? 200 : 401;
      res.end('session');
    } else if (req.url === '/api/v1/spin?round=2') {
      res.end(JSON.stringify({ key: req.headers['idempotency-key'], origin: req.headers.origin }));
    } else if (req.url === '/health') res.end('healthy');
    else {
      res.statusCode = 404;
      res.end('missing');
    }
  });
  backend.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
    socket.on('data', (data) => socket.write(data));
  });
  track(backend);
  const api = await listen(backend);
  gateway = createWebServer({ apiOrigin: api, staticRoot: directory, timeoutMs: 500 });
  track(gateway);
  origin = await listen(gateway);
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  gateway.closeAllConnections();
  backend.closeAllConnections();
  await Promise.all([new Promise((r) => gateway.close(r)), new Promise((r) => backend.close(r))]);
  await rm(directory, { recursive: true, force: true });
});
test('preserves HttpOnly cookies and authenticates a later same-origin request', async () => {
  const login = await fetch(origin + '/api/v1/auth/login', {
    method: 'POST',
    headers: { Origin: origin },
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers.getSetCookie().length, 2);
  assert.match(login.headers.getSetCookie()[0], /HttpOnly; Secure; SameSite=None/);
  const me = await fetch(origin + '/api/v1/auth/me', {
    headers: { Cookie: 'sp_access_token=disposable' },
  });
  assert.equal(me.status, 200);
  assert.equal(me.headers.get('cache-control'), 'private, no-store');
  assert.equal((await fetch(origin + '/api/v1/auth/me')).status, 401);
});
test('preserves query, Origin and idempotency headers', async () => {
  const res = await fetch(origin + '/api/v1/spin?round=2', {
    method: 'POST',
    headers: { Origin: origin, 'Idempotency-Key': 'exact-ticket' },
  });
  assert.deepEqual(await res.json(), { key: 'exact-ticket', origin });
});
test('rejects cross-origin and originless writes without sending them upstream', async () => {
  for (const headers of [{ Origin: 'https://attacker.example' }, {}])
    assert.equal(
      (await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers })).status,
      403
    );
});
test('serves SPA routes but never turns missing assets or private paths into HTML', async () => {
  assert.match(await (await fetch(origin + '/games/spin-win/live')).text(), /PlayQube/);
  assert.equal(
    (await fetch(origin + '/app.js')).headers.get('content-type'),
    'text/javascript; charset=utf-8'
  );
  for (const route of ['/missing.js', '/.env', '/%2e%2e/secret.txt'])
    assert.equal((await fetch(origin + route)).status, 404);
  assert.equal((await fetch(origin + '/games/spin-win', { method: 'HEAD' })).status, 200);
  assert.equal(await (await fetch(origin + '/games/spin-win', { method: 'HEAD' })).text(), '');
});
test('revalidates the pre-entry recovery script while keeping ordinary assets cacheable', async () => {
  const recovery = await fetch(origin + '/app-recovery.js');
  assert.equal(recovery.status, 200);
  assert.equal(recovery.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(recovery.headers.get('cache-control'), 'no-cache');
  assert.equal(
    (await fetch(origin + '/app.js')).headers.get('cache-control'),
    'public, max-age=3600'
  );
});
test('forwards health checks and bounds unavailable upstream failures', async () => {
  assert.equal(await (await fetch(origin + '/health')).text(), 'healthy');
  const unavailable = createWebServer({
    apiOrigin: 'http://127.0.0.1:1',
    staticRoot: directory,
    timeoutMs: 100,
  });
  const u = await listen(unavailable);
  try {
    assert.equal((await fetch(u + '/api/v1/games')).status, 502);
  } finally {
    unavailable.closeAllConnections();
    await new Promise((r) => unavailable.close(r));
  }
});
test('pins the upstream origin and refuses credentials, alternate paths and insecure remote hosts', () => {
  for (const bad of [
    'https://user:password@api.example',
    'https://api.example/path',
    'http://api.example',
    'https://api.example/?query=1',
  ])
    assert.throws(() => upstreamOrigin(bad));
});
test('proxies Socket.IO upgrades and rejects a cross-origin socket', async () => {
  const exchange = (headerOrigin) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(gateway.address().port, '127.0.0.1');
      let result = '';
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error('socket timeout'));
      });
      socket.on('connect', () =>
        socket.write(
          `GET /ws/?EIO=4&transport=websocket HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nOrigin: ${headerOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`
        )
      );
      socket.on('error', reject);
      socket.on('data', (data) => {
        result += data.toString();
        if (result.includes('403')) {
          socket.destroy();
          resolve(result);
        } else if (result.includes('101') && !result.includes('echo-check'))
          socket.write('echo-check');
        else if (result.includes('echo-check')) {
          socket.destroy();
          resolve(result);
        }
      });
    });
  assert.match(await exchange(origin), /echo-check/);
  assert.match(await exchange('https://attacker.example'), /403/);
});
