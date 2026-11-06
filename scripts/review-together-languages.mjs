// Synthetic production-preview language acceptance. Only loopback assets are read;
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
const fixtures = Object.fromEntries(TOGETHER_GAMES.map((game) => [game.key, fixtureFor(game.key)]));
const checks = [],
  errors = [],
  forbiddenWrites = [],
  externalRequests = [],
  activityPings = [],
  screenshots = [];
const startedAt = new Date().toISOString();
let failure = null;
const browser = await chromium.launch({ headless: true });
try {
  for (const { code: language, direction } of LANGUAGES) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block',
    });
    await context.addInitScript((code) => localStorage.setItem('salem-language', code), language);
    if (typeof context.routeWebSocket === 'function')
      await context.routeWebSocket('**/*', (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let width = 1440;
    let current = null;
    let lobbyRound = null;
    page.on('pageerror', (error) => errors.push({ language, width, message: error.message }));
    page.on('response', (response) => {
      if (response.status() >= 500)
        errors.push({ language, width, status: response.status(), url: response.url() });
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        externalRequests.push({ language, width, origin: url.origin, pathname: url.pathname });
        return route.abort();
      }
      if (url.pathname.startsWith('/ws')) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname.replace('/api/v1', ''),
        method = request.method();
      const respond = (data, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ success: status === 200, data }),
        });
      // Existing daily-activity ping is mocked locally and never reaches an API.
      if (path === '/member-rewards/activity' && method === 'POST') {
        activityPings.push({ language, width });
        return respond({ earned: false, credited: 0 });
      }
      if (method !== 'GET') {
        forbiddenWrites.push({ language, width, path, method });
        return respond({ error: 'This read-only synthetic review cannot write' }, 409);
      }
      const common = {
        serverTime: Date.now(),
        workerReady: true,
        admissionsEnabled: true,
        settings,
        cashAvailable: false,
        balances,
      };
      const summary = (round) => ({
        id: round.id,
        groupId: group.id,
        groupName: group.name,
        game: round.game,
        currency: round.currency,
        entryAmount: round.entryAmount,
        feeBps: round.feeBps,
        state: round.state,
        closesAt: round.closesAt,
        participants: round.entries.length,
        createdAt: round.closesAt - 120000,
        paidAt: round.paidAt,
      });
      let data = {};
      if (path === '/auth/me') data = { user };
      else if (path === '/workspaces/access')
        data = { admin: false, agent: false, agentStatus: null };
      else if (path === '/play-together/' || path === '/play-together')
        data = {
          ...common,
          group,
          groups: [group],
          legacyPending: false,
          rounds: lobbyRound ? [summary(lobbyRound)] : [],
        };
      else if (path.startsWith('/play-together/rounds/')) {
        assert.ok(current && path.endsWith('/' + current.id), 'Unexpected round API request');
        data = { ...common, round: current };
      } else if (path === `/play-together/groups/${group.id}/activity`)
        data = {
          serverTime: Date.now(),
          activeRound: null,
          latestResult: lobbyRound ? summary(lobbyRound) : null,
        };
      else if (path === `/groups/${group.id}/lifecycle`)
        data = {
          name: group.name,
          expiresAt: Date.now() + 86400000,
          serverTime: Date.now(),
          closed: false,
          archived: false,
          canModerate: true,
        };
      else if (path === `/groups/${group.id}`)
        data = {
          ...group,
          isMember: true,
          isPrivate: true,
          memberCount: 2,
          memberRole: 'OWNER',
          owner: user,
        };
      else if (path === '/groups/inbox' || path.startsWith(`/groups/${group.id}/`)) data = [];
      else if (path.includes('unread')) data = { count: 0, unreadCount: 0 };
      else if (path.includes('notifications')) data = { notifications: [], unreadCount: 0 };
      return respond(data);
    });
    const visibleText = async (key, values, scope = page) => {
      const expected = t(language, key, values);
      await scope.getByText(expected, { exact: true }).first().waitFor({ state: 'visible' });
      return expected;
    };
    async function capture(state, game, screenshot = false) {
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        language: document.documentElement.lang,
        direction: document.documentElement.dir,
      }));
      assert.equal(layout.language, language);
      assert.equal(layout.direction, direction);
      assert.ok(
        layout.document <= layout.viewport + 1,
        `${language}/${width}/${game}/${state} overflow: ${JSON.stringify(layout)}`
      );
      assert.equal(errors.length, 0, 'Browser errors: ' + JSON.stringify(errors));
      assert.equal(
        forbiddenWrites.length,
        0,
        'Unexpected mutation: ' + JSON.stringify(forbiddenWrites)
      );
      if (screenshot) {
        const name = `${language}-${width}-${game}-${state}.png`;
        await page.screenshot({ path: resolve(output, name), fullPage: true });
        screenshots.push(name);
      }
      checks.push({ language, width, game, state, ...layout });
    }
    async function groupNav() {
      const nav = page.getByRole('navigation', {
        name: t(language, 'Group sections'),
        exact: true,
      });
      for (const [label, path] of [
        ['Chat', `/messages/${group.id}`],
        ['Games', `/groups/${group.id}/games`],
        ['Gifts', `/groups/${group.id}/gifts`],
        ['Members', `/groups/${group.id}`],
      ])
        assert.equal(
          await nav
            .getByRole('link', { name: t(language, label), exact: true })
            .getAttribute('href'),
          path
        );
    }
    for (width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      current = null;
      lobbyRound = null;
      await page.goto(origin + `/groups/${group.id}/games`, { waitUntil: 'domcontentloaded' });
      await page.locator('.together-game-grid').waitFor();
      await groupNav();
      assert.ok(
        (await page.locator('.together-hero h1').innerText()).startsWith(
          t(language, 'Play together')
        )
      );
      await visibleText('Choose together');
      await visibleText('Watch together');
      await visibleText('See the result');
      assert.equal(await page.locator('.together-game-grid button').count(), 12);
      await capture('lobby', 'all-games', true);
      for (const [index, game] of TOGETHER_GAMES.entries()) {
        await page.locator('.together-game-grid button').nth(index).click();
        const rules = page.locator('details.together-catalogue > section.together-panel');
        await rules.getByRole('heading', { name: t(language, game.name), exact: true }).waitFor();
        await visibleText(game.rules, undefined, rules);
        const guide = togetherGameGuide(game.key);
        await visibleText(guide.choiceNote, undefined, rules);
        for (const line of guide.mechanics) await visibleText(line, undefined, rules);
        await visibleText(guide.tieRule, undefined, rules);
        await visibleText(
          'The fee is {percent}% of winning profit before fees. No additional entry or winner fee.',
          { percent: 7 },
          rules
        );
        await capture(
          'rules',
          game.key,
          (language === 'ar' || language === 'am') && game.key === 'sky_crash'
        );
      }
      // Exercise the pre-confirmation experience without accepting any entry.
      for (const key of ['roulette_keno', 'virtual_football_3d', 'sky_crash']) {
        current = fixtures[key].open;
        await page.goto(origin + '/play-together/rounds/' + current.id, {
          waitUntil: 'domcontentloaded',
        });
        await visibleText('Everyone gets ready here');
        await visibleText('Choose your entry or watch');
        await groupNav();
        assert.equal(
          await page.locator('.tg-result').count(),
          0,
          'An open round must not reveal a result'
        );
        const confirm = page.locator('.together-confirm button.together-primary');
        await confirm.waitFor();
        assert.equal(await confirm.isDisabled(), true, `${key} must require a complete choice`);
        const inputs = page.locator('.together-selection');
        if (key === 'roulette_keno') {
          for (const number of selection(key))
            await inputs
              .getByRole('button', {
                name: t(language, 'Choose {number}', { number }),
                exact: true,
              })
              .click();
        } else if (key === 'virtual_football_3d') {
          for (const [index, value] of selection(key).entries())
            await inputs.locator('select').nth(index).selectOption(String(value));
        } else
          await inputs
            .locator('input')
            .fill(language === 'ar' ? '٢٫٠٠' : language === 'fr' ? '2,00' : '2.00');
        await page.waitForFunction(
          () => !document.querySelector('.together-confirm button.together-primary')?.disabled
        );
        assert.equal(
          await confirm.innerText(),
          t(language, 'Confirm {amount} entry', {
            amount: t(language, '{amount} points', { amount: 1000 }),
          })
        );
        await capture('ready-unconfirmed', key, key === 'sky_crash' && width === 390);
      }
      for (const game of TOGETHER_GAMES) {
        current = fixtures[game.key].paid;
        await page.goto(origin + '/play-together/rounds/' + current.id, {
          waitUntil: 'domcontentloaded',
        });
        const result = page.locator('.tg-result');
        await result
          .getByRole('heading', { name: t(language, resultHeading(game.key)), exact: true })
          .waitFor();
        await visibleText('Recorded result', undefined, result);
        await visibleText('Round complete');
        await visibleText('Group result and payouts');
        await groupNav();
        assert.equal(await result.getAttribute('data-reveal-phase'), 'complete');
        assert.equal(await result.getAttribute('data-reveal-mode'), 'final');
        assert.equal(Number(await result.getAttribute('data-reveal-progress')), 1);
        assert.equal(
          await page.getByText(t(language, 'Result display unavailable'), { exact: true }).count(),
          0
        );
        const pool = page.locator('.together-pool');
        await visibleText('Funded pool', undefined, pool);
        await visibleText('{amount} points', { amount: current.settlement.funded }, pool);
        await visibleText(
          'Platform fee: {amount}',
          { amount: t(language, '{amount} points', { amount: current.settlement.platformFee }) },
          pool
        );
        const roster = page.locator('.together-participants');
        await visibleText('{name} · You', { name: 'Abebe' }, roster);
        await roster.getByText('Tigist', { exact: true }).waitFor();
        assert.equal(await roster.locator(':scope > div').count(), 2);
        const payoutTexts = await roster.locator('.together-member-amount').allTextContents();
        for (const entry of current.entries)
          assert.ok(
            payoutTexts.some((text) =>
              text.includes(t(language, '{amount} points', { amount: entry.payout }))
            ),
            `${game.key} saved payout missing`
          );
        await capture(
          'paid',
          game.key,
          game.key === 'roulette_keno' ||
            (width === 390 &&
              ['blackjack', 'virtual_football_3d', 'thunder_derby_3d'].includes(game.key))
        );
        // Saved totals stay stable when the local replay is started and skipped.
        if (width === 390) {
          const financialBefore = await page.locator('#group-results').innerText();
          await result
            .getByRole('button', { name: t(language, 'Replay for me'), exact: true })
            .click();
          await visibleText(
            'Your personal replay. The group’s result and everyone’s wallet are unchanged.',
            undefined,
            result
          );
          await result
            .getByRole('button', { name: t(language, 'Show final result'), exact: true })
            .click();
          assert.equal(await result.getAttribute('data-reveal-mode'), 'final');
          assert.equal(await page.locator('#group-results').innerText(), financialBefore);
          await capture('personal-replay-finished', game.key);
        }
        if ((language === 'ar' || language === 'am') && game.key === 'sky_crash') {
          const policy = page.locator('details.together-panel').filter({
            has: page.getByText(t(language, 'Round rules and interruption policy'), {
              exact: true,
            }),
          });
          await policy.locator('summary').click();
          await visibleText(
            'Selections are private until betting closes. Everyone pays the same entry. The owner cannot place a bet for you or change accepted round terms.',
            undefined,
            policy
          );
          await visibleText(
            'Tied leaders share equally, with at most one smallest currency unit difference for rounding. The fee applies only to the shared profit; your original entry is included once in the payout.',
            undefined,
            policy
          );
          await capture('interruption-policy', game.key, true);
        }
      }
      // The lobby keeps a direct link to an already paid result in every locale.
      lobbyRound = fixtures.roulette_keno.paid;
      current = lobbyRound;
      await page.goto(origin + `/groups/${group.id}/games`, { waitUntil: 'domcontentloaded' });
      const savedLink = page.locator(`a[href^="/play-together/rounds/${current.id}"]`).first();
      await savedLink.waitFor();
      await savedLink.click();
      await page
        .locator('.tg-result')
        .getByRole('heading', { name: t(language, 'The shared draw'), exact: true })
        .waitFor();
      assert.equal(await page.locator('.tg-result').getAttribute('data-reveal-mode'), 'final');
      await capture('saved-result-link', 'roulette_keno');
      console.log(
        JSON.stringify({
          language,
          width,
          completedChecks: checks.length,
          forbiddenWrites: forbiddenWrites.length,
          errors: errors.length,
        })
      );
    }
    await context.close();
  }
} catch (error) {
  failure = { message: error.message, stack: error.stack };
} finally {
  await browser.close();
  await writeFile(
    resolve(output, 'review.json'),
    JSON.stringify(
      {
        ok: !failure,
        startedAt,
        finishedAt: new Date().toISOString(),
        origin,
        scope:
          'Synthetic production-preview only: mocked auth/API/clock/outcomes; no live wallet, signed-proof, provider, physical-device or native-language-review claim.',
        languages: LANGUAGES.map(({ code }) => code),
        widths: [1440, 390, 320],
        games: TOGETHER_GAMES.map(({ key }) => key),
        checks,
        screenshots,
        errors,
        forbiddenWrites,
        mockedActivityPings: activityPings.length,
        blockedExternalRequests: externalRequests,
        failure,
      },
      null,
      2
    )
  );
}
if (failure) throw new Error(failure.message);
console.log(
  JSON.stringify({
    ok: true,
    checks: checks.length,
    screenshots: screenshots.length,
    errors: errors.length,
    forbiddenWrites: forbiddenWrites.length,
    report: resolve(output, 'review.json'),
  })
);
