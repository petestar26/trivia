// Member-facing mobile/desktop audit: shell, discovery pages, wallet, deposit and agent payments.
//
// Usage (repository root; a web server for apps/web must already listen on loopback):
//   REVIEW_ORIGIN=http://127.0.0.1:5199 PLAYWRIGHT_MODULE=<path to playwright-core> \
//     node evidence/member-mobile-ui-review/review.cjs <label> <output-dir>
//
// Exit code: 0 only when every required check in gate.cjs passes for every render; 1 otherwise.
//   REVIEW_ONLY=<regex>     audit only scenarios whose name matches (results file is not written)
//   REVIEW_CELL=<regex>     audit only matrix cells such as en.390 or ar.zoom200 (same)
//   REVIEW_INJECT=<defect>  deliberately break each page before auditing it, to prove the gate fails:
//                           overflow | small-target | page-error | write
//
// Every API response is a SYNTHETIC fixture. Every other origin and every WebSocket
// is blocked and service workers are disabled. No real account, agent, order,
// payment, provider or database is involved, and any write other than the passive
// reward-activity ping is rejected and recorded as a failure.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { TOUCH_MIN, evaluate } = require('./gate.cjs');

const [, , label = 'run', outArg = 'review-output'] = process.argv;
const origin = process.env.REVIEW_ORIGIN;
if (!origin || new URL(origin).hostname !== '127.0.0.1') {
  throw new Error('Set REVIEW_ORIGIN to a loopback (127.0.0.1) web server');
}
const inject = process.env.REVIEW_INJECT || '';
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ORDER = '11111111-1111-4111-8111-111111111111';
const USER = {
  id: 'synthetic-member-a',
  username: 'synthetic_dawit',
  displayName: 'Dawit Synthetic',
  email: 'dawit@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
const pricing = () => ({
  minorDigits: 2,
  source: 'synthetic',
  localPerUsd: '157.25',
  observedAt: iso(-60000),
  expiresAt: iso(600000),
  feeMinor: 0,
});
const snapshot = {
  accountName: 'Abebe Bekele Synthetic',
  accountNumber: 'TEST-1000123456789',
  bankName: 'Example Bank of Testing',
};
const orders = () => [
  {
    id: ORDER,
    orderNumber: 'AG-000123',
    status: 'CREATED',
    coinAmount: 250000,
    fiatAmount: '250000',
    fiatCurrency: 'ETB',
    createdAt: iso(-120000),
    paymentSnapshot: snapshot,
    pricingSnapshot: pricing(),
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    orderNumber: 'AG-000101',
    status: 'COMPLETED',
    coinAmount: 100000,
    fiatAmount: '100000',
    fiatCurrency: 'ETB',
    createdAt: iso(-86400000),
    pricingSnapshot: pricing(),
  },
];
const room = () => ({
  id: ORDER,
  number: 'AG-000123',
  kind: 'deposit',
  role: 'member',
  status: 'CREATED',
  coinAmount: 250000,
  fiatAmount: '250000',
  fiatCurrency: 'ETB',
  pricingSnapshot: { minorDigits: 2, feeMinor: 0 },
  paymentSnapshot: snapshot,
  createdAt: iso(-120000),
  serverNow: iso(0),
  deadline: iso(600000),
  confirmationDeadline: null,
  memberName: 'Dawit Synthetic',
  agentName: 'Abebe · verified agent',
  hold: { status: 'ACTIVE', amount: 250000 },
  submission: null,
  appeals: [],
  recovery: null,
  messages: [
    {
      id: 'm1',
      role: 'member',
      mine: true,
      body: 'I will use the account shown on this order and keep the transfer reference here.',
      createdAt: iso(-90000),
      attachment: null,
    },
    {
      id: 'm2',
      role: 'agent',
      mine: false,
      body: 'I will verify the actual payment before completing the order.',
      createdAt: iso(-60000),
      attachment: null,
    },
  ],
  nextCursor: null,
  actions: {
    markPaid: true,
    release: false,
    cancel: true,
    claim: false,
    submitPayout: false,
    confirmReceipt: false,
    appeal: true,
    latePayment: false,
    message: true,
  },
});
const paymentOptions = (variant) => ({
  countries:
    variant === 'no-countries'
      ? []
      : [
          {
            id: 'c-et',
            name: 'Ethiopia',
            currencyCode: 'ETB',
            agentPaymentEnabled: true,
            usdPricingEnabled: true,
          },
        ],
  agents: [
    {
      id: 'a-1',
      countryId: 'c-et',
      displayName: 'Abebe · verified agent',
      minOrderAmount: 50000,
      maxOrderAmount: 5000000,
      paymentAccounts: [
        { id: 'pa-1', methodDef: { name: 'Example Bank transfer' } },
        { id: 'pa-2', methodDef: { name: 'Example mobile money' } },
      ],
    },
  ],
  isAgent: false,
  isAdmin: false,
  withdrawalsEnabled: true,
});
const transactions = () =>
  ['COIN_CREDIT', 'COIN_DEBIT', 'COIN_CREDIT'].map((type, i) => ({
    id: `tx-${i}`,
    type,
    currency: 'ETB',
    amount: 25000 * (i + 1),
    balanceBefore: 1000000,
    balanceAfter: 1000000 + (type === 'COIN_CREDIT' ? 1 : -1) * 25000 * (i + 1),
    referenceType: 'SYNTHETIC',
    referenceId: null,
    description: 'Synthetic',
    createdAt: iso(-3600000 * (i + 1)),
  }));
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
const TITLES = ['Wheel', 'Reels', 'Table', 'Crash', 'Cards', 'Dice'].map((name, i) => ({
  id: `synthetic-${i + 1}`,
  name: `Synthetic ${name}`,
  provider: 'Synthetic Studio',
  category: i % 2 ? 'slots' : 'table',
}));

function fixture(path, variant) {
  if (path === '/workspaces/access') return [{ admin: false, agent: false }];
  if (path === '/wallet')
    return [
      {
        coinsBalance: 1234500,
        gamePointsBalance: 500,
        coinAvailability: { spendable: 1000000, betOnly: 234500, pendingReview: 0 },
      },
    ];
  if (path === '/wallet/transactions')
    return [variant === 'empty' ? [] : transactions(), { page: 1, total: 3, totalPages: 1 }];
  if (path === '/wallet/payment-options') return [paymentOptions(variant)];
  if (path === '/agent-orders/me') return [variant === 'empty' ? [] : orders()];
  if (path === '/withdrawals/me' || path === '/withdrawals/payout-accounts') return [[]];
  if (path === '/late-payments/me') return [[]];
  if (path === '/agent-config/countries') return [[{ id: 'c-et', name: 'Ethiopia' }]];
  if (path === '/agent-config/countries/c-et/payment-methods/active')
    return [
      [
        {
          id: 'md-1',
          name: 'Example Bank transfer',
          fieldSchema: { requiredFields: ['accountName', 'accountNumber'] },
        },
      ],
    ];
  if (path === '/agent-config/countries/c-et/deposit-preview')
    return [
      {
        policy: {
          localPerUsd: '157.25',
          observedAt: iso(-60000),
          expiresAt: iso(600000),
          p2pDepositMinUsdCents: 300,
          p2pWithdrawalAboveUsdCents: 500,
        },
        preview: { coinAmount: 250000 },
      },
    ];
  if (path === `/payment-orders/deposit/${ORDER}`) return [room()];
  if (path === '/agents/me/setup') return [null];
  if (path === '/crypto-payments/options')
    return [
      {
        rate: {
          available: true,
          rateId: 'r1',
          localPerUsd: '157.25',
          observedAt: iso(-60000),
          expiresAt: iso(600000),
          source: 'synthetic',
          cryptoDepositMinUsdCents: 300,
          cryptoWithdrawalAboveUsdCents: 500,
        },
        depositEnabled: true,
        withdrawalEnabled: true,
        countries: [{ id: 'c-et', name: 'Ethiopia' }],
      },
    ];
  if (path === '/crypto-payments/me') return [{ deposits: [], withdrawals: [] }];
  if (path === '/games')
    return [
      Object.keys(GAME_NAMES).map((k) => ({
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
  if (path === '/provider-test/status')
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
  if (path === '/provider-test/games') return [TITLES];
  if (path === '/provider-test/wallet')
    return [{ balanceCents: 100000, created: true, movements: [] }];
  if (path === '/sportsbook/status')
    return [
      {
        balanceMinor: 12345,
        rewardBalanceMinor: 0,
        currency: 'ETB',
        mode: 'real-wallet',
        browseReady: true,
        liveEnabled: false,
        canBet: false,
        reason: 'not-live',
      },
    ];
  if (path === '/play-together/' || path === '/play-together')
    return [
      {
        serverTime: Date.now(),
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
  if (path === '/member-rewards')
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
  if (path === '/security/factors') return [{ factors: [] }];
  if (path === '/member-profile')
    return [
      {
        ...USER,
        bio: 'Synthetic profile used only for interface review.',
        avatarUrl: null,
        emailVerified: true,
        lastLoginAt: iso(-3600000),
        signInMethods: ['PASSWORD'],
        payoutCountry: { name: 'Ethiopia', currencyCode: 'ETB' },
        kycVerification: null,
      },
    ];
  if (path.includes('unread')) return [{ count: 0, unreadCount: 0 }];
  if (path.startsWith('/notifications'))
    return [[], { page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0 }];
  return [[]];
}

const LANGUAGES = { en: 'ltr', am: 'ltr', ar: 'rtl' };

async function session(browser, opts = {}) {
  const { language = 'en', width = 390, height, dsf, variant, slow = {}, failing = {} } = opts;
  const mobile = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: height || (mobile ? 844 : 900) },
    deviceScaleFactor: dsf || (mobile ? 2 : 1),
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const state = { requests: [], writes: [], external: [], errors: [] };
  await context.addInitScript((code) => {
    try {
      localStorage.setItem('salem-language', code);
    } catch {}
  }, language);
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
                code: status === 401 ? 'UNAUTHORIZED' : 'SERVER_ERROR',
                message: 'Synthetic fixture',
              },
            }
      ),
    });
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) {
      state.external.push(url.origin);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/v1', '');
    const key = `${req.method()} ${path}`;
    state.requests.push(key);
    if (key === 'GET /auth/me' || key === 'POST /auth/refresh')
      return opts.guest ? reply(route, 401) : reply(route, 200, { user: USER });
    if (opts.guest) return reply(route, 401);
    if (key === 'POST /member-rewards/activity')
      return reply(route, 200, { earned: false, credited: 0 });
    if (req.method() !== 'GET') {
      state.writes.push(key);
      return reply(route, 400);
    }
    if (slow[path]) await delay(slow[path]);
    if (failing[path]) return reply(route, 500);
    const data = fixture(path, variant);
    return reply(route, 200, data[0], data[1]);
  });
  await context.routeWebSocket('**/*', (socket) => socket.close());
  const page = await context.newPage();
  page.on('pageerror', (e) => state.errors.push(e.message));
  return { context, page, state };
}

async function settle(page) {
  await page.locator('main, [role="status"], [role="alert"]').first().waitFor({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await delay(300);
}

// Deliberate defects for the negative test of the gate.
async function injectDefect(page, kind) {
  if (kind === 'overflow')
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;top:0;left:0;width:200vw;height:4px';
      document.body.appendChild(el);
    });
  else if (kind === 'small-target')
    await page.evaluate(() => {
      const el = document.createElement('button');
      el.textContent = 'x';
      el.style.cssText = 'display:block;width:20px;height:20px;padding:0;min-height:0;min-width:0';
      (document.querySelector('main') || document.body).appendChild(el);
    });
  else if (kind === 'page-error')
    await page.evaluate(() =>
      setTimeout(() => {
        throw new Error('Injected page error');
      }, 0)
    );
  else if (kind === 'write')
    await page.evaluate(() =>
      fetch('/api/v1/agent-orders', { method: 'POST', body: '{}' }).catch(() => undefined)
    );
  else throw new Error(`Unknown REVIEW_INJECT value: ${kind}`);
  await delay(300);
}

// Layout facts gathered from the whole rendered document (page content and shell).
const audit = (page, touchMin) =>
  page.evaluate(
    ({ min, vw }) => {
      // Compare against the configured viewport: under mobile emulation the layout viewport
      // (innerWidth) grows to fit over-wide content, which would hide the very defect we look for.
      const root = document.body;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width <= 1 || r.height <= 1 || cs.visibility === 'hidden' || cs.display === 'none')
          return false;
        if (parseFloat(cs.opacity) === 0 || cs.pointerEvents === 'none') return false;
        // Closed drawers, sheets and menus are not targets until they open.
        if (el.closest('[aria-hidden="true"], [inert], details:not([open]) > :not(summary)'))
          return false;
        const doc = document.documentElement;
        const left = r.left + scrollX;
        const top = r.top + scrollY;
        return (
          left < doc.scrollWidth &&
          left + r.width > 0 &&
          top + r.height > 0 &&
          top < doc.scrollHeight
        );
      };
      const name = (el) => {
        const cls =
          typeof el.className === 'string' && el.className
            ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')
            : '';
        const text = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim();
        const parent = el.parentElement;
        const within =
          parent && typeof parent.className === 'string' && parent.className
            ? `${parent.tagName.toLowerCase()}.${parent.className.split(/\s+/).filter(Boolean)[0]} > `
            : '';
        return `${within}${el.tagName.toLowerCase()}${cls} "${text.replace(/\s+/g, ' ').slice(0, 40)}"`;
      };
      const interactive = [
        ...root.querySelectorAll(
          'a[href], button, select, input:not([type=hidden]), textarea, summary, [role=button], [role=tab]'
        ),
      ].filter(visible);
      // The hit area is the control, or the label that wraps a checkbox, radio or file input.
      const box = (el) => {
        const host = el.matches('input[type=checkbox], input[type=radio], input[type=file]')
          ? el.closest('label')
          : null;
        return (host || el).getBoundingClientRect();
      };
      const smallTargets = interactive
        .filter((el) => {
          if (el.disabled) return false;
          // Links inside a sentence are exempt (WCAG 2.5.8 inline exception).
          if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false;
          const r = box(el);
          return r.height < min - 0.5 || r.width < min - 0.5;
        })
        .map((el) => {
          const r = box(el);
          return `${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        });
      const clipped = [...root.querySelectorAll('*')]
        .filter(
          (el) =>
            visible(el) &&
            el.children.length === 0 &&
            el.scrollWidth > el.clientWidth + 1 &&
            getComputedStyle(el).overflowX !== 'visible'
        )
        .map(name);
      const unlabelled = [...root.querySelectorAll('input:not([type=hidden]), select, textarea')]
        .filter(
          (el) =>
            visible(el) &&
            !el.labels?.length &&
            !el.getAttribute('aria-label') &&
            !el.getAttribute('aria-labelledby') &&
            !el.getAttribute('title')
        )
        .map(name);
      // Horizontal overflow. The app shell clips its own overflow, so the document's scroll
      // width alone cannot see content that runs off the side of the screen.
      const clips = (el) => getComputedStyle(el).overflowX !== 'visible';
      const escapes = [...root.querySelectorAll('*')]
        .filter((el) => {
          if (!visible(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.right <= vw + 1 && r.left >= -1) return false;
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement)
            if (clips(p)) return false;
          return true;
        })
        .map(name);
      const cutOff = [...root.querySelectorAll('*')]
        .filter((el) => {
          const x = getComputedStyle(el).overflowX;
          return (
            (x === 'hidden' || x === 'clip') &&
            visible(el) &&
            el.clientWidth >= vw * 0.9 &&
            el.scrollWidth > el.clientWidth + 1
          );
        })
        .map(name);
      const overflowDetail = [
        ...new Set([...escapes, ...cutOff.map((n) => `clipped inside ${n}`)]),
      ];
      return {
        overflow: document.documentElement.scrollWidth > vw + 1 || overflowDetail.length > 0,
        overflowDetail: overflowDetail.slice(0, 8),
        h1: document.querySelectorAll('h1').length,
        lang: document.documentElement.lang,
        dir: document.documentElement.dir || getComputedStyle(document.documentElement).direction,
        smallTargets: [...new Set(smallTargets)],
        clipped: [...new Set(clipped)],
        unlabelled: [...new Set(unlabelled)],
      };
    },
    { min: touchMin, vw: page.viewportSize().width }
  );

// Tab through the document and report controls with no visible focus indicator.
async function focusAudit(page) {
  const missing = [];
  const seen = new Set();
  await page.evaluate(() => {
    scrollTo(0, 0);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  for (let i = 0; i < 140; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      // A visually hidden input shows its ring on the label that hosts it.
      const host = el.closest('label');
      const hostCs = host ? getComputedStyle(host) : null;
      const r = el.getBoundingClientRect();
      const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
      return {
        id: `${el.tagName.toLowerCase()} "${text.replace(/\s+/g, ' ').slice(0, 40)}" @${Math.round(r.left + scrollX)},${Math.round(r.top + scrollY)}`,
        outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
        ring: cs.boxShadow !== 'none',
        host: !!hostCs && (hostCs.outlineStyle !== 'none' || hostCs.boxShadow !== 'none'),
      };
    });
    if (!info) {
      if (seen.size) break;
      continue;
    }
    if (seen.has(info.id)) break;
    seen.add(info.id);
    if (!info.outline && !info.ring && !info.host) missing.push(info.id);
  }
  return { focusable: seen.size, missingIndicator: missing };
}

async function fillDeposit(page) {
  const selects = page.locator('.payment-panel select');
  await selects.nth(0).selectOption('c-et');
  await page.locator('.payment-panel input[inputmode="decimal"]').fill('2500');
  await selects.nth(1).selectOption('a-1');
  await page.locator('.payment-panel select').nth(2).selectOption('pa-1');
  await delay(600);
}

const room404 = `/payment-orders/deposit/${ORDER}`;
// name, path, options. `touch` marks pages whose controls must all meet the touch minimum.
const SCENARIOS = [
  { name: 'guest-dashboard', path: '/dashboard', opts: { guest: true }, touch: true },
  { name: 'login', path: '/login', opts: { guest: true }, touch: true },
  { name: 'register', path: '/register', opts: { guest: true }, touch: true },
  { name: 'dashboard', path: '/dashboard', touch: true },
  { name: 'casino', path: '/casino', touch: true },
  { name: 'sports', path: '/sports', touch: true },
  { name: 'play-together', path: '/play-together', touch: true },
  { name: 'groups', path: '/groups', touch: true },
  { name: 'messages', path: '/messages', touch: true },
  { name: 'rewards', path: '/rewards', touch: true },
  { name: 'support', path: '/support', touch: true },
  { name: 'profile', path: '/profile', touch: true },
  { name: 'wallet-overview', path: '/wallet', touch: true },
  { name: 'wallet-overview-empty', path: '/wallet', opts: { variant: 'empty' }, touch: true },
  { name: 'deposit-start', path: '/wallet/deposit', touch: true },
  {
    name: 'deposit-filled',
    path: '/wallet/deposit',
    interact: fillDeposit,
    scrollTo: '.payment-panel',
    touch: true,
  },
  {
    name: 'deposit-invalid-amount',
    path: '/wallet/deposit',
    interact: async (page) => {
      await page.locator('.payment-panel select').nth(0).selectOption('c-et');
      await page.locator('.payment-panel input[inputmode="decimal"]').fill('12.345');
      await delay(300);
    },
    scrollTo: '.payment-panel',
    touch: true,
    expectAlert: true,
  },
  {
    name: 'deposit-loading',
    path: '/wallet/deposit',
    opts: {
      slow: { '/wallet/payment-options': 6000, '/wallet': 6000, '/agent-orders/me': 6000 },
      noSettle: true,
    },
    expectStatus: true,
  },
  {
    name: 'deposit-error',
    path: '/wallet/deposit',
    opts: {
      failing: { '/wallet/payment-options': true, '/wallet': true, '/agent-orders/me': true },
    },
    touch: true,
    expectAlert: true,
  },
  {
    name: 'deposit-no-countries',
    path: '/wallet/deposit',
    opts: { variant: 'no-countries' },
    touch: true,
  },
  { name: 'withdraw-start', path: '/wallet/withdraw', touch: true },
  { name: 'activity', path: '/wallet/activity', touch: true },
  { name: 'activity-empty', path: '/wallet/activity', opts: { variant: 'empty' }, touch: true },
  { name: 'order-room', path: `/wallet/orders/deposit/${ORDER}`, touch: true },
  {
    name: 'order-room-confirm',
    path: `/wallet/orders/deposit/${ORDER}`,
    interact: async (page) => {
      await page.locator('.p2p-actions button').first().click();
      await delay(300);
    },
    scrollTo: '.p2p-confirm',
    touch: true,
  },
  {
    name: 'order-room-error',
    path: `/wallet/orders/deposit/${ORDER}`,
    opts: { failing: { [room404]: true } },
    touch: true,
    expectAlert: true,
  },
  { name: 'crypto-deposit', path: '/wallet/crypto?direction=deposit', touch: true },
  { name: 'agent-setup', path: '/wallet/agent-setup', touch: true },
];
// language, width, extra context options, tag
const MATRIX = [
  ['en', 390],
  ['am', 390],
  ['ar', 390],
  ['en', 1440],
  ['am', 1440],
];
const NARROW = new Set([
  'dashboard',
  'deposit-filled',
  'order-room',
  'activity',
  'wallet-overview',
]);
// 200% browser zoom of a 1280x800 window is a 640x400 CSS-pixel viewport at device scale 2.
const ZOOM = new Set(['dashboard', 'wallet-overview', 'deposit-filled', 'order-room', 'casino']);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.REVIEW_BROWSER_CHANNEL || 'chrome',
  });
  const results = [];
  const only = process.env.REVIEW_ONLY ? new RegExp(process.env.REVIEW_ONLY) : null;
  const cell = process.env.REVIEW_CELL ? new RegExp(process.env.REVIEW_CELL) : null;
  try {
    for (const scenario of SCENARIOS) {
      const { name, path, opts = {}, interact, scrollTo: scrollTarget } = scenario;
      if (only && !only.test(name)) continue;
      const matrix = [...MATRIX];
      if (NARROW.has(name)) matrix.push(['en', 320], ['am', 320], ['ar', 320]);
      if (ZOOM.has(name))
        matrix.push(
          ['en', 640, { height: 400, dsf: 2 }, 'zoom200'],
          ['ar', 640, { height: 400, dsf: 2 }, 'zoom200']
        );
      for (const [language, width, extra = {}, tag] of matrix) {
        if (cell && !cell.test(`${language}.${tag || width}`)) continue;
        const id = `${name}.${language}.${tag || width}`;
        const phone = width < 600;
        const entry = {
          id,
          name,
          language,
          width,
          expectLang: language,
          expectDir: LANGUAGES[language],
          touchRequired: !!scenario.touch && phone,
          expectAlert: !!scenario.expectAlert,
          expectStatus: !!scenario.expectStatus,
        };
        const { context, page, state } = await session(browser, {
          ...opts,
          ...extra,
          language,
          width,
        });
        try {
          await page.goto(origin + path);
          if (opts.noSettle) await delay(2500);
          else await settle(page);
          // Failed queries retry with back-off before the page reports the error.
          if (opts.failing) {
            await page.locator('main [role="alert"]').first().waitFor({ timeout: 30000 });
            await delay(400);
          }
          if (interact) await interact(page);
          if (inject) await injectDefect(page, inject);
          Object.assign(entry, await audit(page, TOUCH_MIN));
          entry.statusRegions = await page.locator('[role="status"]').count();
          entry.alerts = await page.locator('[role="alert"]').count();
          if (scrollTarget)
            await page
              .locator(scrollTarget)
              .first()
              .evaluate((el) =>
                scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 90))
              );
          await page.screenshot({
            path: resolve(outDir, `${id}.png`),
            fullPage: !scrollTarget && !opts.noSettle && !tag,
          });
          if (language !== 'am' && !opts.noSettle && !tag && width !== 320)
            entry.focus = await focusAudit(page);
        } catch (e) {
          entry.error = String(e && e.message ? e.message : e).slice(0, 300);
        }
        entry.writes = state.writes;
        entry.external = [...new Set(state.external)];
        entry.pageErrors = state.errors;
        results.push(entry);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const verdict = evaluate(results);
  if (!only && !cell && !inject)
    writeFileSync(resolve(outDir, `results.${label}.json`), JSON.stringify(results, null, 2));
  const failed = new Set(verdict.failures.map((f) => f.id));
  for (const f of verdict.failures) console.log(`FAIL ${f.id} [${f.check}] ${f.detail}`);
  console.log(
    `${results.length - failed.size}/${results.length} renders pass every required check; ${verdict.failures.length} failure(s)`
  );
  process.exitCode = verdict.ok ? 0 : 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
