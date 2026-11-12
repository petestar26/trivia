// Two-client synchronisation review for Dog Racing, against a built loopback preview.
//
// Both browsers share one synthetic "server" (fixtures generated from the repository's
// own presentation and solo position code) and run on Playwright fake clocks stepped in
// lockstep, so every comparison is exact and repeatable. External hosts and WebSockets
// are aborted and any non-GET API request fails the run: nothing can place a bet.
//
//   HOUND_REVIEW_ORIGIN=http://127.0.0.1:4312 HOUND_REVIEW_OUTPUT=/tmp/sync \
//     node scripts/review-greyhound-sync.mjs
//
// Checks (shared group round): client B joins mid-race; at held checkpoints both clients
// draw every runner exactly at the published position; B loses its connection and never
// runs ahead, then matches again; A reloads mid-race and matches; both show the same
// official finishing order as the server outcome, with the winner on the line. Solo page:
// two clients never draw a runner beyond a published position and show the same result.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherTermsHash,
  togetherSeedCommitment,
  togetherRosterHash,
  quicknetTargetForCutoff,
  deriveTogetherOutcome,
  rankTogether,
  settleTogether,
  DOG_RACING_RULES,
} from '../packages/shared/dist/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.HOUND_REVIEW_ORIGIN;
assert.ok(origin, 'Set HOUND_REVIEW_ORIGIN to the built loopback preview URL');
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Only a loopback preview is allowed');
const output = resolve(process.env.HOUND_REVIEW_OUTPUT ?? 'greyhound-sync');
await mkdir(output, { recursive: true });

async function bundle(entry) {
  const result = await build({
    entryPoints: [resolve(repo, entry)],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  return import(
    'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const { preparePresentation } = await bundle('apps/api/src/games/play-together/presentation.ts');
const { derbyPositions } = await bundle('apps/api/src/games/thunder-derby/math.ts');

const user = {
  id: 'sync-member',
  username: 'Abebe',
  displayName: 'Abebe Bekele',
  email: 'sync-member@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const group = { id: 'sync-group', name: 'Addis Friends', ownerId: user.id, status: 'ACTIVE' };
const settings = {
  version: 1,
  feeBps: 700,
  minEntry: 100,
  maxEntry: 100000,
  enabledGames: ['neon_hounds_3d'],
  practiceEnabled: true,
  cashEnabled: false,
  publicRoomsEnabled: false,
};
function sharedFixture() {
  const game = 'neon_hounds_3d',
    id = 'sync-' + game,
    closesAt = 1799999000000;
  const round = {
    id,
    groupId: group.id,
    groupName: group.name,
    creatorId: user.id,
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
    { id: 'entry-me', userId: user.id, selection: [1] },
    { id: 'entry-other', userId: 'sync-other', selection: [2] },
  ];
  let derived;
  for (let attempt = 1; attempt <= 500; attempt++) {
    const seed = (attempt + 77).toString(16).padStart(64, '0');
    round.seedCommitment = togetherSeedCommitment(id, seed);
    const proof = {
      seed,
      beacon: { round: round.beaconRound, randomness: 'cb'.repeat(32), signature: '00'.repeat(48) },
    };
    const outcome = deriveTogetherOutcome(round, tickets, proof);
    const ranking = rankTogether(game, tickets, outcome);
    const settlement = settleTogether(1000, 700, ranking, id);
    derived = { proof, outcome, ranking, settlement };
    if (!settlement.refunds) break;
  }
  round.termsHash = togetherTermsHash(round);
  const entries = tickets.map((ticket, i) => ({
    ...ticket,
    username: i ? 'Tigist' : 'Abebe',
    state: 'SETTLED',
    amount: 1000,
    payout: derived.settlement.payouts.find((p) => p.entryId === ticket.id)?.amount ?? 0,
    createdAt: closesAt - 60000,
    walletTransactionId: 'wallet-' + ticket.id,
    payoutTransactionId: 'paid-' + ticket.id,
    requestId: null,
  }));
  return {
    ...round,
    ...derived,
    state: 'PAID',
    paidAt: closesAt + 60000,
    rosterHash: togetherRosterHash(tickets),
    entries,
  };
}

const fixture = sharedFixture();
const duration = 32000,
  epoch = 1800000000000;
const recording = preparePresentation(
  'neon_hounds_3d',
  duration,
  fixture.outcome,
  fixture.entries,
  fixture.proof.seed
);
const raceEvents = recording.filter((e) => e.kind === 'race');
// The one synthetic server both clients talk to. `hold` caps disclosure at a checkpoint.
const server = { elapsed: -2000, hold: null };
function disclosure() {
  const elapsed = server.elapsed,
    disclosed = server.hold ?? elapsed,
    finished = elapsed >= duration && disclosed >= duration,
    now = epoch + elapsed;
  const r = {
    ...fixture,
    termsVersion: 2,
    presentationVersion: 2,
    presentationDurationMs: duration,
    state: finished ? 'PAID' : 'DRAWN',
    eventSequence: Math.max(0, Math.floor(disclosed / 1000)),
    presentation: {
      version: 2,
      startsAt: epoch,
      finishesAt: epoch + duration,
      observedAt: now,
      resultAvailable: finished,
      events: recording.filter((e) => e.atMs <= disclosed),
    },
  };
  if (!finished)
    Object.assign(r, {
      outcome: null,
      proof: null,
      ranking: [],
      settlement: null,
      paidAt: null,
      entries: r.entries.map((e) => ({
        ...e,
        state: 'ACCEPTED',
        payout: null,
        payoutTransactionId: null,
      })),
    });
  r.termsHash = togetherTermsHash(r);
  return { now, r };
}
const soloSeed = 'c'.repeat(64),
  soloOrder = [4, 2, 6, 1, 3, 5];
function soloSnapshot() {
  const elapsed = server.elapsed,
    raceMs = DOG_RACING_RULES.raceMs,
    finished = elapsed >= raceMs;
  return {
    rulesId: DOG_RACING_RULES.id,
    serverTime: epoch + elapsed,
    balance: 1000,
    rounds: [
      {
        id: 'sync-solo-race',
        field: 6,
        opensAt: epoch - 60000,
        startsAt: epoch,
        finishesAt: epoch + raceMs,
        endsAt: epoch + raceMs + 15000,
        commitment: 'a'.repeat(64),
        order: finished ? soloOrder : null,
        seed: finished ? soloSeed : null,
        positions: derbyPositions(soloOrder, Math.max(0, elapsed), soloSeed),
        ticket: null,
      },
    ],
  };
}

const checks = [],
  errors = [],
  blocked = [];
const browser = await chromium.launch({ headless: true });

async function client(name, { width = 390, height = 844 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  const self = { name, ctx, offline: false, page: null };
  await ctx.addInitScript(() => {
    localStorage.setItem('salem-language', 'en');
    localStorage.setItem('salem-game-quality', 'balanced');
  });
  await ctx.routeWebSocket('**/*', (socket) => socket.close());
  await ctx.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) {
      blocked.push({ client: name, url: url.origin, path: url.pathname });
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/'))
      return req.method() === 'GET' ? route.continue() : route.abort();
    const path = url.pathname.replace('/api/v1', '');
    const respond = (data) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    if (path === '/member-rewards/activity') return respond({ earned: false, credited: 0 });
    if (req.method() !== 'GET') {
      errors.push(`${name}: unexpected ${req.method()} ${path}`);
      return route.abort();
    }
    if (self.offline && (path.startsWith('/play-together') || path === '/games/dog-racing'))
      return route.abort();
    if (path === '/auth/me') return respond({ user });
    if (path === '/workspaces/access') return respond({ admin: false, agent: false });
    if (path === '/games/dog-racing') return respond(soloSnapshot());
    const { now, r } = disclosure();
    if (path.startsWith('/play-together/rounds/'))
      return respond({
        serverTime: now,
        round: r,
        workerReady: true,
        admissionsEnabled: true,
        settings,
        cashAvailable: false,
        balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 0, pointsReserved: 0 },
      });
    if (path === `/groups/${group.id}/lifecycle`)
      return respond({
        name: group.name,
        expiresAt: now + 86400000,
        serverTime: now,
        closed: false,
        archived: false,
        canModerate: false,
      });
    if (path === `/groups/${group.id}`)
      return respond({
        ...group,
        isMember: true,
        memberCount: 2,
        memberRole: 'MEMBER',
        owner: user,
      });
    if (path.includes('unread')) return respond({ count: 0, unreadCount: 0 });
    if (path.includes('notifications')) return respond({ notifications: [], unreadCount: 0 });
    return respond([]);
  });
  self.open = async (url) => {
    self.page?.isClosed() === false && (await self.page.close());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.clock.install({ time: epoch + server.elapsed });
    await page.clock.pauseAt(epoch + server.elapsed);
    await page.goto(origin + url);
    for (let i = 0; i < 600 && !(await page.locator('.hounds-scene canvas').count()); i++)
      await page.clock.runFor(5);
    await page.evaluate(() =>
      document.querySelector('.hounds-scene')?.scrollIntoView({ block: 'center' })
    );
    self.page = page;
  };
  self.laps = () =>
    self.page.$$eval('.hounds-scene-tags span', (spans) =>
      spans.map((s) => (s.style.visibility === 'visible' ? Number(s.dataset.lap) : null))
    );
  self.text = (selector) =>
    self.page
      .locator(selector)
      .first()
      .innerText()
      .catch(() => null);
  return self;
}

/** Advance the server and every listed client by `ms`, in 100 ms lockstep slices. */
async function advance(clients, ms, slice = 100) {
  for (let t = 0; t < ms; t += slice) {
    server.elapsed += slice;
    await Promise.all(clients.map((c) => c.page.clock.runFor(slice)));
  }
}
const published = (atMs) =>
  raceEvents.find((e) => e.atMs === atMs).positions.map((p) => Number(p.toFixed(4)));
async function holdAndCompare(clients, atMs, label) {
  server.hold = atMs;
  await advance(clients, 1600);
  const expected = published(atMs);
  const drawn = await Promise.all(clients.map((c) => c.laps()));
  drawn.forEach((laps, i) => assert.deepEqual(laps, expected, `${clients[i].name} at ${label}`));
  await Promise.all(
    clients.map((c) =>
      c.page
        .locator('.hounds-scene')
        .screenshot({ path: resolve(output, `${label}-${c.name}.png`) })
    )
  );
  server.hold = null;
  checks.push(
    `${label}: ${clients.map((c) => c.name).join(' and ')} draw every runner at the published ${atMs} ms positions`
  );
  return expected;
}

const shared = '/play-together/rounds/' + fixture.id;
const A = await client('A'),
  B = await client('B', { width: 844, height: 390 });
const frames = resolve(output, 'frames');
await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
let frameNo = 0;
async function film(ms) {
  // Side-by-side frames at 10 fps for the evidence video.
  for (let t = 0; t < ms; t += 100) {
    await advance([A, B], 100);
    const n = String(frameNo++).padStart(4, '0');
    await Promise.all([
      A.page.locator('.hounds-scene').screenshot({ path: resolve(frames, `A-${n}.png`) }),
      B.page.locator('.hounds-scene').screenshot({ path: resolve(frames, `B-${n}.png`) }),
    ]);
  }
}
try {
  // A joins before the off; B joins ten seconds into the race on a landscape phone.
  await A.open(shared);
  for (let t = server.elapsed; t < 10000; t += 100) {
    server.elapsed += 100;
    await A.page.clock.runFor(100);
  }
  await B.open(shared);
  checks.push('B joined mid-race at 10 s (fresh page load) while A was watching');
  await advance([A, B], 2000);
  await holdAndCompare([A, B], 12000, 'join-12s');
  await film(2000);
  // B loses its connection for four seconds; it must never draw a runner ahead of A.
  B.offline = true;
  for (let t = 0; t < 4000; t += 500) {
    await advance([A, B], 500);
    const [a, b] = await Promise.all([A.laps(), B.laps()]);
    b.forEach((lap, i) => assert.ok(lap <= a[i] + 1e-9, `offline B ran ahead on runner ${i + 1}`));
  }
  const status = await B.text('.tg-live-connection');
  checks.push(`B offline 4 s: never drew a runner ahead of A (status: ${status ?? 'none shown'})`);
  B.offline = false;
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await advance([A, B], 2000);
  await holdAndCompare([A, B], 20000, 'reconnect-20s');
  await film(1500);
  // A reloads mid-race.
  await A.page.reload();
  await A.page.clock.pauseAt(epoch + server.elapsed).catch(() => {});
  const now = await A.page.evaluate(() => Date.now());
  if (Math.abs(now - (epoch + server.elapsed)) > 50) await A.open(shared);
  for (let i = 0; i < 600 && !(await A.page.locator('.hounds-scene canvas').count()); i++)
    await A.page.clock.runFor(5);
  checks.push('A reloaded mid-race and resumed from the disclosed snapshot');
  await advance([A, B], 1000);
  await holdAndCompare([A, B], 24000, 'reload-24s');
  await film(Math.max(0, 31000 - server.elapsed));
  // Finish: both show the server's official order with the winner on the line.
  await advance([A, B], 3000);
  for (const c of [A, B])
    assert.equal(await c.page.locator('.tg-live').getAttribute('data-result-available'), 'true');
  const finalPositions = published(32000);
  const [aLaps, bLaps] = await Promise.all([A.laps(), B.laps()]);
  assert.deepEqual(aLaps, finalPositions);
  assert.deepEqual(bLaps, finalPositions);
  const official = fixture.outcome.numbers;
  const drawnOrder = finalPositions
    .map((p, i) => ({ p, runner: i + 1 }))
    .sort((x, y) => y.p - x.p || x.runner - y.runner)
    .map((x) => x.runner);
  assert.deepEqual(drawnOrder, official.slice(0, 8), 'drawn order equals the server outcome');
  assert.equal(finalPositions[official[0] - 1], 1, 'winner drawn on the line');
  // Compare content, not layout: the two viewports show the lists responsively.
  const runnersIn = (c, selector) =>
    c.page.$$eval(selector, (els) => els.map((e) => e.textContent.trim()));
  const [aOrder, bOrder] = await Promise.all([
    runnersIn(A, '.tg-race-order li b'),
    runnersIn(B, '.tg-race-order li b'),
  ]);
  assert.deepEqual(aOrder, bOrder);
  assert.deepEqual(
    aOrder.map(Number),
    official.slice(0, 8),
    'race order list equals the server outcome'
  );
  const [aResult, bResult] = await Promise.all(
    [A, B].map((c) => c.page.$eval('.tg-result', (e) => e.textContent.replace(/\s+/g, ' ').trim()))
  );
  assert.ok(aResult && aResult === bResult, 'same result panel content on both clients');
  await Promise.all(
    [A, B].map((c) => c.page.screenshot({ path: resolve(output, `finish-${c.name}-page.png`) }))
  );
  await Promise.all(
    [A, B].map((c) =>
      c.page.locator('.hounds-scene').screenshot({ path: resolve(output, `finish-${c.name}.png`) })
    )
  );
  checks.push(
    `finish: both clients show the server order ${official.join('-')} and draw runner ${official[0]} on the line`
  );

  // Solo page: two members watch the same scheduled race.
  server.elapsed = 8000;
  await A.open('/games/dog-racing');
  await B.open('/games/dog-racing');
  for (let t = 0; t < 12000; t += 500) {
    await advance([A, B], 500);
    const limit = derbyPositions(soloOrder, server.elapsed, soloSeed).map((p) => p / 1.06);
    for (const c of [A, B])
      (await c.laps()).forEach((lap, i) => {
        if (lap !== null)
          assert.ok(lap <= limit[i] + 1e-4, `${c.name} solo runner ${i + 1} ahead of published`);
      });
  }
  checks.push('solo: neither client ever drew a runner beyond its latest published position');
  server.elapsed = DOG_RACING_RULES.raceMs + 2000;
  await advance([A, B], 3000);
  const [soloA, soloB] = await Promise.all([A.text('.derby-results'), B.text('.derby-results')]);
  assert.ok(
    soloA && soloA.includes('#' + soloOrder[0]),
    'solo official order shows the server winner'
  );
  assert.equal(soloA, soloB, 'same solo result text');
  const soloLaps = await A.laps();
  const soloOrderDrawn = soloLaps
    .map((p, i) => ({ p, runner: i + 1 }))
    .filter((x) => x.p !== null)
    .sort((x, y) => y.p - x.p)
    .map((x) => x.runner);
  assert.equal(soloOrderDrawn[0], soloOrder[0], 'solo winner drawn in front');
  await Promise.all(
    [A, B].map((c) => c.page.screenshot({ path: resolve(output, `solo-finish-${c.name}.png`) }))
  );
  checks.push(
    `solo finish: both clients show the same result; runner ${soloOrder[0]} drawn in front`
  );

  // Side-by-side video of the two shared clients (10 fps capture, played at true speed).
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '10',
    '-i',
    resolve(frames, 'A-%04d.png'),
    '-framerate',
    '10',
    '-i',
    resolve(frames, 'B-%04d.png'),
    '-filter_complex',
    '[0:v]scale=-2:360[a];[1:v]scale=-2:360[b];[a][b]hstack=inputs=2,pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '23',
    '-movflags',
    '+faststart',
    resolve(output, 'two-clients.mp4'),
  ]);
  assert.equal(errors.length, 0, JSON.stringify(errors));
} catch (error) {
  errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'sync.json'),
    JSON.stringify({ origin, checks, errors, blocked }, null, 2)
  );
  console.log(JSON.stringify({ checks: checks.length, errors, blocked: blocked.length }, null, 2));
}
