// Captures current-state screens from a local loopback build with synthetic API data.
// No outside requests: every non-loopback request is aborted; WebSockets are closed.
const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const origin = process.env.ORIGIN || 'http://127.0.0.1:4178';
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

const now = Date.now();
const iso = (minutesAgo) => new Date(now - minutesAgo * 60_000).toISOString();
const member = {
  id: 'synthetic-member-0001',
  username: 'synthetic.member',
  displayName: 'Synthetic Member',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const providers = ['Aurora Studio', 'Basalt Games', 'Cedar Play', 'Dune Labs', 'Ember Live'];
const kinds = ['slots', 'slots', 'slots', 'crash', 'keno', 'table', 'live', 'instant'];
const games = Array.from({ length: 96 }, (_, i) => {
  const category = kinds[i % kinds.length];
  return {
    id: `synthetic-${i}`,
    name: `${['Sample', 'Demo', 'Mock', 'Test'][i % 4]} ${category === 'slots' ? 'Reels' : category[0].toUpperCase() + category.slice(1)} ${i + 1}`,
    provider: providers[(i * 7) % providers.length],
    category,
    categories: category === 'live' ? ['live', 'table'] : [category],
  };
});

const data = {
  '/auth/me': { user: member },
  '/workspaces/access': { admin: false, agent: false, role: 'USER' },
  '/sportsbook/status': {
    balanceMinor: 0,
    rewardBalanceMinor: 2500,
    currency: 'ETB',
    mode: 'real-wallet',
    browseReady: true,
    liveEnabled: false,
    canBet: false,
    reason: 'not-live',
  },
  '/sportsbook/activity': [],
  '/member-rewards': {
    config: {
      version: 3,
      daily_enabled: true,
      daily_amount: 500,
      gift_enabled: false,
      gift_amount: 0,
      gift_daily_limit: 0,
      referral_enabled: false,
      referral_amount: 0,
      gift_minimum: 0,
      updated_at: iso(3000),
    },
    wallet: { coinAvailability: { spendable: 0, betOnly: 0, pendingReview: 0, reserved: 0 } },
    eligibility: { canClaim: false, expiryHours: null },
    referralCode: 'SYNTH0001',
    referrals: 2,
    qualifiedReferrals: 0,
    pendingMinor: 1500,
    earnedMinor: 1500,
    today: { id: 'e3', claimed_at: null },
    day: new Date(now + 3 * 3600_000).toISOString().slice(0, 10),
    nextCheckInAt: new Date(now + 6 * 3600_000).toISOString(),
    history: [
      { id: 'e3', kind: 'DAILY', amount: 500, created_at: iso(30), claimed_at: null },
      { id: 'e2', kind: 'DAILY', amount: 500, created_at: iso(1470), claimed_at: null },
      { id: 'e1', kind: 'DAILY', amount: 500, created_at: iso(2910), claimed_at: null },
    ],
    hasMore: false,
  },
  '/provider-test/status': { enabled: true, launchReady: true },
  '/provider-test/games': games,
  '/provider-test/wallet': { balanceCents: 100000, created: false, movements: [] },
  '/wallet': {
    coinsBalance: 0,
    gamePointsBalance: 1200,
    coinAvailability: { spendable: 0, betOnly: 0, pendingReview: 0, reserved: 0 },
  },
  '/wallet/transactions': [],
  '/wallet/payment-options': { countries: [], agents: [], isAgent: false, isAdmin: false, withdrawalsEnabled: false },
  '/agent-orders/me': [
    {
      id: 'synthetic-order-1',
      orderNumber: 'D-SYNTH-0042',
      status: 'PAYMENT_SUBMITTED',
      coinAmount: 50000,
      fiatAmount: '50000',
      fiatCurrency: 'ETB',
      createdAt: iso(9),
    },
  ],
  '/withdrawals/me': [],
  '/withdrawals/payout-accounts': [],
  '/member-profile': {
    id: member.id,
    username: member.username,
    displayName: member.displayName,
    bio: null,
    avatarUrl: null,
    email: null,
    role: 'USER',
    status: 'ACTIVE',
    isVerified: true,
    createdAt: iso(60 * 24 * 20),
    lastLoginAt: iso(5),
    referralCode: 'SYNTH0001',
    kycVerification: null,
    phone: null,
    phoneVerified: false,
    signInMethods: ['PASSWORD'],
    payoutCountry: null,
  },
  '/games/history': [],
};

async function open(browser, width, height, scale) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    localStorage.setItem('salem-language', 'en');
    localStorage.setItem('theme', 'dark');
  });
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (s) => s.close());
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const p = url.pathname.replace('/api/v1', '');
    let body = data[p];
    if (body === undefined) body = p.includes('unread') ? { count: 0, unreadCount: 0 } : [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: body, meta: { page: 1, total: 0, totalPages: 0 } }),
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  return { context, page };
}

const shots = [
  ['current-sports-desktop', '/sports', 1280, 900, 'text=Browse sports'],
  ['current-rewards-desktop', '/rewards', 1280, 900, 'text=Daily activity'],
  ['current-casino-desktop', '/casino', 1280, 900, '.casino-game-tile'],
  ['current-wallet-activity-desktop', '/wallet/activity', 1280, 900, 'text=Deposit requests'],
  ['current-profile-desktop', '/profile', 1280, 900, 'text=Payment country'],
  ['current-rewards-phone', '/rewards', 390, 844, 'text=Daily activity'],
  ['current-sports-phone', '/sports', 390, 844, 'text=Browse sports'],
];

(async () => {
  const browser = await chromium.launch();
  for (const [name, route, w, h, ready] of shots) {
    const { context, page } = await open(browser, w, h, 2);
    await page.goto(origin + route);
    await page.locator(ready).first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `${name}.jpg`), type: 'jpeg', quality: 72 });
    console.log('captured', name);
    await context.close();
  }
  // Provider dropdown as a native select cannot be screenshotted open; capture the
  // option list via DOM for the report instead.
  const { context, page } = await open(browser, 1280, 900, 1);
  await page.goto(origin + '/casino');
  await page.locator('.casino-game-tile').first().waitFor();
  const options = await page.locator('.casino-provider-filter option').allTextContents();
  console.log('provider options:', JSON.stringify(options));
  await context.close();
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
