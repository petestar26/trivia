import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the router in the generated release worker, without fetching or caching.
const worker = await readFile(new URL('./dist/sw.js', import.meta.url), 'utf8');
const dependency = worker.match(/["']\.\/(workbox-[^"']+)["']/)?.[1];
assert.ok(dependency, 'Build the PWA before running its routing contracts');
const workbox = await readFile(new URL(`./dist/${dependency}.js`, import.meta.url), 'utf8');
const exports = {};
const routes = [];
const workerScope = { define() {}, skipWaiting() {} };
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
    clientsClaim() {},
    precacheAndRoute() {},
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
