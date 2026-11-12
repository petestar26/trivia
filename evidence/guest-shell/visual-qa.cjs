// Private loopback QA. Every API is stubbed; all external requests are blocked.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { spawn } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const origin = 'http://127.0.0.1:5186';
const output = resolve('evidence/guest-shell');
const server = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '5186'],
  { cwd: resolve('apps/web'), stdio: 'pipe' }
);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  mkdirSync(output, { recursive: true });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await delay(200);
  }
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
    headless: true,
  });
  const reports = [];
  try {
    for (const width of [1440, 768, 390, 320]) {
      const context = await browser.newContext({
        viewport: { width, height: 950 },
        serviceWorkers: 'block',
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      const errors = [],
        requests = [],
        external = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          external.push(url.origin);
          return route.abort();
        }
        if (url.pathname.startsWith('/api/')) {
          requests.push(`${route.request().method()} ${url.pathname}`);
          return route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              error: { code: 'UNAUTHORIZED', message: 'Synthetic guest' },
            }),
          });
        }
        return route.continue();
      });
      await context.routeWebSocket('**/*', (socket) => socket.close());
      for (const path of ['/', '/casino', '/sports', '/wallet', '/play-together?game=dice']) {
        await page.goto(origin + path);
        await page.getByRole('heading', { level: 1 }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `horizontal overflow ${width} ${path}`
        );
        const name = path === '/' ? 'home' : path.split('?')[0].slice(1);
        await page.screenshot({ path: `${output}/guest-${name}-${width}.png`, fullPage: true });
        if (path === '/wallet') {
          await page.getByRole('button', { name: 'Open wallet', exact: true }).click();
          await page.getByRole('dialog').waitFor();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false
          );
          await page.screenshot({ path: `${output}/guest-prompt-${width}.png` });
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('dialog').count(), 0);
          assert.equal(new URL(page.url()).pathname, '/wallet');
        }
      }
      if (width < 1024) {
        await page.getByRole('button', { name: 'Open navigation menu' }).click();
        await page.getByRole('dialog', { name: 'Main navigation' }).waitFor();
        await page.screenshot({ path: `${output}/guest-menu-${width}.png` });
        await page.getByRole('button', { name: 'Close navigation menu' }).click();
      }
      assert.deepEqual(errors, [], 'No console errors');
      assert(
        requests.every((r) => /^GET \/api\/v1\/auth\/me$|^POST \/api\/v1\/auth\/refresh$/.test(r)),
        JSON.stringify(requests)
      );
      reports.push({ width, errors, requests, externalBlocked: external });
      await context.close();
    }
    writeFileSync(`${output}/visual-results.json`, JSON.stringify(reports, null, 2));
    console.log(JSON.stringify(reports, null, 2));
  } finally {
    await browser.close();
  }
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => server.kill());
