// Built local website only. All account and wallet responses are synthetic.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.TOGETHER_REVIEW_ORIGIN;
assert.ok(origin, 'Set TOGETHER_REVIEW_ORIGIN to a built loopback preview');
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(origin).origin, origin);
const output = resolve(process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-payment-preview');
await mkdir(output, { recursive: true });
const files = (await readdir(resolve(repo, 'apps/web/src/lib/i18n/catalogues')))
  .filter((f) => f.endsWith('.ts'))
  .sort();
const bundle = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/lib/i18n/format.ts'; export { LANGUAGES } from './apps/web/src/lib/i18n/types.ts'; export { catalogue } from './apps/web/src/lib/i18n/catalogue.ts';",
    resolveDir: repo,
    sourcefile: 'payments-preview-review.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'static-catalogue',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]i18n[/\\]catalogue\.ts$/ }, () => ({
          contents:
            files
              .map((f, i) => `import c${i} from ${JSON.stringify('./catalogues/' + f)};`)
              .join('\n') +
            "\nimport { mergeCatalogues } from './validation'; export const catalogue=mergeCatalogues({" +
            files.map((f, i) => `${JSON.stringify(f)}:c${i}`).join(',') +
            '});',
          loader: 'ts',
          resolveDir: resolve(repo, 'apps/web/src/lib/i18n'),
        }));
      },
    },
  ],
});
const { LANGUAGES, translate, catalogue } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const t = (language, key) => translate(language, key);
const errors = [],
  checks = [],
  screenshots = [];
const id = '11111111-1111-4111-8111-111111111111';
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PAYMENT_REVIEW_BROWSER_CHANNEL ?? 'chrome',
});
function fixture(kind = 'deposit', role = 'member') {
  return {
    id,
    number: kind === 'deposit' ? 'AG-000123' : 'WD-000123',
    kind,
    role,
    status: kind === 'deposit' ? 'CREATED' : 'PAYOUT_IN_PROGRESS',
    coinAmount: 50000,
    fiatAmount: '50000',
    fiatCurrency: 'ETB',
    pricingSnapshot: { minorDigits: 2, feeMinor: 0 },
    paymentSnapshot: {
      accountName: 'Abebe Bekele',
      accountNumber: 'TEST-123456789',
      bankName: 'Example bank',
    },
    createdAt: new Date().toISOString(),
    serverNow: new Date().toISOString(),
    deadline: new Date(Date.now() + 600000).toISOString(),
    confirmationDeadline: null,
    memberName: 'Dawit',
    agentName: 'Abebe · verified agent',
    hold: { status: 'ACTIVE', amount: 50000 },
    submission: null,
    appeals: [],
    recovery: null,
    messages: [
      {
        id: 'm1',
        role: 'member',
        mine: role === 'member',
        body: 'I will use the account shown on this order. Please keep the transfer reference in this conversation.',
        createdAt: new Date().toISOString(),
        attachment: null,
      },
      {
        id: 'm2',
        role: 'agent',
        mine: role === 'agent',
        body: 'I will verify the actual payment before completing the order.',
        createdAt: new Date().toISOString(),
        attachment: null,
      },
    ],
    nextCursor: null,
    actions: {
      markPaid: kind === 'deposit' && role === 'member',
      release: false,
      cancel: kind === 'deposit' && role === 'member',
      claim: false,
      submitPayout: kind === 'withdrawal' && role === 'agent',
      confirmReceipt: false,
      appeal: role !== 'support',
      latePayment: false,
      message: role !== 'support',
    },
  };
}
async function open(language, width, kind = 'deposit', role = 'member') {
  const room = fixture(kind, role),
    writes = [];
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    serviceWorkers: 'block',
  });
  await context.addInitScript((code) => {
    localStorage.setItem('salem-language', code);
    localStorage.setItem('theme', 'dark');
  }, language);
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (s) => s.close());
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/v1', '');
    let data = [];
    if (req.method() !== 'GET') {
      if (path === '/member-rewards/activity') data = { earned: false, credited: 0 };
      else if (path === '/agent-disputes' || path === `/withdrawals/${id}/appeal`) {
        writes.push({ path, body: req.postDataJSON() });
        room.status = kind === 'deposit' ? 'DISPUTE' : 'DISPUTED';
        room.actions = {
          ...room.actions,
          appeal: false,
          markPaid: false,
          cancel: false,
          submitPayout: false,
        };
        room.appeals = [
          {
            id: 'synthetic-appeal',
            reason: 'OTHER',
            description: req.postDataJSON().description,
            status: 'OPEN',
            openedAt: new Date().toISOString(),
            resolutionNote: null,
          },
        ];
        data = {};
      } else if (path === `/payment-orders/${kind}/${id}/messages`) {
        const body = req.postDataJSON();
        writes.push({ path, body });
        room.messages.push({
          id: crypto.randomUUID(),
          role,
          mine: true,
          body: body.body,
          createdAt: new Date().toISOString(),
          attachment: null,
        });
        data = {};
      } else
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            success: false,
            error: { message: 'Unexpected synthetic write' },
          }),
        });
    } else if (path === '/auth/me')
      data = {
        user: {
          id: 'preview-payment-member',
          username: 'Dawit',
          displayName: 'Dawit',
          role: role === 'support' ? 'ADMIN' : 'USER',
          status: 'ACTIVE',
          isVerified: true,
        },
      };
    else if (path === '/workspaces/access')
      data = { admin: role === 'support', agent: role === 'agent' };
    else if (path === `/payment-orders/${kind}/${id}`)
      data = { ...room, serverNow: new Date().toISOString() };
    else if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
    else if (path.includes('notifications')) data = [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/wallet/orders/${kind}/${id}`);
  await page.getByText(room.number, { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context, room, writes };
}
async function layout(page, width) {
  const box = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    panels: [...document.querySelectorAll('.p2p-page .payment-panel')].map((e) => {
      const r = e.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        width: r.width,
        scroll: e.scrollWidth,
        client: e.clientWidth,
      };
    }),
  }));
  assert.ok(box.scroll <= width + 1, JSON.stringify(box));
  for (const p of box.panels) {
    assert.ok(p.left >= -1 && p.right <= width + 1, JSON.stringify(box));
    assert.ok(p.scroll <= p.client + 1, JSON.stringify(box));
  }
}
try {
  for (const language of LANGUAGES.map((l) => l.code))
    for (const width of [1440, 390]) {
      const s = await open(language, width);
      await layout(s.page, width);
      assert.equal(await s.page.locator('html').getAttribute('lang'), language);
      assert.equal(
        await s.page.getByRole('button', { name: t(language, 'Open appeal'), exact: true }).count(),
        1
      );
      assert.equal(
        await s.page
          .getByRole('button', { name: t(language, 'Send message'), exact: true })
          .count(),
        1
      );
      if (['en', 'am', 'ar'].includes(language)) {
        const name = `payment-${language}-${width}.png`;
        await s.page.screenshot({ path: resolve(output, name), fullPage: true });
        screenshots.push(name);
      }
      checks.push({ language, width, check: 'order, conversation, appeal and overflow' });
      await s.context.close();
    }
  for (const kind of ['deposit', 'withdrawal'])
    for (const role of ['member', 'agent']) {
      const s = await open('en', 390, kind, role);
      await s.page.getByRole('button', { name: 'Open appeal', exact: true }).click();
      await s.page
        .getByLabel('Describe the issue', { exact: true })
        .fill('Synthetic test: payment is delayed.');
      assert.ok(
        await s.page.getByRole('button', { name: 'Confirm action', exact: true }).isDisabled()
      );
      await s.page
        .getByRole('checkbox', { name: 'I checked the order details and understand this action.' })
        .check();
      await s.page.getByRole('button', { name: 'Confirm action', exact: true }).click();
      await s.page.getByText('Appeal in progress', { exact: true }).waitFor();
      assert.equal(s.writes.length, 1);
      await s.page
        .getByLabel('Message', { exact: true })
        .fill('Synthetic test receipt discussion.');
      await s.page.getByRole('button', { name: 'Send message', exact: true }).click();
      await s.page.getByText('Synthetic test receipt discussion.', { exact: true }).waitFor();
      await layout(s.page, 390);
      const name = `appeal-${kind}-${role}.png`;
      await s.page.screenshot({ path: resolve(output, name), fullPage: true });
      screenshots.push(name);
      checks.push({ kind, role, check: 'appeal consent, hold, conversation and preserved state' });
      await s.context.close();
    }
  const s = await open('en', 320, 'withdrawal', 'agent');
  await layout(s.page, 320);
  checks.push({ width: 320, check: 'narrow phone layout' });
  await s.context.close();
  const support = await open('en', 1440, 'withdrawal', 'support');
  assert.equal(
    await support.page.getByRole('link', { name: 'Open review desk' }).getAttribute('href'),
    '/admin/disputes'
  );
  assert.equal(
    await support.page.getByRole('button', { name: 'Open appeal', exact: true }).count(),
    0
  );
  assert.equal(
    await support.page.getByRole('button', { name: 'Send message', exact: true }).count(),
    0
  );
  checks.push({ role: 'support', check: 'unclaimed order is read-only and points to review desk' });
  await support.context.close();
  assert.deepEqual(errors, []);
} catch (e) {
  await writeFile(resolve(output, 'failure.txt'), String(e.stack));
  throw e;
} finally {
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify({ synthetic: true, checks, errors, screenshots }, null, 2)
  );
  await browser.close();
}
console.log(JSON.stringify({ passed: checks.length, screenshots: screenshots.length, errors }));
