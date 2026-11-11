import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('private review server blocks real API use and serves only its static fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'salem-guest-preview-test-'));
  await writeFile(join(dir, 'index.html'), '<h1>Guest preview</h1>');
  await writeFile(join(dir, 'asset.css'), 'body{color:green}');
  const child = spawn(
    process.execPath,
    [new URL('./preview-server.mjs', import.meta.url).pathname],
    { env: { ...process.env, PORT: '0', GUEST_PREVIEW_DIST: dir } }
  );
  try {
    const [output] = await once(child.stdout, 'data');
    const origin = String(output).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    assert(origin);
    const home = await fetch(origin + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Guest preview/);
    assert.match(home.headers.get('content-security-policy'), /connect-src 'self'/);
    assert.match(home.headers.get('content-security-policy'), /worker-src 'none'/);
    assert.equal(await (await fetch(origin + '/sports')).text(), '<h1>Guest preview</h1>');
    assert.equal((await fetch(origin + '/asset.css')).status, 200);
    assert.equal((await fetch(origin + '/missing.css')).status, 404);
    assert.equal((await fetch(origin + '/sw.js')).status, 404);
    assert.equal((await fetch(origin + '/asset.js.map')).status, 404);
    assert.equal((await fetch(origin + '/%2e%2e%2fprivate.txt')).status, 403);
    for (const path of [
      '/api/v1/auth/me',
      '/api/v1/sportsbook/launch',
      '/api/v1/provider-test/games',
    ]) {
      const response = await fetch(origin + path, {
        method: path.endsWith('/launch') ? 'POST' : 'GET',
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).success, false);
    }
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
