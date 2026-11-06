// Synthetic release checks: no real accounts, external traffic or financial writes.
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.THEME_REVIEW_ORIGIN ?? 'http://127.0.0.1:57429';
const interfaceCatalogue = JSON.parse(
  await readFile(
    process.env.I18N_REVIEW_CATALOGUE ?? '/private/tmp/salem-current-catalogue.json',
    'utf8'
  )
);
const output = process.env.THEME_REVIEW_OUTPUT ?? '/private/tmp/salem-emerald-review';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const user = {
  id: 'theme-member',
  username: 'abebe',
  displayName: 'Abebe Bekele',
  email: 'theme@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const keys = [
  'spin_win',
  'turbo_keno',
  'sky_crash',
  'thunder_derby_3d',
  'virtual_football_3d',
  'neon_hounds_3d',
  'crash_point',
  'roulette_keno',
  'dice',
  'number_challenge',
  'lucky_six',
  'blackjack',
];
const names = [
  'Spin',
  'Turbo Keno',
  'Sky Crash',
  'Derby',
  'Football',
  'Dog Racing',
  'Crash Point',
  'Roulette Keno',
  'Dice',
  'Number Challenge',
  'Lucky Six',
  'Blackjack',
];
const art = ['spin', 'keno', 'dice', 'crash-point', 'thunder-derby', 'dog-racing'];
const games = keys.map((key, i) => ({
  id: key,
  key,
  name: names[i],
  mode: 'WAGER',
  catalogStatus: 'READY',
  practiceAvailable: true,
}));
const catalogue = art.map((image, i) => ({
  id: 'provider-' + i,
  name: [
    'Emerald Wheel',
    'Keno Gold',
    'Royal Dice',
    'Night Flight',
    'Grand Derby',
    'Moonlight Chase',
  ][i],
  provider: 'Preview catalogue',
  category: ['slots', 'keno', 'table', 'crash', 'virtual', 'virtual'][i],
  image: '/art/ruby-grand/' + image + '.webp',
}));
const rewards = {
  config: {
    version: 1,
    daily_enabled: true,
    daily_amount: 500,
    gift_enabled: true,
    gift_amount: 1000,
    gift_daily_limit: 5000,
    referral_enabled: true,
    referral_amount: 2500,
    gift_minimum: 1000,
    updated_at: '2026-11-06T00:00:00Z',
  },
  wallet: { coinAvailability: { spendable: 0, betOnly: 500, pendingReview: 0, reserved: 0 } },
  eligibility: { canClaim: true, expiryHours: null },
  referralCode: 'SAMPLE',
  referrals: 3,
  qualifiedReferrals: 1,
  pendingMinor: 0,
  earnedMinor: 3000,
  today: { id: 'today', claimed_at: '2026-11-06T00:00:00Z' },
  day: '2026-11-06',
  nextCheckInAt: '2026-11-07T00:00:00Z',
  history: [],
  hasMore: false,
};
const report = { checks: [], errors: [], writes: [], untranslated: [], activityPings: 0 };
try {
  for (const lang of ['en', 'am', 'om', 'ti', 'so', 'ar', 'sw', 'fr'])
    for (const width of [1440, 390, 320]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      await context.addInitScript((l) => localStorage.setItem('salem-language', l), lang);
      const page = await context.newPage();
      page.on('pageerror', (e) => report.errors.push({ lang, width, message: e.message }));
      let authenticated = true;
      await page.route('**/*', async (route) => {
        const req = route.request(),
          url = new URL(req.url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname.startsWith('/ws')) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const path = url.pathname.replace('/api/v1', '');
        const send = (data, status = 200) =>
          route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ success: status === 200, data }),
          });
        if (path === '/member-rewards/activity') {
          report.activityPings++;
          return send({ earned: false, credited: 0 });
        }
        if (path === '/auth/refresh') return send(null, 401);
        if (req.method() !== 'GET') {
          report.writes.push({ lang, width, path, method: req.method() });
          return send(null, 409);
        }
        if (path === '/auth/me') return authenticated ? send({ user }) : send(null, 401);
        if (path === '/workspaces/access')
          return send({ admin: false, agent: false, agentStatus: null });
        if (path === '/groups')
          return send([
            {
              id: 'addis',
              name: 'Addis Friends',
              memberCount: 3,
              isMember: true,
              isPrivate: true,
              status: 'ACTIVE',
            },
          ]);
        if (path === '/games') return send(games);
        if (path === '/provider-test/status') return send({ enabled: true, launchReady: true });
        if (path === '/provider-test/games') return send(catalogue);
        if (path === '/provider-test/wallet')
          return send({ balanceCents: 100000, created: true, movements: [] });
        if (path === '/sportsbook/status')
          return send({
            balanceMinor: 0,
            rewardBalanceMinor: 500,
            currency: 'ETB',
            mode: 'real-wallet',
            browseReady: true,
            liveEnabled: false,
            canBet: false,
            reason: 'not-live',
          });
        if (path === '/sportsbook/activity') return send([]);
        if (path === '/member-rewards') return send(rewards);
        if (path === '/member-profile')
          return send({
            ...user,
            bio: 'A place to play together.',
            avatarUrl: null,
            phone: null,
            phoneVerified: false,
            createdAt: '2026-10-15T10:00:00Z',
            lastLoginAt: '2026-11-06T10:00:00Z',
            signInMethods: ['password'],
            payoutCountry: { name: 'Ethiopia', currencyCode: 'ETB' },
            kycVerification: null,
          });
        if (path === '/security/factors') return send({ factors: [] });
        if (path.includes('unread')) return send({ count: 0, unreadCount: 0 });
        if (path.includes('notifications')) return send({ notifications: [], unreadCount: 0 });
        return send({});
      });
      for (const path of ['/dashboard', '/casino', '/sports', '/profile', '/rewards', '/login']) {
        if (width === 320 && !['/dashboard', '/casino', '/login'].includes(path)) continue;
        authenticated = path !== '/login';
        await page.goto(origin + path, { waitUntil: 'networkidle' });
        await page.locator('html.qube-member.dark').waitFor();
        await page.waitForTimeout(200);
        const metrics = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          width: innerWidth,
          lang: document.documentElement.lang,
          dir: document.documentElement.dir,
          bg: getComputedStyle(document.documentElement).getPropertyValue('--casino-bg').trim(),
          empty: !document.body.innerText.trim(),
          text: document.body.innerText.slice(0, 100),
          ballAnimation: document.querySelector('.sports-ball')
            ? getComputedStyle(document.querySelector('.sports-ball')).animationName
            : null,
        }));
        const name = `${path.slice(1)}-${lang}-${width}`;
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${output}/${name}.png` });
        report.checks.push({ name, ...metrics, overflow: metrics.scroll > width + 1 });
        if (lang !== 'en') {
          const expected = Object.fromEntries(
            Object.entries(interfaceCatalogue).flatMap(([key, entry]) => {
              const value = typeof entry[lang] === 'string' ? entry[lang] : entry[lang]?.other;
              return value && value !== key && !key.includes('{') ? [[key, value]] : [];
            })
          );
          const untranslated = await page.evaluate((expected) => {
            const found = new Set(),
              walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walk.nextNode())) {
              const parent = node.parentElement,
                text = node.textContent.trim();
              if (
                !parent ||
                !expected[text] ||
                parent.closest('script,style,code,[aria-hidden="true"]')
              )
                continue;
              const box = parent.getBoundingClientRect(),
                style = getComputedStyle(parent);
              if (
                box.width &&
                box.height &&
                style.visibility !== 'hidden' &&
                style.display !== 'none'
              )
                found.add(text);
            }
            return [...found];
          }, expected);
          if (untranslated.length) report.untranslated.push({ name, messages: untranslated });
        }

        assert.equal(metrics.bg, '#050b09', name + ' theme tokens missing');
        assert.equal(metrics.empty, false, name + ' blank');
        assert.equal(metrics.lang, lang, name + ' lang');
        assert.equal(metrics.dir, lang === 'ar' ? 'rtl' : 'ltr', name + ' dir');
        if (path === '/sports')
          assert.equal(metrics.ballAnimation, 'none', name + ' reduced motion');
      }
      await context.close();
    }
} catch (error) {
  report.failure = error.stack;
} finally {
  await browser.close();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify(
    {
      checks: report.checks.length,
      overflows: report.checks.filter((c) => c.overflow),
      errors: report.errors,
      writes: report.writes,
      untranslated: report.untranslated,
      failure: report.failure,
      output,
    },
    null,
    2
  )
);
if (
  report.failure ||
  report.errors.length ||
  report.writes.length ||
  report.untranslated.length ||
  report.checks.some((c) => c.overflow)
)
  process.exitCode = 1;
