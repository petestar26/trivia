// Local synthetic lobby/chat visual regression. No real account, backend, wallet or message writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  TOGETHER_GAMES,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherGameGuide,
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
const origin = process.env.TOGETHER_REVIEW_ORIGIN;
assert.ok(origin, 'Set TOGETHER_REVIEW_ORIGIN to the built loopback preview URL');
const parsedOrigin = new URL(origin);
assert.equal(parsedOrigin.hostname, '127.0.0.1', 'Only a loopback preview is allowed');
assert.equal(parsedOrigin.origin, origin, 'Use an origin without a trailing path');
const output = resolve(process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-group-languages');
await mkdir(output, { recursive: true });
try {
  const previous = await readFile(resolve(output, 'review.json'), 'utf8');
  await writeFile(resolve(output, `review.previous-${Date.now()}.json`), previous);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// Load the same checked-in static catalogue and formatters used by the browser.
// Replace only Vite's eager glob with explicit local imports for this Node script.
const catalogueDir = resolve(repo, 'apps/web/src/lib/i18n/catalogues');
const files = (await readdir(catalogueDir)).filter((file) => file.endsWith('.ts')).sort();
const bundle = await build({
  stdin: {
    contents: `export * from './apps/web/src/lib/i18n/format.ts';\nexport { LANGUAGES } from './apps/web/src/lib/i18n/types.ts';\nexport { catalogue } from './apps/web/src/lib/i18n/catalogue.ts';`,
    resolveDir: repo,
    sourcefile: 'language-review-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
  plugins: [
    {
      name: 'local-catalogue-glob',
      setup(builder) {
        builder.onLoad({ filter: /[/\\]i18n[/\\]catalogue\.ts$/ }, () => ({
          contents:
            files
              .map((file, i) => `import c${i} from ${JSON.stringify('./catalogues/' + file)};`)
              .join('\n') +
            `\nimport { mergeCatalogues } from './validation';\nexport const catalogue = mergeCatalogues({` +
            files.map((file, i) => `${JSON.stringify(file)}: c${i}`).join(',') +
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
const t = (language, key, values) => {
  if (language !== 'en')
    assert.ok(catalogue[key]?.[language], `${language} catalogue missing: ${key}`);
  return translate(language, key, values);
};

const user = {
  id: 'visual-member',
  username: 'Abebe',
  displayName: 'Abebe Bekele',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const group = { id: 'visual-group', name: 'Addis Friends', ownerId: user.id, status: 'ACTIVE' };
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
const balances = { cashAvailable: 0, cashReserved: 0, pointsAvailable: 10000, pointsReserved: 0 };
const now = Date.now();
const round = {
  id: 'saved-refund',
  groupId: group.id,
  groupName: group.name,
  creatorId: user.id,
  game: 'spin_win',
  currency: 'GAME_POINTS',
  entryAmount: 100,
  feeBps: 700,
  settingsVersion: 1,
  minPlayers: 2,
  maxPlayers: 20,
  closesAt: now - 120000,
  createdAt: now - 240000,
  state: 'REFUNDED',
  rulesId: TOGETHER_RULES_ID,
  feePolicy: TOGETHER_FEE_POLICY,
  termsHash: 'a'.repeat(64),
  seedCommitment: 'b'.repeat(64),
  beaconRound: 1,
  rosterHash: null,
  entries: [],
  outcome: null,
  ranking: [],
  settlement: null,
  voidReason: 'NOT_ENOUGH_PLAYERS',
  paidAt: now - 60000,
  recoveryDeadline: now + 120000,
  proof: null,
};
const gift = {
  id: 'gift-message',
  userId: user.id,
  createdAt: new Date(now - 30000).toISOString(),
  type: 'TEXT',
  content: '',
  sender: { id: user.id, username: 'Abebe' },
  gift: {
    id: 'gift',
    name: 'Little Rose',
    emoji: '🌹',
    theme: 'rose',
    recipientUsername: 'TigistBekeleLongUsername',
    faceValue: 500,
    currency: 'PRACTICE_ETB',
  },
};
const checks = [],
  errors = [],
  forbiddenWrites = [],
  screenshots = [];
let failure = null;
const browser = await chromium.launch({ headless: true });
try {
  for (const { code: language, direction } of LANGUAGES) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    });
    await context.addInitScript((code) => localStorage.setItem('salem-language', code), language);
    if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (e) => errors.push({ language, message: e.message }));
    let messageError = false;
    await context.route('**/*', async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (url.origin !== origin || url.pathname.startsWith('/ws')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/v1', '');
      const answer = (data, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({
            success: status === 200,
            data,
            error:
              status === 200
                ? undefined
                : { code: 'UNAVAILABLE', message: 'Synthetic connection failure' },
          }),
        });
      if (path === '/member-rewards/activity' && req.method() === 'POST')
        return answer({ earned: false, credited: 0 });
      if (req.method() !== 'GET') {
        forbiddenWrites.push({ path, method: req.method() });
        return answer({}, 409);
      }
      if (path === '/auth/me') return answer({ user });
      if (path === '/workspaces/access') return answer({ admin: false, agent: false });
      if (path === '/play-together/' || path === '/play-together')
        return answer({
          serverTime: Date.now(),
          workerReady: true,
          admissionsEnabled: true,
          cashAvailable: false,
          settings,
          balances,
          group: url.searchParams.has('groupId') ? group : null,
          groups: [group],
          legacyPending: false,
          rounds: [],
        });
      if (path === `/play-together/groups/${group.id}/activity`)
        return answer({
          serverTime: Date.now(),
          activeRound: null,
          latestResult: { ...round, participants: 0 },
        });
      if (path === `/play-together/rounds/${round.id}`)
        return answer({ serverTime: Date.now(), settings, balances, round });
      if (path === `/groups/${group.id}/lifecycle`)
        return answer({
          name: group.name,
          serverTime: Date.now(),
          expiresAt: Date.now() + 86400000,
          closed: false,
          archived: false,
          canModerate: true,
        });
      if (path === `/groups/${group.id}/messages`)
        return answer(
          [
            gift,
            {
              id: 'text',
              content: 'Welcome to the group',
              createdAt: new Date(now).toISOString(),
              sender: { id: 'friend', username: 'Tigist' },
            },
          ],
          messageError ? 503 : 200
        );
      if (path === '/groups/inbox')
        return answer([
          {
            ...group,
            memberCount: 2,
            isPrivate: false,
            latestMessage: { content: 'Welcome to the group' },
            updatedAt: new Date(now).toISOString(),
          },
        ]);
      if (path.includes('unread')) return answer({ count: 0, unreadCount: 0 });
      if (path.includes('notifications')) return answer({ notifications: [], unreadCount: 0 });
      return answer([]);
    });
    const layout = async (label, width) => {
      await page.evaluate(() => document.fonts.ready);
      const actual = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
      }));
      assert.equal(actual.lang, language);
      assert.equal(actual.dir, direction);
      assert.ok(
        actual.scroll <= actual.width + 1,
        `${language}/${width}/${label}: overflow ${JSON.stringify(actual)}`
      );
      assert.equal(errors.length, 0, JSON.stringify(errors));
      assert.equal(forbiddenWrites.length, 0, JSON.stringify(forbiddenWrites));
      checks.push({ language, width, label, ...actual });
    };
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(origin + '/play-together?game=spin_win');
      await page.locator('.tg-game-intro').waitFor();
      for (const [index, game] of TOGETHER_GAMES.entries()) {
        await page.locator('.together-game-grid button').nth(index).click();
        const intro = page.locator('.tg-game-intro');
        await intro.getByRole('heading', { name: t(language, game.name), exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('game'), game.key);
        assert.equal(await intro.locator('.tg-ambience').getAttribute('data-game'), game.key);
        assert.equal(await intro.locator('.tg-ambience').getAttribute('aria-hidden'), 'true');
        assert.ok((await intro.innerText()).includes(t(language, game.rules)));
        const guide = togetherGameGuide(game.key);
        for (const line of guide.mechanics)
          assert.ok((await intro.innerText()).includes(t(language, line)));
        assert.ok((await intro.innerText()).includes(t(language, guide.tieRule)));
        const textStyle = await intro.locator('.tg-intro-lead').evaluate((el) => ({
          weight: parseInt(getComputedStyle(el).fontWeight),
          color: getComputedStyle(el).color,
        }));
        assert.ok(textStyle.weight >= 700, JSON.stringify(textStyle));
        assert.equal(textStyle.color, 'rgb(241, 245, 239)');
        await layout(game.key, width);
        if (
          (language === 'en' && width === 1440) ||
          (['am', 'ar'].includes(language) && width === 390 && game.key === 'spin_win')
        ) {
          await intro.scrollIntoViewIfNeeded();
          const file = `${language}-${width}-${game.key}.png`;
          await intro.screenshot({ path: resolve(output, file) });
          screenshots.push(file);
        }
      }
      await page.locator('.together-columns .tg-social-card').first().scrollIntoViewIfNeeded();
      if (language === 'en') {
        const file = `en-${width}-community.png`;
        await page.locator('.together-columns').screenshot({ path: resolve(output, file) });
        screenshots.push(file);
      }
      await layout('community', width);
    }
    if (language === 'en') {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(origin + '/play-together?game=spin_win');
      const intro = page.locator('.tg-game-intro');
      await intro.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () => document.querySelector('.tg-ambience')?.getAttribute('data-running') === 'true'
      );
      const angle = () =>
        page.locator('.tg-ambient-wheel svg').evaluate((el) => getComputedStyle(el).transform);
      const first = await angle();
      await page.waitForTimeout(250);
      assert.notEqual(await angle(), first, 'spin ambience must move');
      await intro.getByRole('button', { name: 'Pause animation' }).click();
      await page.waitForFunction(
        () =>
          getComputedStyle(document.querySelector('.tg-ambient-wheel svg')).animationPlayState ===
          'paused'
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      const paused = await angle();
      await page.waitForTimeout(250);
      assert.equal(await angle(), paused, 'pause must stop motion');
      await intro.getByRole('button', { name: 'Resume animation' }).click();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(
        await page
          .locator('.tg-ambient-wheel svg')
          .evaluate((el) => getComputedStyle(el).animationName),
        'none'
      );
      checks.push({ language, label: 'pause-resume-reduced-motion' });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    if (['en', 'am', 'ar'].includes(language))
      for (const width of [1440, 1024, 390, 320]) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(origin + `/messages/${group.id}`);
        await page.getByText('Welcome to the group', { exact: true }).waitFor();
        assert.equal(
          await page.locator('.salem-support-float').count(),
          0,
          'support shortcut must not cover chat controls'
        );
        assert.equal(
          await page.locator('.tg-group-arena').count(),
          0,
          'historical result must not displace chat'
        );
        await page.getByRole('button', { name: t(language, 'View result'), exact: true }).click();
        await page.locator('.tg-result-refund').waitFor();
        const activitySpacing = await page.evaluate(() => ({
          link: document.querySelector('.tg-group-activity-bar a').getBoundingClientRect().bottom,
          summary: document.querySelector('.tg-group-watch > p').getBoundingClientRect().top,
        }));
        assert.ok(
          activitySpacing.link <= activitySpacing.summary + 1,
          `result link overlaps summary: ${JSON.stringify(activitySpacing)}`
        );
        if (width < 1000)
          await page.getByRole('button', { name: t(language, 'Group chat'), exact: true }).click();
        const contrast = await page
          .locator('.tg-result-refund')
          .evaluate((el) => getComputedStyle(el).color);
        assert.equal(contrast, 'rgb(245, 247, 239)', 'refund notice must have readable light text');
        await page.locator('.tg-chat-gift').scrollIntoViewIfNeeded();
        const bounds = await page.locator('.tg-chat-gift').evaluate((el) => {
          const r = el.getBoundingClientRect(),
            copy = el.querySelector('.tg-chat-gift-copy').getBoundingClientRect();
          const thread = el.closest('.qube-chat-thread');
          return {
            cardWidth: el.clientWidth,
            cardScroll: el.scrollWidth,
            copyLeft: copy.left,
            left: r.left,
            copyRight: copy.right,
            right: r.right,
            threadWidth: thread.clientWidth,
            threadScroll: thread.scrollWidth,
          };
        });
        assert.ok(
          bounds.cardScroll <= bounds.cardWidth + 1 &&
            bounds.copyLeft >= bounds.left &&
            bounds.copyRight <= bounds.right + 1 &&
            bounds.threadScroll <= bounds.threadWidth + 1,
          `gift clipped: ${JSON.stringify(bounds)}`
        );
        await layout('chat-expanded-result-and-gift', width);
        if (language === 'en' || width === 390) {
          const file = `${language}-${width}-chat.png`;
          await page.screenshot({ path: resolve(output, file), fullPage: true });
          screenshots.push(file);
        }
      }
    if (language === 'en') {
      messageError = true;
      await page.goto(origin + `/messages/${group.id}`);
      await page
        .getByText('Messages could not be loaded. Check your connection and try again.')
        .waitFor();
      messageError = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByText('Welcome to the group', { exact: true }).waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
      checks.push({ language, label: 'chat-retry' });
    }
    await context.close();
  }
} catch (error) {
  failure = error.stack ?? String(error);
  throw error;
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify({ checks, errors, forbiddenWrites, screenshots, failure }, null, 2)
  );
}
console.log(
  JSON.stringify({
    checks: checks.length,
    errors: errors.length,
    financialWrites: forbiddenWrites.length,
    screenshots: screenshots.length,
  })
);
