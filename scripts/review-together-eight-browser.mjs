// Synthetic UI acceptance only. All accounts, API responses and outcome records are
// fixtures; no production server, funds, signing key or provider is contacted.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import {
  TOGETHER_GAMES,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherTermsHash,
  togetherSeedCommitment,
  togetherRosterHash,
  quicknetTargetForCutoff,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
} from '../packages/shared/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const origin = process.env.TOGETHER_REVIEW_ORIGIN ?? 'http://127.0.0.1:57426';
const output = resolve(
  process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-together-eight-review'
);
assert.equal(
  new URL(origin).hostname,
  '127.0.0.1',
  'This harness may only target a loopback preview'
);
const games = TOGETHER_GAMES.slice(4);
const resultHeading = (game) =>
  game === 'roulette_keno' || game === 'lucky_six'
    ? 'The shared draw'
    : game === 'thunder_derby_3d' || game === 'neon_hounds_3d'
      ? 'The finishing order'
      : game === 'blackjack'
        ? 'The table revealed'
        : game === 'virtual_football_3d'
          ? 'Full-time results'
          : 'The crash result';
const selection = (game, other = false) => {
  if (game === 'roulette_keno') return other ? [10, 11, 12, 13, 14] : [1, 2, 3, 4, 5];
  if (game === 'lucky_six') return other ? [10, 11, 12, 13, 14, 15] : [1, 2, 3, 4, 5, 6];
  if (game === 'thunder_derby_3d' || game === 'neon_hounds_3d') return [other ? 2 : 1];
  if (game === 'blackjack') return other ? [2, 0, 1, 2, 0, 1] : [0, 1, 2, 0, 1, 2];
  if (game === 'virtual_football_3d') return other ? [2, 0, 1] : [0, 1, 2];
  return [other ? 300 : 200];
};
function roundFixture(game, width, tag = '') {
  const id = `browser-${game}-${width}-${tag}`;
  const closesAt = Date.now() + 600000;
  const round = {
    id,
    groupId: null,
    creatorId: 'member-demo',
    groupName: null,
    game,
    currency: 'GAME_POINTS',
    entryAmount: 1000,
    feeBps: 700,
    settingsVersion: 1,
    minPlayers: 2,
    maxPlayers: 20,
    closesAt,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: '',
    beaconRound: quicknetTargetForCutoff(closesAt).beaconRound,
    state: 'OPEN',
    termsHash: '',
    rosterHash: null,
    entries: [],
    outcome: null,
    ranking: [],
    settlement: null,
    voidReason: null,
    proof: null,
    recoveryDeadline: closesAt + 600000,
    paidAt: null,
  };
  const tickets = [
    { id: 'entry-me', userId: 'member-demo', selection: selection(game) },
    { id: 'entry-other', userId: 'other-demo', selection: selection(game, true) },
  ];
  let derived;
  for (let attempt = 1; attempt <= 200; attempt++) {
    const seed = attempt.toString(16).padStart(64, '0');
    round.seedCommitment = togetherSeedCommitment(id, seed);
    // Deliberately synthetic proof: the proof verification button is never used.
    const proof = {
      seed,
      beacon: { round: round.beaconRound, randomness: 'ca'.repeat(32), signature: '00'.repeat(48) },
    };
    const outcome = deriveTogetherOutcome(round, tickets, proof);
    const ranking = rankTogether(game, tickets, outcome);
    const settlement = settleTogether(1000, 700, ranking, id);
    derived = { proof, outcome, ranking, settlement };
    if (!settlement.refunds) break;
  }
  assert.equal(derived.settlement.refunds, false, `Unable to create paid ${game} fixture`);
  round.termsHash = togetherTermsHash(round);
  const entries = tickets.map((t) => ({
    ...t,
    username: t.userId === 'member-demo' ? 'Abebe' : 'Tigist',
    state: 'ACCEPTED',
    amount: 1000,
    payout: null,
    createdAt: Date.now(),
    walletTransactionId: 'wallet-' + t.id,
    payoutTransactionId: null,
    requestId: null,
  }));
  round.entries = [{ ...entries[1], selection: null }];
  return { round, entries, tickets, derived };
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [],
  errors = [];
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push({ width, message: e.message }));
    const user = {
      id: 'member-demo',
      username: 'Abebe',
      displayName: 'Abebe Bekele',
      email: 'demo@example.invalid',
      role: 'USER',
      status: 'ACTIVE',
      isVerified: true,
    };
    const settings = {
      version: 1,
      feeBps: 700,
      minEntry: 100,
      maxEntry: 100000,
      enabledGames: TOGETHER_GAMES.map((g) => g.key),
      practiceEnabled: true,
      cashEnabled: false,
      publicRoomsEnabled: false,
    };
    let fixture,
      writes = [],
      offline = false,
      workerReady = true;
    let balances = { cashAvailable: 0, cashReserved: 0, pointsAvailable: 10000, pointsReserved: 0 };
    await page.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/v1', ''),
        method = request.method();
      if (offline && path.startsWith('/play-together/'))
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Synthetic disconnect' }),
        });
      let data = {};
      if (path === '/auth/me') data = { user };
      else if (path === '/workspaces/access')
        data = { admin: false, agent: false, agentStatus: null };
      else if (path.endsWith('/entries') && method === 'POST') {
        const body = request.postDataJSON();
        writes.push({ path, method, body });
        assert.equal(body.termsHash, fixture.round.termsHash);
        assert.deepEqual(body.selection, selection(fixture.round.game));
        fixture.round.entries.push({ ...fixture.entries[0], requestId: body.requestId });
        balances = { ...balances, pointsAvailable: 9000, pointsReserved: 1000 };
        data = { accepted: true, entryId: 'entry-me', receiptId: body.requestId };
      } else if (path.startsWith('/play-together/rounds/')) {
        data = {
          serverTime: Date.now(),
          workerReady,
          admissionsEnabled: true,
          settings,
          cashAvailable: false,
          balances,
          round: fixture.round,
        };
      } else if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
      else if (path.includes('notifications')) data = { notifications: [], unreadCount: 0 };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    });
    async function capture(game, state, screenshot = true) {
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
      }));
      assert.ok(
        layout.document <= layout.viewport + 1,
        `${game} ${state} overflows at ${width}: ${JSON.stringify(layout)}`
      );
      if (screenshot)
        await page.screenshot({
          path: resolve(output, `${game}-${state}-${width}.png`),
          fullPage: true,
        });
      checks.push({ game, state, width, ...layout });
    }
    async function choose(game) {
      if (game === 'blackjack' || game === 'virtual_football_3d') {
        const selects = page.locator('.together-selection select');
        for (let i = 0; i < selection(game).length; i++)
          await selects.nth(i).selectOption(String(selection(game)[i]));
      } else if (game === 'sky_crash' || game === 'crash_point')
        await page.getByLabel('Automatic exit target (1.01×–20×)').fill('2.00');
      else if (game === 'thunder_derby_3d')
        await page.getByRole('button', { name: 'Choose runner 1', exact: true }).click();
      else if (game === 'neon_hounds_3d')
        await page.getByRole('button', { name: 'Choose dog 1', exact: true }).click();
      else
        for (const n of selection(game))
          await page.getByRole('button', { name: 'Choose ' + n, exact: true }).click();
    }
    for (const game of games) {
      fixture = roundFixture(game.key, width);
      writes = [];
      balances = { cashAvailable: 0, cashReserved: 0, pointsAvailable: 10000, pointsReserved: 0 };
      await page.goto(origin + '/play-together/rounds/' + fixture.round.id);
      const confirm = page.getByRole('button', { name: 'Confirm 1,000 points entry', exact: true });
      await confirm.waitFor();
      assert.equal(
        await confirm.isDisabled(),
        true,
        `${game.key} requires an explicit complete choice`
      );
      assert.equal(await page.getByText('Recorded result', { exact: true }).count(), 0);
      assert.equal(writes.length, 0);
      await choose(game.key);
      assert.equal(await confirm.isEnabled(), true);
      await capture(game.key, 'open');
      await confirm.click();
      await page.getByRole('heading', { name: 'Your confirmed entry', exact: true }).waitFor();
      assert.equal(writes.length, 1);
      await capture(game.key, 'confirmed', false);
      fixture.round = {
        ...fixture.round,
        ...fixture.derived,
        state: 'PAID',
        paidAt: Date.now() - 60000,
        rosterHash: togetherRosterHash(fixture.tickets),
        entries: fixture.entries.map((entry) => ({
          ...entry,
          state: 'SETTLED',
          payout: fixture.derived.settlement.payouts.find((p) => p.entryId === entry.id).amount,
          payoutTransactionId: 'payout-' + entry.id,
        })),
      };
      await page.getByRole('heading', { name: resultHeading(game.key), exact: true }).waitFor();
      assert.equal(await page.getByText('Result display unavailable', { exact: true }).count(), 0);
      assert.equal(await page.getByText(/It will settle automatically/).count(), 0);
      await capture(game.key, 'paid');
      const replay = page.getByRole('button', { name: 'Replay for me', exact: true });
      if (await replay.count()) {
        await replay.click();
        await page
          .getByText(
            'Your personal replay. The group’s result and everyone’s wallet are unchanged.',
            {
              exact: true,
            }
          )
          .waitFor();
        await page.getByRole('button', { name: 'Show final result', exact: true }).click();
        assert.equal(writes.length, 1, 'Replay must not submit a financial action');
        await capture(game.key, 'replay', false);
      }
    }
    fixture = roundFixture('roulette_keno', width, 'underfilled');
    fixture.round = {
      ...fixture.round,
      state: 'REFUNDED',
      entries: [{ ...fixture.entries[0], state: 'REFUNDED', payout: 1000 }],
      outcome: null,
      ranking: [],
      proof: null,
      voidReason: 'NOT_ENOUGH_PLAYERS',
      settlement: {
        funded: 1000,
        feeBps: 700,
        platformFee: 0,
        winnerCount: 0,
        refunds: true,
        reason: 'NOT_ENOUGH_PLAYERS',
        payouts: [{ entryId: 'entry-me', amount: 1000, profit: 0 }],
      },
    };
    await page.goto(origin + '/play-together/rounds/' + fixture.round.id);
    await page.getByRole('heading', { name: 'Entries returned', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Replay for me', exact: true }).count(), 0);
    await capture('roulette_keno', 'refund');
    fixture = roundFixture('sky_crash', width, 'worker-paused');
    workerReady = false;
    await page.goto(origin + '/play-together/rounds/' + fixture.round.id);
    const confirm = page.getByRole('button', { name: 'Confirm 1,000 points entry', exact: true });
    await confirm.waitFor();
    await choose('sky_crash');
    assert.equal(await confirm.isDisabled(), true);
    await capture('sky_crash', 'worker-paused', false);
    workerReady = true;
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Confirm 1,000 points entry' && !b.disabled
      )
    );
    offline = true;
    await page
      .getByText('Reconnecting. Entry controls are paused until the server confirms this round.', {
        exact: true,
      })
      .waitFor();
    assert.equal(await confirm.isDisabled(), true);
    await capture('sky_crash', 'disconnected');
    offline = false;
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (b) => b.textContent === 'Confirm 1,000 points entry' && !b.disabled
      )
    );
    await capture('sky_crash', 'reconnected', false);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    await context.close();
  }
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      {
        kind: 'Synthetic Chromium UI checks: mocked authentication, API and proof; no live wallet verification.',
        checks,
        errors,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ passed: checks.length, output, errors }));
} finally {
  await browser.close();
}
