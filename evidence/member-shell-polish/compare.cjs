// Usage (from the repository root, after building both bundles):
//   node evidence/member-shell-polish/compare.cjs apps/web <before-dist> <after-dist> <output-dir>
// Before/after visual comparison + targeted interaction checks.
// Serves two production builds on loopback with `vite preview --outDir`.
// Every API response is a SYNTHETIC fixture; every other origin and every
// WebSocket is blocked; service workers are disabled. No real account,
// provider, bet or payment exists anywhere in this run.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

const [, , webDir, beforeDir, afterDir, outDir] = process.argv;
const BUILDS = { before: { dir: beforeDir, port: 5201 }, after: { dir: afterDir, port: 5202 } };
mkdirSync(outDir, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const USER = {
  id: 'synthetic-member-a',
  username: 'synthetic_amina',
  displayName: 'Amina Synthetic',
  email: 'amina@example.invalid',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const GAME_KEYS = ['blackjack', 'lucky_six', 'roulette_keno', 'number_challenge', 'sky_crash',
  'thunder_derby_3d', 'neon_hounds_3d', 'virtual_football_3d', 'crash_point', 'dice', 'spin_win', 'turbo_keno'];
const GAME_NAMES = { blackjack: 'Blackjack', lucky_six: 'Lucky Six', roulette_keno: 'Roulette Keno',
  number_challenge: 'Number Challenge', sky_crash: 'Sky Crash', thunder_derby_3d: 'Thunder Derby',
  neon_hounds_3d: 'Neon Hounds', virtual_football_3d: 'Virtual Football', crash_point: 'Crash Point',
  dice: 'Dice', spin_win: 'Spin & Win', turbo_keno: 'Turbo Keno' };
const TITLES = ['Wheel', 'Reels', 'Table', 'Crash', 'Cards', 'Dice'].map((name, i) => ({
  id: `synthetic-${i + 1}`, name: `Synthetic ${name}`, provider: 'Synthetic Studio',
  category: i % 2 ? 'slots' : 'table' }));
const LAUNCHES = new Set(['POST /api/v1/provider-test/launch', 'POST /api/v1/provider-demo/launch',
  'POST /api/v1/sportsbook/launch']);
const SESSION = new Set(['GET /api/v1/auth/me', 'POST /api/v1/auth/refresh']);

function fixture(key) {
  switch (key) {
    case 'GET /api/v1/notifications':
      return [[], { page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0 }];
    case 'GET /api/v1/games':
      return [GAME_KEYS.map((k) => ({ id: k, key: k, name: GAME_NAMES[k], practiceAvailable: true,
        catalogStatus: 'ACTIVE', isActive: true, description: null, type: k, mode: 'WAGER',
        family: 'INSTANT', wagerCurrency: 'COINS', rewardCurrency: 'COINS', currentRulesVersion: null,
        minBet: 0, maxBet: 0 }))];
    case 'GET /api/v1/provider-test/status':
      return [{ enabled: true, launchReady: true, unavailableReason: null, mode: 'virtual-test',
        currency: 'ETB', country: 'ET' }];
    case 'GET /api/v1/provider-test/games':
      return [TITLES];
    case 'GET /api/v1/provider-test/wallet':
      return [{ balanceCents: 100000, created: true, movements: [] }];
    case 'GET /api/v1/sportsbook/status':
      return [{ balanceMinor: 12345, rewardBalanceMinor: 0, currency: 'ETB', mode: 'real-wallet',
        browseReady: true, liveEnabled: false, canBet: false, reason: 'not-live' }];
    case 'GET /api/v1/sportsbook/activity':
    case 'GET /api/v1/groups':
    case 'GET /api/v1/groups/inbox':
      return [[]];
    case 'GET /api/v1/play-together/':
      return [{ serverTime: Date.now(), workerReady: true, admissionsEnabled: true, cashAvailable: false,
        settings: { version: 1, feeBps: 700, minEntry: 100, maxEntry: 100000,
          enabledGames: ['spin_win', 'dice'], practiceEnabled: true, cashEnabled: false,
          publicRoomsEnabled: false },
        group: null, groups: [],
        balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 5000, pointsReserved: 0 },
        legacyPending: false, rounds: [] }];
    case 'GET /api/v1/wallet':
      return [{ coinsBalance: 12345, gamePointsBalance: 500 }];
    case 'GET /api/v1/wallet/transactions':
      return [[], { page: 1, total: 0, totalPages: 0 }];
    case 'GET /api/v1/member-rewards':
      return [{ config: { version: 1, daily_enabled: true, daily_amount: 100, gift_enabled: false,
        gift_amount: 0, gift_daily_limit: 0, referral_enabled: false, referral_amount: 0,
        gift_minimum: 0, updated_at: '2026-01-01T00:00:00.000Z' },
        wallet: {}, eligibility: { canClaim: false, expiryHours: null }, referralCode: null,
        referrals: 0, qualifiedReferrals: 0, pendingMinor: 0, earnedMinor: 0, today: null,
        day: '2026-11-11', nextCheckInAt: '2026-11-12T00:00:00.000Z', history: [] }];
    case 'POST /api/v1/member-rewards/activity':
      return [{}];
    case 'GET /api/v1/workspaces/access':
      return [{ admin: false, agent: false }];
    default:
      return null;
  }
}

async function session(browser, build, opts = {}) {
  const { language = 'en', width = 390, height, signedIn = false, dsf = 2, reduce = true,
    probeDelay = 0, probeFail = false, slow = {}, failing = {} } = opts;
  const origin = `http://127.0.0.1:${BUILDS[build].port}`;
  const context = await browser.newContext({
    viewport: { width, height: height || (width < 600 ? 844 : 900) },
    deviceScaleFactor: dsf,
    reducedMotion: reduce ? 'reduce' : 'no-preference',
    serviceWorkers: 'block',
    ...(width < 600 ? { isMobile: true, hasTouch: true } : {}),
  });
  const state = { signedIn, requests: [], external: [], errors: [], probeFail };
  await context.addInitScript((v) => { try { localStorage.setItem('salem-language', v); } catch {} }, language);
  const reply = (route, status, data, meta) => route.fulfill({ status, contentType: 'application/json',
    body: JSON.stringify(status < 400 ? { success: true, data, ...(meta ? { meta } : {}) }
      : { success: false, error: { code: status === 401 ? 'UNAUTHORIZED' : 'SERVER_ERROR', message: 'Synthetic fixture' } }) });
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) { state.external.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const key = `${req.method()} ${url.pathname}`;
    state.requests.push(key);
    if (key === 'POST /api/v1/auth/login') { state.signedIn = true; return reply(route, 200, { user: USER }); }
    if (key === 'POST /api/v1/auth/logout') { state.signedIn = false; return reply(route, 200, {}); }
    if (key === 'POST /api/v1/auth/refresh') return state.signedIn ? reply(route, 200, { user: USER }) : reply(route, 401);
    if (key === 'GET /api/v1/auth/me') {
      if (state.probeFail) return route.abort('connectionrefused');
      if (probeDelay) await delay(probeDelay);
      return state.signedIn ? reply(route, 200, { user: USER }) : reply(route, 401);
    }
    if (!state.signedIn) return reply(route, 401);
    if (slow[key]) await delay(slow[key]);
    if (failing[key]) return reply(route, 500);
    const data = fixture(key);
    return data ? reply(route, 200, data[0], data[1]) : reply(route, 404);
  });
  await context.routeWebSocket('**/*', (s) => s.close());
  const page = await context.newPage();
  page.on('pageerror', (e) => state.errors.push(e.message));
  return { context, page, state, origin };
}

async function settle(page) {
  await page.locator('main, [role="status"], [role="alert"]').first().waitFor({ timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
      scrollTo(0, y); await new Promise((r) => setTimeout(r, 30));
    }
    scrollTo(0, 0);
    await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)));
  });
  await delay(250);
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const results = [];
function record(name, build, ok, detail = {}) {
  results.push({ name, build, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${build}] ${name}${detail.error ? ' — ' + detail.error : ''}`);
}
async function run(name, build, fn) {
  try { const d = await fn(); record(name, build, true, d || {}); }
  catch (e) { record(name, build, false, { error: String(e && e.message ? e.message : e).slice(0, 400) }); }
}

// Same states captured for both builds.
const SHOTS = [
  // [file, path, opts, scrollToSelector]
  ['guest-en-390-dashboard', '/dashboard', { width: 390 }],
  ['guest-en-390-casino', '/casino', { width: 390 }],
  ['guest-en-320-play-together-controls', '/play-together', { width: 320 }, '.salem-collection-controls'],
  ['guest-en-1440-dashboard', '/dashboard', { width: 1440, dsf: 1 }],
  ['member-en-390-dashboard', '/dashboard', { width: 390, signedIn: true }],
  ['member-en-390-wallet', '/wallet', { width: 390, signedIn: true }],
  ['member-en-320-dashboard-controls', '/dashboard', { width: 320, signedIn: true }, '.salem-collection-controls'],
  ['member-ar-390-play-together', '/play-together', { width: 390, signedIn: true, language: 'ar' }],
  ['member-ar-390-casino', '/casino', { width: 390, signedIn: true, language: 'ar' }],
  ['guest-ar-320-dashboard', '/dashboard', { width: 320, language: 'ar' }],
  // 200% browser zoom of a 1280x800 window = 640x400 CSS px at device scale 2.
  ['zoom200-member-wallet', '/wallet', { width: 640, height: 400, signedIn: true, dsf: 2 }],
  ['zoom200-guest-dashboard', '/dashboard', { width: 640, height: 400, dsf: 2 }],
  ['zoom200-member-ar-dashboard', '/dashboard', { width: 640, height: 400, signedIn: true, language: 'ar', dsf: 2 }],
];

async function main(browser) {
  for (const build of ['before', 'after']) {
    for (const [file, path, opts, scrollTo] of SHOTS) {
      await run(`shot ${file}`, build, async () => {
        const { context, page, state, origin } = await session(browser, build, opts);
        await page.goto(origin + path);
        await settle(page);
        if (scrollTo) {
          await page.locator(scrollTo).first().evaluate((el) => {
            const top = el.getBoundingClientRect().top + scrollY - 140;
            scrollTo(0, Math.max(0, top));
          });
          await delay(200);
        }
        const over = await overflow(page);
        await page.screenshot({ path: resolve(outDir, `${file}.${build}.png`) });
        const launches = state.requests.filter((k) => LAUNCHES.has(k));
        await context.close();
        assert.equal(over, false, 'horizontal overflow');
        assert.deepEqual(launches, [], 'launch on arrival');
        assert.deepEqual(state.external, [], 'external origin');
        assert.deepEqual(state.errors, [], 'page errors');
        return { over };
      });
    }

    // Loading state while the wallet loads.
    await run('wallet loading state', build, async () => {
      const { context, page, origin } = await session(browser, build, {
        signedIn: true, slow: { 'GET /api/v1/wallet': 4000 } });
      await page.goto(origin + '/wallet');
      await delay(1500);
      const status = await page.locator('main [role="status"]').count();
      const text = await page.locator('main').innerText();
      await page.screenshot({ path: resolve(outDir, `state-wallet-loading.${build}.png`) });
      await context.close();
      return { statusRegions: status, announces: text.includes('Loading') };
    });

    // Session probe pending on a held member deep link (Layout's own loading screen).
    await run('probe loading screen', build, async () => {
      const { context, page, origin } = await session(browser, build, { signedIn: true, probeDelay: 4000 });
      await page.goto(origin + '/sports/open');
      await delay(900);
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const status = await page.getByRole('status').allInnerTexts();
      await page.screenshot({ path: resolve(outDir, `state-probe-loading.${build}.png`) });
      await context.close();
      return { bodyBackground: bg, status };
    });

    // Session check cannot reach the server: reconnect alert.
    await run('session check failure alert', build, async () => {
      const { context, page, state, origin } = await session(browser, build, { probeFail: true });
      await page.goto(origin + '/wallet');
      const alert = page.getByRole('alert').filter({ hasText: 'session' });
      await alert.waitFor({ timeout: 15000 });
      await delay(300);
      await page.screenshot({ path: resolve(outDir, `state-session-alert.${build}.png`) });
      const retry = alert.getByRole('button');
      const label = await retry.innerText();
      // Retry must still re-run the probe (behavior preserved).
      const before = state.requests.filter((k) => k === 'GET /api/v1/auth/me').length;
      state.probeFail = false;
      await retry.click();
      await page.waitForFunction(() => !document.body.innerText.includes('Reconnecting'), null, { timeout: 15000 });
      const after = state.requests.filter((k) => k === 'GET /api/v1/auth/me').length;
      await context.close();
      assert(after > before, 'retry re-ran the session probe');
      return { label, probesBefore: before, probesAfter: after };
    });

    // Catalogue failure on Play Together (existing alert + retry).
    await run('catalogue error state', build, async () => {
      const { context, page, origin } = await session(browser, build, {
        signedIn: true, failing: { 'GET /api/v1/games': true } });
      await page.goto(origin + '/dashboard');
      await page.locator('.salem-collection [role="alert"]').waitFor({ timeout: 20000 });
      await page.locator('.salem-collection').evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await delay(300);
      await page.screenshot({ path: resolve(outDir, `state-catalogue-error.${build}.png`) });
      await context.close();
    });

    // Keyboard focus on the bottom navigation is fully visible.
    await run('bottom-nav focus ring visible', build, async () => {
      const { context, page, origin } = await session(browser, build, { signedIn: true, width: 390 });
      await page.goto(origin + '/dashboard');
      await settle(page);
      const link = page.locator('.salem-mobile-nav a').nth(2);
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      const info = await link.evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const off = parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth);
        return { focused: el === document.activeElement, matches: el.matches(':focus-visible'),
          outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor,
          ringBottom: r.bottom + off, viewport: innerHeight };
      });
      await page.screenshot({ path: resolve(outDir, `state-nav-focus.${build}.png`),
        clip: { x: 0, y: 844 - 110, width: 390, height: 110 } });
      await context.close();
      assert(info.focused && info.matches, 'link focused via keyboard');
      assert(info.ringBottom <= info.viewport, `focus ring clipped by viewport edge (${info.ringBottom} > ${info.viewport})`);
      return info;
    });

    // Back/Forward through the bottom navigation: active item tracks history, nothing launches.
    await run('back/forward with bottom nav', build, async () => {
      const { context, page, state, origin } = await session(browser, build, { signedIn: true, width: 390 });
      await page.goto(origin + '/dashboard');
      await settle(page);
      const nav = page.locator('.salem-mobile-nav');
      const current = async () => (await nav.locator('[aria-current="page"]').getAttribute('href'));
      const from = state.requests.length;
      for (const href of ['/casino', '/sports', '/wallet']) {
        await nav.locator(`a[href="${href}"]`).click();
        await page.waitForURL((u) => u.pathname === href);
        assert.equal(await current(), href);
      }
      const trail = [];
      for (const [action, expect] of [['back', '/sports'], ['back', '/casino'], ['forward', '/sports'], ['back', '/casino'], ['back', '/dashboard']]) {
        await (action === 'back' ? page.goBack() : page.goForward());
        await page.waitForURL((u) => u.pathname === expect);
        await page.locator('main').first().waitFor();
        assert.equal(await current(), expect, `${action} -> ${expect} active item`);
        trail.push(expect);
      }
      const launched = state.requests.slice(from).filter((k) => LAUNCHES.has(k));
      const writes = state.requests.slice(from).filter((k) => !k.startsWith('GET ') && !SESSION.has(k)
        && k !== 'POST /api/v1/member-rewards/activity');
      await context.close();
      assert.deepEqual(launched, [], 'no launch during history navigation');
      assert.deepEqual(writes, [], 'no write during history navigation');
      assert.deepEqual(state.errors, []);
      return { trail };
    });

    // Reduced motion: the new motion is absent under reduce and present otherwise.
    await run('reduced motion respected', build, async () => {
      const out = {};
      for (const reduce of [true, false]) {
        const { context, page, origin } = await session(browser, build, {
          signedIn: true, reduce, slow: { 'GET /api/v1/wallet': 4000 } });
        await page.goto(origin + '/wallet');
        await delay(1200);
        out[reduce ? 'reduce' : 'motion'] = await page.evaluate(() => {
          const mark = document.querySelector('.salem-loading-mark');
          const main = document.querySelector('.qube-main > *');
          return { loadingMark: mark ? getComputedStyle(mark).animationName : null,
            pageEntrance: main ? getComputedStyle(main).animationName : null };
        });
        await context.close();
      }
      if (build === 'after') {
        assert.equal(out.reduce.loadingMark, 'none');
        assert.equal(out.reduce.pageEntrance, 'none');
        assert.equal(out.motion.loadingMark, 'salem-loading-turn');
      }
      return out;
    });

    // Guest login interruption from the new loading/wallet path: prompt -> sign in -> back to section.
    await run('guest prompt → sign in → return → Back', build, async () => {
      const { context, page, state, origin } = await session(browser, build, { width: 390 });
      await page.goto(origin + '/wallet');
      await settle(page);
      const before = state.requests.length;
      await page.locator('main button:visible').first().click();
      const dialog = page.locator('[role="dialog"].salem-guest-dialog');
      await dialog.waitFor();
      assert.deepEqual(state.requests.slice(before).filter((k) => !SESSION.has(k)), [], 'prompt made no request');
      await dialog.locator('a[href="/login"]').click();
      await page.waitForURL((u) => u.pathname === '/login');
      await page.locator('#email').fill('amina@example.invalid');
      await page.locator('#password').fill('Synthetic-Passw0rd!');
      await page.locator('form button[type="submit"]').click();
      await page.waitForURL((u) => u.pathname === '/wallet', { timeout: 15000 });
      await settle(page);
      await page.screenshot({ path: resolve(outDir, `flow-after-signin-wallet.${build}.png`) });
      await page.goBack();
      await delay(1200);
      const afterBack = new URL(page.url()).pathname;
      const launched = state.requests.filter((k) => LAUNCHES.has(k));
      await context.close();
      assert.deepEqual(launched, []);
      return { afterBack };
    });
  }
}

(async () => {
  const servers = Object.values(BUILDS).map(({ dir, port }) =>
    spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', dir,
      '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: webDir, stdio: 'ignore' }));
  try {
    for (const { port } of Object.values(BUILDS))
      for (let i = 0; i < 100; i += 1) {
        try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
        await delay(200);
      }
    const browser = await chromium.launch();
    try { await main(browser); } finally { await browser.close(); }
  } finally { servers.forEach((s) => s.kill()); }
  writeFileSync(resolve(outDir, 'compare-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
