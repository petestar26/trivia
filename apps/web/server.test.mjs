import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
  const parent = await mkdtemp(path.join(tmpdir(), 'playqube-workbox-gateway-'));
  directory = path.join(parent, 'public');
  await mkdir(directory);
  await writeFile(path.join(directory, 'index.html'), '<h1>PlayQube</h1>');
  await writeFile(path.join(directory, 'app.js'), 'console.log("app")');
  await writeFile(path.join(directory, 'app-recovery.js'), '/* pre-entry recovery */');
  for (const name of ['sw.js', 'workbox-runtime.js', 'swatches.js', 'my-workbox.js', 'workbox.js']) {
    await writeFile(path.join(directory, name), '/* cache fixture */');
  }
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
  await rm(path.dirname(directory), { recursive: true, force: true });
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
test('selects service-worker basenames independently of the parent directory', async () => {
  assert.match(path.dirname(directory), /workbox/);
  for (const name of ['sw.js', 'workbox-runtime.js', 'app-recovery.js', 'index.html']) {
    const response = await fetch(origin + '/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache', name);
  }
  for (const name of ['app.js', 'swatches.js', 'my-workbox.js', 'workbox.js']) {
    const response = await fetch(origin + '/' + name);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=3600', name);
  }
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

test('provider callback uses HTTP 200 JSON errors instead of the app shell or upstream errors', async () => {
  for (const method of ['GET','POST']) {
    const r=await fetch(origin+'/sg/callback?key=private',{method});
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{error:2,balance:0});
    assert.match(r.headers.get('cache-control'),/no-store/);
  }
});
test('provider callback preserves signature/query and attests Railway source IP', async () => {
  const {createHmac}=await import('node:crypto');
  const secret='fixture-gateway-secret-at-least-32-characters';
  let seen;
  const api=http.createServer((req,res)=>{seen={url:req.url,headers:req.headers};res.end(JSON.stringify({error:0,balance:12345}));});
  const apiUrl=await listen(api);
  const web=createWebServer({apiOrigin:apiUrl,staticRoot:directory,gatewaySecret:secret,clientIpSource:'railway'});
  const webUrl=await listen(web);
  try {
    const p='/sg/callback?username=st_fixture&amount=50&key=private';
    const r=await fetch(webUrl+p,{headers:{'x-real-ip':'85.122.129.59','x-signature':'provider-signature','x-playqube-client-signature':'spoofed'}});
    assert.equal(r.status,200);assert.deepEqual(await r.json(),{error:0,balance:12345});
    assert.equal(seen.url,p);assert.equal(seen.headers['x-signature'],'provider-signature');
    assert.equal(seen.headers['x-playqube-client-ip'],'85.122.129.59');
    assert.equal(seen.headers['x-playqube-client-signature'],createHmac('sha256',secret).update(JSON.stringify([seen.headers['x-playqube-client-time'],'GET',p,'85.122.129.59'])).digest('hex'));
  } finally {web.closeAllConnections();api.closeAllConnections();await Promise.all([new Promise(r=>web.close(r)),new Promise(r=>api.close(r))]);}
});
