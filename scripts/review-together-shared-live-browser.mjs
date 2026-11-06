// Read-only browser acceptance of one existing QA practice round. Start this
// immediately after review-together-shared-live.mjs setup, while entries are open.
// Normal QA sign-in, session refresh and the standard activity heartbeat are
// allowed. Wagering, publication and administrator writes are always blocked.
// --completed checks this same round after settlement without claiming a new
// observation of its shared reveal or creating any replacement round.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const site = 'https://salem.bet';
const statePath = '/private/tmp/salem-shared-live-state.json';
const completedMode = process.argv[2] === '--completed';
const output = '/private/tmp/salem-shared-live-browser' + (completedMode ? '/completed' : '');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const labels = ['owner', 'member', 'spectator'];
const report = {
  source: site,
  actualAuthentication: true,
  mockedResponses: false,
  practiceOnly: true,
  mode: completedMode ? 'completed-results' : 'live-shared-reveal',
  sharedRevealObservedThisRun: false,
  checks: [],
  errors: [],
  serverErrors: [],
  blockedMutations: [],
  allowedActivityRequests: [],
};
let state, browser;
const clients = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw Error('Cannot read shared-round QA state; run shared live setup first.');
  }
}
function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = (Array.isArray(state?.users) ? state.users : [])
    .flatMap((u) => [u.password, u.username, u.email, ...Object.values(u.cookies ?? {})])
    .filter((v) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  return message.slice(0, 2500);
}
function validateState() {
  assert.equal(state.site, site);
  assert.equal(state.version, 1);
  assert(/^[a-f0-9]{10}$/.test(state.suffix), 'Unexpected QA suffix');
  assert.equal(state.users?.length, 3, 'Exactly three disposable QA identities are required');
  for (let i = 0; i < 3; i++) {
    const user = state.users[i];
    assert.equal(user.username, `qa_shared_${state.suffix}_${i}`, 'Unexpected QA identity');
    assert.equal(user.email, user.username + '@example.invalid', 'Unexpected QA email');
    assert(uuid.test(user.id), 'QA registration is incomplete');
    assert.equal(typeof user.password, 'string', 'QA credentials have already been retired');
  }
  assert.equal(new Set(state.users.map((u) => u.id)).size, 3, 'Three separate logins are required');
  assert.equal(state.groups?.length, 1, 'Only the single QA group is permitted');
  assert(
    uuid.test(state.groups[0].id) && uuid.test(state.round?.id),
    'QA round setup is incomplete'
  );
  assert(/^[a-f0-9]{64}$/.test(state.round.termsHash), 'Missing original round terms');
  assert.equal(
    state.round.receipts?.length,
    2,
    'The two participants must finish confirmation first'
  );
}
async function persistCookies(index) {
  const latest = await loadState();
  assert.equal(latest.suffix, state.suffix, 'QA state changed');
  assert.equal(latest.users?.[index]?.id, state.users[index].id, 'QA identity changed');
  assert.equal(typeof latest.users[index].password, 'string', 'QA credentials have been retired');
  latest.users[index].cookies = state.users[index].cookies;
  const temporary = statePath + '.browser-next';
  await writeFile(temporary, JSON.stringify(latest, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}
function allowedPath(path) {
  return [
    '/auth/me',
    '/auth/login',
    '/play-together/',
    '/play-together/rounds/' + state.round.id,
    '/play-together/groups/' + state.groups[0].id + '/activity',
  ].includes(path);
}
async function apiRequest(index, path, method = 'GET', body) {
  assert(allowedPath(path), 'Only this QA account, group and round may be read');
  assert(
    method === 'GET' || (method === 'POST' && path === '/auth/login'),
    'Only normal QA sign-in may write'
  );
  const user = state.users[index];
  const headers = { Origin: site, Accept: 'application/json' };
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
  let bodyJson;
  try {
    bodyJson = await response.json();
  } catch {
    throw Error(`QA API returned a non-JSON response (${response.status})`);
  }
  return { status: response.status, data: bodyJson.data ?? bodyJson };
}
async function read(index, path) {
  const result = await apiRequest(index, path);
  assert.equal(result.status, 200, 'QA application read failed: ' + path);
  return result.data;
}
async function ensureSession(index) {
  let result = await apiRequest(index, '/auth/me');
  if (result.status === 401) {
    const user = state.users[index];
    result = await apiRequest(index, '/auth/login', 'POST', {
      email: user.email,
      password: user.password,
    });
  }
  assert.equal(result.status, 200, 'The original QA sign-in could not be renewed');
  assert.equal(result.data.user?.id, state.users[index].id, 'Unexpected authenticated identity');
  await persistCookies(index);
}
function validateSnapshot(snapshot) {
  const round = snapshot.round;
  assert.equal(round.id, state.round.id);
  assert.equal(round.groupId, state.groups[0].id);
  assert.equal(round.game, 'roulette_keno');
  assert.equal(round.currency, 'GAME_POINTS');
  assert.equal(round.entryAmount, 100);
  assert.equal(round.termsHash, state.round.termsHash);
  assert.equal(round.entries.length, 2, 'Spectator must never acquire an entry');
  assert.deepEqual(
    round.entries.map((e) => e.userId).sort(),
    state.users
      .slice(0, 2)
      .map((u) => u.id)
      .sort()
  );
  assert.equal(snapshot.cashAvailable, false);
  assert.equal(snapshot.settings.cashEnabled, false);
  return round;
}
async function pageSnapshot(client) {
  const response = await client.context.request.get(
    site + '/api/v1/play-together/rounds/' + state.round.id
  );
  assert.equal(response.status(), 200, 'Authenticated round reload failed');
  const result = await response.json();
  validateSnapshot(result.data);
  return result.data;
}
async function revealViews() {
  return Promise.all(
    clients.map(async (client) => ({
      label: client.label,
      ...(await client.page.evaluate(() => {
        const result = document.querySelector('.tg-result[data-reveal-phase]');
        return result
          ? {
              phase: result.getAttribute('data-reveal-phase'),
              mode: result.getAttribute('data-reveal-mode'),
              progress: Number(result.getAttribute('data-reveal-progress')),
            }
          : { phase: 'waiting', mode: null, progress: null };
      })),
    }))
  );
}
async function eventually(action, timeout, description) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw Error(description + ': ' + safeMessage(last ?? 'timeout'));
}
async function screenshot(client, name) {
  await client.page.evaluate(() => document.fonts.ready);
  const size = await client.page.evaluate(() => ({
    width: innerWidth,
    overflow: document.documentElement.scrollWidth > innerWidth + 1,
  }));
  assert.equal(size.overflow, false, client.label + ' view overflows');
  await client.page.screenshot({
    path: resolve(output, `${client.label}-${name}-${size.width}.png`),
    fullPage: true,
  });
  report.checks.push({ viewer: client.label, screen: name, ...size });
}

try {
  assert.equal(
    process.env.TOGETHER_LIVE_ACK,
    'practice-release',
    'Explicit practice-release acknowledgement required'
  );
  assert(
    process.argv.length === 2 || (process.argv.length === 3 && completedMode),
    'Use no flag for the live reveal, or --completed for the same finished round'
  );
  state = await loadState();
  validateState();
  await mkdir(output, { recursive: true, mode: 0o700 });
  // Persist sequentially so independent cookie refreshes cannot overwrite each other.
  for (let i = 0; i < 3; i++) await ensureSession(i);
  const initial = await Promise.all(
    state.users.map((_, i) => read(i, '/play-together/rounds/' + state.round.id))
  );
  initial.forEach(validateSnapshot);
  if (completedMode)
    assert(
      initial.every((s) => ['PAID', 'REFUNDED'].includes(s.round.state)),
      'Completed mode requires the existing round to be settled'
    );
  else
    assert.equal(
      initial[0].round.state,
      'OPEN',
      'Start the shared browser check immediately after live setup, while the round is open. Do not silently publish a replacement.'
    );
  const spectatorBefore = (await read(2, '/play-together/')).balances;
  const activity = await Promise.all(
    state.users.map((_, i) => read(i, '/play-together/groups/' + state.groups[0].id + '/activity'))
  );
  for (const item of activity)
    assert.equal(
      (completedMode ? item.latestResult : item.activeRound)?.id,
      state.round.id,
      'Every group member must discover the same QA round'
    );
  report.checks.push({
    action: completedMode
      ? 'Owner, member and spectator discover the same saved result; spectator has no entry'
      : 'Owner, member and spectator discover the same active round; spectator has no entry',
  });
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
  browser = await chromium.launch({ headless: true });
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext({
      viewport: { width: i === 0 ? 1440 : 390, height: 900 },
      locale: 'en-US',
      serviceWorkers: 'block',
    });
    await context.addCookies(
      Object.entries(state.users[i].cookies)
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
    const page = await context.newPage(),
      client = { page, context, index: i, label: labels[i] };
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) =>
      report.errors.push({ viewer: client.label, message: safeMessage(error) })
    );
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === site && url.pathname.startsWith('/api/') && response.status() >= 500)
        report.serverErrors.push({
          viewer: client.label,
          path: url.pathname,
          status: response.status(),
        });
    });
    await context.route('**/*', async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== site) return route.abort();
      const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(request.method());
      const sessionRefresh = request.method() === 'POST' && url.pathname === '/api/v1/auth/refresh';
      const activityHeartbeat =
        request.method() === 'POST' && url.pathname === '/api/v1/member-rewards/activity';
      if (activityHeartbeat)
        report.allowedActivityRequests.push({ viewer: client.label, path: url.pathname });
      if (url.pathname.startsWith('/api/') && !readOnly && !sessionRefresh && !activityHeartbeat) {
        report.blockedMutations.push({
          viewer: client.label,
          method: request.method(),
          path: url.pathname,
        });
        return route.abort();
      }
      return route.continue();
    });
    clients.push(client);
  }
  await Promise.all(
    clients.map(async (client) => {
      await client.page.goto(site + '/groups/' + state.groups[0].id + '/games', {
        waitUntil: 'domcontentloaded',
      });
      const link = client.page
        .getByRole('link', {
          name: completedMode ? 'View group result' : 'Watch or join round',
          exact: false,
        })
        .first();
      await link.waitFor();
      assert.equal(
        await link.getAttribute('href'),
        '/play-together/rounds/' + state.round.id + (completedMode ? '#group-results' : '')
      );
      await link.click();
      await client.page.locator('.together-hero h1').waitFor();
      assert.equal(new URL(client.page.url()).pathname, '/play-together/rounds/' + state.round.id);
      await screenshot(client, completedMode ? 'completed-entry' : 'open');
    })
  );
  assert.equal(
    await clients[2].page.getByText(/You’re watching\. No entry has been charged\./).count(),
    1
  );
  if (!completedMode) {
    let lastHeartbeat = 0,
      common;
    const timeoutAt =
      Date.now() + Math.max(60000, initial[0].round.closesAt - initial[0].serverTime + 60000);
    while (Date.now() < timeoutAt) {
      const views = await revealViews();
      if (views.every((v) => v.phase === 'revealing' && v.mode === 'shared')) {
        const spread =
          Math.max(...views.map((v) => v.progress)) - Math.min(...views.map((v) => v.progress));
        assert(
          spread <= 0.2,
          'Shared reveal progress differs by more than network/polling tolerance'
        );
        common = { views, spread };
        break;
      }
      if (views.every((v) => v.phase === 'complete')) {
        // An unavailable visual clock deliberately shows the saved final. Verify
        // the actual server timeline before treating that fallback as a missed
        // reveal; a fresh response may still restore the common presentation.
        const current = await read(0, '/play-together/rounds/' + state.round.id);
        const ended =
          current.round.paidAt !== null && current.serverTime >= current.round.paidAt + 15000;
        assert(
          !ended,
          'The reveal ended before all viewers overlapped; retain evidence and investigate instead of creating another bet'
        );
      }
      if (Date.now() - lastHeartbeat >= 15000) {
        lastHeartbeat = Date.now();
        console.log('WAIT shared reveal: ' + views.map((v) => v.label + '=' + v.phase).join(', '));
      }
      await sleep(250);
    }
    assert(common, 'The shared reveal did not arrive within the expected settlement window');
    report.checks.push({
      action: 'Three live viewers overlap on the canonical shared reveal',
      ...common,
    });
    console.log('PASS three live viewers share the same reveal');
    await Promise.all(clients.map((client) => screenshot(client, 'shared-reveal')));
    // A normal reload reconnects the spectator. It must catch the common progress,
    // or the common final if navigation happens to cross the end of the reveal.
    await clients[2].page.reload({ waitUntil: 'domcontentloaded' });
    await clients[2].page.getByRole('heading', { name: 'The shared draw', exact: true }).waitFor();
    const caughtUp = await eventually(
      async () => {
        const views = await revealViews();
        assert(views.every((v) => v.phase === 'revealing' || v.phase === 'complete'));
        const spread =
          Math.max(...views.map((v) => v.progress)) - Math.min(...views.map((v) => v.progress));
        assert(spread <= 0.2);
        return { views, spread };
      },
      12000,
      'Reloaded spectator did not catch up'
    );
    report.checks.push({
      action: 'Spectator reload catches up without restarting the group',
      ...caughtUp,
    });
    report.sharedRevealObservedThisRun = true;
  } else {
    report.checks.push({
      action:
        'Existing completed round reopened; shared reveal timing is not re-tested in this mode',
    });
  }
  await eventually(
    async () => {
      const views = await revealViews();
      assert(views.every((v) => v.phase === 'complete' && v.mode === 'final' && v.progress === 1));
    },
    20000,
    'Common final did not become visible'
  );
  const finalSnapshots = await Promise.all(clients.map(pageSnapshot));
  const official = finalSnapshots[0].round;
  for (const snapshot of finalSnapshots) {
    assert(['PAID', 'REFUNDED'].includes(snapshot.round.state));
    assert.equal(snapshot.round.paidAt, official.paidAt);
    assert.deepEqual(snapshot.round.outcome, official.outcome);
    assert.deepEqual(snapshot.round.settlement, official.settlement);
  }
  const tables = await Promise.all(
    clients.map((client) => client.page.locator('.together-participants').innerText())
  );
  const normalized = tables.map((text) =>
    text.replaceAll(' · You', '').replaceAll(/\s+/g, ' ').trim()
  );
  assert.equal(normalized[0], normalized[1], 'Owner and member see different result tables');
  assert.equal(normalized[0], normalized[2], 'Spectator sees a different result table');
  report.checks.push({
    action:
      'All three accounts see identical saved outcome, paidAt, payouts and public result table',
    state: official.state,
  });
  for (const client of clients) {
    await client.page
      .getByRole('button', { name: 'Verify result and payouts', exact: true })
      .click();
    await client.page
      .getByText(/^Verified:.*result and payouts match\.$/)
      .waitFor({ timeout: 30000 });
    report.checks.push({ viewer: client.label, action: 'Actual signed result and payouts verify' });
  }
  await clients[0].page.getByRole('button', { name: 'Replay for me', exact: true }).click();
  assert.equal((await revealViews())[0].mode, 'personal');
  assert(
    (await revealViews()).slice(1).every((v) => v.mode === 'final'),
    'Personal replay changed another viewer'
  );
  await clients[0].page.getByRole('button', { name: 'Show final result', exact: true }).click();
  report.checks.push({ action: 'Personal replay affects only its viewer' });
  for (const client of clients) {
    await client.page.goto(site + '/groups/' + state.groups[0].id + '/games', {
      waitUntil: 'domcontentloaded',
    });
    const link = client.page.getByRole('link', { name: 'View group result', exact: false }).first();
    await link.waitFor();
    assert.equal(
      await link.getAttribute('href'),
      '/play-together/rounds/' + state.round.id + '#group-results'
    );
    await link.click();
    await client.page
      .getByRole('heading', { name: 'Group result and payouts', exact: true })
      .waitFor();
    assert.equal(new URL(client.page.url()).hash, '#group-results');
    for (const width of [1440, 390]) {
      await client.page.setViewportSize({ width, height: 900 });
      await screenshot(client, 'final');
    }
  }
  const spectatorResponse = await clients[2].context.request.get(site + '/api/v1/play-together/');
  assert.equal(spectatorResponse.status(), 200);
  const spectatorAfter = (await spectatorResponse.json()).data.balances;
  assert.deepEqual(
    spectatorAfter,
    spectatorBefore,
    'Viewing/reloading/replaying changed spectator balances'
  );
  report.checks.push({
    action: completedMode
      ? 'Spectator balances unchanged across viewing, replay and saved result reload'
      : 'Spectator balances unchanged across viewing, live reveal and result reload',
    balancesUnchanged: true,
  });
  assert.deepEqual(report.errors, [], 'JavaScript errors occurred');
  assert.deepEqual(report.serverErrors, [], 'Application API server errors occurred');
  assert.deepEqual(
    report.blockedMutations,
    [],
    'Read-only review attempted an application mutation'
  );
  for (const client of clients) {
    for (const cookie of await client.context.cookies(site))
      state.users[client.index].cookies[cookie.name] = cookie.value;
    await persistCookies(client.index);
  }
  report.completedAt = new Date().toISOString();
  console.log('SHARED_LIVE_BROWSER_COMPLETE ' + report.checks.length);
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
