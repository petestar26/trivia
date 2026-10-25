import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPreviewServer, HTML_SHA256, SOURCE_COMMIT, SOURCE_TREE } from './server.mjs';

let server, base;
before(async () => {
  server = await createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
test('serves the exact labelled disconnected welcome artifact', async () => {
  const r = await fetch(base);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const html = await r.text();
  assert.equal(createHash('sha256').update(html).digest('hex'), HTML_SHA256);
  assert.match(html, /INTERACTIVE DESIGN PREVIEW/);
  assert.match(html, /connect-src 'none'/);
});
test('identifies reviewed source and disconnected backend through health', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    status: 'ok', preview: true, syntheticData: true, backendConnected: false,
    sourceCommit: SOURCE_COMMIT, sourceTree: SOURCE_TREE, htmlSha256: HTML_SHA256,
  });
});
test('HEAD serves headers without a response body', async () => {
  const r = await fetch(base, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
  assert.equal(Number(r.headers.get('content-length')), Buffer.byteLength(await (await fetch(base)).text()));
});
test('has no API, login or filesystem route', async () => {
  for (const path of ['/login', '/api/v1/wallet', '/../server.mjs', '/%2e%2e/server.mjs', '/secret']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});
test('refuses writes without executing a proxy', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await fetch(base, { method, body: 'blocked' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'GET, HEAD');
  }
});
test('prevents indexing, caching and framing', async () => {
  const r = await fetch(base);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});
