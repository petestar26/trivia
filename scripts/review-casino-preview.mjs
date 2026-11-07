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
const origin = process.env.CASINO_REVIEW_ORIGIN;
assert.ok(origin, 'Set CASINO_REVIEW_ORIGIN to a built loopback preview');
assert.equal(new URL(origin).hostname, '127.0.0.1');
assert.equal(new URL(origin).origin, origin);
const output = resolve(process.env.CASINO_REVIEW_OUTPUT ?? '/private/tmp/salem-casino-preview');
await mkdir(output, { recursive: true });
const files = (await readdir(resolve(repo, 'apps/web/src/lib/i18n/catalogues')))
  .filter((f) => f.endsWith('.ts'))
  .sort();
const bundle = await build({
  stdin: {
    contents:
      "export * from './apps/web/src/lib/i18n/format.ts'; export { LANGUAGES } from './apps/web/src/lib/i18n/types.ts'; export { catalogue } from './apps/web/src/lib/i18n/catalogue.ts';",
    resolveDir: repo,
    sourcefile: 'casino-preview-review.ts',
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
const t = (language, key, params) => translate(language, key, params);
const errors = [],
  checks = [];
const games = [
  ...Array.from({ length: 42 }, (_, i) => ({
    id: `keno-${i}`,
    name: `Keno ${i + 1}`,
    category: 'keno',
    provider: i % 2 ? 'Studio B' : 'Studio A',
  })),
  ...Array.from({ length: 40 }, (_, i) => ({
    id: `slot-${i}`,
    name: `Slot ${i + 1}`,
    category: 'slots',
    provider: 'Studio C',
  })),
  {
    id: 'live-table',
    name: 'Live Roulette',
    category: 'live',
    categories: ['live', 'table', 'spin'],
    provider: 'Studio A',
  },
  {
    id: 'wheel',
    name: 'Mega Wheel',
    category: 'live',
    categories: ['live', 'spin'],
    provider: 'Studio D',
  },
];
const browser = await chromium.launch({
  headless: true,
  channel: process.env.CASINO_REVIEW_BROWSER_CHANNEL ?? 'chrome',
});
async function open(language, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    serviceWorkers: 'block',
  });
  await context.addInitScript((code) => {
    localStorage.setItem('salem-language', code);
    localStorage.setItem('theme', 'dark');
  }, language);
  if (context.routeWebSocket) await context.routeWebSocket('**/*', (s) => s.close());
  let launches = 0;
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin || url.pathname.startsWith('/ws')) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.replace('/api/v1', '');
    let data = [];
    if (path === '/auth/me')
      data = {
        user: {
          id: 'synthetic-casino-member',
          username: 'Dawit',
          displayName: 'Dawit',
          role: 'USER',
          status: 'ACTIVE',
          isVerified: true,
        },
      };
    else if (path === '/workspaces/access') data = { admin: false, agent: false };
    else if (path === '/provider-test/status') data = { enabled: true, launchReady: true };
    else if (path === '/provider-test/games') data = games;
    else if (path === '/provider-test/wallet')
      data = { balanceCents: 100000, created: false, movements: [] };
    else if (path === '/provider-test/launch') {
      launches++;
      return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: { code: 'CASINO_GAME_REGION_UNAVAILABLE', message: 'private-provider-message' },
        }),
      });
    } else if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/casino`);
  await page.getByRole('button', { name: t(language, 'Keno'), exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { page, context, launches: () => launches };
}
async function layout(page, width) {
  const size = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    controls: [...document.querySelectorAll('.casino-provider-filter, .casino-search')].map((e) => {
      const r = e.getBoundingClientRect();
      return { left: r.left, right: r.right };
    }),
  }));
  assert.ok(size.scroll <= width + 1, JSON.stringify(size));
  for (const c of size.controls)
    assert.ok(c.left >= -1 && c.right <= width + 1, JSON.stringify(size));
}
try {
  for (const language of LANGUAGES.map((l) => l.code))
    for (const width of [1440, 390]) {
      const s = await open(language, width),
        page = s.page;
      assert.equal(
        await page.locator('.casino-categories > button').first().getAttribute('aria-label'),
        t(language, 'Favorites')
      );
      await page.getByRole('button', { name: t(language, 'Spin'), exact: true }).click();
      assert.equal(await page.locator('.casino-game-tile').count(), 2);
      assert.equal(await page.locator('.casino-game-tile h3').first().innerText(), 'Mega Wheel');
      await page.getByRole('button', { name: t(language, 'Keno'), exact: true }).click();
      assert.equal(await page.locator('.casino-game-tile').count(), 36);
      await page.getByRole('button', { name: t(language, 'Show more games'), exact: true }).click();
      assert.equal(await page.locator('.casino-game-tile').count(), 42);
      await page
        .getByRole('combobox', { name: t(language, 'Game provider') })
        .selectOption('Studio A');
      assert.equal(await page.locator('.casino-game-tile').count(), 21);
      await layout(page, width);
      assert.equal(s.launches(), 0);
      assert.equal(await page.locator('html').getAttribute('lang'), language);
      if (['en', 'am', 'ar'].includes(language))
        await page.screenshot({
          path: resolve(output, `casino-${language}-${width}.png`),
          fullPage: true,
        });
      await page
        .getByRole('button', {
          name: t(language, 'Add {name} to favorites', { name: 'Keno 1' }),
          exact: true,
        })
        .click();
      await page
        .getByRole('button', {
          name: t(language, 'Remove {name} from favorites', { name: 'Keno 1' }),
          exact: true,
        })
        .waitFor();
      await page.getByRole('button', { name: t(language, 'Favorites'), exact: true }).click();
      assert.equal(await page.locator('.casino-game-tile').count(), 1);
      assert.equal(s.launches(), 0);
      await page.reload();
      await page.getByRole('button', { name: t(language, 'Favorites'), exact: true }).click();
      await page.locator('.casino-game-tile h3').waitFor();
      assert.equal(await page.locator('.casino-game-tile h3').innerText(), 'Keno 1');
      await layout(page, width);
      const heartSize = await page.locator('.casino-favorite').boundingBox();
      assert.ok(heartSize.width >= 44 && heartSize.height >= 44, 'Heart has a usable touch target');
      if (['en', 'am', 'ar'].includes(language))
        await page.screenshot({
          path: resolve(output, `favorites-${language}-${width}.png`),
          fullPage: true,
        });
      await page
        .getByRole('button', {
          name: t(language, 'Remove {name} from favorites', { name: 'Keno 1' }),
          exact: true,
        })
        .click();
      await page.getByText(t(language, 'No favorites yet'), { exact: true }).waitFor();
      assert.equal(s.launches(), 0);
      // Keep the existing live-table check scoped to its original provider.
      await page
        .getByRole('combobox', { name: t(language, 'Game provider') })
        .selectOption('Studio A');
      await page.getByRole('button', { name: t(language, 'Table games'), exact: true }).click();
      assert.equal(await page.locator('.casino-game-tile h3').innerText(), 'Live Roulette');
      await page.getByRole('button', { name: t(language, 'Live casino'), exact: true }).click();
      assert.equal(await page.locator('.casino-game-tile h3').innerText(), 'Live Roulette');
      await page.locator('.casino-game-tile').click();
      await page
        .getByText(
          t(language, 'This provider does not offer this game in Ethiopia. Choose another game.'),
          { exact: true }
        )
        .waitFor();
      assert.equal(s.launches(), 1);
      assert.equal(await page.locator('iframe').count(), 0);
      assert.equal(await page.getByText('private-provider-message').count(), 0);
      await layout(page, width);
      checks.push({
        language,
        width,
        passed: [
          'full-category-pagination',
          'spin-category',
          'favorites-first-save-reload-remove',
          'favorite-does-not-launch',
          'favorite-touch-target',
          'provider-filter',
          'live-table-category',
          'localized-launch-error',
          'no-private-error-text',
          'no-overflow',
        ],
      });
      await s.context.close();
    }
  const narrow = await open('en', 320);
  await layout(narrow.page, 320);
  checks.push({ width: 320, passed: ['narrow-phone-layout'] });
  await narrow.context.close();
  assert.deepEqual(errors, []);
} catch (e) {
  await writeFile(resolve(output, 'failure.txt'), String(e.stack));
  throw e;
} finally {
  await writeFile(
    resolve(output, 'result.json'),
    JSON.stringify({ synthetic: true, checks, errors }, null, 2)
  );
  await browser.close();
}
console.log(JSON.stringify({ checks: checks.length, errors: errors.length, output }));
