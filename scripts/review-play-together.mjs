// Local, synthetic browser review. No production account, money or API is used.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherTermsHash,
} from '../packages/shared/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.TOGETHER_REVIEW_ORIGIN ?? 'http://127.0.0.1:57426';
const output = resolve(process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-together-review');
assert.equal(new URL(origin).hostname, '127.0.0.1');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage(),
      errors = [],
      writes = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const user = {
      id: 'member-demo',
      username: 'Abebe',
      displayName: 'Abebe Bekele',
      email: 'demo@example.invalid',
      role: 'ADMIN',
      status: 'ACTIVE',
      isVerified: true,
    };
    let settings = {
      version: 1,
      feeBps: 700,
      minEntry: 100,
      maxEntry: 100000,
      enabledGames: ['spin_win', 'turbo_keno', 'dice', 'number_challenge'],
      practiceEnabled: true,
      cashEnabled: false,
      publicRoomsEnabled: false,
    };
    const group = { id: 'sample-group', name: 'Addis Friends', ownerId: user.id, status: 'ACTIVE' };
    const balances = {
      cashAvailable: 0,
      cashReserved: 0,
      pointsAvailable: 10000,
      pointsReserved: 0,
    };
    const round = {
      id: 'sample-round',
      groupId: null,
      creatorId: null,
      groupName: null,
      game: 'spin_win',
      currency: 'GAME_POINTS',
      entryAmount: 1000,
      feeBps: 700,
      settingsVersion: 1,
      minPlayers: 2,
      maxPlayers: 20,
      closesAt: Date.now() + 300000,
      rulesId: TOGETHER_RULES_ID,
      feePolicy: TOGETHER_FEE_POLICY,
      seedCommitment: 'ab'.repeat(32),
      beaconRound: 1,
      state: 'OPEN',
      termsHash: '',
      rosterHash: null,
      entries: [],
      outcome: null,
      ranking: [],
      settlement: null,
      voidReason: null,
      proof: null,
      recoveryDeadline: Date.now() + 900000,
      paidAt: null,
    };
    round.termsHash = togetherTermsHash(round);
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/v1', ''),
        method = request.method();
      let data = {};
      if (path === '/auth/me') data = { user };
      else if (path === '/workspaces/access')
        data = { admin: true, agent: false, agentStatus: null };
      else if (path === '/play-together/admin/settings') {
        if (method === 'PUT') {
          settings = { ...request.postDataJSON(), version: settings.version + 1 };
          writes.push({ path, method });
        }
        data = settings;
      } else if (path === '/play-together/admin/rounds') data = [];
      else if (path === '/play-together/') {
        data = {
          serverTime: Date.now(),
          workerReady: true,
          admissionsEnabled: true,
          settings,
          cashAvailable: false,
          balances,
          group: url.searchParams.has('groupId') ? group : null,
          groups: [group],
          legacyPending: false,
          rounds: [],
        };
      } else if (path === '/play-together/rounds/sample-round/entries' && method === 'POST') {
        writes.push({ path, method });
        const body = request.postDataJSON();
        round.entries = [
          {
            id: 'receipt-1',
            userId: user.id,
            username: user.username,
            selection: body.selection,
            requestId: body.requestId,
            state: 'ACCEPTED',
            amount: 1000,
            payout: null,
            createdAt: Date.now(),
            walletTransactionId: 'wallet-receipt-1',
            payoutTransactionId: null,
          },
        ];
        balances.pointsAvailable = 9000;
        balances.pointsReserved = 1000;
        data = { accepted: true, entryId: 'receipt-1', receiptId: body.requestId };
      } else if (path === '/play-together/rounds/sample-round') {
        data = {
          serverTime: Date.now(),
          workerReady: true,
          admissionsEnabled: true,
          settings,
          cashAvailable: false,
          balances,
          round,
        };
      } else if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
      else if (path.includes('notifications')) data = { notifications: [], unreadCount: 0 };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    });
    async function capture(name) {
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      assert.ok(layout.scroll <= layout.width + 1, name + ' overflows at ' + width);
      await page.screenshot({ path: resolve(output, name + '-' + width + '.png'), fullPage: true });
      results.push({ screen: name, width, ...layout, errors: [...errors] });
    }
    await page.goto(origin + '/play-together');
    await page.getByRole('heading', { name: 'Play together.', exact: true }).waitFor();
    await capture('lobby');
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: 'Real Birr', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Open shared room' }).isDisabled(), true);
    await page.goto(origin + '/groups/sample-group/games');
    await page.getByRole('button', { name: 'Publish round' }).waitFor();
    await capture('owner');
    await page.goto(origin + '/play-together/rounds/sample-round');
    const confirm = page.getByRole('button', { name: 'Confirm 1,000 points entry', exact: true });
    await confirm.waitFor();
    await capture('confirmation');
    await confirm.click();
    await page.getByRole('heading', { name: 'Your confirmed entry', exact: true }).waitFor();
    assert.equal(writes.filter((w) => w.path.endsWith('/entries')).length, 1);
    await capture('confirmed');
    await page.goto(origin + '/admin/group-play');
    await page.getByText('Platform fee (%)', { exact: true }).waitFor();
    await capture('admin');
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      { kind: 'Synthetic Chromium UI checks; database and authentication are mocked.', results },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: results.length, output }));
} finally {
  await browser.close();
}
