// Authenticated, read-only browser acceptance AFTER review-together-eight-live.mjs
// has completed setup and verification. Only its two disposable QA identities and
// eight practice rounds are accepted. No games/settings/bets/funds are changed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const site = 'https://salem.bet';
const statePath = '/private/tmp/salem-eight-live-state.json';
const output = '/private/tmp/salem-eight-live-browser';
const games = [
  ['roulette_keno', 'The shared draw'],
  ['lucky_six', 'The shared draw'],
  ['thunder_derby_3d', 'The finishing order'],
  ['neon_hounds_3d', 'The finishing order'],
  ['virtual_football_3d', 'Full-time results'],
  ['blackjack', 'The table revealed'],
  ['sky_crash', 'The crash result'],
  ['crash_point', 'The crash result'],
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const report = {
  source: site,
  actualAuthentication: true,
  mockedResponses: false,
  practiceOnly: true,
  checks: [],
  errors: [],
  serverErrors: [],
  blockedMutations: [],
};
let state, browser;

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    // JSON parser errors can quote a portion of private input. Keep them private.
    throw Error('Cannot read the eight-game QA state; run live setup and verify first.');
  }
}

function safeMessage(error) {
  let text = error instanceof Error ? error.message : String(error);
  const secrets = (state?.users ?? [])
    .flatMap((u) => [u.password, u.email, u.username, ...Object.values(u.cookies ?? {})])
    .filter((v) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.replaceAll(secret, '[redacted]');
  return text.slice(0, 2500);
}

function validateState() {
  assert.equal(state?.site, site, 'Only the expected Salem Bet QA state is permitted');
  assert.equal(state.version, 1, 'Unexpected QA state version');
  assert(/^[a-f0-9]{10}$/.test(state.suffix), 'Unexpected QA suffix');
  assert.equal(state.users?.length, 2, 'Exactly two disposable QA identities are required');
  for (let i = 0; i < 2; i++) {
    const user = state.users[i];
    assert.equal(user.username, `qa_eight_${state.suffix}_${i}`, 'Unexpected QA username');
    assert.equal(user.email, user.username + '@example.invalid', 'Unexpected QA identity');
    assert(uuid.test(user.id), 'QA registration must be complete');
    assert.equal(typeof user.password, 'string', 'QA credentials have already been retired');
  }
  assert.notEqual(state.users[0].id, state.users[1].id, 'QA identities must be separate');
  assert(
    state.setupComplete && state.completedAt,
    'Run live verification to completion before this browser check'
  );
  assert.equal(state.groups?.length, 8, 'Exactly eight QA groups are required');
  assert.deepEqual(
    Object.keys(state.rounds).sort(),
    games.map(([game]) => game).sort(),
    'Unexpected QA round catalogue'
  );
  const ids = new Set();
  for (const [game] of games) {
    const saved = state.rounds[game];
    assert(uuid.test(saved.id) && uuid.test(saved.groupId), 'Incomplete QA round identity');
    assert(!ids.has(saved.id), 'Duplicate QA round');
    ids.add(saved.id);
    assert(
      state.groups.some((g) => g.id === saved.groupId && g.private === true),
      'QA group must already be private'
    );
    assert(saved.confirmed && saved.finalSnapshot, 'QA round verification is incomplete');
    validateRound(game, saved.finalSnapshot.round);
  }
}

function validateRound(game, round) {
  const saved = state.rounds[game];
  assert(round, 'The QA round was not returned');
  assert.equal(round.id, saved.id, 'Unexpected QA round');
  assert.equal(round.groupId, saved.groupId, 'Unexpected QA group');
  assert.equal(round.game, game, 'Unexpected QA game');
  assert.equal(round.termsHash, saved.termsHash, 'Published QA terms changed');
  assert.equal(round.currency, 'GAME_POINTS', 'Only practice rounds are allowed');
  assert.equal(round.entryAmount, 100, 'Unexpected practice entry');
  assert(
    ['PAID', 'REFUNDED'].includes(round.state),
    'Wait for automatic settlement before browser acceptance'
  );
  assert(round.outcome && round.proof && round.settlement, 'Expected completed signed outcome');
  assert.equal(round.entries.length, 2, 'Only the two QA members may participate');
  assert.deepEqual(
    round.entries.map((e) => e.userId).sort(),
    state.users.map((u) => u.id).sort(),
    'Unexpected round participant'
  );
  assert.equal(round.settlement.funded, 200, 'Unexpected practice pool');
  assert.equal(
    round.settlement.payouts.reduce((sum, p) => sum + p.amount, 0) + round.settlement.platformFee,
    200,
    'Practice pool does not reconcile'
  );
}

async function persistCookies() {
  // Merge only the refreshed QA session into the latest file. Do not overwrite
  // settlement receipts or later verification evidence from another command.
  const latest = await loadState();
  assert.equal(latest.suffix, state.suffix, 'QA state changed during verification');
  assert.equal(latest.users?.[0]?.id, state.users[0].id, 'QA identity changed during verification');
  assert.equal(typeof latest.users[0].password, 'string', 'QA account has been retired');
  latest.users[0].cookies = state.users[0].cookies;
  const temporary = statePath + '.browser-next';
  await writeFile(temporary, JSON.stringify(latest, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}

async function apiRequest(path, method = 'GET', body) {
  assert(
    path === '/auth/me' ||
      path === '/auth/login' ||
      games.some(([game]) => path === '/play-together/rounds/' + state.rounds[game].id),
    'Only QA identity and round reads are permitted'
  );
  assert(
    method === 'GET' || (method === 'POST' && path === '/auth/login'),
    'Only normal QA sign-in may write'
  );
  const headers = { Origin: site, Accept: 'application/json' };
  const user = state.users[0];
  if (Object.keys(user.cookies ?? {}).length)
    headers.Cookie = Object.entries(user.cookies)
      .filter(([, v]) => v)
      .map(([k, v]) => k + '=' + v)
      .join('; ');
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(site + '/api/v1' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  user.cookies ??= {};
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0],
      split = pair.indexOf('=');
    if (split > 0) user.cookies[pair.slice(0, split)] = pair.slice(split + 1);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw Error(`QA API returned a non-JSON response (${response.status})`);
  }
  return { status: response.status, data: json.data ?? json };
}

async function ensureSession() {
  let result = await apiRequest('/auth/me');
  if (result.status === 401) {
    const user = state.users[0];
    result = await apiRequest('/auth/login', 'POST', {
      email: user.email,
      password: user.password,
    });
  }
  assert.equal(result.status, 200, 'The existing QA sign-in could not be renewed');
  assert.equal(
    result.data.user?.id,
    state.users[0].id,
    'The browser must use the original QA account'
  );
  await persistCookies();
}

try {
  assert.equal(
    process.env.TOGETHER_LIVE_ACK,
    'practice-release',
    'Explicit practice-release acknowledgement required'
  );
  state = await loadState();
  validateState();
  await mkdir(output, { recursive: true, mode: 0o700 });
  await ensureSession();
  const snapshots = {};
  for (const [game] of games) {
    const result = await apiRequest('/play-together/rounds/' + state.rounds[game].id);
    assert.equal(result.status, 200, 'Live QA round could not be read');
    validateRound(game, result.data.round);
    assert.equal(
      result.data.cashAvailable,
      false,
      'Real-money group admission must remain disabled'
    );
    assert.equal(result.data.settings.cashEnabled, false, 'Cash policy must remain disabled');
    snapshots[game] = result.data.round;
  }
  await persistCookies();
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    await ensureSession();
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      locale: 'en-US',
      serviceWorkers: 'block',
    });
    await context.addCookies(
      Object.entries(state.users[0].cookies)
        .filter(([, value]) => value)
        .map(([name, value]) => ({
          name,
          value,
          domain: 'salem.bet',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        }))
    );
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    page.on('pageerror', (error) => report.errors.push({ width, message: safeMessage(error) }));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === site && url.pathname.startsWith('/api/') && response.status() >= 500)
        report.serverErrors.push({ width, path: url.pathname, status: response.status() });
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== site) return route.abort();
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      const normalRefresh = request.method() === 'POST' && url.pathname === '/api/v1/auth/refresh';
      if (url.pathname.startsWith('/api/') && !read && !normalRefresh) {
        report.blockedMutations.push({ width, method: request.method(), path: url.pathname });
        return route.abort();
      }
      return route.continue();
    });
    for (const [game, heading] of games) {
      const round = snapshots[game],
        route = '/play-together/rounds/' + round.id;
      await page.goto(site + route, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(new URL(page.url()).origin, site, 'Browser left the expected site');
      assert.equal(new URL(page.url()).pathname, route, 'QA round unexpectedly redirected');
      assert.equal(
        await page
          .getByRole('heading', { name: 'Result display unavailable', exact: true })
          .count(),
        0,
        'Recorded outcome did not render'
      );
      assert.equal(
        await page.getByText(/It will settle automatically/).count(),
        0,
        'A completed round still displays pending settlement'
      );
      const own = round.entries.find((entry) => entry.userId === state.users[0].id);
      assert.equal(
        await page.locator('.together-personal-result > strong').innerText(),
        own.payout.toLocaleString('en-US') + ' points',
        'Displayed payout differs from the recorded QA receipt'
      );
      if (width === 390) {
        await page.getByRole('button', { name: 'Verify result and payouts', exact: true }).click();
        await page.getByText(/^Verified:.*result and payouts match\.$/).waitFor({ timeout: 30000 });
        report.checks.push({
          game,
          width,
          action: 'Actual signed result and payouts verified in browser',
        });
      }
      const replay = page.getByRole('button', { name: 'Replay reveal', exact: true });
      if (await replay.count()) {
        await replay.click();
        await page
          .getByText('Replaying the saved result. Your entry and wallet are unchanged.', {
            exact: true,
          })
          .waitFor();
        await page.getByRole('button', { name: 'Show final result', exact: true }).click();
        assert.equal(await page.getByText(/Replaying the saved result/).count(), 0);
        report.checks.push({ game, width, action: 'Saved reveal replay returns to final result' });
      }
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1
      );
      assert.equal(overflow, false, `${game} overflows at ${width}px`);
      await page.screenshot({ path: resolve(output, `${game}-${width}.png`), fullPage: true });
      report.checks.push({
        game,
        width,
        state: round.state,
        loaded: true,
        payoutMatches: true,
        overflow: false,
      });
      console.log(`PASS ${game} ${width}px`);
    }
    // Save only same-origin session cookies. This keeps a normal browser refresh
    // usable for the next viewport without copying any unrelated browser data.
    for (const cookie of await context.cookies(site))
      state.users[0].cookies[cookie.name] = cookie.value;
    await persistCookies();
    await context.close();
  }
  assert.deepEqual(report.errors, [], 'Browser reported a JavaScript error');
  assert.deepEqual(report.serverErrors, [], 'A live application API returned a server error');
  assert.deepEqual(
    report.blockedMutations,
    [],
    'Result review unexpectedly attempted an application mutation'
  );
  report.completedAt = new Date().toISOString();
  console.log(`EIGHT_GAME_LIVE_BROWSER_COMPLETE ${report.checks.length}`);
} catch (error) {
  report.failure = safeMessage(error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  if (state && process.env.TOGETHER_LIVE_ACK === 'practice-release') {
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  }
  await browser?.close();
}
