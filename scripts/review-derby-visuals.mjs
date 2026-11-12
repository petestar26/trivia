// Synthetic loopback review for the Derby (horse racing) presentation.
//
// Every API response is a local fixture. Published progress comes from the API's
// own `derbyPositions`, so the scene sees exactly what the server would publish at
// each moment, and the finishing order is disclosed only after the finish time.
// External hosts and WebSockets are aborted and any non-GET API request fails the
// run. No account, wallet, wager, payment or database is used.
//
// Build the web app, serve it on loopback, then run for example:
//   DERBY_REVIEW_ORIGIN=http://127.0.0.1:4401 DERBY_REVIEW_OUTPUT=/tmp/derby/before \
//     node scripts/review-derby-visuals.mjs
// Options: DERBY_REVIEW_PARTS=stills,states,clips,perf (default: all)
//          DERBY_REVIEW_LABEL=before|after (only written into review.json)
//          DERBY_REVIEW_CLIPS=name,name (subset of clips)
//
// All captures use Playwright's fake clock. Page time and the fixture's server time
// advance together, one frame at a time, so software-rendered clips play back at
// their true speed and the before/after builds see identical published positions.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { DERBY_RULES } from '../packages/shared/dist/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.env.DERBY_REVIEW_ORIGIN;
assert.ok(origin, 'Set DERBY_REVIEW_ORIGIN to the built loopback preview URL');
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Only a loopback preview is allowed');
const output = resolve(process.env.DERBY_REVIEW_OUTPUT ?? 'derby-review');
const label = process.env.DERBY_REVIEW_LABEL ?? 'review';
const parts = new Set(
  (process.env.DERBY_REVIEW_PARTS ?? 'stills,states,clips,perf').split(',').filter(Boolean)
);
const onlyClips = process.env.DERBY_REVIEW_CLIPS?.split(',').filter(Boolean);
const skip = new Set((process.env.DERBY_REVIEW_SKIP ?? '').split(',').filter(Boolean));
await mkdir(output, { recursive: true });

const bundled = await build({
  entryPoints: [resolve(repo, 'apps/api/src/games/thunder-derby/math.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { derbyPositions } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')
);

const user = {
  id: 'review-member',
  username: 'Abebe',
  displayName: 'Abebe Bekele',
  email: 'review-member@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const epoch = 1800000000000;
const raceMs = DERBY_RULES.raceMs;
// Fixed synthetic finishing orders and seeds; identical for every build reviewed.
const ORDERS = { 6: [3, 1, 5, 2, 6, 4], 8: [7, 3, 1, 5, 8, 2, 6, 4] };
const SEED = 'c'.repeat(64),
  NEXT_SEED = 'd'.repeat(64),
  PRIOR_SEED = 'e'.repeat(64);
const PRIOR = { 6: [5, 2, 6, 1, 4, 3], 8: [2, 8, 4, 6, 1, 3, 7, 5] };

/** The harness owns server time: elapsed milliseconds since the reviewed race started. */
const state = { elapsed: 0, offline: false, failModels: false, failBackdrop: false };
function round(field, id, startsAt, order, seed, now) {
  const cycle = field * 30000;
  const opensAt = startsAt - (cycle - 60000);
  const finishesAt = startsAt + raceMs;
  const reveal = now >= finishesAt;
  return {
    id,
    field,
    opensAt,
    startsAt,
    finishesAt,
    endsAt: finishesAt + DERBY_RULES.resultMs,
    commitment: 'a'.repeat(64),
    order: reveal ? order : null,
    seed: reveal ? seed : null,
    positions: derbyPositions(order, now - startsAt, seed),
    ticket: null,
  };
}
function snapshot(field) {
  const now = epoch + state.elapsed;
  const current = round(field, `synthetic-race-${field}`, epoch, ORDERS[field], SEED, now);
  const prior = round(
    field,
    `synthetic-prior-${field}`,
    epoch - field * 30000,
    PRIOR[field],
    PRIOR_SEED,
    now
  );
  const rounds = [current, prior];
  if (now >= current.endsAt)
    rounds.unshift(
      round(
        field,
        `synthetic-next-${field}`,
        current.endsAt + field * 30000 - 60000,
        [...ORDERS[field]].reverse(),
        NEXT_SEED,
        now
      )
    );
  return { rulesId: DERBY_RULES.id, serverTime: now, balance: 1000, rounds };
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
  noWebGL = false,
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
    ({ quality, noWebGL }) => {
      localStorage.setItem('salem-language', 'en');
      if (quality) localStorage.setItem('salem-game-quality', quality);
      // Telemetry lives only in this external driver, never in the application bundle.
      window.__derbyProbe = { contexts: [] };
      const originalGet = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (noWebGL && String(kind).startsWith('webgl')) return null;
        return originalGet.call(this, kind, ...args);
      };
      const states = new WeakMap();
      for (const api of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!api) continue;
        const stateOf = (gl) => {
          let s = states.get(gl);
          if (!s) {
            s = {
              canvas: gl.canvas,
              gl,
              draws: 0,
              triangles: 0,
              clears: 0,
              textures: 0,
              frameDraws: [],
              frameTriangles: [],
              current: { draws: 0, triangles: 0 },
            };
            states.set(gl, s);
            window.__derbyProbe.contexts.push(s);
          }
          return s;
        };
        for (const name of [
          'createTexture',
          'drawElements',
          'drawArrays',
          'clear',
          'bindFramebuffer',
        ]) {
          const original = api.prototype[name];
          api.prototype[name] = function (...args) {
            const s = stateOf(this);
            if (name === 'bindFramebuffer') s.offscreen = !!args[1];
            if (name === 'createTexture') s.textures++;
            if (name === 'drawElements' || name === 'drawArrays') {
              s.draws++;
              s.current.draws++;
              if (args[0] === this.TRIANGLES) {
                const t = args[name === 'drawArrays' ? 2 : 1] / 3;
                s.triangles += t;
                s.current.triangles += t;
              }
            }
            if (name === 'clear' && args[0] & this.COLOR_BUFFER_BIT && !s.offscreen) {
              s.clears++;
              if (s.frameDraws.length < 4000) {
                s.frameDraws.push(s.current.draws);
                s.frameTriangles.push(Math.round(s.current.triangles));
              }
              s.current = { draws: 0, triangles: 0 };
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
    if (state.failModels && url.pathname.startsWith('/models/derby/')) return route.abort();
    if (state.failBackdrop && url.pathname.includes('derby-racecourse')) return route.abort();
    if (!url.pathname.startsWith('/api/'))
      return req.method() === 'GET' ? route.continue() : route.abort();
    const path = url.pathname.replace('/api/v1', '');
    const respond = (data) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    if (req.method() !== 'GET') {
      if (path !== '/member-rewards/activity') errors.push(`Unexpected ${req.method()} ${path}`);
      return path === '/member-rewards/activity'
        ? respond({ earned: false, credited: 0 })
        : route.abort();
    }
    if (path === '/auth/me') return respond({ user });
    if (path === '/workspaces/access') return respond({ admin: false, agent: false });
    if (path === '/games/thunder-derby') {
      if (state.offline) return route.abort();
      return respond(snapshot(Number(url.searchParams.get('field')) === 8 ? 8 : 6));
    }
    if (path.includes('unread')) return respond({ count: 0, unreadCount: 0 });
    if (path.includes('notifications')) return respond({ notifications: [], unreadCount: 0 });
    return respond([]);
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text()))
      errors.push('console: ' + m.text().slice(0, 300));
  });
  return { ctx, page };
}

/** Advance page and fixture time together. */
async function advance(page, ms, step = 33) {
  let left = ms;
  while (left > 0) {
    const d = Math.min(step, left);
    await page.clock.runFor(d);
    state.elapsed += d;
    left -= d;
  }
}

/**
 * Open the Derby page at `start` ms of race time on a frozen clock, choose the
 * field and wait for the authored runners (or their documented fallback).
 */
async function open(page, { start, field = 6, expectAuthored = true }) {
  state.elapsed = start;
  await page.clock.install({ time: epoch + start });
  await page.clock.pauseAt(epoch + start);
  await page.goto(origin + '/games/thunder-derby');
  for (let i = 0; i < 600; i++) {
    if (await page.locator('.derby-scene, .derby-scene-fallback').count()) break;
    await advance(page, 10, 10);
  }
  if (field === 8) {
    await page.getByRole('button', { name: /^8 horses/ }).click();
    for (let i = 0; i < 200; i++) {
      if ((await page.locator('.derby-progress > div').count()) === 8) break;
      await advance(page, 10, 10);
    }
  }
  if (expectAuthored) {
    for (let i = 0; i < 600; i++) {
      const runners = await page
        .locator('.derby-scene')
        .first()
        .getAttribute('data-runners')
        .catch(() => null);
      if (runners === 'authored-rigs') break;
      await advance(page, 10, 10);
      await page.waitForTimeout(10);
    }
  }
  await page.evaluate(() =>
    document
      .querySelector('.derby-scene-shell, .derby-scene')
      ?.scrollIntoView({ block: 'center', behavior: 'instant' })
  );
}
async function sceneInfo(page) {
  return page.evaluate(() => {
    const scene = document.querySelector('.derby-scene');
    const s = window.__derbyProbe.contexts.filter((c) => c.canvas.isConnected).at(-1);
    return {
      runners: scene?.getAttribute('data-runners') ?? null,
      camera: scene?.getAttribute('data-camera') ?? null,
      tier: scene?.getAttribute('data-render-tier') ?? null,
      canvas: s ? [s.canvas.width, s.canvas.height] : null,
      css: scene ? [scene.clientWidth, scene.clientHeight] : null,
      fallback: !!document.querySelector('.derby-scene-fallback'),
      heading: document.querySelector('.derby-race-heading h2')?.textContent ?? null,
      label: document.querySelector('.derby-broadcast-label strong')?.textContent ?? null,
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
}
/** A screenshot can wait for a compositor frame that a paused page clock never
 * schedules; nudge the clock one frame and retry rather than fail the run. */
async function screenshot(page, options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.screenshot({ ...options, timeout: 30000 });
    } catch (error) {
      if (attempt >= 3) throw error;
      await page.clock.runFor(34).catch(() => {});
      state.elapsed += 34;
      await page.waitForTimeout(500);
    }
  }
}
async function shot(page, name, { scene = true, full = true } = {}) {
  if (full) {
    await screenshot(page, { path: resolve(output, name + '.png') });
    captures.push(name + '.png');
  }
  const box = await sceneBox(page);
  if (scene && box) {
    await screenshot(page, { path: resolve(output, name + '-scene.png'), clip: box });
    captures.push(name + '-scene.png');
  }
}
/** Run one scenario; record a failure and keep going with the rest. */
async function scenario(name, run) {
  const contexts = [];
  const make = async (options) => {
    const c = await createContext(options);
    contexts.push(c.ctx);
    return c;
  };
  try {
    await run(make);
  } catch (error) {
    errors.push(`${name}: ${String(error?.message ?? error).split('\n')[0]}`);
  } finally {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    state.offline = state.failModels = state.failBackdrop = false;
  }
}
/** The course shell's viewport rectangle. Clipping by box avoids Playwright's rAF
 * stability wait, which never completes while the page clock is paused. */
async function sceneBox(page) {
  const box = await page.evaluate(() => {
    const r = document.querySelector('.derby-scene-shell')?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0
      ? { x: r.left, y: r.top, width: r.width, height: r.height }
      : null;
  });
  return box;
}
async function expand(page) {
  const toggle = page.locator('.derby-display .game-arena__toggle').first();
  if (await toggle.count()) {
    await toggle.click();
    await advance(page, 400);
  }
}
async function chooseCamera(page, name) {
  const button = page.locator('.derby-cameras button', { hasText: name }).first();
  if (!(await button.count())) return false;
  await button.click();
  return true;
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 1000, scale: 2 },
  phone375: { width: 375, height: 812, scale: 2, mobile: true },
  phone320: { width: 320, height: 568, scale: 2, mobile: true },
  landscape: { width: 844, height: 390, scale: 2, mobile: true },
};
const MOMENTS = [
  [-8000, 'gate'],
  [3000, 'start'],
  [12000, 'early'],
  [24000, 'mid'],
  [38000, 'late'],
  [44500, 'line'],
  [47500, 'official'],
];

try {
  if (parts.has('smoke')) {
    // Quick development pass: a few representative frames only.
    const moments = (process.env.DERBY_REVIEW_SMOKE_MOMENTS ?? '-8000,3000,24000,47500')
      .split(',')
      .map(Number);
    const views = (process.env.DERBY_REVIEW_SMOKE_VIEWS ?? 'desktop,phone375').split(',');
    for (const view of views)
      for (const elapsed of moments) {
        const field = Number(process.env.DERBY_REVIEW_SMOKE_FIELD ?? 8);
        const c = await createContext({
          ...VIEWPORTS[view],
          quality: process.env.DERBY_REVIEW_SMOKE_QUALITY,
        });
        await open(c.page, { start: elapsed - 3000, field });
        if (process.env.DERBY_REVIEW_SMOKE_CAMERA)
          await chooseCamera(c.page, process.env.DERBY_REVIEW_SMOKE_CAMERA);
        await advance(c.page, 3000);
        const name = `smoke-${field}-${view}-${elapsed}`;
        await shot(c.page, name, { full: view !== 'desktop' });
        measurements.push({ stage: name, ...(await sceneInfo(c.page)) });
        await c.ctx.close();
      }
  }
  if (parts.has('stills')) {
    for (const field of [6, 8]) {
      for (const [view, opts] of Object.entries(VIEWPORTS)) {
        const moments = view === 'desktop' ? MOMENTS : MOMENTS.filter((m) => m[1] !== 'line');
        for (const [elapsed, moment] of moments) {
          const c = await createContext(opts);
          // A deterministic three-second run-up lets interpolation, gait and camera settle.
          await open(c.page, { start: elapsed - 3000, field });
          await advance(c.page, 3000);
          const name = `still-${field}-${view}-${moment}`;
          await shot(c.page, name, { full: view !== 'desktop' || moment === 'mid' });
          const info = await sceneInfo(c.page);
          assert.equal(info.overflow, false, `${name} overflows horizontally`);
          assert.equal(info.fallback, false, `${name} fell back`);
          measurements.push({ stage: name, ...info });
          await c.ctx.close();
        }
        checks.push(`${field} runners · ${view}: ${moments.length} race moments render`);
      }
      // Expanded arena on desktop and phone, mid-race.
      for (const view of ['desktop', 'phone375', 'landscape']) {
        const c = await createContext(VIEWPORTS[view]);
        await open(c.page, { start: 21000, field });
        await expand(c.page);
        await advance(c.page, 2600);
        const name = `still-${field}-${view}-expanded-mid`;
        await shot(c.page, name);
        measurements.push({ stage: name, ...(await sceneInfo(c.page)) });
        await c.ctx.close();
      }
      checks.push(`${field} runners: expanded desktop/phone/landscape render`);
    }
    // Camera presets (where the build offers them), 8 runners, desktop and phone.
    for (const view of ['desktop', 'phone375']) {
      for (const camera of ['Broadcast', 'Follow', 'Head-on', 'Overhead']) {
        const c = await createContext(VIEWPORTS[view]);
        await open(c.page, { start: 21000, field: 8 });
        if (!(await chooseCamera(c.page, camera))) {
          await c.ctx.close();
          break;
        }
        await advance(c.page, 3000);
        const name = `camera-8-${view}-${camera.toLowerCase()}`;
        await shot(c.page, name, { full: view !== 'desktop' });
        measurements.push({ stage: name, ...(await sceneInfo(c.page)) });
        await c.ctx.close();
        checks.push(`camera ${camera} (${view}) renders`);
      }
    }
  }

  if (parts.has('states')) {
    const run = (name, body) => (skip.has(name) ? null : scenario(name, body));
    // Reduced motion: still image, one refresh per second.
    await run('reduced', async (make) => {
      for (const view of ['desktop', 'phone375']) {
        const c = await make({ ...VIEWPORTS[view], reduced: true });
        await open(c.page, { start: 21000, field: 8 });
        await advance(c.page, 3000);
        await shot(c.page, `state-reduced-motion-${view}`);
        measurements.push({ stage: 'reduced ' + view, ...(await sceneInfo(c.page)) });
      }
      checks.push('reduced motion renders on desktop and phone');
    });
    // Quality tiers.
    await run('quality', async (make) => {
      for (const quality of ['high', 'balanced', 'low']) {
        const c = await make({ ...VIEWPORTS.phone375, quality });
        await open(c.page, { start: 21000, field: 8 });
        await advance(c.page, 3000);
        await shot(c.page, `state-quality-${quality}-phone375`);
        measurements.push({ stage: 'quality ' + quality, ...(await sceneInfo(c.page)) });
      }
      checks.push('quality tiers render');
    });
    // Reconnect: the API stops answering mid-race, then returns.
    await run('reconnect', async (make) => {
      const c = await make(VIEWPORTS.desktop);
      await open(c.page, { start: 16000, field: 6 });
      await advance(c.page, 2000);
      state.offline = true;
      await advance(c.page, 9000);
      const paused = await sceneInfo(c.page);
      await shot(c.page, 'state-reconnect-paused');
      state.offline = false;
      await advance(c.page, 5000);
      const resumed = await sceneInfo(c.page);
      await shot(c.page, 'state-reconnect-resumed');
      measurements.push({ stage: 'reconnect', paused, resumed });
      assert.match(paused.heading ?? '', /Reconnecting/i, 'reconnect heading not shown');
      assert.doesNotMatch(resumed.heading ?? '', /Reconnecting/i, 'reconnect did not recover');
      checks.push('reconnect: paused view while offline, resumes after');
    });
    // Model and backdrop download failure: procedural runners remain.
    await run('asset-failure', async (make) => {
      state.failModels = true;
      state.failBackdrop = true;
      const c = await make(VIEWPORTS.desktop);
      await open(c.page, { start: 21000, field: 8, expectAuthored: false });
      await advance(c.page, 3000);
      const info = await sceneInfo(c.page);
      await shot(c.page, 'state-asset-failure');
      measurements.push({ stage: 'asset failure', ...info });
      assert.equal(info.runners, 'procedural');
      assert.equal(info.fallback, false);
      checks.push('asset failure: procedural runners keep racing');
    });
    // Graphics context loss and restoration.
    await run('context-loss', async (make) => {
      const c = await make(VIEWPORTS.desktop);
      await open(c.page, { start: 21000, field: 8 });
      await advance(c.page, 1000);
      const lost = await c.page.evaluate(() => {
        const canvas = document.querySelector('.derby-scene canvas');
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        const ext = gl.getExtension('WEBGL_lose_context');
        window.__derbyLose = ext;
        ext.loseContext();
        return true;
      });
      await advance(c.page, 300);
      await c.page.waitForTimeout(200);
      await shot(c.page, 'state-context-lost');
      const during = await sceneInfo(c.page);
      await c.page.evaluate(() => window.__derbyLose.restoreContext());
      await c.page.waitForTimeout(300);
      for (let i = 0; i < 300; i++) {
        const runners = await c.page.locator('.derby-scene').first().getAttribute('data-runners');
        if (runners === 'authored-rigs' && !(await c.page.locator('.derby-scene-fallback').count()))
          break;
        await advance(c.page, 10, 10);
        await c.page.waitForTimeout(10);
      }
      await advance(c.page, 1500);
      const after = await sceneInfo(c.page);
      await shot(c.page, 'state-context-restored');
      measurements.push({ stage: 'context loss', lost, during, after });
      assert.equal(during.fallback, true, 'context loss did not show the fallback');
      assert.equal(after.fallback, false, 'context restoration did not rebuild');
      checks.push('context loss shows fallback; restoration rebuilds the scene');
    });
    // No WebGL at all.
    await run('no-webgl', async (make) => {
      const c = await make({ ...VIEWPORTS.phone375, noWebGL: true });
      await open(c.page, { start: 21000, field: 6, expectAuthored: false });
      await advance(c.page, 1000);
      await shot(c.page, 'state-no-webgl');
      const info = await sceneInfo(c.page);
      assert.equal(info.fallback, true);
      checks.push('no WebGL: accessible fallback');
    });
    // Reset into the next race after the result window.
    await run('reset', async (make) => {
      const c = await make(VIEWPORTS.desktop);
      await open(c.page, { start: 56000, field: 6 });
      await advance(c.page, 2000);
      await shot(c.page, 'state-result-window');
      await advance(c.page, 4000);
      const info = await sceneInfo(c.page);
      await shot(c.page, 'state-next-race-reset');
      measurements.push({ stage: 'reset', ...info });
      assert.match(info.heading ?? '', /starting gate/i, 'next race did not reset to the gate');
      checks.push('result window then reset to the next race gate');
    });
  }

  if (parts.has('clips')) {
    const clips = [
      // Comparable full race: same race, same default camera, normal speed.
      { name: 'race-8-desktop-full', field: 8, view: 'desktop', from: -4000, ms: 52000, fps: 25 },
      { name: 'race-6-phone375-mid', field: 6, view: 'phone375', from: 14000, ms: 10000, fps: 30 },
      { name: 'race-8-phone320-start', field: 8, view: 'phone320', from: -2000, ms: 9000, fps: 30 },
      {
        name: 'race-8-landscape-finish',
        field: 8,
        view: 'landscape',
        from: 39000,
        ms: 10000,
        fps: 30,
      },
      {
        name: 'race-8-desktop-follow',
        field: 8,
        view: 'desktop',
        from: 20000,
        ms: 8000,
        fps: 30,
        camera: 'Follow',
      },
      {
        name: 'race-8-desktop-headon',
        field: 8,
        view: 'desktop',
        from: 26000,
        ms: 8000,
        fps: 30,
        camera: 'Head-on',
      },
    ].filter((clip) => !onlyClips || onlyClips.includes(clip.name));
    for (const clip of clips)
      await scenario('clip ' + clip.name, async (make) => {
        const frames = resolve(output, 'frames-' + clip.name);
        await rm(frames, { recursive: true, force: true });
        await mkdir(frames, { recursive: true });
        const opts = { ...VIEWPORTS[clip.view], scale: clip.view === 'desktop' ? 1 : 2 };
        const c = await make(opts);
        await open(c.page, { start: clip.from - 2000, field: clip.field });
        if (clip.camera && !(await chooseCamera(c.page, clip.camera))) return;
        await advance(c.page, 2000);
        const step = 1000 / clip.fps,
          count = Math.round((clip.ms / 1000) * clip.fps),
          box = await sceneBox(c.page);
        let carried = 0;
        const started = Date.now();
        for (let i = 0; i < count; i++) {
          carried += step;
          const d = Math.floor(carried);
          carried -= d;
          await advance(c.page, d, d);
          await screenshot(c.page, {
            path: resolve(frames, String(i).padStart(5, '0') + '.png'),
            clip: box,
          });
        }
        const realSeconds = (Date.now() - started) / 1000;
        const probe = await c.page.evaluate(() => {
          const s = window.__derbyProbe.contexts.filter((x) => x.canvas.isConnected).at(-1);
          return s
            ? { draws: s.frameDraws.slice(-60), triangles: s.frameTriangles.slice(-60) }
            : null;
        });
        await c.ctx.close().catch(() => {});
        const encode = (rate, out) =>
          execFileSync('ffmpeg', [
            '-y',
            '-loglevel',
            'error',
            '-framerate',
            String(rate),
            '-i',
            resolve(frames, '%05d.png'),
            '-vf',
            'pad=ceil(iw/2)*2:ceil(ih/2)*2',
            '-c:v',
            'libx264',
            '-pix_fmt',
            'yuv420p',
            '-crf',
            '23',
            '-movflags',
            '+faststart',
            resolve(output, out),
          ]);
        encode(clip.fps, clip.name + '.mp4');
        if (clip.ms <= 10000) encode(clip.fps / 4, clip.name + '-quarter-speed.mp4');
        captures.push(clip.name + '.mp4');
        measurements.push({
          stage: 'clip ' + clip.name,
          frames: count,
          fps: clip.fps,
          captureSeconds: realSeconds,
          probe,
        });
        checks.push(`clip ${clip.name}: ${count} frames at ${clip.fps} fps`);
      });
  }

  if (parts.has('perf')) {
    // Draw calls and triangles for one rendered frame. Software WebGL: these are
    // workload counts, not device frame rates.
    for (const [view, quality] of [
      ['desktop', 'high'],
      ['desktop', 'balanced'],
      ['phone375', 'balanced'],
      ['phone375', 'low'],
    ]) {
      await scenario(`perf ${view} ${quality}`, async (make) => {
        const c = await make({ ...VIEWPORTS[view], quality, scale: 2 });
        await open(c.page, { start: 21000, field: 8 });
        await advance(c.page, 2000);
        const result = await c.page.evaluate(() => {
          const s = window.__derbyProbe.contexts.filter((x) => x.canvas.isConnected).at(-1);
          const gl = s?.gl;
          const debug = gl?.getExtension('WEBGL_debug_renderer_info');
          return s
            ? {
                drawsPerFrame: s.frameDraws.slice(-20),
                trianglesPerFrame: s.frameTriangles.slice(-20),
                texturesCreated: s.textures,
                canvas: [s.canvas.width, s.canvas.height],
                renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
              }
            : null;
        });
        measurements.push({ stage: `perf ${view} ${quality}`, ...result });
      });
    }
    checks.push('perf: draw/triangle workload recorded');
  }
} catch (error) {
  errors.push(String(error?.stack ?? error));
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      { label, origin, parts: [...parts], checks, errors, blocked, captures, measurements },
      null,
      2
    )
  );
}
console.log(JSON.stringify({ label, checks: checks.length, errors, blocked: blocked.length }));
if (errors.length) process.exitCode = 1;
