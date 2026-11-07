// Synthetic production-preview shared live-game acceptance. Only loopback assets are read;
// every API response is a local fixture. No real account, proof verification,
// provider, database, payment or wager is used. Run after the final web build:
// TOGETHER_REVIEW_ORIGIN=http://127.0.0.1:<preview-port> node scripts/review-together-languages.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  TOGETHER_GAMES,
  TOGETHER_GAME_DURATION_MS,
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
const output = resolve(
  process.env.TOGETHER_REVIEW_OUTPUT ?? '/private/tmp/salem-shared-live-browser'
);
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
  id: 'language-member',
  username: 'Abebe',
  displayName: 'Abebe Bekele',
  email: 'language-member@example.invalid',
  role: 'USER',
  status: 'ACTIVE',
  isVerified: true,
};
const group = { id: 'language-group', name: 'Addis Friends', ownerId: user.id, status: 'ACTIVE' };
const settings = {
  version: 1,
  feeBps: 700,
  minEntry: 100,
  maxEntry: 100000,
  enabledGames: TOGETHER_GAMES.map((game) => game.key),
  practiceEnabled: true,
  cashEnabled: false,
  publicRoomsEnabled: false,
};
const balances = { cashAvailable: 0, cashReserved: 0, pointsAvailable: 10000, pointsReserved: 0 };
const selection = (game, other = false) => {
  if (game === 'spin_win' || game === 'dice') return [];
  if (game === 'number_challenge') return [other ? 75 : 25];
  if (game === 'turbo_keno' || game === 'roulette_keno')
    return other ? [10, 11, 12, 13, 14] : [1, 2, 3, 4, 5];
  if (game === 'lucky_six') return other ? [10, 11, 12, 13, 14, 15] : [1, 2, 3, 4, 5, 6];
  if (game === 'thunder_derby_3d' || game === 'neon_hounds_3d') return [other ? 2 : 1];
  if (game === 'blackjack') return other ? [2, 0, 1, 2, 0, 1] : [0, 1, 2, 0, 1, 2];
  if (game === 'virtual_football_3d') return other ? [2, 0, 1] : [0, 1, 2];
  return [other ? 300 : 200];
};
const resultHeading = (game) =>
  ({
    spin_win: 'The winning segment',
    turbo_keno: 'The shared draw',
    dice: 'The dice results',
    number_challenge: 'The shared target',
    roulette_keno: 'The shared draw',
    lucky_six: 'The shared draw',
    thunder_derby_3d: 'The finishing order',
    neon_hounds_3d: 'The finishing order',
    virtual_football_3d: 'Full-time results',
    blackjack: 'The table revealed',
    sky_crash: 'The crash result',
    crash_point: 'The crash result',
  })[game];

// Same deterministic fixture strategy as review-together-eight-browser.mjs.
// The dummy beacon signature is deliberately invalid; proof verification is not tested.
function fixtureFor(game) {
  const id = 'language-' + game;
  const closesAt = Date.now() + 3600000;
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
    { id: 'entry-me', userId: user.id, selection: selection(game) },
    { id: 'entry-other', userId: 'language-other', selection: selection(game, true) },
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
  assert.equal(derived.settlement.refunds, false, `Cannot create settled ${game} fixture`);
  round.termsHash = togetherTermsHash(round);
  const entries = tickets.map((ticket, i) => ({
    ...ticket,
    username: i ? 'Tigist' : 'Abebe',
    state: 'ACCEPTED',
    amount: 1000,
    payout: null,
    createdAt: closesAt - 60000,
    walletTransactionId: 'wallet-' + ticket.id,
    payoutTransactionId: null,
    requestId: null,
  }));
  return {
    open: { ...round, entries: [{ ...entries[1], selection: null }] },
    paid: {
      ...round,
      ...derived,
      state: 'PAID',
      paidAt: Date.now() - 60000,
      rosterHash: togetherRosterHash(tickets),
      entries: entries.map((entry) => ({
        ...entry,
        state: 'SETTLED',
        payout:
          derived.settlement.payouts.find((payout) => payout.entryId === entry.id)?.amount ?? 0,
        payoutTransactionId: 'paid-' + entry.id,
      })),
    },
  };
}

const presentationBundle = await build({
  entryPoints: [resolve(repo, 'apps/api/src/games/play-together/presentation.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const { preparePresentation } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(presentationBundle.outputFiles[0].text).toString('base64')
);
const checks = [],
  errors = [],
  screenshots = [],
  writes = [];
const browser = await chromium.launch({ headless: true });
let failure;
let activePage;
try {
  for (const { code: language, direction } of LANGUAGES.filter(
    (l) => !process.env.TOGETHER_REVIEW_LANGUAGE || l.code === process.env.TOGETHER_REVIEW_LANGUAGE
  )) {
    const context = await browser.newContext({
      viewport: { width: language === 'en' ? 1280 : 390, height: 900 },
      reducedMotion: language === 'en' ? 'no-preference' : 'reduce',
      serviceWorkers: 'block',
    });
    await context.addInitScript(
      ({ code, quality }) => {
        localStorage.setItem('salem-language', code);
        localStorage.setItem('salem-game-quality', quality);
      },
      { code: language, quality: process.env.TOGETHER_REVIEW_QUALITY ?? 'balanced' }
    );
    if (context.routeWebSocket) await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => errors.push({ language, message: error.message }));
    let current, recording;
    const spectator = { ...user, id: 'unfunded-spectator', username: 'Hana' };
    await context.route('**/*', async (route) => {
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
      if (path === '/auth/me') return respond({ user: spectator });
      if (path === '/workspaces/access') return respond({ admin: false, agent: false });
      if (path === `/play-together/groups/${group.id}/activity`)
        return respond({
          serverTime: Date.now(),
          latestResult: null,
          activeRound: {
            id: current.id,
            game: current.game,
            currency: current.currency,
            entryAmount: current.entryAmount,
            state: current.state,
            closesAt: current.closesAt,
            participants: current.entries.length,
            groupName: group.name,
          },
        });
      if (path.startsWith('/play-together/rounds/')) {
        const now = Date.now(),
          p = current.presentation;
        const finished = now >= p.finishesAt;
        const round = {
          ...current,
          presentation: {
            ...p,
            observedAt: now,
            resultAvailable: finished,
            events: recording.filter((e) => e.atMs <= now - p.startsAt),
          },
        };
        if (!finished)
          Object.assign(round, {
            outcome: null,
            proof: null,
            ranking: [],
            settlement: null,
            paidAt: null,
            entries: round.entries.map((e) => ({
              ...e,
              state: 'ACCEPTED',
              payout: null,
              payoutTransactionId: null,
            })),
          });
        return respond({
          serverTime: now,
          round,
          workerReady: true,
          admissionsEnabled: true,
          settings,
          cashAvailable: false,
          balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 0, pointsReserved: 0 },
        });
      }
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
          memberCount: 10,
          memberRole: 'MEMBER',
          owner: user,
        });
      if (path.includes('unread')) return respond({ count: 0, unreadCount: 0 });
      if (path.includes('notifications')) return respond({ notifications: [], unreadCount: 0 });
      return respond([]);
    });
    async function capture(game, stage, image = false) {
      const result = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
        phase: document.querySelector('.tg-live')?.getAttribute('data-reveal-phase'),
        progress: Number(document.querySelector('.tg-live')?.getAttribute('data-reveal-progress')),
        canvases: document.querySelectorAll('.tg-live canvas').length,
        scrollY,
        arenaTop: document.querySelector('.tg-live-stage')?.getBoundingClientRect().top + scrollY,
        arenaHeight: document.querySelector('.tg-live-stage')?.getBoundingClientRect().height,
        quality: document.querySelector('.tg-live')?.getAttribute('data-quality'),
      }));
      assert.equal(result.language, language);
      assert.equal(result.direction, direction);
      assert.ok(
        result.scroll <= result.width + 1,
        `${language}/${game}/${stage} overflow: ${JSON.stringify(result)}`
      );
      assert.equal(errors.length, 0, JSON.stringify(errors));
      assert.equal(writes.length, 0, JSON.stringify(writes));
      if (stage === 'live' && !(await page.getByRole('alert').count())) {
        assert.ok(
          result.arenaTop < 340,
          `Arena buried below the header: ${JSON.stringify(result)}`
        );
        assert.ok(result.arenaHeight >= 200, `Arena too small: ${JSON.stringify(result)}`);
        assert.equal(result.scrollY, 0, 'Loading chat must not scroll the surrounding page');
      }
      checks.push({ language, game, stage, ...result });
      if (image) {
        const name = `${language}-${game}-${stage}.png`;
        await page.screenshot({ path: resolve(output, name), fullPage: true, timeout: 60000 });
        screenshots.push(name);
      }
    }
    for (const { key: game } of TOGETHER_GAMES.filter(
      (g) => !process.env.TOGETHER_REVIEW_GAME || g.key === process.env.TOGETHER_REVIEW_GAME
    )) {
      current = fixtureFor(game).paid;
      const duration = TOGETHER_GAME_DURATION_MS[game];
      recording = preparePresentation(
        game,
        duration,
        current.outcome,
        current.entries,
        current.proof.seed
      );
      current = {
        ...current,
        termsVersion: 2,
        presentationVersion: 2,
        presentationDurationMs: duration,
        state: 'DRAWN',
        settlement: null,
        paidAt: null,
        entries: current.entries.map((e) => ({
          ...e,
          state: 'ACCEPTED',
          payout: null,
          payoutTransactionId: null,
        })),
        presentation: {
          version: 2,
          startsAt: Date.now() - duration * 0.45,
          finishesAt: Date.now() + duration * 0.55,
          observedAt: Date.now(),
          events: [],
          resultAvailable: false,
        },
      };
      current.termsHash = togetherTermsHash(current);
      if (language === 'en' && game === 'spin_win') {
        current.presentation.startsAt = Date.now() + 45000;
        current.presentation.finishesAt = current.presentation.startsAt + duration;
        await page.goto(origin + '/play-together/rounds/' + current.id);
        await page.locator('.tg-live-countdown').waitFor();
        await capture(game, 'countdown', true);
        current.presentation.startsAt = Date.now() - duration * 0.45;
        current.presentation.finishesAt = current.presentation.startsAt + duration;
      }
      await page.goto(origin + '/play-together/rounds/' + current.id);
      await page.locator('.tg-live[data-reveal-phase="revealing"]').waitFor();
      await page.getByText(t(language, 'Watching'), { exact: true }).first().waitFor();
      if (game === 'virtual_football_3d') {
        await page.locator('.original-football .vf-board-overlay').waitFor();
        await page.evaluate(() => document.fonts.ready);
        // Read both rectangles in one frame; translated fonts may settle between
        // separate browser calls and otherwise produce a false overlap report.
        const layout = await page.evaluate(() => {
          const picker = document.querySelector('.tg-live-scores').getBoundingClientRect();
          const board = document
            .querySelector('.original-football .vf-board-overlay')
            .getBoundingClientRect();
          return { pickerBottom: picker.bottom, scoreboardTop: board.top };
        });
        assert.ok(
          layout.pickerBottom <= layout.scoreboardTop,
          `${language}: match controls must not cover the original stadium scoreboard: ${JSON.stringify(layout)}`
        );
      }
      assert.equal(
        await page.getByRole('button', { name: t(language, 'Replay for me'), exact: true }).count(),
        0
      );
      if (
        language === 'en' &&
        ['thunder_derby_3d', 'neon_hounds_3d', 'virtual_football_3d'].includes(game)
      ) {
        await page.locator('.tg-live canvas').first().waitFor({ timeout: 40000 });
        if (game === 'virtual_football_3d') {
          await page.waitForTimeout(1000);
          assert.equal(
            await page.locator('.tg-live .vf-stage-view').getAttribute('data-problem'),
            'none'
          );
        }
      }
      await capture(game, 'live', language === 'en' || ['am', 'ar'].includes(language));
      if (game === 'spin_win') {
        const chat = page.locator('.tg-arena-chat-heading');
        assert.equal(
          await chat.getAttribute('aria-expanded'),
          language === 'en' ? 'true' : 'false'
        );
        await chat.click();
        assert.equal(
          await chat.getAttribute('aria-expanded'),
          language === 'en' ? 'false' : 'true'
        );
        await chat.click();
        await page.evaluate(() => scrollTo(0, 0));
      }
      if (
        language === 'en' &&
        ['thunder_derby_3d', 'neon_hounds_3d', 'virtual_football_3d'].includes(game)
      ) {
        if (game === 'thunder_derby_3d')
          await page.locator('[data-runners="authored-rigs"]').waitFor({ timeout: 40000 });
        await page.getByLabel(t(language, 'Graphics quality')).selectOption('low');
        await page.locator('.tg-live[data-quality="low"]').waitFor();
        await page.locator('.tg-live canvas').first().waitFor();
        assert.ok((await page.locator('.tg-live [data-original-scene]').count()) > 0);
        await capture(game, 'original-low-quality', true);
        await page.getByLabel(t(language, 'Graphics quality')).selectOption('balanced');
      }
      if (language === 'en') {
        current.presentation.startsAt = Date.now() - duration - 1000;
        current.presentation.finishesAt = current.presentation.startsAt + duration;
        await page.reload();
        await page
          .getByText(t(language, 'Game finished—confirming payout'), { exact: true })
          .first()
          .waitFor();
        await capture(game, 'official-pending', game === 'virtual_football_3d');
        if (game === 'virtual_football_3d') {
          await page.locator('.tg-live canvas').first().waitFor();
          await page
            .locator('.tg-live canvas')
            .first()
            .evaluate((canvas) =>
              canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
            );
          await page.locator('.tg-live .vf-scene-fallback').waitFor();
          await capture(game, 'renderer-loss');
        }
        await page.getByRole('button', { name: t(language, 'Replay for me'), exact: true }).click();
        await page
          .locator('.tg-live[data-reveal-mode="personal"][data-reveal-phase="revealing"]')
          .waitFor();
        await capture(game, 'personal-replay');
      }
    }
    if (['en', 'am', 'ar'].includes(language) && !process.env.TOGETHER_REVIEW_GAME) {
      await page.goto(origin + '/messages/' + group.id);
      await page.locator('.tg-group-arena .tg-live').waitFor();
      const layout = await page.evaluate(() => {
        const game = document.querySelector('.tg-group-game').getBoundingClientRect();
        const chat = document.querySelector('.tg-group-conversation').getBoundingClientRect();
        return { gameX: game.x, gameRight: game.right, chatX: chat.x, chatWidth: chat.width };
      });
      if (language === 'en')
        assert.ok(layout.chatX >= layout.gameRight - 2, 'Desktop chat must sit beside the arena');
      else {
        assert.equal(layout.chatWidth, 0, 'Mobile chat starts collapsed');
        await page.locator('.tg-mobile-chat-toggle').click();
        await page.locator('.tg-group-conversation').waitFor({ state: 'visible' });
        await page.locator('.tg-mobile-chat-toggle').click();
      }
      await page.evaluate(() => scrollTo(0, 0));
      await capture(current.game, 'group-chat-arena', true);
      assert.ok(
        (await page
          .locator('.tg-live-stage')
          .evaluate((el) => el.getBoundingClientRect().top + scrollY)) < 360,
        'Mobile group header must stay compact'
      );
      await page.getByRole('button', { name: t(language, 'Hide game'), exact: true }).click();
      await page.locator('.tg-group-arena').waitFor({ state: 'detached' });
      await page.getByRole('button', { name: t(language, 'Watch live'), exact: true }).click();
      await page.locator('.tg-group-arena .tg-live').waitFor();
      assert.equal(writes.length, 0);
    }
    await context.close();
  }
} catch (error) {
  failure = error.stack;
  if (activePage && !activePage.isClosed()) {
    await activePage
      .screenshot({ path: resolve(output, 'failure.png'), fullPage: true })
      .catch(() => {});
    await writeFile(
      resolve(output, 'failure.txt'),
      await activePage
        .locator('body')
        .innerText()
        .catch(() => '')
    );
  }
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      {
        kind: 'synthetic local browser fixtures; not live acceptance',
        checks,
        errors,
        writes,
        screenshots,
        failure,
      },
      null,
      2
    )
  );
}
if (failure) throw new Error(failure);
console.log(
  JSON.stringify({
    checks: checks.length,
    errors: errors.length,
    writes: writes.length,
    screenshots: screenshots.length,
    output,
  })
);
