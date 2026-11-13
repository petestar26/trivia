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
const output = resolve(process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-sports-preview');
await mkdir(output, { recursive: true });
const files = (await readdir(resolve(repo, 'apps/web/src/lib/i18n/catalogues')))
  .filter((f) => f.endsWith('.ts'))
  .sort();
const bundle = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/lib/i18n/format.ts'; export { LANGUAGES } from './apps/web/src/lib/i18n/types.ts'; export { catalogue } from './apps/web/src/lib/i18n/catalogue.ts';",
    resolveDir: repo,
    sourcefile: 'sports-preview-review.ts',
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
  writes = [],
  checks = [],
  screenshots = [];
let failure = null;
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
async function session(language = 'en', options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: 'block',
    ...options,
  });
  await context.addInitScript((code) => localStorage.setItem('salem-language', code), language);
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
  await context.route('**/*', (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/member-rewards/activity' && request.method() === 'POST')
      data = { earned: false, credited: 0 };
    else if (request.method() !== 'GET') {
      writes.push({ path, method: request.method() });
      return route.abort();
    }
    if (path === '/auth/me')
      data = {
        user: {
          id: 'preview-member',
          username: 'Abebe',
          displayName: 'Abebe',
          role: 'USER',
          status: 'ACTIVE',
          isVerified: true,
        },
      };
    if (path === '/workspaces/access') data = { admin: false, agent: false };
    if (path === '/sportsbook/status')
      data = {
        balanceMinor: 0,
        rewardBalanceMinor: 100000,
        currency: 'ETB',
        mode: 'real-wallet',
        browseReady: true,
        liveEnabled: false,
        canBet: false,
        reason: 'not-live',
      };
    if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
    if (path.includes('notifications')) data = { notifications: [], unreadCount: 0 };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page };
}
async function capture(page, name) {
  await page.locator('.sports-feature').screenshot({ path: resolve(output, name) });
  screenshots.push(name);
}
async function layout(page, language, width) {
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.locator('.sports-football-label').innerText(),
    t(language, 'Football preview')
  );
  const bounds = await page.evaluate(() => {
    const r = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    };
    return {
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      scene: r('.sports-football'),
      button: r('.sports-football-controls button'),
      label: r('.sports-football-label'),
      copy: r('.sports-feature-copy'),
      heading: r('#sports-browse-title'),
      lang: document.documentElement.lang,
    };
  });
  assert.equal(bounds.lang, language);
  assert.ok(bounds.scroll <= width + 1, JSON.stringify(bounds));
  for (const element of [bounds.button, bounds.label])
    assert.ok(
      element.left >= bounds.scene.left &&
        element.right <= bounds.scene.right + 1 &&
        element.bottom <= bounds.scene.bottom,
      JSON.stringify(bounds)
    );
  assert.ok(
    bounds.heading.left >= bounds.copy.left && bounds.heading.right <= bounds.copy.right + 1
  );
  const link = page.getByRole('link', { name: t(language, 'Browse sports'), exact: true });
  assert.equal(await link.getAttribute('href'), '/sports/open');
  assert.equal(await link.getAttribute('target'), '_blank');
  assert.equal(await page.locator('iframe').count(), 0);
  checks.push({ language, width, label: 'layout-and-protected-launch' });
}
try {
  for (const { code: language } of LANGUAGES) {
    assert.ok(language === 'en' || catalogue['Football preview']?.[language]);
    const { context, page } = await session(language, { reducedMotion: 'reduce' });
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + '/sports');
      await page.locator('.sports-football').scrollIntoViewIfNeeded();
      await page
        .locator('.sports-wallet strong')
        .filter({ hasNotText: t(language, 'Loading…') })
        .waitFor();
      await layout(page, language, width);
      assert.equal(
        await page.locator('.sports-football canvas').count(),
        0,
        'Reduced motion must not start the 3D renderer'
      );
      if (['am', 'ar', 'so'].includes(language) && width === 390)
        await capture(page, `${language}-${width}-reduced.png`);
    }
    await context.close();
  }
  for (const width of [1440, 390]) {
    const { context, page } = await session('en', { viewport: { width, height: 300 } });
    await page.goto(origin + '/sports');
    await page.locator('.sports-football').waitFor();
    assert.equal(
      await page.locator('.sports-football canvas').count(),
      0,
      'Offscreen card must not initialize the renderer'
    );
    await page.setViewportSize({ width, height: 900 });
    await page.locator('.sports-football').scrollIntoViewIfNeeded();
    await page.locator('.sports-football[data-state="playing"] canvas').waitFor();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1600);
    const canvas = page.locator('.sports-football canvas');
    const first = await canvas.screenshot();
    await page.waitForTimeout(1000);
    const second = await canvas.screenshot();
    assert.ok(!first.equals(second), 'The football scene must animate');
    await capture(page, `en-${width}-football-action.png`);
    await layout(page, 'en', width);
    await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
    await page.locator('.sports-football[data-state="paused"]').waitFor();
    // Keep both actual pixels on failure: a screenshot includes overlays as well as
    // the WebGL scene, so a mismatch alone cannot identify which part changed.
    const pauseState = () =>
      canvas.evaluate((element) => {
        const host = element.parentElement;
        const card = element.closest('.sports-football');
        const bounds = element.getBoundingClientRect();
        return {
          state: card?.getAttribute('data-state'),
          canvas: { width: element.width, height: element.height },
          bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          opacity: getComputedStyle(host).opacity,
          documentHidden: document.hidden,
          scroll: { x: scrollX, y: scrollY },
          animations: card?.getAnimations({ subtree: true }).map((animation) => ({
            playState: animation.playState,
            currentTime: animation.currentTime,
          })),
        };
      });
    const held = await canvas.screenshot();
    const heldState = await pauseState();
    await page.waitForTimeout(500);
    const afterPause = await canvas.screenshot();
    if (!held.equals(afterPause)) {
      const prefix = `en-${width}-pause-failure`;
      await writeFile(resolve(output, `${prefix}-before.png`), held);
      await writeFile(resolve(output, `${prefix}-after.png`), afterPause);
      await writeFile(
        resolve(output, `${prefix}.json`),
        JSON.stringify(
          {
            before: heldState,
            after: await pauseState(),
          },
          null,
          2
        )
      );
      screenshots.push(`${prefix}-before.png`, `${prefix}-after.png`);
    }
    assert.ok(held.equals(afterPause), 'Pause must freeze the rendered football frame');
    await page.getByRole('button', { name: 'Resume animation', exact: true }).click();
    await page.locator('.sports-football[data-state="playing"]').waitFor();
    await page.waitForTimeout(500);
    assert.ok(!held.equals(await canvas.screenshot()), 'Resume must continue the football action');
    await page.locator('#sports-title').scrollIntoViewIfNeeded();
    await page.setViewportSize({ width, height: 300 });
    await page.locator('.sports-football[data-state="paused"]').waitFor();
    checks.push({ width, label: 'visible-motion-pause-resume-and-offscreen' });
    await context.close();
  }
  const { context, page } = await session();
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /webgl/i.test(type) ? null : original.call(this, type, ...args);
    };
  });
  await page.goto(origin + '/sports');
  await page.locator('.sports-football').scrollIntoViewIfNeeded();
  await page.locator('.sports-football[data-state="still"]').waitFor();
  assert.equal(
    await page
      .locator('.sports-football img')
      .evaluate((img) => img.complete && img.naturalWidth > 0),
    true
  );
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await capture(page, 'en-no-webgl-fallback.png');
  checks.push({ label: 'no-webgl-still-fallback' });
  await context.close();
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(writes.length, 0, JSON.stringify(writes));
} catch (error) {
  failure = error.stack ?? String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify({ checks, errors, writes, screenshots, failure }, null, 2)
  );
}
console.log(
  JSON.stringify({
    checks: checks.length,
    errors: errors.length,
    writes: writes.length,
    screenshots: screenshots.length,
  })
);
