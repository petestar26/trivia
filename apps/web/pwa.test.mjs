import assert from 'node:assert/strict';
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
