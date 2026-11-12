// Synthetic loopback review for the greyhound realism pass.
//
// Every API response is a local fixture generated from the repository's own
// server presentation and solo position code. External hosts and WebSockets are
// aborted, and any non-GET API request fails the run. No account, wallet, wager,
// payment or database is used.
//
// Build the web app, serve it on loopback, then run for example:
//   HOUND_REVIEW_ORIGIN=http://127.0.0.1:4310 HOUND_REVIEW_OUTPUT=/tmp/review/after \
//     node scripts/review-greyhound-realism.mjs
// Optional: HOUND_REVIEW_PARTS=stills,states,clips,perf (default: all)
//           HOUND_REVIEW_LABEL=before|after (only written into review.json)
//
// Stills hold one disclosed checkpoint and place the display clock 1.5 s after it,
// as the earlier shared-hound review did. Clips use Playwright's fake clock and
// advance page time and the fixture's disclosure time together, one frame at a
// time, so software-rendered captures play back at their true speed.
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
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.HOUND_REVIEW_ORIGIN;
assert.ok(origin, 'Set HOUND_REVIEW_ORIGIN to the built loopback preview URL');
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Only a loopback preview is allowed');
const output = resolve(process.env.HOUND_REVIEW_OUTPUT ?? 'greyhound-review');
const parts = new Set(
  (process.env.HOUND_REVIEW_PARTS ?? 'stills,states,clips,perf').split(',').filter(Boolean)
);
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
  enabledGames: ['neon_hounds_3d'],
  practiceEnabled: true,
  cashEnabled: false,
  publicRoomsEnabled: false,
};

/** A settled synthetic shared round; the beacon signature is deliberately invalid. */
function sharedFixture() {
  const game = 'neon_hounds_3d',
    id = 'review-' + game;
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
    { id: 'entry-me', userId: user.id, selection: [1] },
    { id: 'entry-other', userId: 'review-other', selection: [2] },
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
// The harness owns the disclosed time. Stills add a 1.5 s display offset; clips do not.
const state = { elapsed: 14000, hold: true, offline: false, soloField: 6, chunk: 'normal' };
function sharedDisclosure() {
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
  return { now: now + (state.hold ? 1500 : 0), r };
}
// Solo: one running six-dog race using the API's own present-position function.
const soloSeed = 'b'.repeat(64),
  soloOrder = [3, 1, 5, 2, 6, 4];
function soloSnapshot() {
  const elapsed = state.elapsed,
    raceMs = DOG_RACING_RULES.raceMs;
  const finished = elapsed >= raceMs;
  return {
    rulesId: DOG_RACING_RULES.id,
    serverTime: epoch + elapsed + (state.hold ? 1500 : 0),
    balance: 1000,
    rounds: [
      {
        id: 'synthetic-solo-race',
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
  blocked = [],
  captures = [],
  measurements = [];
const browser = await chromium.launch({ headless: true });

async function createContext({
  width = 1440,
  height = 1000,
  quality = 'balanced',
  reduced = false,
  noWebGL = false,
  device,
  scale = 1,
} = {}) {
  const ctx = await browser.newContext({
    ...(device ? devices[device] : { viewport: { width, height }, deviceScaleFactor: scale }),
    serviceWorkers: 'block',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
  });
  await ctx.addInitScript(
    ({ quality, noWebGL }) => {
      localStorage.setItem('salem-language', 'en');
      localStorage.setItem('salem-game-quality', quality);
      // Telemetry lives only in this external driver, never in the application bundle.
      window.__houndProbe = { contexts: [] };
      const originalGet = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (noWebGL && String(kind).startsWith('webgl')) return null;
        return originalGet.call(this, kind, ...args);
      };
      const states = new WeakMap();
      for (const api of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!api) continue;
        const state = (gl) => {
          let s = states.get(gl);
          if (!s) {
            s = { canvas: gl.canvas, draws: 0, triangles: 0, clears: 0, textures: 0, frames: [] };
            states.set(gl, s);
            window.__houndProbe.contexts.push(s);
          }
          return s;
        };
        for (const name of ['createTexture', 'drawElements', 'drawArrays', 'clear']) {
          const original = api.prototype[name];
          api.prototype[name] = function (...args) {
            const s = state(this);
            if (name === 'createTexture') s.textures++;
            if (name === 'drawElements' || name === 'drawArrays') {
              s.draws++;
              if (args[0] === this.TRIANGLES)
                s.triangles += args[name === 'drawArrays' ? 2 : 1] / 3;
            }
            if (name === 'clear' && args[0] & this.COLOR_BUFFER_BIT) {
              s.clears++;
              if (s.frames.length < 4000) s.frames.push(performance.now());
            }
            return original.apply(this, args);
          };
        }
      }
    },
    { quality, noWebGL }
  );
  await ctx.routeWebSocket('**/*', (socket) => socket.close());
  await ctx.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) {
      blocked.push({ url: url.origin, path: url.pathname });
      return route.abort();
    }
    if (/\/assets\/race-scene-[^/]+\.js$/.test(url.pathname) && state.chunk !== 'normal') {
      // Simulate a slow phone network or a failed download of the 3D scene chunk.
      if (state.chunk === 'fail') return route.abort();
      await new Promise((r) => setTimeout(r, 6000));
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
    if (path === '/games/dog-racing') return respond(soloSnapshot());
    const { now, r } = sharedDisclosure();
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
  page.setDefaultTimeout(45000);
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}

const sharedUrl = () => origin + '/play-together/rounds/' + fixture.id;
async function openShared(page, elapsed, settle = 2200) {
  state.elapsed = elapsed;
  state.hold = true;
  await page.goto(sharedUrl());
  try {
    await page.locator('.hounds-scene canvas, .hounds-scene-fallback').first().waitFor();
  } catch (error) {
    await page.screenshot({ path: resolve(output, `debug-${elapsed}.png`) });
    const text = await page.evaluate(() => document.body.innerText.slice(0, 800));
    throw new Error(`No race scene at ${elapsed} ms. Page text: ${text}\n${error.message}`);
  }
  await page.waitForTimeout(settle);
}
async function metric(page) {
  return page.evaluate(() => {
    const s = window.__houndProbe.contexts
      .filter((c) => c.canvas.closest?.('.hounds-scene'))
      .at(-1);
    if (!s) return null;
    const gl = s.canvas.getContext('webgl2') || s.canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      draws: s.draws,
      triangles: Math.round(s.triangles),
      clears: s.clears,
      textures: s.textures,
      frames: s.frames.slice(-240),
      canvas: [s.canvas.width, s.canvas.height],
      heap: performance.memory?.usedJSHeapSize,
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      userAgent: navigator.userAgent,
    };
  });
}
async function shot(page, name, { arena = true, full = true } = {}) {
  // Phones: bring the course into the viewport the way a member would scroll to it.
  await page.evaluate(() =>
    document
      .querySelector('.hounds-scene, .hounds-scene-fallback')
      ?.scrollIntoView({ block: 'center' })
  );
  await page.waitForTimeout(150);
  if (full) {
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: false });
    captures.push(name + '.png');
  }
  const scene = page.locator('.hounds-scene').first();
  if (arena && (await scene.count())) {
    await scene.screenshot({ path: resolve(output, name + '-scene.png') });
    captures.push(name + '-scene.png');
  }
}
async function noOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
}
const camera = (page, i) => page.locator('.original-camera-controls button').nth(i).click();

/** Deterministic clip: page and fixture time advance together, one frame per step. */
async function clip(name, { url, startElapsed, ms, fps = 30, context = {}, setup, target }) {
  const frames = resolve(output, 'frames-' + name);
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  const c = await createContext(context);
  state.elapsed = startElapsed;
  state.hold = false;
  await c.page.clock.install({ time: epoch + startElapsed });
  await c.page.clock.pauseAt(epoch + startElapsed);
  await c.page.goto(url);
  // Let the app boot on the frozen clock: advance in tiny steps until the canvas exists.
  for (let i = 0; i < 400 && !(await c.page.locator('.hounds-scene canvas').count()); i++)
    await c.page.clock.runFor(5);
  await c.page.evaluate(() =>
    document.querySelector('.hounds-scene')?.scrollIntoView({ block: 'center' })
  );
  state.elapsed = (await c.page.evaluate(() => Date.now())) - epoch;
  if (setup) await setup(c.page);
  // Warm up two seconds so polls, interpolation and the camera settle.
  for (let t = 0; t < 2000; t += 100) {
    await c.page.clock.runFor(100);
    state.elapsed += 100;
  }
  const step = 1000 / fps,
    count = Math.round((ms / 1000) * fps),
    locator = target ? c.page.locator(target).first() : null;
  let carried = 0;
  const started = Date.now();
  for (let i = 0; i < count; i++) {
    carried += step;
    const advance = Math.floor(carried);
    carried -= advance;
    await c.page.clock.runFor(advance);
    state.elapsed += advance;
    const path = resolve(frames, String(i).padStart(4, '0') + '.png');
    if (locator) await locator.screenshot({ path });
    else await c.page.screenshot({ path });
  }
  const realSeconds = (Date.now() - started) / 1000;
  await c.ctx.close();
  const encode = (rate, out) =>
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-framerate',
      String(rate),
      '-i',
      resolve(frames, '%04d.png'),
      '-vf',
      'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-crf',
      '22',
      '-movflags',
      '+faststart',
      resolve(output, out),
    ]);
  encode(fps, name + '.mp4');
  encode(fps / 4, name + '-quarter-speed.mp4');
  captures.push(name + '.mp4', name + '-quarter-speed.mp4');
  measurements.push({ stage: 'clip ' + name, frames: count, fps, captureSeconds: realSeconds });
}

try {
  if (parts.has('stills')) {
    const main = await createContext({ scale: 1 }),
      { page } = main;
    for (const [elapsed, label] of [
      [-2500, 'shared-gate'],
      [700, 'shared-start'],
      [14000, 'shared-mid'],
      [27000, 'shared-home'],
    ]) {
      await openShared(page, elapsed);
      await shot(page, label + '-trackside');
      checks.push(label + ': trackside renders');
    }
    await openShared(page, 14000);
    for (const [i, label] of [
      [1, 'follow'],
      [2, 'aerial'],
    ]) {
      await camera(page, i);
      await page.waitForTimeout(1800);
      await shot(page, 'shared-mid-' + label);
      checks.push('mid-race ' + label + ' renders');
    }
    await camera(page, 0);
    await openShared(page, 32000);
    await shot(page, 'shared-finish-trackside');
    assert.equal(await page.locator('.tg-live').getAttribute('data-result-available'), 'true');
    checks.push('finish: official result visible with trackside view');
    await main.ctx.close();
    // Solo page with a live published race.
    const solo = await createContext();
    state.elapsed = 20000;
    state.hold = true;
    await solo.page.goto(origin + '/games/dog-racing');
    await solo.page.locator('.hounds-scene canvas').waitFor();
    await solo.page.waitForTimeout(2500);
    await shot(solo.page, 'solo-mid-trackside');
    checks.push('solo running race renders');
    await solo.ctx.close();
    // Phones and landscape. Device presets carry realistic DPR and touch.
    for (const [name, opts] of [
      ['phone-360x780', { width: 360, height: 780, scale: 3 }],
      ['phone-pixel7', { device: 'Pixel 7' }],
      ['phone-iphone13', { device: 'iPhone 13' }],
      ['phone-landscape-844x390', { width: 844, height: 390, scale: 3 }],
    ]) {
      const c = await createContext(opts);
      await openShared(c.page, 14000);
      await shot(c.page, name + '-mid');
      assert.ok(await noOverflow(c.page), name + ' overflows horizontally');
      await openShared(c.page, 32000);
      await shot(c.page, name + '-finish');
      await c.ctx.close();
      checks.push(name + ': mid-race and finish without horizontal overflow');
    }
  }
  if (parts.has('states')) {
    for (const [name, opts] of [
      ['quality-high', { quality: 'high' }],
      ['quality-low', { quality: 'low' }],
      ['reduced-motion', { reduced: true }],
      ['reduced-motion-phone', { reduced: true, width: 390, height: 844, scale: 3 }],
    ]) {
      const c = await createContext(opts);
      await openShared(c.page, 14000);
      await shot(c.page, name);
      checks.push(name + ' renders');
      await c.ctx.close();
    }
    // Loading and download failure of the lazily loaded 3D scene, on both pages.
    for (const [mode, label] of [
      ['slow', 'loading'],
      ['fail', 'chunk-error'],
    ]) {
      for (const [page, url] of [
        ['shared', sharedUrl()],
        ['solo', origin + '/games/dog-racing'],
      ]) {
        const c = await createContext({ width: 390, height: 844, scale: 2 });
        state.chunk = mode;
        state.elapsed = 14000;
        state.hold = true;
        await c.page.goto(url);
        await c.page.waitForTimeout(mode === 'slow' ? 2500 : 4000);
        await shot(c.page, `${label}-${page}`);
        const text = await c.page.evaluate(
          () =>
            document
              .querySelector('.derby-scene-shell, .tg-live-stage')
              ?.textContent?.slice(0, 160) ?? ''
        );
        measurements.push({ stage: `${label} ${page}`, text });
        if (mode === 'slow') {
          await c.page.locator('.hounds-scene canvas').waitFor({ timeout: 30000 });
          await c.page.waitForTimeout(1500);
          await shot(c.page, `${label}-${page}-loaded`);
        }
        state.chunk = 'normal';
        checks.push(`${label} ${page}: page stays usable with a fallback`);
        await c.ctx.close();
      }
    }
    // The smallest common phones, portrait and landscape, and Low on a 320 px screen.
    for (const [name, opts] of [
      ['phone-320x568', { width: 320, height: 568, scale: 2 }],
      ['phone-320x568-low', { width: 320, height: 568, scale: 2, quality: 'low' }],
      ['landscape-667x375', { width: 667, height: 375, scale: 2 }],
      ['landscape-844x390', { width: 844, height: 390, scale: 3 }],
    ]) {
      const c = await createContext(opts);
      await openShared(c.page, 14000);
      await shot(c.page, name);
      assert.ok(await noOverflow(c.page), name + ' overflows horizontally');
      const box = await c.page.locator('.hounds-scene').boundingBox();
      measurements.push({ stage: 'layout ' + name, scene: box });
      checks.push(
        `${name}: course rendered (${Math.round(box.width)}x${Math.round(box.height)} CSS px), no overflow`
      );
      await c.ctx.close();
    }
    const nogl = await createContext({ noWebGL: true, width: 390, height: 844, scale: 2 });
    await nogl.page.goto(sharedUrl());
    await nogl.page.waitForTimeout(2500);
    await shot(nogl.page, 'no-webgl-phone');
    checks.push('no-WebGL phone shows a fallback');
    await nogl.ctx.close();
    const c = await createContext({ width: 390, height: 844, scale: 2 });
    const { page } = c;
    await openShared(page, 14000);
    await page.reload();
    await page.locator('.hounds-scene canvas').waitFor();
    await page.waitForTimeout(2200);
    await shot(page, 'reload-mid');
    checks.push('reload mid-race resumes from the disclosed snapshot');
    state.offline = true;
    await page.waitForTimeout(3000);
    await shot(page, 'reconnect-offline');
    state.offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForTimeout(3000);
    await shot(page, 'reconnect-restored');
    checks.push('aborted polls then resumed polls keep one scene');
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(1500);
    await shot(page, 'resize-to-landscape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1500);
    await shot(page, 'resize-to-portrait');
    assert.equal(await page.locator('.hounds-scene canvas').count(), 1);
    checks.push('portrait/landscape resize keeps one canvas');
    const lost = await page.evaluate(() => {
      const gl = document.querySelector('.hounds-scene canvas').getContext('webgl2');
      window.__lose = gl.getExtension('WEBGL_lose_context');
      window.__lose.loseContext();
      return true;
    });
    assert.ok(lost);
    await page.locator('.hounds-scene-fallback').waitFor();
    await shot(page, 'webgl-lost');
    await page.evaluate(() => window.__lose.restoreContext());
    await page.locator('.hounds-scene-fallback').waitFor({ state: 'detached' });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('.hounds-scene canvas').count(), 1);
    await shot(page, 'webgl-restored');
    checks.push('WebGL loss shows the published-position fallback and restores one canvas');
    await c.ctx.close();
  }
  if (parts.has('perf')) {
    // Software-rendered (SwiftShader) timings. Indicative of CPU-side cost only.
    for (const [name, opts, throttle] of [
      ['desktop-balanced', { quality: 'balanced' }, 1],
      ['phone-balanced-cpu4x', { quality: 'balanced', device: 'Pixel 7' }, 4],
      ['phone-low-cpu4x', { quality: 'low', device: 'Pixel 7' }, 4],
    ]) {
      const c = await createContext(opts);
      const cdp = await c.ctx.newCDPSession(c.page);
      await openShared(c.page, 6000);
      state.hold = false;
      if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      await cdp.send('Performance.enable');
      const before = await cdp.send('Performance.getMetrics');
      const a = await metric(c.page);
      await c.page.waitForTimeout(5000);
      const b = await metric(c.page);
      const after = await cdp.send('Performance.getMetrics');
      const pick = (m, k) => m.metrics.find((x) => x.name === k)?.value ?? 0;
      // One displayed frame can clear twice (shadow map, then the view): group clears
      // closer than 6 ms into a single frame before measuring intervals.
      const starts = b.frames
        .filter((t) => t > (a.frames.at(-1) ?? 0))
        .filter((t, i, all) => i === 0 || t - all[i - 1] > 6);
      const intervals = starts
        .slice(1)
        .map((t, i) => t - starts[i])
        .sort((x, y) => x - y);
      const frames = Math.max(1, starts.length);
      measurements.push({
        stage: 'perf ' + name,
        method:
          'Headless Chromium, SwiftShader software WebGL, ' +
          (throttle > 1 ? `CDP CPU throttling ${throttle}x` : 'no throttling') +
          '. Not a physical-device or GPU measurement.',
        renderer: b.renderer,
        canvas: b.canvas,
        framesIn5s: starts.length,
        medianIntervalMs: intervals[Math.floor(intervals.length / 2)] ?? null,
        p95IntervalMs: intervals[Math.floor(intervals.length * 0.95)] ?? null,
        drawsPerFrame: Math.round((b.draws - a.draws) / frames),
        trianglesPerFrame: Math.round((b.triangles - a.triangles) / frames),
        textures: b.textures,
        scriptSecondsPerSecond:
          (pick(after, 'ScriptDuration') - pick(before, 'ScriptDuration')) / 5,
        taskSecondsPerSecond: (pick(after, 'TaskDuration') - pick(before, 'TaskDuration')) / 5,
        heapBytes: b.heap,
      });
      await c.ctx.close();
    }
    // Hidden page must stop drawing.
    const c = await createContext();
    await openShared(c.page, 6000);
    const cdp = await c.ctx.newCDPSession(c.page);
    const a = await metric(c.page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await c.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await c.page.waitForTimeout(2000);
    const b = await metric(c.page);
    measurements.push({ stage: 'hidden document', clearsIn2s: b.clears - a.clears });
    await c.ctx.close();
  }
  if (parts.has('adapt')) {
    // Real-time (not fake clock): Automatic must react to this browser's measured frames.
    // An explicit choice must be left alone. Records the scene's render scale and tier.
    for (const [name, url, quality, seconds] of [
      ['shared-auto', sharedUrl(), 'auto', 45],
      ['shared-explicit-balanced', sharedUrl(), 'balanced', 25],
      ['solo-auto', origin + '/games/dog-racing', 'auto', 45],
    ]) {
      const c = await createContext({ quality, device: 'Pixel 7' });
      state.elapsed = 4000;
      state.hold = false;
      await c.page.goto(url);
      await c.page.locator('.hounds-scene canvas').waitFor();
      await c.page.evaluate(() =>
        document.querySelector('.hounds-scene')?.scrollIntoView({ block: 'center' })
      );
      const timeline = [];
      const started = Date.now();
      for (let s = 0; s < seconds; s++) {
        await c.page.waitForTimeout(1000);
        state.elapsed = 4000 + (Date.now() - started);
        if (state.elapsed > 30000) state.elapsed = 4000 + ((Date.now() - started) % 26000);
        timeline.push(
          await c.page.evaluate(() => {
            const host = document.querySelector('.hounds-scene');
            return {
              scale: host?.dataset.renderScale ?? null,
              tier: host?.dataset.renderTier ?? null,
              select:
                [...document.querySelectorAll('select')].find((s) =>
                  s.querySelector('option[value="auto"]')
                )?.value ?? null,
            };
          })
        );
      }
      await shot(c.page, 'adapt-' + name);
      const tiers = timeline.map((t) => t.tier);
      const changes = tiers.filter((t, i) => i && t !== tiers[i - 1]).length;
      measurements.push({ stage: 'adapt ' + name, quality, timeline, tierChanges: changes });
      if (quality === 'auto') {
        assert.ok(changes <= 1, name + ': at most one automatic tier change');
        checks.push(
          `${name}: Automatic adapted to measured frames (${tiers[0]} -> ${tiers.at(-1)}, ${changes} tier change)`
        );
      } else {
        assert.ok(
          timeline.every((t) => t.tier === quality && t.scale === '1.00'),
          name + ' changed'
        );
        checks.push(`${name}: explicit choice left at ${quality}, full resolution`);
      }
      await c.ctx.close();
    }
  }
  if (parts.has('clips')) {
    await clip('race-shared-desktop', {
      url: sharedUrl(),
      startElapsed: -1500,
      ms: 34000,
      fps: 30,
      context: { width: 1280, height: 800 },
      target: '.hounds-scene',
    });
    await clip('race-phone-landscape', {
      url: sharedUrl(),
      startElapsed: 20000,
      ms: 8000,
      fps: 30,
      context: { width: 844, height: 390, scale: 2 },
      target: '.hounds-scene',
    });
    await clip('race-phone-portrait', {
      url: sharedUrl(),
      startElapsed: 8000,
      ms: 10000,
      fps: 30,
      context: { device: 'iPhone 13' },
    });
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
} catch (error) {
  errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      {
        label: process.env.HOUND_REVIEW_LABEL ?? null,
        origin,
        checks,
        errors,
        blocked,
        captures,
        measurements,
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ checks: checks.length, errors, blocked: blocked.length }, null, 2));
}
