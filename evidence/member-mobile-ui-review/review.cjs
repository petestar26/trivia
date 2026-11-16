// Member-facing mobile/desktop review of the wallet, deposit and agent-payment screens.
//
// Usage (repository root; a Vite server for apps/web must already listen on loopback):
//   REVIEW_ORIGIN=http://127.0.0.1:5199 PLAYWRIGHT_MODULE=<path to playwright-core> \
//     node evidence/member-mobile-ui-review/review.cjs <label> <output-dir>
//
// Every API response is a SYNTHETIC fixture. Every other origin and every WebSocket
// is blocked and service workers are disabled. No real account, agent, order,
// payment or database is involved, and any write other than the passive
// reward-activity ping is rejected and recorded as a failure.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { mkdirSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

const [, , label = 'run', outArg = 'review-output'] = process.argv;
const origin = process.env.REVIEW_ORIGIN;
if (!origin || new URL(origin).hostname !== '127.0.0.1') {
  throw new Error('Set REVIEW_ORIGIN to a loopback (127.0.0.1) web server');
}
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

function fixture(method, path, variant) {
  if (method !== 'GET') return undefined;
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
  if (path.includes('unread')) return [{ count: 0, unreadCount: 0 }];
  if (path.startsWith('/notifications'))
    return [[], { page: 1, limit: 20, total: 0, totalPages: 0, unreadCount: 0 }];
  return [[]];
}

async function session(browser, opts = {}) {
  const { language = 'en', width = 390, height, variant, slow = {}, failing = {} } = opts;
  const mobile = width < 600;
  const context = await browser.newContext({
    viewport: { width, height: height || (mobile ? 844 : 900) },
    deviceScaleFactor: mobile ? 2 : 1,
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
          : { success: false, error: { code: 'SERVER_ERROR', message: 'Synthetic fixture' } }
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
      return reply(route, 200, { user: USER });
    if (key === 'POST /member-rewards/activity')
      return reply(route, 200, { earned: false, credited: 0 });
    if (req.method() !== 'GET') {
      state.writes.push(key);
      return reply(route, 400);
    }
    if (slow[path]) await delay(slow[path]);
    if (failing[path]) return reply(route, 500);
    const data = fixture(req.method(), path, variant);
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

// Layout facts gathered from the rendered page (content area only).
const audit = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('.payments-page, main') || document.body;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const name = (el) =>
      `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : ''} "${(el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 40)}"`;
    const interactive = [
      ...root.querySelectorAll(
        'a[href], button, select, input:not([type=hidden]), textarea, summary'
      ),
    ].filter(visible);
    const smallTargets = interactive
      .filter((el) => {
        if (el.matches('input[type=checkbox], input[type=radio], input[type=file]')) return false;
        const r = el.getBoundingClientRect();
        // Inline text links inside a sentence are exempt (WCAG 2.5.8 inline exception).
        if (el.tagName === 'A' && getComputedStyle(el).display === 'inline') return false;
        return r.height < 43.5;
      })
      .map((el) => `${name(el)} ${Math.round(el.getBoundingClientRect().height)}px`);
    const clipped = [...root.querySelectorAll('*')]
      .filter(
        (el) =>
          visible(el) &&
          el.children.length === 0 &&
          el.scrollWidth > el.clientWidth + 1 &&
          getComputedStyle(el).overflowX !== 'visible'
      )
      .map(name);
    const offscreen = [...root.querySelectorAll('*')]
      .filter(
        (el) =>
          visible(el) &&
          (el.getBoundingClientRect().right > innerWidth + 1 ||
            el.getBoundingClientRect().left < -1)
      )
      .map(name)
      .slice(0, 10);
    const unlabelled = [...root.querySelectorAll('input:not([type=hidden]), select, textarea')]
      .filter(
        (el) =>
          visible(el) &&
          !el.labels?.length &&
          !el.getAttribute('aria-label') &&
          !el.getAttribute('aria-labelledby')
      )
      .map(name);
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      h1: document.querySelectorAll('h1').length,
      lang: document.documentElement.lang,
      smallTargets,
      clipped,
      offscreen,
      unlabelled,
    };
  });

// Tab through the content area and report controls with no visible focus indicator.
async function focusAudit(page) {
  const missing = [];
  const seen = new Set();
  await page
    .locator('.payments-page, main')
    .first()
    .evaluate((el) => {
      el.setAttribute('tabindex', '-1');
      el.focus();
    });
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      const root = document.querySelector('.payments-page, main');
      if (!el || !root || !root.contains(el) || el === root) return null;
      const cs = getComputedStyle(el);
      const host = el.closest('label.p2p-file');
      const hostOutline = host ? getComputedStyle(host).outlineStyle : 'none';
      return {
        id: `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40)}" @${Math.round(el.getBoundingClientRect().top + scrollY)}`,
        outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
        ring: cs.boxShadow !== 'none',
        host: hostOutline !== 'none',
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

// [name, path, session options, optional interaction, optional scroll target]
const SCENARIOS = [
  ['dashboard', '/dashboard', {}],
  ['wallet-overview', '/wallet', {}],
  ['wallet-overview-empty', '/wallet', { variant: 'empty' }],
  ['deposit-start', '/wallet/deposit', {}],
  ['deposit-filled', '/wallet/deposit', {}, fillDeposit, '.payment-panel'],
  [
    'deposit-invalid-amount',
    '/wallet/deposit',
    {},
    async (page) => {
      await page.locator('.payment-panel select').nth(0).selectOption('c-et');
      await page.locator('.payment-panel input[inputmode="decimal"]').fill('12.345');
      await delay(300);
    },
    '.payment-panel',
  ],
  [
    'deposit-loading',
    '/wallet/deposit',
    {
      slow: { '/wallet/payment-options': 6000, '/wallet': 6000, '/agent-orders/me': 6000 },
      noSettle: true,
    },
  ],
  [
    'deposit-error',
    '/wallet/deposit',
    { failing: { '/wallet/payment-options': true, '/wallet': true, '/agent-orders/me': true } },
  ],
  ['deposit-no-countries', '/wallet/deposit', { variant: 'no-countries' }],
  ['activity', '/wallet/activity', {}],
  ['activity-empty', '/wallet/activity', { variant: 'empty' }],
  ['order-room', `/wallet/orders/deposit/${ORDER}`, {}],
  [
    'order-room-confirm',
    `/wallet/orders/deposit/${ORDER}`,
    {},
    async (page) => {
      await page.locator('.p2p-actions button').first().click();
      await delay(300);
    },
    '.p2p-confirm',
  ],
  [
    'order-room-error',
    `/wallet/orders/deposit/${ORDER}`,
    { failing: { [`/payment-orders/deposit/${ORDER}`]: true } },
  ],
  ['crypto-deposit', '/wallet/crypto?direction=deposit', {}],
  ['agent-setup', '/wallet/agent-setup', {}],
];
const MATRIX = [
  ['en', 390],
  ['am', 390],
  ['en', 1440],
  ['am', 1440],
];
const NARROW = new Set(['deposit-filled', 'order-room', 'activity']);

(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.REVIEW_BROWSER_CHANNEL || 'chrome',
  });
  const results = [];
  try {
    const only = process.env.REVIEW_ONLY ? new RegExp(process.env.REVIEW_ONLY) : null;
    for (const [name, path, opts, interact, scrollTarget] of SCENARIOS) {
      if (only && !only.test(name)) continue;
      const matrix = NARROW.has(name) ? [...MATRIX, ['en', 320], ['am', 320]] : MATRIX;
      for (const [language, width] of matrix) {
        const id = `${name}.${language}.${width}`;
        const entry = { id, name, language, width };
        const { context, page, state } = await session(browser, { ...opts, language, width });
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
          Object.assign(entry, await audit(page));
          if (scrollTarget)
            await page
              .locator(scrollTarget)
              .first()
              .evaluate((el) =>
                scrollTo(0, Math.max(0, el.getBoundingClientRect().top + scrollY - 90))
              );
          await page.screenshot({
            path: resolve(outDir, `${id}.png`),
            fullPage: !scrollTarget && !opts.noSettle,
          });
          if (
            [
              'deposit-filled',
              'order-room',
              'wallet-overview',
              'activity',
              'crypto-deposit',
              'agent-setup',
            ].includes(name) &&
            language === 'en'
          )
            entry.focus = await focusAudit(page);
          entry.statusRegions = await page.locator('main [role="status"]').count();
          entry.alerts = await page.locator('main [role="alert"]').count();
        } catch (e) {
          entry.error = String(e && e.message ? e.message : e).slice(0, 300);
        }
        entry.writes = state.writes;
        entry.external = [...new Set(state.external)];
        entry.pageErrors = state.errors;
        results.push(entry);
        console.log(`${entry.error ? 'ERR ' : 'ok  '} ${id}${entry.overflow ? ' OVERFLOW' : ''}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (!process.env.REVIEW_ONLY)
    writeFileSync(resolve(outDir, `results.${label}.json`), JSON.stringify(results, null, 2));
  const bad = results.filter(
    (r) => r.error || r.overflow || r.writes.length || r.pageErrors.length
  );
  console.log(
    `${results.length - bad.length}/${results.length} without errors, overflow, writes or page errors`
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
