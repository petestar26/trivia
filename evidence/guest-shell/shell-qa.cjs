// Guest-versus-member shell evidence for the integrated guest shell.
//
// Runs the production build on a loopback `vite preview` with SYNTHETIC
// fixtures only: two fictional members, fictional casino titles and provider
// URLs on the reserved .invalid domain. Every other origin and every WebSocket
// is blocked, service workers are disabled, and every API request is recorded
// with the page that made it. No real account, provider, bet or payment exists
// anywhere in this run. This is simulated-browser evidence (Playwright
// Chromium), not a test on physical devices.
//
// Covers: guest and member screenshots (EN 1440/768/390/320, AR 1440/390/320);
// the anonymous network audit; every guest action prompt (keyboard, Escape,
// focus return); the mobile drawer; sign-in return paths and Back; guest deep
// links to launching, wallet, game and invite URLs; member deep links without
// a fresh click; the sportsbook's new tab; casino tiles, reload, Back and
// Forward; staff route spellings; logout; account switching; a slow session
// probe; session restoration through refresh; and session expiry.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn, execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');

const pinned = '0bf9531e78f6e7e8575f6414bde3284d06acc4e5';
const inputs = ['apps', 'packages', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
let source = pinned;
if (process.env.QA_ALLOW_UNCOMMITTED === '1') {
  source = 'uncommitted working tree (not a release record)';
} else {
  execFileSync('git', ['diff', '--exit-code', pinned, '--', ...inputs]);
  assert.equal(
    execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...inputs]).toString(),
    '',
    'untracked application files'
  );
}
const port = Number(process.env.QA_PORT || 5187);
const origin = `http://127.0.0.1:${port}`;
const output = resolve(process.env.QA_OUTPUT || `/tmp/salem-shell-qa-${pinned.slice(0, 7)}`);
mkdirSync(output, { recursive: true });
const only = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(',')) : null;

const member = (id, username, displayName, email, coins) => ({
  user: {
    id,
    username,
    displayName,
    email,
    isVerified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  coins,
});
const MEMBERS = {
  'amina@example.invalid': member(
    'synthetic-member-a',
    'synthetic_amina',
    'Amina Synthetic',
    'amina@example.invalid',
    12345
  ),
  'bekele@example.invalid': member(
    'synthetic-member-b',
    'synthetic_bekele',
    'Bekele Synthetic',
    'bekele@example.invalid',
    999
  ),
};
const A = MEMBERS['amina@example.invalid'];
const SESSION = new Set(['GET /api/v1/auth/me', 'POST /api/v1/auth/refresh']);
const LAUNCHES = new Set([
  'POST /api/v1/provider-test/launch',
  'POST /api/v1/provider-demo/launch',
  'POST /api/v1/sportsbook/launch',
]);
// The member layout's existing automatic activity reward; member-only, never a guest request.
const MEMBER_LAYOUT_WRITE = 'POST /api/v1/member-rewards/activity';
const GAME_KEYS = [
  'blackjack',
  'lucky_six',
  'roulette_keno',
  'number_challenge',
  'sky_crash',
  'thunder_derby_3d',
  'neon_hounds_3d',
  'virtual_football_3d',
  'crash_point',
  'dice',
  'spin_win',
  'turbo_keno',
];
const GAME_NAMES = {
  blackjack: 'Blackjack',
  lucky_six: 'Lucky Six',
  roulette_keno: 'Roulette Keno',
  number_challenge: 'Number Challenge',
  sky_crash: 'Sky Crash',
  thunder_derby_3d: 'Thunder Derby',
  neon_hounds_3d: 'Neon Hounds',
  virtual_football_3d: 'Virtual Football',
  crash_point: 'Crash Point',
  dice: 'Dice',
  spin_win: 'Spin & Win',
  turbo_keno: 'Turbo Keno',
};
const TITLES = ['Wheel', 'Reels', 'Table', 'Crash', 'Cards', 'Dice'].map((name, index) => ({
  id: `synthetic-${index + 1}`,
  name: `Synthetic ${name}`,
  provider: 'Synthetic Studio',
  category: index % 2 ? 'slots' : 'table',
}));
const INVITE = '/groups/invite/0f8b1c2e-3d4a-4b5c-8d9e-112233445566';
const now = () => Date.now();

function fixture(state, key, url) {
  const m = state.member;
  switch (key) {
    case 'GET /api/v1/notifications':
      return [[], { page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0 }];
    case 'GET /api/v1/games':
      return [
        GAME_KEYS.map((k) => ({
          id: k,
          key: k,
          name: GAME_NAMES[k],
          practiceAvailable: true,
          catalogStatus: 'ACTIVE',
          isActive: true,
          description: null,
          type: k,
          mode: 'WAGER',
          family: 'INSTANT',
          wagerCurrency: 'COINS',
          rewardCurrency: 'COINS',
          currentRulesVersion: null,
          minBet: 0,
          maxBet: 0,
        })),
      ];
    case 'GET /api/v1/provider-test/status':
      return [
        {
          enabled: true,
          launchReady: true,
          unavailableReason: null,
          mode: 'virtual-test',
          currency: 'ETB',
          country: 'ET',
        },
      ];
    case 'GET /api/v1/provider-test/games':
      return [TITLES];
    case 'GET /api/v1/provider-test/wallet':
      return [{ balanceCents: 100000, created: true, movements: [] }];
    case 'POST /api/v1/provider-test/launch':
      return [{ url: 'https://provider.invalid/synthetic-launch', mode: 'virtual-test' }];
    case 'GET /api/v1/sportsbook/status':
      return [
        {
          balanceMinor: m.coins,
          rewardBalanceMinor: 0,
          currency: 'ETB',
          mode: 'real-wallet',
          browseReady: true,
          liveEnabled: false,
          canBet: false,
          reason: 'not-live',
        },
      ];
    case 'GET /api/v1/sportsbook/activity':
      return [[]];
    case 'POST /api/v1/sportsbook/launch':
      return [{ url: 'https://provider.invalid/synthetic-sports', mode: 'real-wallet' }];
    case 'GET /api/v1/groups':
    case 'GET /api/v1/groups/inbox':
      return [[]];
    case 'GET /api/v1/play-together/':
      return [
        {
          serverTime: now(),
          workerReady: true,
          admissionsEnabled: true,
          cashAvailable: false,
          settings: {
            version: 1,
            feeBps: 700,
            minEntry: 100,
            maxEntry: 100000,
            enabledGames: ['spin_win', 'dice'],
            practiceEnabled: true,
            cashEnabled: false,
            publicRoomsEnabled: false,
          },
          group: null,
          groups: [],
          balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 5000, pointsReserved: 0 },
          legacyPending: false,
          rounds: [],
        },
      ];
    case 'GET /api/v1/wallet':
      return [{ coinsBalance: m.coins, gamePointsBalance: 500 }];
    case 'GET /api/v1/wallet/transactions':
      return [[], { page: 1, total: 0, totalPages: 0 }];
    case 'GET /api/v1/member-rewards':
      return [
        {
          config: {
            version: 1,
            daily_enabled: true,
            daily_amount: 100,
            gift_enabled: false,
            gift_amount: 0,
            gift_daily_limit: 0,
            referral_enabled: false,
            referral_amount: 0,
            gift_minimum: 0,
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          wallet: {},
          eligibility: { canClaim: false, expiryHours: null },
          referralCode: null,
          referrals: 0,
          qualifiedReferrals: 0,
          pendingMinor: 0,
          earnedMinor: 0,
          today: null,
          day: '2026-11-11',
          nextCheckInAt: '2026-11-12T00:00:00.000Z',
          history: [],
        },
      ];
    case MEMBER_LAYOUT_WRITE:
      return [{}];
    case 'GET /api/v1/workspaces/access':
      return [{ admin: false, agent: false }];
    default:
      return null;
  }
}

/** A browser context whose API is answered by synthetic fixtures and recorded. */
async function session(browser, opts = {}) {
  const {
    language = 'en',
    width = 1440,
    signedIn = false,
    access = true,
    probeDelay = 0,
    watchMarkers = false,
  } = opts;
  const height = opts.height || (width < 600 ? 844 : 900);
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    ...(width < 600 ? { isMobile: true, hasTouch: true } : {}),
  });
  const state = { signedIn, access, member: A, probeDelay, requests: [], external: [], errors: [] };
  const reply = (route, status, data, meta) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        status < 400
          ? { success: true, data, ...(meta ? { meta } : {}) }
          : {
              success: false,
              error: {
                code: status === 401 ? 'UNAUTHORIZED' : 'NOT_FOUND',
                message: 'Synthetic fixture',
              },
            }
      ),
    });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem('salem-language', value);
    } catch {}
  }, language);
  if (watchMarkers)
    await context.addInitScript(() => {
      // Record every moment a private marker of member A is on screen.
      window.__markers = [];
      const check = () => {
        const text = document.body ? document.body.innerText : '';
        for (const marker of ['Amina', '123.45'])
          if (text.includes(marker))
            window.__markers.push({ marker, at: Date.now(), path: location.pathname });
      };
      new MutationObserver(check).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      state.external.push(url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const key = `${request.method()} ${url.pathname}`;
    state.requests.push({
      key,
      at: now(),
      signedIn: state.signedIn,
      page: request.frame()?.url() ?? '',
    });
    if (key === 'POST /api/v1/auth/login') {
      const body = JSON.parse(request.postData() || '{}');
      state.member = MEMBERS[body.email] || A;
      state.signedIn = true;
      state.access = true;
      return reply(route, 200, { user: state.member.user });
    }
    if (key === 'POST /api/v1/auth/logout') {
      state.signedIn = false;
      return reply(route, 200, {});
    }
    if (key === 'POST /api/v1/auth/refresh') {
      if (!state.signedIn) return reply(route, 401);
      state.access = true;
      return reply(route, 200, { user: state.member.user });
    }
    if (key === 'GET /api/v1/auth/me') {
      if (state.probeDelay) await new Promise((r) => setTimeout(r, state.probeDelay));
      return state.signedIn && state.access
        ? reply(route, 200, { user: state.member.user })
        : reply(route, 401);
    }
    if (!state.signedIn || !state.access) return reply(route, 401);
    const data = fixture(state, key, url);
    return data ? reply(route, 200, data[0], data[1]) : reply(route, 404);
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  const page = await context.newPage();
  const watch = (p) =>
    p.on('pageerror', (error) => state.errors.push(`${p.url()} ${error.message}`));
  watch(page);
  context.on('page', watch);
  return { context, page, state };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = (state, from = 0) => state.requests.slice(from).map((r) => r.key);
const launches = (state, from = 0) => keys(state, from).filter((k) => LAUNCHES.has(k));
const writes = (state, from = 0) =>
  keys(state, from).filter(
    (k) =>
      !k.startsWith('GET ') &&
      !SESSION.has(k) &&
      k !== 'POST /api/v1/auth/login' &&
      k !== 'POST /api/v1/auth/logout' &&
      k !== MEMBER_LAYOUT_WRITE
  );
const nonSession = (state, from = 0) => keys(state, from).filter((k) => !SESSION.has(k));
const pathOf = (page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

async function settle(page, { heading = true } = {}) {
  if (heading) await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 15000 });
  else await page.locator('main').first().waitFor({ timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  // Bring lazy artwork into view, then wait for every image to decode.
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    scrollTo(0, 0);
    await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
  });
  await delay(150);
}
const shot = (page, name, fullPage = true) =>
  page.screenshot({ path: resolve(output, `${name}.png`), fullPage });

async function signIn(page, email = 'amina@example.invalid') {
  await page.locator('#email').waitFor();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill('Synthetic-Passw0rd!');
  await page.locator('form button[type="submit"]').click();
}
async function headerSignIn(page) {
  await page.locator('header').getByRole('link', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/login');
}

/** Activate guest controls in order until one opens the sign-in prompt. */
async function openPrompt(page) {
  const buttons = page.locator('main button:visible');
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    await buttons.nth(index).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in to continue' });
    if (
      await dialog.waitFor({ timeout: 600 }).then(
        () => true,
        () => false
      )
    )
      return dialog;
    // Another dialog (such as a collection sheet) is not the prompt; close it and go on.
    if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
  }
  throw new Error('no control opened the sign-in prompt');
}

const results = {};
async function check(name, fn) {
  if (only && !only.has(name)) return;
  const started = now();
  try {
    results[name] = { ok: true, ...(await fn()), ms: now() - started };
    console.log(`PASS ${name}`);
  } catch (error) {
    results[name] = {
      ok: false,
      error: String(error && error.stack ? error.stack : error),
      ms: now() - started,
    };
    console.log(`FAIL ${name}\n${error && error.stack ? error.stack : error}`);
  }
}

const GUEST_PAGES = [
  '/dashboard',
  '/casino',
  '/sports',
  '/play-together',
  '/wallet',
  '/groups',
  '/messages',
  '/rewards',
];
const MEMBER_PAGES = ['/dashboard', '/casino', '/sports', '/play-together', '/wallet'];
const MATRIX = [
  ['en', 1440],
  ['en', 768],
  ['en', 390],
  ['en', 320],
  ['ar', 1440],
  ['ar', 390],
  ['ar', 320],
];
const anonymous = new Set();

async function sweepPrompts(page, state, label) {
  // Every guest action in the page opens the same sign-in prompt and makes no request.
  const before = state.requests.length;
  // The install reminder's own controls are not guest actions; dismissing it would change later pages.
  const buttons = page.locator(
    'main button:visible:not(.salem-install-dismiss):not(.salem-install-button):not(.salem-install-help)'
  );
  const count = await buttons.count();
  let prompts = 0;
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    await button.scrollIntoViewIfNeeded();
    await button.focus();
    await page.keyboard.press('Enter');
    // Identified by structure, not English text, so the Arabic sweep checks the same thing.
    const dialog = page.locator('[role="dialog"].salem-guest-dialog');
    if (!(await dialog.isVisible().catch(() => false))) {
      await delay(150);
      if (!(await dialog.isVisible().catch(() => false))) {
        // Not a sign-in control (a filter, tab or collection sheet). Close anything it opened.
        if (await page.getByRole('dialog').count()) {
          await page.keyboard.press('Escape');
          await page.getByRole('dialog').waitFor({ state: 'detached' });
        }
        continue;
      }
    }
    prompts += 1;
    assert(await dialog.locator('a[href="/login"]').isVisible(), `${label}: prompt offers sign-in`);
    assert(
      await dialog.locator('a[href="/register"]').isVisible(),
      `${label}: prompt offers sign-up`
    );
    assert(
      (await dialog.locator('h2').innerText()).trim().length > 0,
      `${label}: prompt has a title`
    );
    assert(
      await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')),
      `${label}: focus moves into the prompt`
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    // Radix restores focus just after the dialog unmounts.
    const handle = await button.elementHandle();
    const returned = await page
      .waitForFunction((element) => element === document.activeElement, handle, { timeout: 1500 })
      .then(
        () => true,
        () => false
      );
    assert(
      returned,
      `${label}: focus returns to control ${index} (${await button.getAttribute('aria-label')})`
    );
  }
  assert.deepEqual(nonSession(state, before), [], `${label}: prompts made no request`);
  return prompts;
}

async function main(browser) {
  // 1. Guest screenshots, overflow, direction, anonymous network and every prompt.
  await check('guest-matrix', async () => {
    const summary = [];
    for (const [language, width] of MATRIX) {
      const { context, page, state } = await session(browser, { language, width });
      for (const path of GUEST_PAGES) {
        if (width === 768 && !['/dashboard', '/casino', '/sports', '/wallet'].includes(path))
          continue;
        await page.goto(origin + path);
        await settle(page);
        assert.equal(pathOf(page), path, `guest stays on ${path}`);
        assert.equal(await overflow(page), false, `overflow ${language} ${width} ${path}`);
        assert.equal(
          await page.evaluate(() => document.documentElement.dir || 'ltr'),
          language === 'ar' ? 'rtl' : 'ltr'
        );
        assert(
          await page
            .locator('header')
            .getByRole('link', { name: language === 'ar' ? /./ : 'Sign in' })
            .first()
            .isVisible(),
          'header sign-in visible'
        );
        await shot(page, `guest-${language}-${width}-${path.slice(1)}`);
        await shot(page, `guest-${language}-${width}-${path.slice(1)}-screen`, false);
        const prompts = ['en-1440', 'en-320', 'ar-390'].includes(`${language}-${width}`)
          ? await sweepPrompts(page, state, `${language} ${width} ${path}`)
          : undefined;
        summary.push({ language, width, path, prompts });
      }
      for (const k of keys(state)) anonymous.add(k);
      assert.deepEqual(nonSession(state), [], `guest ${language} ${width}: only session probes`);
      assert.deepEqual(state.external, [], 'no external origin');
      assert.deepEqual(state.errors, [], 'no page errors');
      await context.close();
    }
    return { summary };
  });

  // 2. Member screenshots for the same widths (restored session).
  await check('member-matrix', async () => {
    const summary = [];
    for (const [language, width] of MATRIX) {
      const { context, page, state } = await session(browser, { language, width, signedIn: true });
      for (const path of MEMBER_PAGES) {
        if (width === 768 && path === '/play-together') continue;
        const from = state.requests.length;
        await page.goto(origin + path);
        await settle(page);
        assert.equal(new URL(page.url()).pathname, path);
        assert.equal(await overflow(page), false, `overflow ${language} ${width} ${path}`);
        await shot(page, `member-${language}-${width}-${path.slice(1)}`);
        await shot(page, `member-${language}-${width}-${path.slice(1)}-screen`, false);
        assert.deepEqual(launches(state, from), [], `member ${path}: nothing launches on arrival`);
        assert.deepEqual(writes(state, from), [], `member ${path}: no write on arrival`);
        summary.push({ language, width, path, requests: [...new Set(keys(state, from))] });
      }
      assert.deepEqual(state.external, [], 'no external origin');
      assert.deepEqual(state.errors, [], 'no page errors');
      await context.close();
    }
    return { summary };
  });

  // 3. Mobile navigation drawer for guests and members.
  await check('mobile-drawer', async () => {
    const out = [];
    for (const [language, width, signedIn] of [
      ['en', 390, false],
      ['en', 320, false],
      ['ar', 390, false],
      ['en', 390, true],
      ['ar', 320, true],
    ]) {
      const { context, page, state } = await session(browser, { language, width, signedIn });
      await page.goto(origin + '/dashboard');
      await settle(page);
      const opener = page.locator('header button').first();
      await opener.focus();
      await page.keyboard.press('Enter');
      const drawer = page.getByRole('dialog');
      await drawer.waitFor();
      await delay(250);
      const box = await drawer.boundingBox();
      await shot(page, `${signedIn ? 'member' : 'guest'}-${language}-${width}-menu`, false);
      const links = await drawer.getByRole('link').allInnerTexts();
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'detached' });
      assert(
        await opener.evaluate((element) => element === document.activeElement),
        'focus returns to the menu button'
      );
      if (!signedIn) assert.deepEqual(nonSession(state), [], 'guest drawer made no request');
      out.push({
        language,
        width,
        signedIn,
        drawerX: Math.round(box.x),
        drawerWidth: Math.round(box.width),
        links: links.length,
      });
      await context.close();
    }
    return { out };
  });

  // 4. Keyboard: skip link and the first focus stops on guest Home.
  await check('keyboard-home', async () => {
    const { context, page, state } = await session(browser, { width: 1440 });
    await page.goto(origin + '/dashboard');
    await settle(page);
    const stops = [];
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          const style = getComputedStyle(el);
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 40),
            outline: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
          };
        })
      );
      if (i === 3) await shot(page, 'guest-en-1440-focus', false);
    }
    assert.match(stops[0].text, /Skip to content/);
    assert(
      stops.every((s) => s.outline),
      'every stop shows a focus indicator'
    );
    await page.keyboard.press('Shift+Tab');
    await page.goto(origin + '/dashboard');
    await settle(page);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await delay(300);
    assert.equal(
      new URL(page.url()).hash,
      '#main-content',
      'the skip link keeps its anchor for guests'
    );
    await page.keyboard.press('Tab');
    assert(
      await page.evaluate(() => !!document.activeElement?.closest('#main-content')),
      'the next Tab stop is inside the main content'
    );
    assert.deepEqual(nonSession(state), []);
    await context.close();
    return { stops };
  });

  // 5. A guest action's sign-in returns to that section, starts nothing, and Back starts nothing.
  await check('prompt-sign-in-return', async () => {
    const out = [];
    for (const [path, expected] of [
      ['/casino', '/casino'],
      ['/sports', '/sports'],
      ['/wallet', '/wallet'],
      ['/play-together?game=dice', '/play-together?game=dice'],
    ]) {
      const { context, page, state } = await session(browser, { width: 390 });
      await page.goto(origin + path);
      await settle(page);
      const dialog = await openPrompt(page);
      if (path === '/casino') await shot(page, 'guest-en-390-casino-prompt', false);
      await dialog.getByRole('link', { name: 'Sign in' }).click();
      await page.waitForURL((url) => url.pathname === '/login');
      const from = state.requests.length;
      await signIn(page);
      await page.waitForURL((url) => url.pathname + url.search === expected);
      await settle(page);
      await delay(1500);
      assert.deepEqual(launches(state, from), [], `${path}: nothing launched after sign-in`);
      assert.deepEqual(writes(state, from), [], `${path}: no write after sign-in`);
      await page.goBack();
      await delay(1500);
      const afterBack = pathOf(page);
      assert.deepEqual(launches(state, from), [], `${path}: nothing launched after Back`);
      assert.deepEqual(writes(state, from), [], `${path}: no write after Back`);
      out.push({ path, landed: expected, afterBack });
      await context.close();
    }
    return { out };
  });

  // 6. Guest deep links: canonicalised for guests, kept as information after sign-in, never launched.
  await check('guest-deep-links', async () => {
    const out = [];
    const cases = [
      ['/sports/open', '/sports', '/sports'],
      ['/sports/open?intent=0f8b1c2e-3d4a-4b5c-8d9e-112233445566', '/sports', '/sports'],
      ['/casino?game=synthetic-1', '/casino', '/casino'],
      ['/CASINO?game=synthetic-1', '/casino', '/casino'],
      ['/games/dice', '/play-together?game=dice', '/play-together?game=dice'],
      [INVITE + '?utm=1', INVITE, INVITE],
      ['/wallet/withdraw', '/wallet', '/wallet'],
      ['/messages/synthetic-group', '/messages', '/messages'],
      ['/games/provider-demos', '/casino', '/casino'],
    ];
    for (const [link, guestPath, afterSignIn] of cases)
      try {
        const { context, page, state } = await session(browser, { width: 1440 });
        await page.goto(origin + link);
        await settle(page);
        assert.equal(pathOf(page), guestPath, `${link}: guest location`);
        if (link === INVITE + '?utm=1') await shot(page, 'guest-en-1440-invite');
        assert.deepEqual(nonSession(state), [], `${link}: guest made no request`);
        await headerSignIn(page);
        const from = state.requests.length;
        await signIn(page);
        await page.waitForURL((url) => url.pathname + url.search === afterSignIn);
        await settle(page, { heading: false });
        await delay(1500);
        const memberHeading = (
          await page
            .locator('main h1, main h2')
            .first()
            .innerText()
            .catch(() => '')
        ).slice(0, 60);
        if (link.startsWith('/groups/invite'))
          await shot(page, 'member-en-1440-invite-after-sign-in', false);
        assert.deepEqual(launches(state, from), [], `${link}: no launch after sign-in`);
        assert.deepEqual(writes(state, from), [], `${link}: no write after sign-in`);
        await page.goBack();
        await delay(1200);
        const afterBack = pathOf(page);
        assert.deepEqual(launches(state, from), [], `${link}: no launch after Back`);
        assert.deepEqual(writes(state, from), [], `${link}: no write after Back`);
        out.push({ link, guestPath, afterSignIn, afterBack, memberHeading });
        await context.close();
      } catch (error) {
        error.message = `${link}: ${error.message}`;
        throw error;
      }
    return { out };
  });

  // 7. Member deep links without a fresh click wait for one; the click is the positive control.
  await check('member-deep-links', async () => {
    const { context, page, state } = await session(browser, { width: 1440, signedIn: true });
    await page.goto(origin + '/sports/open');
    await page.getByRole('heading', { name: 'Browse sports' }).waitFor();
    await delay(1500);
    assert.deepEqual(launches(state), [], 'bare /sports/open does not launch');
    await shot(page, 'member-en-1440-sports-open-bare', false);
    await page.goto(origin + '/sports/open?intent=0f8b1c2e-3d4a-4b5c-8d9e-112233445566');
    await page.getByRole('heading', { name: 'Browse sports' }).waitFor();
    await delay(1000);
    assert.equal(pathOf(page), '/sports/open', 'unknown intent is removed from the address');
    assert.deepEqual(launches(state), [], 'unknown intent does not launch');
    const sportsClick = state.requests.length;
    await page.getByRole('button', { name: 'Browse sports' }).click();
    await delay(1000);
    assert.deepEqual(
      launches(state, sportsClick),
      ['POST /api/v1/sportsbook/launch'],
      'a click launches once (positive control)'
    );

    await page.goto(origin + '/casino?game=synthetic-1');
    await settle(page);
    await delay(1500);
    const casinoArrival = launches(state, sportsClick).length;
    assert.equal(casinoArrival, 1, 'bare /casino?game= does not launch');
    await shot(page, 'member-en-1440-casino-selected', false);
    const play = page.locator('.casino-player-placeholder').getByRole('button', { name: 'Play' });
    await play.waitFor();
    assert(
      await page.locator('.casino-player-placeholder').getByText('Synthetic Wheel').isVisible(),
      'the linked game is shown as the selection'
    );
    // The page drops ?game= once it has selected the game, so a reload cannot reselect or launch it.
    assert.equal(pathOf(page), '/casino');
    await page.reload();
    await settle(page);
    await delay(1500);
    assert.equal(launches(state, sportsClick).length, 1, 'reload does not launch');
    await page.goto(origin + '/casino?game=synthetic-1');
    await page
      .locator('.casino-player-placeholder')
      .getByRole('button', { name: 'Play' })
      .waitFor();
    const casinoClick = state.requests.length;
    await page.locator('.casino-player-placeholder').getByRole('button', { name: 'Play' }).click();
    await delay(1000);
    assert.deepEqual(
      launches(state, casinoClick),
      ['POST /api/v1/provider-test/launch'],
      'Play launches once (positive control)'
    );
    await context.close();
    return {};
  });

  // 8. The sportsbook opens in a new tab once per click; the same address cannot reopen it.
  await check('sportsbook-new-tab', async () => {
    const { context, page, state } = await session(browser, { width: 1440, signedIn: true });
    await page.goto(origin + '/sports');
    await settle(page);
    const link = page.getByRole('link', { name: 'Browse sports' });
    assert.equal(await link.getAttribute('target'), '_blank');
    const before = state.requests.length;
    const [popup] = await Promise.all([context.waitForEvent('page'), link.click()]);
    const href = await link.getAttribute('href');
    assert.match(href, /^\/sports\/open\?intent=[0-9a-f-]{36}$/);
    await popup.waitForEvent('request', (r) => r.url().endsWith('/sportsbook/launch'));
    await delay(1000);
    const popupLaunches = state.requests.slice(before).filter((r) => LAUNCHES.has(r.key));
    assert.equal(popupLaunches.length, 1, 'the new tab launches once');
    assert.match(popupLaunches[0].page, /\/sports\/open/);
    assert(
      state.external.includes('https://provider.invalid'),
      'the new tab heads for the (blocked) provider'
    );
    const reuse = await context.newPage();
    await reuse.goto(origin + href);
    await reuse.getByRole('heading', { name: 'Browse sports' }).waitFor();
    await delay(1500);
    assert.equal(
      state.requests.slice(before).filter((r) => LAUNCHES.has(r.key)).length,
      1,
      'the used address cannot launch again'
    );
    assert.equal(pathOf(reuse), '/sports/open');
    const original = pathOf(page);
    await context.close();
    return { href, originalTab: original };
  });

  // 9. A casino tile click launches once; Back, Forward and reload never relaunch.
  await check('casino-tile-history', async () => {
    const { context, page, state } = await session(browser, { width: 1440, signedIn: true });
    await page.goto(origin + '/dashboard');
    await settle(page);
    const tile = page.getByRole('link', { name: 'Play Synthetic Wheel' });
    assert.equal(await tile.getAttribute('href'), '/casino?game=synthetic-1');
    const before = state.requests.length;
    await tile.click();
    await page.waitForURL((url) => url.pathname === '/casino');
    await page.waitForRequest((r) => r.url().endsWith('/provider-test/launch'));
    await delay(1000);
    assert.equal(pathOf(page), '/casino', 'the intent and game are removed from the address');
    assert.equal(launches(state, before).length, 1, 'tile click launches once');
    await page.goBack();
    await page.waitForURL((url) => url.pathname === '/dashboard');
    await page.goForward();
    await page.waitForURL((url) => url.pathname === '/casino');
    await delay(1500);
    assert.equal(launches(state, before).length, 1, 'Back then Forward does not relaunch');
    await page.reload();
    await settle(page);
    await delay(1500);
    assert.equal(launches(state, before).length, 1, 'reload does not relaunch');
    await context.close();
    return {};
  });

  // 10. Staff routes, in any spelling, stay private.
  await check('staff-routes', async () => {
    const out = [];
    for (const signedIn of [false, true]) {
      const { context, page, state } = await session(browser, { width: 1440, signedIn });
      for (const path of [
        '/admin',
        '/ADMIN',
        '/%61dmin',
        '/Admin/',
        '/admin/accounts',
        '/admin//accounts',
        '/agent',
        '/AGENT/wallet',
        '/wallet/operations',
      ]) {
        const from = state.requests.length;
        await page.goto(origin + path);
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
        await delay(400);
        const text = await page.locator('body').innerText();
        const landed = pathOf(page);
        const calls = [...new Set(keys(state, from))];
        if (!signedIn) {
          assert.deepEqual(nonSession(state, from), [], `guest ${path}: no request`);
          assert(
            /^\/(admin|agent)\/login$/i.test(new URL(page.url()).pathname) ||
              path === '/wallet/operations',
            `guest ${path}: sent to staff sign-in, got ${landed}`
          );
        } else {
          assert(
            calls.every(
              (k) =>
                SESSION.has(k) ||
                k === 'GET /api/v1/workspaces/access' ||
                k === 'GET /api/v1/notifications' ||
                k === MEMBER_LAYOUT_WRITE
            ),
            `member ${path}: ${calls}`
          );
        }
        assert(!/Synthetic Studio|synthetic_bekele/.test(text), 'no staff or other-member data');
        out.push({
          signedIn,
          path,
          landed,
          heading: (
            await page
              .locator('h1')
              .first()
              .innerText()
              .catch(() => '')
          ).slice(0, 60),
          calls,
        });
        if (path === '/admin')
          await shot(
            page,
            signedIn ? 'member-en-1440-admin-denied' : 'guest-en-1440-admin-to-staff-login',
            false
          );
      }
      await context.close();
    }
    return { out };
  });

  // 11. Logout and account switching never show the previous member's data.
  await check('logout-account-switch', async () => {
    const { context, page, state } = await session(browser, { width: 1440, watchMarkers: true });
    await page.goto(origin + '/wallet');
    await settle(page);
    await headerSignIn(page);
    await signIn(page, 'amina@example.invalid');
    await page.waitForURL((url) => url.pathname === '/wallet');
    await page
      .getByText(/123\.45/)
      .first()
      .waitFor();
    await shot(page, 'member-a-wallet', false);
    const signOutAt = now();
    const beforeLogout = state.requests.length;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.locator('header').getByRole('link', { name: 'Sign in', exact: true }).waitFor();
    await delay(800);
    const afterLogout = pathOf(page);
    await shot(page, 'after-logout', false);
    assert(keys(state, beforeLogout).includes('POST /api/v1/auth/logout'));
    const leakedAfterLogout = (await page.evaluate(() => window.__markers)).filter(
      (m) => m.at > signOutAt + 300
    );
    assert.deepEqual(leakedAfterLogout, [], 'no member A data after logout');
    const guestFrom = state.requests.length;
    await page.goBack();
    await delay(1000);
    await page.goForward();
    await delay(1000);
    assert.deepEqual(
      nonSession(state, guestFrom),
      [],
      'signed-out Back/Forward made no private request'
    );
    await headerSignIn(page);
    const switchAt = now();
    await signIn(page, 'bekele@example.invalid');
    await page.waitForURL((url) => !url.pathname.startsWith('/login'));
    for (const path of ['/wallet', '/dashboard', '/sports', '/rewards']) {
      await page.goto(origin + path);
      await settle(page);
    }
    await page.goto(origin + '/wallet');
    await page.getByText(/9\.99/).first().waitFor();
    await shot(page, 'member-b-wallet', false);
    const leaked = (await page.evaluate(() => window.__markers)).filter((m) => m.at > switchAt);
    assert.deepEqual(leaked, [], 'member B never sees member A data');
    await context.close();
    return { afterLogout };
  });

  // 12. Slow session probe: what a returning member and a guest see before it settles.
  await check('slow-probe', async () => {
    const out = {};
    for (const signedIn of [true, false]) {
      const { context, page, state } = await session(browser, {
        width: 390,
        signedIn,
        probeDelay: 2000,
      });
      await page.goto(origin + '/dashboard');
      await delay(700);
      const name = `${signedIn ? 'member' : 'guest'}-en-390-probe-pending`;
      await shot(page, name, false);
      const during = {
        headerSignIn: await page
          .locator('header')
          .getByRole('link', { name: 'Sign in', exact: true })
          .isVisible()
          .catch(() => false),
        heading: await page
          .locator('h1')
          .first()
          .innerText()
          .catch(() => ''),
      };
      await page.waitForResponse((r) => r.url().endsWith('/auth/me'));
      await settle(page);
      const after = {
        headerSignIn: await page
          .locator('header')
          .getByRole('link', { name: 'Sign in', exact: true })
          .isVisible()
          .catch(() => false),
        heading: await page
          .locator('h1')
          .first()
          .innerText()
          .catch(() => ''),
      };
      if (!signedIn) assert.deepEqual(nonSession(state), []);
      assert.equal(during.headerSignIn, false, 'no sign-in button while the probe is pending');
      assert.equal(after.headerSignIn, !signedIn, 'the settled header matches the session');
      out[signedIn ? 'member' : 'guest'] = { during, after };
      await context.close();
    }
    // A launching deep link held during a slow probe still does not launch.
    const { context, page, state } = await session(browser, {
      width: 390,
      signedIn: true,
      probeDelay: 2000,
    });
    await page.goto(origin + '/sports/open');
    await delay(600);
    out.sportsOpenDuring = await page.locator('body').innerText();
    await page.getByRole('heading', { name: 'Browse sports' }).waitFor();
    await delay(1200);
    assert.deepEqual(launches(state), []);
    await context.close();
    return out;
  });

  // 13. Session restoration through refresh keeps the member deep link and starts nothing.
  await check('session-restore', async () => {
    const out = [];
    for (const [link, expected, heading] of [
      ['/casino?game=synthetic-2', '/casino', null],
      ['/sports/open', '/sports/open', 'Browse sports'],
      [INVITE, INVITE, null],
    ]) {
      const { context, page, state } = await session(browser, {
        width: 390,
        signedIn: true,
        access: false,
      });
      await page.goto(origin + link);
      if (heading) await page.getByRole('heading', { name: heading }).waitFor();
      else await settle(page);
      await delay(1500);
      const sequence = keys(state).filter((k) => k.includes('/auth/'));
      assert.equal(
        sequence.filter((k) => k.endsWith('/auth/refresh')).length,
        1,
        'one refresh restores the session'
      );
      assert.equal(sequence.at(-1), 'GET /api/v1/auth/me');
      assert.equal(pathOf(page), expected);
      if (link.startsWith('/casino'))
        assert(
          await page.locator('.casino-player-placeholder').getByText('Synthetic Reels').isVisible(),
          'restored member sees the selection'
        );
      assert.deepEqual(launches(state), [], `${link}: nothing launched on restore`);
      assert.deepEqual(writes(state), [], `${link}: no write on restore`);
      out.push({ link, landed: pathOf(page), sequence });
      await context.close();
    }
    return { out };
  });

  // 14. Session expiry while browsing: the next private read cannot be refreshed.
  await check('session-expiry', async () => {
    const { context, page, state } = await session(browser, { width: 1440, signedIn: true });
    await page.goto(origin + '/wallet');
    await page
      .getByText(/123\.45/)
      .first()
      .waitFor();
    state.signedIn = false; // the server forgets the session (expired refresh token)
    const from = state.requests.length;
    await page.locator('aside, nav').getByRole('link', { name: 'Rewards' }).first().click();
    await delay(2500);
    const text = await page.locator('body').innerText();
    await shot(page, 'member-en-1440-expired', false);
    assert.deepEqual(launches(state, from), []);
    assert.deepEqual(writes(state, from), []);
    return {
      landed: pathOf(page),
      guestHeader: await page
        .locator('header')
        .getByRole('link', { name: 'Sign in', exact: true })
        .isVisible()
        .catch(() => false),
      shows: text.includes('123.45') ? 'still shows the cached balance' : 'balance not shown',
      requests: keys(state, from),
    };
  });
}

(async () => {
  const server = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: resolve('apps/web'), stdio: 'ignore' }
  );
  try {
    for (let i = 0; i < 75; i += 1) {
      try {
        if ((await fetch(origin)).ok) break;
      } catch {}
      await delay(200);
    }
    const browser = await chromium.launch();
    try {
      await main(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill();
  }
  const report = {
    source,
    generatedAt: new Date().toISOString(),
    viewport: 'Playwright Chromium (simulated)',
    anonymousRequests: [...anonymous].sort(),
    results,
  };
  writeFileSync(resolve(output, 'shell-qa-results.json'), JSON.stringify(report, null, 2));
  const failed = Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([n]) => n);
  console.log(
    `${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed${failed.length ? '; failed: ' + failed.join(', ') : ''}`
  );
  console.log('anonymous requests:', report.anonymousRequests.join(', '));
  if (failed.length) process.exitCode = 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
