// Capacity and long-hand layout regression against a built LOOPBACK preview.
// All APIs are fixtures; external requests and financial writes are blocked.
// TOGETHER_REVIEW_ORIGIN=http://127.0.0.1:4181 PLAYWRIGHT_MODULE=<installed module> \
//   node scripts/review-shared-game-capacity.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import {
  TOGETHER_GAMES,
  TOGETHER_LIMITS,
  TOGETHER_GAME_DURATION_MS,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  bjTotal,
  bjResult,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
  quicknetTargetForCutoff,
  togetherSeedCommitment,
  togetherTermsHash,
  togetherRosterHash,
} from '../packages/shared/dist/index.js';

const origin = process.env.TOGETHER_REVIEW_ORIGIN;
assert.ok(origin, 'Set TOGETHER_REVIEW_ORIGIN to the built loopback preview');
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(origin).origin, origin);
const output = resolve(process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-group-capacity');
await mkdir(output, { recursive: true });
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const bundle = await build({
  entryPoints: [resolve('apps/api/src/games/play-together/presentation.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { preparePresentation } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const viewer = {
  id: 'capacity-spectator',
  username: 'Hana',
  displayName: 'Hana Tesfaye',
  email: 'spectator@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const group = {
  id: 'capacity-group',
  name: 'Addis Friends',
  ownerId: 'member-01',
  status: 'ACTIVE',
};
const maximum = TOGETHER_LIMITS.maxPlayers;
assert.equal(maximum, 20, 'Update the capacity matrix if the published limit changes');
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

function selection(game, i) {
  if (['spin_win', 'dice'].includes(game)) return [];
  if (game === 'number_challenge') return [1 + i * 5];
  if (['thunder_derby_3d', 'neon_hounds_3d'].includes(game)) return [1 + (i % 8)];
  if (['blackjack', 'virtual_football_3d'].includes(game))
    return Array.from(
      { length: game === 'blackjack' ? 6 : 3 },
      (_, n) => Math.floor(i / 3 ** n) % 3
    );
  if (['sky_crash', 'crash_point'].includes(game)) return [101 + i * 10];
  return Array.from({ length: game === 'lucky_six' ? 6 : 5 }, (_, n) => 1 + i + n);
}

// A physically possible six-deck shoe. Both dealer and hand 1 have twelve cards.
// Each prefix still hits below 17; no repeated card IDs or impossible all-ace hands.
function longBlackjackOutcome() {
  const ranks = [
    [...Array(6).fill(1), 6, ...Array(5).fill(1)],
    [...Array(6).fill(1), 6, ...Array(5).fill(1)],
    [...Array(8).fill(2), 1],
    [...Array(8).fill(2), 1],
    [...Array(8).fill(2), 3],
    Array(6).fill(3),
    [...Array(4).fill(4), 5],
  ];
  const shoe = Array.from({ length: 312 }, (_, i) => i);
  const hands = ranks.map((hand) =>
    hand.map((rank) => {
      const index = shoe.findIndex((id) => id % 13 === rank - 1);
      assert.ok(index >= 0, 'Fixture exhausted a card rank');
      return shoe.splice(index, 1)[0];
    })
  );
  for (const hand of hands) {
    for (let n = 2; n < hand.length; n++) assert.ok(bjTotal(hand.slice(0, n)).total < 17);
    assert.ok(bjTotal(hand).total >= 17);
  }
  assert.equal(new Set(hands.flat()).size, hands.flat().length);
  return {
    hands,
    numbers: hands.slice(1).map((h) => ['WIN', 'DRAW', 'LOSE'].indexOf(bjResult(h, hands[0]))),
  };
}

function fixture(game, mode) {
  const now = Date.now(),
    duration = TOGETHER_GAME_DURATION_MS[game],
    id = 'capacity-' + game;
  const closesAt = now - duration - 30000;
  const round = {
    id,
    groupId: group.id,
    groupName: group.name,
    creatorId: group.ownerId,
    game,
    currency: 'GAME_POINTS',
    entryAmount: 1000,
    feeBps: 700,
    settingsVersion: 1,
    minPlayers: 2,
    maxPlayers: maximum,
    closesAt,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: '',
    beaconRound: quicknetTargetForCutoff(closesAt).beaconRound,
    termsVersion: 2,
    presentationVersion: 2,
    presentationDurationMs: duration,
    voidReason: null,
    recoveryDeadline: closesAt + 600000,
  };
  const tickets = Array.from({ length: maximum }, (_, i) => ({
    id: 'entry-' + String(i + 1).padStart(2, '0'),
    userId: 'member-' + String(i + 1).padStart(2, '0'),
    selection: selection(game, i),
  }));
  let proof, outcome, ranking, settlement;
  for (let i = 1; i <= 500; i++) {
    const seed = i.toString(16).padStart(64, '0');
    round.seedCommitment = togetherSeedCommitment(id, seed);
    // Intentionally not a valid beacon proof: this is a browser layout fixture.
    proof = {
      seed,
      beacon: { round: round.beaconRound, randomness: 'ca'.repeat(32), signature: '00'.repeat(48) },
    };
    outcome =
      game === 'blackjack' ? longBlackjackOutcome() : deriveTogetherOutcome(round, tickets, proof);
    ranking = rankTogether(game, tickets, outcome);
    settlement = settleTogether(1000, 700, ranking, id);
    if (!settlement.refunds) break;
  }
  assert.equal(settlement.refunds, false, `No payable fixture for ${game}`);
  const complete = mode === 'complete';
  const startsAt = now - duration * (complete ? 1.2 : 0.8);
  const recording = preparePresentation(game, duration, outcome, tickets, proof.seed);
  const entries = tickets.map((ticket, i) => ({
    ...ticket,
    username: 'GebremedhinWoldeMichael' + String(i + 1).padStart(2, '0'),
    state: complete ? 'SETTLED' : 'ACCEPTED',
    amount: 1000,
    payout: complete
      ? (settlement.payouts.find((p) => p.entryId === ticket.id)?.amount ?? 0)
      : null,
    createdAt: closesAt - 60000,
    walletTransactionId: 'hold-' + ticket.id,
    payoutTransactionId: complete ? 'paid-' + ticket.id : null,
    requestId: null,
  }));
  return {
    ...round,
    termsHash: togetherTermsHash(round),
    rosterHash: togetherRosterHash(tickets),
    state: complete ? 'PAID' : 'DRAWN',
    entries,
    outcome: complete ? outcome : null,
    ranking: complete ? ranking : [],
    settlement: complete ? settlement : null,
    proof: complete ? proof : null,
    paidAt: complete ? startsAt + duration : null,
    eventSequence: recording.length,
    presentation: {
      version: 2,
      startsAt,
      finishesAt: startsAt + duration,
      observedAt: now,
      resultAvailable: complete,
      events: recording.filter((e) => e.atMs <= now - startsAt),
    },
  };
}

const cases = [
  { language: 'en', width: 1280 },
  { language: 'en', width: 1024 },
  { language: 'en', width: 768 },
  { language: 'en', width: 390 },
  { language: 'en', width: 320 },
  { language: 'am', width: 390 },
  { language: 'ar', width: 390 },
].filter(
  (c) =>
    (!process.env.TOGETHER_REVIEW_LANGUAGE ||
      c.language === process.env.TOGETHER_REVIEW_LANGUAGE) &&
    (!process.env.TOGETHER_REVIEW_WIDTH || c.width === Number(process.env.TOGETHER_REVIEW_WIDTH))
);
const games = TOGETHER_GAMES.filter(
  (g) => !process.env.TOGETHER_REVIEW_GAME || g.key === process.env.TOGETHER_REVIEW_GAME
);
const checks = [],
  errors = [],
  writes = [],
  failures = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const { language, width } of cases) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      serviceWorkers: 'block',
      reducedMotion: 'reduce',
    });
    await context.addInitScript((code) => {
      localStorage.setItem('salem-language', code);
      localStorage.setItem('salem-game-quality', 'low');
    }, language);
    if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
    let round;
    await context.route('**/*', (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin || url.pathname.startsWith('/ws')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/v1', '');
      const respond = (data) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data }),
        });
      if (path === '/member-rewards/activity') return respond({ earned: false, credited: 0 });
      if (request.method() !== 'GET') {
        writes.push({ path, method: request.method() });
        return route.abort();
      }
      if (path === '/auth/me') return respond({ user: viewer });
      if (path === '/workspaces/access') return respond({ admin: false, agent: false });
      if (path.startsWith('/play-together/rounds/'))
        return respond({
          serverTime: round.presentation.observedAt,
          round,
          workerReady: true,
          admissionsEnabled: true,
          settings,
          cashAvailable: false,
          balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 0, pointsReserved: 0 },
        });
      if (path === `/groups/${group.id}/lifecycle`)
        return respond({
          name: group.name,
          expiresAt: Date.now() + 86400000,
          serverTime: Date.now(),
          closed: false,
          archived: false,
          canModerate: false,
        });
      if (path === `/groups/${group.id}`)
        return respond({
          ...group,
          isMember: true,
          memberCount: maximum + 1,
          memberRole: 'MEMBER',
          owner: { id: group.ownerId },
        });
      if (path.includes('unread')) return respond({ count: 0, unreadCount: 0 });
      if (path.includes('notifications')) return respond({ notifications: [], unreadCount: 0 });
      return respond([]);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push({ language, width, message: error.message }));
    for (const { key: game } of games)
      for (const mode of ['live', 'complete']) {
        const label = `${language}-${width}-${game}-${mode}`;
        try {
          round = fixture(game, mode);
          await page.goto(origin + '/play-together/rounds/' + round.id);
          await page.locator('.tg-live').waitFor();
          await page.locator('.together-participants > div').first().waitFor({ state: 'attached' });
          // Let new card-deal transforms finish before measuring the stable layout.
          await page.waitForTimeout(650);
          const geometry = await page.evaluate(() => {
            const box = (e) => {
              const r = e.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                right: r.right,
                bottom: r.bottom,
                width: r.width,
                height: r.height,
              };
            };
            const hands = [...document.querySelectorAll('.original-blackjack .bj-hand')].map(
              (el) => ({
                ...box(el),
                cards: [...el.querySelectorAll('.bj-card')].map((card) => ({
                  ...box(card),
                  label: card.getAttribute('aria-label'),
                })),
              })
            );
            const lists = ['.tg-wheel-roster', '.original-dice-roster', '.tg-guesses']
              .map((selector) => {
                const el = document.querySelector(selector);
                return el
                  ? {
                      selector,
                      clientHeight: el.clientHeight,
                      scrollHeight: el.scrollHeight,
                      clientWidth: el.clientWidth,
                      scrollWidth: el.scrollWidth,
                      overflowY: getComputedStyle(el).overflowY,
                    }
                  : null;
              })
              .filter(Boolean);
            return {
              width: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              scrollY,
              direction: document.documentElement.dir,
              hands,
              lists,
              participants: document.querySelectorAll('.together-participants > div').length,
              dicePlayers: document.querySelectorAll('.original-dice-player').length,
              wheelPlayers: document.querySelectorAll('.tg-wheel-roster > div').length,
              guesses: document.querySelectorAll('.tg-guesses > li').length,
            };
          });
          checks.push({ label, game, mode, ...geometry });
          const defects = [];
          if (geometry.scrollWidth > width + 1) defects.push('page horizontal overflow');
          if (geometry.participants !== maximum) defects.push('missing participant rows');
          if (geometry.scrollY !== 0) defects.push('unexpected document scrolling');
          if (geometry.direction !== (language === 'ar' ? 'rtl' : 'ltr'))
            defects.push('wrong language direction');
          for (const [key, expected] of [
            ['dicePlayers', game === 'dice'],
            ['wheelPlayers', game === 'spin_win'],
            ['guesses', game === 'number_challenge'],
          ])
            if (expected && geometry[key] !== maximum) defects.push(`missing ${key}`);
          for (const list of geometry.lists) {
            if (list.scrollWidth > list.clientWidth + 1)
              defects.push(`${list.selector} horizontal overflow`);
            if (
              list.scrollHeight > list.clientHeight + 1 &&
              !['auto', 'scroll'].includes(list.overflowY)
            )
              defects.push(`${list.selector} has unreachable rows`);
          }
          for (const [i, hand] of geometry.hands.entries()) {
            if (hand.cards.some((card) => card.x < hand.x - 1 || card.right > hand.right + 1))
              defects.push(`hand ${i} cards leave their hand`);
            for (const [j, other] of geometry.hands.entries())
              if (
                j > i &&
                hand.cards.some((a) =>
                  other.cards.some(
                    (b) =>
                      Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
                      Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1
                  )
                )
              )
                defects.push(`hands ${i}/${j} cards overlap`);
          }
          if (game === 'blackjack' && mode === 'complete') {
            assert.deepEqual(
              geometry.hands.map((h) => h.cards.length),
              [12, 12, 9, 9, 9, 6, 5]
            );
            assert.ok(
              geometry.hands.every((h) => h.cards.every((c) => c.label)),
              'All released cards have accessible labels'
            );
          }
          if (
            defects.length ||
            (['blackjack', 'dice', 'spin_win', 'number_challenge'].includes(game) &&
              mode === 'complete')
          ) {
            await page.screenshot({ path: resolve(output, label + '.png'), fullPage: true });
            await page
              .locator('.tg-live')
              .screenshot({ path: resolve(output, label + '-arena.png') });
          }
          if (defects.length) failures.push({ label, defects });
          // Actual hit-testing catches a rank/suit strip hidden beneath another card,
          // including when the surrounding interface uses right-to-left text.
          if (game === 'blackjack' && mode === 'complete') {
            const covered = await page.evaluate(async () => {
              const failures = [];
              for (const [index, card] of [
                ...document.querySelectorAll('.original-blackjack .bj-hand .bj-card'),
              ].entries()) {
                const corner = card.querySelector('.bj-card-corner');
                corner.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                await new Promise(requestAnimationFrame);
                const r = corner.getBoundingClientRect();
                if (
                  ![0.25, 0.75].every((f) =>
                    card.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height * f))
                  )
                )
                  failures.push(index);
              }
              return failures;
            });
            assert.deepEqual(covered, [], 'Every card rank and suit must remain visible');
          }
          for (const [container, row] of [
            ['.tg-wheel-roster', '.tg-wheel-roster > div'],
            ['.original-dice-roster', '.original-dice-player'],
            ['.tg-guesses', '.tg-guesses > li'],
          ]) {
            if (!(await page.locator(row).count())) continue;
            await page.locator(row).last().scrollIntoViewIfNeeded();
            const reach = await page.evaluate(
              ({ container, row }) => {
                const outer = document.querySelector(container).getBoundingClientRect();
                const inner = [...document.querySelectorAll(row)].at(-1).getBoundingClientRect();
                return inner.bottom <= outer.bottom + 1 && inner.top >= outer.top - 1;
              },
              { container, row }
            );
            assert.ok(reach, `The final player must be reachable in ${container}`);
          }
          // Expand the official result and confirm the full roster remains reachable.
          if (mode === 'complete') {
            const last = page.locator('.together-participants > div').last();
            await last.scrollIntoViewIfNeeded();
            assert.ok(await last.isVisible(), 'Last participant can be reached');
            if (game === 'blackjack') {
              await page.locator('.tg-result-details > summary').click();
              assert.equal(await page.locator('.tg-result-cards .tg-result-card').count(), 62);
            }
          }
        } catch (error) {
          failures.push({ label, error: error.stack });
          console.error(JSON.stringify({ label, error: error.message }));
          await page
            .screenshot({ path: resolve(output, label + '-error.png'), fullPage: true })
            .catch(() => {});
        }
      }
    console.log(
      JSON.stringify({ language, width, checks: checks.length, failures: failures.length })
    );
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'capacity.json'),
    JSON.stringify(
      {
        kind: 'Synthetic loopback browser fixtures; no live accounts, bets or proof verification',
        maximumParticipants: maximum,
        longHandLengths: [12, 12, 9, 9, 9, 6, 5],
        checks,
        failures,
        errors,
        writes,
      },
      null,
      2
    )
  );
}
console.log(
  JSON.stringify({
    checks: checks.length,
    failures: failures.length,
    errors: errors.length,
    writes: writes.length,
    output,
  })
);
assert.equal(
  errors.length + writes.length + failures.length,
  0,
  'See capacity.json and screenshots for reproducible layout failures'
);
