import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the router in the generated release worker, without fetching or caching.
const worker = await readFile(new URL('./dist/sw.js', import.meta.url), 'utf8');
const dependency = worker.match(/["']\.\/(workbox-[^"']+)["']/)?.[1];
assert.ok(dependency, 'Build the PWA before running its routing contracts');
const workbox = await readFile(new URL(`./dist/${dependency}.js`, import.meta.url), 'utf8');
const exports = {};
const routes = [];
const messages = [];
const precache = [];
let skips = 0;
let claims = 0;
const workerScope = {
  define() {},
  skipWaiting() {
    skips++;
  },
  addEventListener(type, listener) {
    if (type === 'message') messages.push(listener);
  },
};
const context = vm.createContext({
  self: workerScope,
  URL,
  location: new URL('https://playqube.example/'),
  define: (_dependencies, factory) => factory(exports),
});
vm.runInContext(workbox, context, { filename: dependency });
context.define = (_dependencies, factory) =>
  factory({
    ...exports,
    clientsClaim() {
      claims++;
    },
    precacheAndRoute(entries) {
      precache.push(...entries);
    },
    cleanupOutdatedCaches() {},
    createHandlerBoundToURL: () => () => {},
    registerRoute: (route) => routes.push(route),
  });
vm.runInContext(worker, context, { filename: 'sw.js' });
assert.equal(routes.length, 1, 'Expected one generated app navigation fallback');
const route = routes[0];
const matches = (path, mode = 'navigate') =>
  Boolean(
    route.match({
      url: new URL(path, 'https://playqube.example/'),
      request: { mode },
    })
  );

test('the release is installable with a stable identity and real home-screen icons', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('./dist/manifest.webmanifest', import.meta.url), 'utf8')
  );
  assert.equal(manifest.name, 'Salem Bet');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  for (const size of [192, 512]) {
    const icon = manifest.icons.find(
      (icon) => icon.sizes === `${size}x${size}` && icon.type === 'image/png'
    );
    assert.ok(icon, `Missing ${size}px install icon`);
    assert.match(icon.src, /^\/icons\/[^/]+\.png$/);
    const bytes = await readFile(new URL(`./dist${icon.src}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  assert.ok((await stat(new URL('./dist/apple-touch-icon.png', import.meta.url))).size > 0);
});

test('updates wait for explicit activation instead of taking over during a page load', () => {
  assert.equal(skips, 0);
  assert.equal(claims, 0);
  assert.equal(messages.length, 1);
  messages[0]({ data: { type: 'UNRELATED' } });
  assert.equal(skips, 0);
  messages[0]({ data: { type: 'SKIP_WAITING' } });
  assert.equal(skips, 1);
});

test('release HTML installs its recovery guard before the generated entry module', async () => {
  const html = await readFile(new URL('./dist/index.html', import.meta.url), 'utf8');
  const guardAt = html.indexOf('<script src="/app-recovery.js"');
  const entryAt = html.search(/<script[^>]*type="module"/);
  assert.ok(guardAt >= 0 && entryAt > guardAt);
  assert.equal(
    await readFile(new URL('./dist/app-recovery.js', import.meta.url), 'utf8'),
    await readFile(new URL('./public/app-recovery.js', import.meta.url), 'utf8')
  );
});
test('gateway and asset navigations reach the network instead of the app shell', () => {
  for (const path of [
    '/api',
    '/api?check=1',
    '/api/v1/auth/me',
    '/api/v1/games?check=1',
    '/health',
    '/health?check=1',
    '/health/',
    '/ws',
    '/ws?transport=polling',
    '/ws/',
    '/assets',
    '/assets?check=1',
    '/assets/missing.js',
    '/sg/callback',
    '/sg/callback?action=balance',
  ]) {
    assert.equal(matches(path), false, `${path} must reach the gateway`);
  }
});

test('app navigation keeps its offline fallback, including similar prefixes', () => {
  for (const path of [
    '/',
    '/login',
    '/casino',
    '/games/spin-win',
    '/games/spin-win/live?view=table',
    '/games/spin-win/play',
    '/health-guide',
    '/api-help',
    '/assets-guide',
    '/sg/callback-guide',
  ]) {
    assert.equal(matches(path), true, `${path} must retain the app fallback`);
  }
});

test('ordinary API fetches never match the navigation fallback', () => {
  assert.equal(matches('/api/v1/wallet', 'same-origin'), false);
  assert.equal(matches('/games/spin-win', 'cors'), false);
});

test('optional Sky Crash artwork is absent from the generated install precache', () => {
  assert.ok(precache.length > 0, 'Inspect the actual generated manifest');
  assert.equal(
    precache.some((entry) => /images\/sky-crash\//.test(entry.url)),
    false
  );
});
test('greyhound racing ships no raster dog artwork and no precached race scene', () => {
  // The greyhounds and course are generated in code; nothing under images/dog-racing ships.
  assert.equal(
    precache.some((entry) => /images\/dog-racing\//.test(entry.url)),
    false
  );
  assert.equal(existsSync(new URL('./dist/images/dog-racing', import.meta.url)), false);
});
test('Sky Crash display assets stay within the mobile transfer budget', async () => {
  for (const name of ['aircraft', 'alpine-dawn']) {
    const asset = new URL(`./dist/images/sky-crash/${name}.webp`, import.meta.url);
    assert.ok((await stat(asset)).size <= 200 * 1024, `${name} exceeds 200 KiB`);
    await assert.rejects(stat(new URL(`./dist/images/sky-crash/${name}.png`, import.meta.url)), {
      code: 'ENOENT',
    });
  }
});

test('optional Derby renderer is bundled but absent from the install precache', async () => {
  const { readdir } = await import('node:fs/promises');
  const assets = await readdir(new URL('./dist/assets/', import.meta.url));
  assert.ok(
    assets.some((name) => /^race-scene-.*\.js$/.test(name)),
    'Renderer must remain available on demand'
  );
  assert.equal(
    precache.some((entry) => /assets\/race-scene-.*\.js$/.test(entry.url)),
    false
  );
});

test('optional Virtual Football renderer is bundled but absent from the install precache', async () => {
  const { readdir } = await import('node:fs/promises');
  const assets = await readdir(new URL('./dist/assets/', import.meta.url));
  assert.ok(
    assets.some((name) => /^football-scene-.*\.js$/.test(name)),
    'Renderer must remain available on demand'
  );
  assert.equal(
    precache.some((entry) => /assets\/football-scene-.*\.js$/.test(entry.url)),
    false
  );
});

test('Derby horse and human rigs ship locally within budget without install precaching', async () => {
  for (const [name, limit] of [
    ['horse', 400000],
    ['jockey', 600000],
  ]) {
    const bytes = await readFile(new URL(`./dist/models/derby/${name}.glb`, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString(), 'glTF');
    assert.ok(bytes.length <= limit, `${name} exceeds its mobile transfer budget`);
  }
  assert.equal(
    precache.some((entry) => /models\/derby\//.test(entry.url)),
    false
  );
});

test('Football face is a small local optional asset, not install precache', async () => {
  const bytes = await readFile(new URL('./dist/models/football/face.glb', import.meta.url));
  assert.equal(bytes.subarray(0, 4).toString(), 'glTF');
  assert.ok(bytes.length < 40000);
  assert.equal(
    precache.some((entry) => /models\/football\//.test(entry.url)),
    false
  );
});

test('the app entry and all language packs are available in the install cache', async () => {
  const { readdir } = await import('node:fs/promises');
  const html = await readFile(new URL('./dist/index.html', import.meta.url), 'utf8');
  const entry = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
  assert.ok(entry, 'Release entry is present');
  const cached = new Set(precache.map((item) => item.url.replace(/^\//, '')));
  assert.ok(cached.has(entry.replace(/^\//, '')), 'The offline app must include its entry module');
  const packs = (await readdir(new URL('./dist/assets/', import.meta.url))).filter((name) =>
    /^translations-.*\.js$/.test(name)
  );
  assert.equal(packs.length, 4, 'Every static catalogue group ships in the release');
  for (const pack of packs) {
    assert.ok(cached.has('assets/' + pack), pack + ' must be cached for offline language changes');
    assert.ok(
      (await stat(new URL('./dist/assets/' + pack, import.meta.url))).size < 2 * 1024 * 1024,
      pack + ' must stay below the default cache size limit'
    );
  }
});
