// Synthetic loopback review of the group (play-together) horse race.
//
// Every API response is a local fixture. The settled round is generated with the
// repository's own shared outcome/ranking/settlement code and the API's own
// presentation events (the beacon signature is deliberately invalid), and the page
// only ever receives the events disclosed up to the current fixture time. External
// hosts and WebSockets are aborted and any non-GET API request fails the run. No
// account, wallet, entry, payment or database is used.
//
// Build the web app, serve it on loopback, then run for example:
//   DERBY_GROUP_ORIGIN=http://127.0.0.1:4404 DERBY_GROUP_OUTPUT=/tmp/derby-group \
//     node scripts/review-derby-group.mjs
// Options: DERBY_GROUP_PARTS=stills,cameras,states,clips (default: all)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  TOGETHER_GAME_DURATION_MS,
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
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.DERBY_GROUP_ORIGIN;
assert.ok(origin, 'Set DERBY_GROUP_ORIGIN to the built loopback preview URL');
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Only a loopback preview is allowed');
const output = resolve(process.env.DERBY_GROUP_OUTPUT ?? 'derby-group-review');
const parts = new Set(
  (process.env.DERBY_GROUP_PARTS ?? 'stills,cameras,states,clips').split(',').filter(Boolean)
);
await mkdir(output, { recursive: true });

const bundled = await build({
  entryPoints: [resolve(repo, 'apps/api/src/games/play-together/presentation.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { preparePresentation } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);

const game = 'thunder_derby_3d';
const user = {
  id: 'review-member',
  username: 'Abebe',
  displayName: 'Abebe Bekele',
  email: 'review-member@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const group = { id: 'review-group', name: 'Addis Friends', ownerId: user.id, status: 'ACTIVE' };
const settings = {
  version: 1,
  feeBps: 700,
  minEntry: 100,
  maxEntry: 100000,
  enabledGames: [game],
  practiceEnabled: true,
  cashEnabled: false,
  publicRoomsEnabled: false,
};

/** A settled synthetic group round for horse racing. */
function groupFixture() {
  const id = 'review-' + game;
  const closesAt = 1799999000000;
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
    { id: 'entry-me', userId: user.id, selection: [3] },
    { id: 'entry-other', userId: 'review-other', selection: [6] },
  ];
  let derived;
  for (let attempt = 1; attempt <= 500; attempt++) {
    const seed = attempt.toString(16).padStart(64, '0');
    round.seedCommitment = togetherSeedCommitment(id, seed);
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

const fixture = groupFixture();
const duration = TOGETHER_GAME_DURATION_MS[game],
  epoch = 1800000000000;
const recording = preparePresentation(
  game,
  duration,
  fixture.outcome,
  fixture.entries,
  fixture.proof.seed
);
/** The harness owns disclosed time: events at or before `elapsed` only. */
const state = { elapsed: 14000, offline: false };
function disclosure() {
  const elapsed = state.elapsed,
    finished = elapsed >= duration,
    now = epoch + elapsed;
  const r = {
    ...fixture,
    termsVersion: 2,
    presentationVersion: 2,
    presentationDurationMs: duration,
    state: finished ? 'PAID' : 'DRAWN',
    eventSequence: Math.max(0, Math.floor(elapsed / 1000)),
    presentation: {
      version: 2,
      startsAt: epoch,
      finishesAt: epoch + duration,
      observedAt: now,
      resultAvailable: finished,
      events: recording.filter((e) => e.atMs <= elapsed),
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

const checks = [],
  errors = [],
  blocked = [],
  captures = [],
  measurements = [];
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });

async function createContext({
  width = 1440,
  height = 1000,
  scale = 2,
  quality,
  reduced = false,
  mobile = false,
} = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    isMobile: mobile,
    hasTouch: mobile,
    serviceWorkers: 'block',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  await ctx.addInitScript(
    ({ quality }) => {
      localStorage.setItem('salem-language', 'en');
      if (quality) localStorage.setItem('salem-game-quality', quality);
    },
    { quality }
  );
  await ctx.routeWebSocket('**/*', (socket) => socket.close());
  await ctx.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) {
      blocked.push({ url: url.origin, path: url.pathname });
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
      errors.push(`Unexpected ${req.method()} ${path}`);
      return route.abort();
    }
    if (path === '/auth/me') return respond({ user });
    if (path === '/workspaces/access') return respond({ admin: false, agent: false });
    const { now, r } = disclosure();
    if (path.startsWith('/play-together/rounds/')) {
      if (state.offline) return route.abort();
      return respond({
        serverTime: now,
        round: r,
        workerReady: true,
        admissionsEnabled: true,
        settings,
        cashAvailable: false,
        balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 0, pointsReserved: 0 },
      });
    }
    if (path === `/play-together/groups/${group.id}/activity`)
      return respond({ serverTime: now, latestResult: null, activeRound: null });
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
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}

const url = () => origin + '/play-together/rounds/' + fixture.id;
async function advance(page, ms, step = 33) {
  for (let left = ms; left > 0; left -= step) {
    const d = Math.min(step, left);
    await page.clock.runFor(d);
    state.elapsed += d;
  }
}
/** Open at `start` ms of race time on a paused clock and wait for the authored runners. */
async function open(page, start) {
  state.elapsed = start;
  await page.clock.install({ time: epoch + start });
  await page.clock.pauseAt(epoch + start);
  await page.goto(url());
  for (let i = 0; i < 800; i++) {
    const runners = await page
      .locator('.tg-live .derby-scene')
      .first()
      .getAttribute('data-runners', { timeout: 100 })
      .catch(() => null);
    if (runners === 'authored-rigs') break;
    await advance(page, 10, 10);
    await page.waitForTimeout(10);
  }
  await page.evaluate(() =>
    document.querySelector('.tg-live .derby-scene-shell')?.scrollIntoView({ block: 'center' })
  );
}
async function info(page) {
  return page.evaluate(() => {
    const scene = document.querySelector('.tg-live .derby-scene');
    const pressed = document.querySelector('.original-camera-controls [aria-pressed="true"]');
    return {
      runners: scene?.getAttribute('data-runners') ?? null,
      shot: scene?.getAttribute('data-camera') ?? null,
      tier: scene?.getAttribute('data-render-tier') ?? null,
      scale: scene?.getAttribute('data-render-scale') ?? null,
      adaptive: scene?.getAttribute('data-adaptive') ?? null,
      quality: document.querySelector('.tg-live')?.getAttribute('data-quality') ?? null,
      pressed: pressed?.textContent ?? null,
      cameras: [...document.querySelectorAll('.original-camera-controls button')].map(
        (b) => b.textContent
      ),
      phase: document.querySelector('.tg-live')?.getAttribute('data-reveal-phase') ?? null,
      fallback: !!document.querySelector('.tg-live .derby-scene-fallback'),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}
async function screenshot(page, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.screenshot({ ...options, timeout: 30000 });
    } catch (error) {
      if (attempt >= 3) throw error;
      await page.clock.runFor(34).catch(() => {});
      state.elapsed += 34;
    }
  }
}
async function sceneBox(page) {
  return page.evaluate(() => {
    const r = document.querySelector('.tg-live-stage')?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0
      ? {
          x: r.left,
          y: Math.max(0, r.top),
          width: r.width,
          height: Math.min(r.height, innerHeight),
        }
      : null;
  });
}
async function shot(page, name, { full = true } = {}) {
  if (full) {
    await screenshot(page, { path: resolve(output, name + '.png') });
    captures.push(name + '.png');
  }
  const box = await sceneBox(page);
  if (box) {
    await screenshot(page, { path: resolve(output, name + '-stage.png'), clip: box });
    captures.push(name + '-stage.png');
  }
}
async function camera(page, label) {
  await page.locator('.original-camera-controls button', { hasText: label }).first().click();
}
async function scenario(name, run) {
  const contexts = [];
  try {
    await run(async (options) => {
      const c = await createContext(options);
      contexts.push(c.ctx);
      return c;
    });
  } catch (error) {
    errors.push(`${name}: ${String(error?.message ?? error).split('\n')[0]}`);
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    state.offline = false;
  }
}

const VIEWS = {
  desktop: { width: 1440, height: 1000, scale: 2 },
  phone375: { width: 375, height: 812, scale: 2, mobile: true },
  phone320: { width: 320, height: 568, scale: 2, mobile: true },
  landscape: { width: 844, height: 390, scale: 2, mobile: true },
};
// Moments of the shared race (duration from the shared rules).
const MOMENTS = [
  [-2500, 'before-off'],
  [1500, 'break'],
  [Math.round(duration * 0.45), 'mid'],
  [Math.round(duration * 0.88), 'home'],
  [duration + 1500, 'result'],
];

try {
  if (parts.has('stills'))
    for (const [view, opts] of Object.entries(VIEWS))
      for (const [elapsed, moment] of view === 'desktop' ? MOMENTS : MOMENTS.slice(2, 4))
        await scenario(`still ${view} ${moment}`, async (make) => {
          const c = await make(opts);
          await open(c.page, elapsed - 3000);
          await advance(c.page, 3000);
          const name = `group-${view}-${moment}`;
          await shot(c.page, name, { full: view !== 'desktop' || moment === 'mid' });
          const facts = await info(c.page);
          measurements.push({ stage: name, ...facts });
          assert.equal(facts.overflow, false, `${name} overflows`);
          assert.equal(facts.fallback, false, `${name} fell back`);
          assert.deepEqual(facts.cameras, ['Trackside', 'Follow race', 'Aerial']);
          checks.push(`${name}: renders with the three camera views`);
        });
  if (parts.has('cameras'))
    for (const view of ['desktop', 'phone375'])
      for (const [elapsed, moment] of MOMENTS.slice(2, 4))
        for (const [label, shot_] of [
          ['Trackside', null],
          ['Follow race', 'chase'],
          ['Aerial', 'aerial'],
        ])
          await scenario(`camera ${label} ${view} ${moment}`, async (make) => {
            const c = await make(VIEWS[view]);
            await open(c.page, elapsed - 3000);
            await camera(c.page, label);
            await advance(c.page, 3000);
            const facts = await info(c.page);
            const name = `group-camera-${view}-${label.toLowerCase().replace(/ /g, '-')}-${moment}`;
            await shot(c.page, name, { full: view !== 'desktop' });
            measurements.push({ stage: name, ...facts });
            assert.equal(facts.pressed, label);
            if (shot_) assert.equal(facts.shot, shot_, `${name} drew ${facts.shot}`);
            else assert.ok(['side', 'final'].includes(facts.shot), `${name} drew ${facts.shot}`);
            checks.push(`${name}: ${label} pressed, scene shot ${facts.shot}`);
          });
  if (parts.has('states')) {
    for (const [quality, tier] of [
      ['high', 'high'],
      ['balanced', 'balanced'],
      ['low', 'low'],
    ])
      await scenario(`quality ${quality}`, async (make) => {
        const c = await make({ ...VIEWS.phone375, quality });
        await open(c.page, 11000);
        await advance(c.page, 3000);
        const facts = await info(c.page);
        await shot(c.page, `group-quality-${quality}-phone375`);
        measurements.push({ stage: 'quality ' + quality, ...facts });
        assert.equal(facts.tier, tier);
        assert.equal(facts.adaptive, 'false', 'an explicit tier must not adapt');
        checks.push(`quality ${quality}: scene tier ${facts.tier}, not adaptive`);
      });
    await scenario('automatic', async (make) => {
      const c = await make(VIEWS.phone375);
      await open(c.page, 11000);
      await advance(c.page, 3000);
      const facts = await info(c.page);
      measurements.push({ stage: 'automatic', ...facts });
      // Automatic starts at Balanced and drives the adaptive resolution governor.
      assert.equal(facts.tier, 'balanced');
      assert.equal(facts.adaptive, 'true', 'Automatic did not reach the horse scene');
      checks.push(`automatic: tier ${facts.tier}, adaptive, render scale ${facts.scale}`);
    });
    await scenario('reduced motion', async (make) => {
      const c = await make({ ...VIEWS.phone375, reduced: true });
      await open(c.page, 11000);
      await advance(c.page, 3000);
      const facts = await info(c.page);
      await shot(c.page, 'group-reduced-motion-phone375');
      measurements.push({ stage: 'reduced', ...facts });
      assert.equal(facts.shot, 'overview');
      checks.push('reduced motion: still overview');
    });
    await scenario('camera persists across reconnect', async (make) => {
      const c = await make(VIEWS.desktop);
      await open(c.page, 9000);
      await camera(c.page, 'Aerial');
      await advance(c.page, 2000);
      state.offline = true;
      await advance(c.page, 6000);
      const offline = await info(c.page);
      state.offline = false;
      await advance(c.page, 4000);
      const back = await info(c.page);
      await shot(c.page, 'group-reconnect-aerial', { full: false });
      measurements.push({ stage: 'reconnect', offline, back });
      assert.equal(back.pressed, 'Aerial');
      assert.equal(back.shot, 'aerial');
      checks.push('reconnect: Aerial kept through a poll outage');
    });
  }
  if (parts.has('clips'))
    for (const clip of [
      {
        name: 'group-race-desktop-trackside',
        view: 'desktop',
        from: -2000,
        ms: duration + 4000,
        fps: 12.5,
      },
      {
        name: 'group-race-phone375-follow',
        view: 'phone375',
        from: 9000,
        ms: 6000,
        fps: 25,
        label: 'Follow race',
      },
      {
        name: 'group-race-desktop-aerial',
        view: 'desktop',
        from: Math.round(duration * 0.7),
        ms: 6000,
        fps: 25,
        label: 'Aerial',
      },
    ])
      await scenario('clip ' + clip.name, async (make) => {
        const frames = resolve(output, 'frames-' + clip.name);
        await rm(frames, { recursive: true, force: true });
        await mkdir(frames, { recursive: true });
        const c = await make({ ...VIEWS[clip.view], scale: clip.view === 'desktop' ? 1 : 2 });
        await open(c.page, clip.from - 2000);
        if (clip.label) await camera(c.page, clip.label);
        await advance(c.page, 2000);
        const box = await sceneBox(c.page);
        const count = Math.round((clip.ms / 1000) * clip.fps);
        let carried = 0;
        for (let i = 0; i < count; i++) {
          carried += 1000 / clip.fps;
          const d = Math.floor(carried);
          carried -= d;
          await advance(c.page, d, d);
          await screenshot(c.page, {
            path: resolve(frames, String(i).padStart(5, '0') + '.png'),
            clip: box,
          });
        }
        execFileSync('ffmpeg', [
          '-y',
          '-loglevel',
          'error',
          '-framerate',
          String(clip.fps),
          '-i',
          resolve(frames, '%05d.png'),
          '-vf',
          'pad=ceil(iw/2)*2:ceil(ih/2)*2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-crf',
          '24',
          '-movflags',
          '+faststart',
          resolve(output, clip.name + '.mp4'),
        ]);
        captures.push(clip.name + '.mp4');
        checks.push(`clip ${clip.name}: ${count} frames at ${clip.fps} fps (normal speed)`);
      });
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      { origin, duration, parts: [...parts], checks, errors, blocked, captures, measurements },
      null,
      2
    )
  );
}
console.log(JSON.stringify({ checks: checks.length, errors, blocked: blocked.length }));
if (errors.length) process.exitCode = 1;
