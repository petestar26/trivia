// Authenticated practice-only acceptance on the existing Salem Bet deployment.
// Run setup once, then verify after the published deadlines. Repeating either
// command reuses the saved identities, publication receipts and entry receipts.
// This script never enables a game, changes settings, or funds real cash.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

const site = 'https://salem.bet';
const statePath = '/private/tmp/salem-eight-live-state.json';
const reportPath = '/private/tmp/salem-eight-live-report.json';
const proofModule = '/private/tmp/salem-group-live-proof.mjs';
const games = [
  {
    key: 'roulette_keno',
    selections: [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ],
  },
  {
    key: 'lucky_six',
    selections: [
      [1, 2, 3, 4, 5, 6],
      [7, 8, 9, 10, 11, 12],
    ],
  },
  { key: 'thunder_derby_3d', selections: [[1], [8]] },
  { key: 'neon_hounds_3d', selections: [[2], [7]] },
  {
    key: 'virtual_football_3d',
    selections: [
      [0, 1, 2],
      [2, 0, 1],
    ],
  },
  {
    key: 'blackjack',
    selections: [
      [0, 1, 2, 0, 1, 2],
      [2, 0, 1, 2, 0, 1],
    ],
  },
  { key: 'sky_crash', selections: [[101], [200]] },
  { key: 'crash_point', selections: [[150], [250]] },
];
const terminal = (round) => ['PAID', 'REFUNDED'].includes(round.state);
let state;

async function save() {
  // Atomic replacement prevents a process interruption from truncating the
  // only record of an already published round or already confirmed entry.
  const temporary = statePath + '.next';
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}

async function check(name) {
  if (!state.checks.includes(name)) state.checks.push(name);
  await save();
  console.log('PASS ' + name);
}

async function request(index, path, method = 'GET', body, expected = [200]) {
  assert(path.startsWith('/') && !path.includes('://'), 'Only relative application paths allowed');
  const user = index === null ? null : state.users[index];
  const headers = { Origin: site, Accept: 'application/json' };
  if (user?.cookies)
    headers.Cookie = Object.entries(user.cookies)
      .map(([key, value]) => key + '=' + value)
      .join('; ');
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  // Entry endpoints allow 30 requests/minute. Pace confirmations and retries
  // across both QA sessions, including after a resumed command.
  if (method === 'POST' && path.endsWith('/entries')) {
    const delay = Math.max(0, (state.lastEntryRequestAt ?? 0) + 2300 - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    state.lastEntryRequestAt = Date.now();
    await save();
  }
  const response = await fetch(site + '/api/v1' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (user) {
    user.cookies ??= {};
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      if (separator > 0) user.cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  await save();
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error(`${method} ${path}: non-JSON response (${response.status})`);
  }
  assert(
    expected.includes(response.status),
    `${method} ${path}: unexpected status ${response.status}`
  );
  return { status: response.status, data: result.data ?? result };
}
const call = async (...args) => (await request(...args)).data;
const lobby = (index) => call(index, '/play-together/');
const snapshot = (index, id) => call(index, '/play-together/rounds/' + id);
const publication = (groupId, game, requestId, currency = 'GAME_POINTS') => ({
  groupId,
  game,
  requestId,
  currency,
  entryAmount: 100,
  minPlayers: 2,
  maxPlayers: 4,
  lobbySeconds: 120,
});
const enter = (index, round, selection, requestId) =>
  call(index, '/play-together/rounds/' + round.id + '/entries', 'POST', {
    requestId,
    termsHash: round.termsHash,
    selection,
  });

async function ensureSession(index, allowRegister) {
  let user = state.users[index];
  if (!user) {
    assert(allowRegister, 'Run setup before verify');
    const username = `qa_eight_${state.suffix}_${index}`;
    user = state.users[index] = {
      username,
      email: username + '@example.invalid',
      password: 'Qa9!' + randomBytes(24).toString('base64url'),
      cookies: {},
    };
    await save();
  }
  assert.equal(user.username, `qa_eight_${state.suffix}_${index}`);
  assert.equal(user.email, user.username + '@example.invalid');
  assert.equal(typeof user.password, 'string', 'QA credentials have already been retired');
  if (user.id) {
    const current = await request(index, '/auth/me', 'GET', undefined, [200, 401]);
    if (current.status === 200) {
      assert.equal(current.data.user.id, user.id);
      return;
    }
  }
  if (user.id || user.registrationStarted) {
    const login = await request(
      index,
      '/auth/login',
      'POST',
      {
        email: user.email,
        password: user.password,
      },
      [200, 401]
    );
    if (login.status === 200) {
      if (user.id) assert.equal(login.data.user.id, user.id);
      user.id = login.data.user.id;
      await save();
      return;
    }
    assert(!user.id, 'Existing QA session could not be renewed');
  }
  assert(allowRegister, 'QA account registration is incomplete');
  user.registrationStarted = true;
  await save();
  const registered = await request(
    index,
    '/auth/register',
    'POST',
    {
      username: user.username,
      email: user.email,
      password: user.password,
      displayName: `Game release check ${index + 1}`,
    },
    [201, 409]
  );
  // A previous request may have committed while its response was lost.
  const result =
    registered.status === 201
      ? registered.data
      : await call(index, '/auth/login', 'POST', { email: user.email, password: user.password });
  user.id = result.user.id;
  await save();
}

async function setup() {
  await call(null, '/play-together/', 'GET', undefined, [401]);
  for (let index = 0; index < 2; index++) {
    await ensureSession(index, true);
    let current = await lobby(index);
    assert.equal(current.cashAvailable, false);
    assert.equal(current.settings.cashEnabled, false);
    assert.equal(current.settings.practiceEnabled, true);
    assert.equal(current.workerReady, true);
    assert.equal(current.balances.cashAvailable, 0);
    for (const game of games)
      assert(current.settings.enabledGames.includes(game.key), game.key + ' is disabled');
    await call(index, '/play-together/admin/settings', 'GET', undefined, [403]);
    if (!state.users[index].refilled) {
      await call(index, '/play-together/practice-points', 'POST');
      current = await lobby(index);
      assert.equal(current.balances.pointsAvailable, 10000);
      assert.equal(current.balances.pointsReserved, 0);
      state.users[index].refilled = true;
      state.users[index].initialPoints = 10000;
      await save();
    }
  }
  await check(
    'Eight modes accept ordinary active members; cash and administrator access remain disabled'
  );

  // Finish membership setup before the first timed round starts.
  for (let index = 0; index < games.length; index++) {
    const group = (state.groups[index] ??= {
      name: `Eight-game check ${state.suffix} ${index + 1}`,
    });
    if (!group.id) {
      const matches = (await lobby(0)).groups.filter(
        (g) => g.name === group.name && g.ownerId === state.users[0].id
      );
      assert(matches.length <= 1, 'Ambiguous QA group identity');
      if (matches.length) group.id = matches[0].id;
      else {
        assert(
          !group.createStarted,
          'Prior group creation is uncertain; inspect it before retrying'
        );
        group.createStarted = true;
        await save();
        const created = await call(
          0,
          '/groups/',
          'POST',
          {
            name: group.name,
            description: 'Private release check with free practice points only.',
            isPrivate: false,
          },
          [201]
        );
        assert.equal(created.ownerId, state.users[0].id);
        group.id = created.id;
      }
      await save();
    }
    const membership = await call(1, '/groups/' + group.id);
    if (!membership.isMember) {
      assert.equal(
        membership.isPrivate,
        false,
        'QA peer must join before the group becomes private'
      );
      await call(1, '/groups/' + group.id + '/join', 'POST');
    }
    await call(0, '/groups/' + group.id, 'PUT', { isPrivate: true });
    const joined = await call(1, '/groups/' + group.id);
    assert.equal(joined.isMember, true);
    assert.equal(joined.isPrivate, true);
    assert.equal(joined.memberCount, 2, 'Only the two QA accounts may participate');
    group.private = true;
    await save();
  }

  if (!state.denialsChecked) {
    await call(
      0,
      '/play-together/rounds',
      'POST',
      publication(state.groups[0].id, games[0].key, randomUUID(), 'ETB'),
      [403]
    );
    await call(
      1,
      '/play-together/rounds',
      'POST',
      publication(state.groups[0].id, games[0].key, randomUUID()),
      [403]
    );
    state.denialsChecked = true;
    await check('Real-Birr publication is refused; a member cannot publish the owner’s round');
  }
  for (let index = 0; index < games.length; index++) {
    const game = games[index];
    const saved = (state.rounds[game.key] ??= {
      groupId: state.groups[index].id,
      publishRequestId: randomUUID(),
      entryRequestIds: [randomUUID(), randomUUID()],
      selections: game.selections,
      receipts: [],
    });
    await save();
    const published = await call(
      0,
      '/play-together/rounds',
      'POST',
      publication(saved.groupId, game.key, saved.publishRequestId)
    );
    if (saved.id) assert.equal(published.roundId, saved.id);
    saved.id = published.roundId;
    await save();
    let current = await snapshot(0, saved.id);
    if (!saved.termsHash) {
      assert.equal(current.round.entries.length, 0, 'Publication must not place an entry');
      saved.termsHash = current.round.termsHash;
      saved.publishedEmpty = true;
      await save();
    }
    assert.equal(current.round.termsHash, saved.termsHash);
    if (saved.confirmed) continue;
    assert.equal(
      current.round.state,
      'OPEN',
      'Incomplete QA setup expired; do not create a replacement silently'
    );
    assert(current.serverTime < current.round.closesAt, 'QA entry deadline already closed');
    for (let user = 0; user < 2; user++) {
      const receipt = await enter(
        user,
        current.round,
        game.selections[user],
        saved.entryRequestIds[user]
      );
      assert.equal(receipt.accepted, true, 'Each player must explicitly confirm');
      if (saved.receipts[user]) assert.deepEqual(receipt, saved.receipts[user]);
      saved.receipts[user] = receipt;
      await save();
      const beforeRetry = await snapshot(user, saved.id);
      const own = beforeRetry.round.entries.filter(
        (entry) => entry.userId === state.users[user].id
      );
      assert.equal(own.length, 1);
      assert.deepEqual(own[0].selection, game.selections[user]);
      assert.deepEqual(
        await enter(user, current.round, game.selections[user], saved.entryRequestIds[user]),
        receipt
      );
      const afterRetry = await snapshot(user, saved.id);
      const repeated = afterRetry.round.entries.filter(
        (entry) => entry.userId === state.users[user].id
      );
      assert.equal(repeated.length, 1);
      assert.equal(repeated[0].walletTransactionId, own[0].walletTransactionId);
      // Earlier rounds may settle while later ones are being prepared. The
      // final all-round reconciliation checks the exact total deductions;
      // comparing these two global balances could mistake a valid payout
      // from another round for an effect of this duplicate confirmation.
      const peerView = await snapshot(1 - user, saved.id);
      assert.equal(
        peerView.round.entries.find((entry) => entry.userId === state.users[user].id).selection,
        null
      );
      assert.equal(peerView.round.proof, null);
      if (user === 0)
        assert.equal(
          peerView.round.entries.some((entry) => entry.userId === state.users[1].id),
          false
        );
    }
    current = await snapshot(0, saved.id);
    assert.equal(current.round.entries.length, 2);
    assert(current.round.entries.every((entry) => entry.state === 'ACCEPTED'));
    saved.confirmed = true;
    saved.openSnapshot = current;
    await check(game.key + ': independent consent, sealed picks and duplicate protection');
  }
  state.setupComplete = true;
  await save();
  console.log('SETUP_COMPLETE: eight normal 120-second rounds; run verify after their deadlines.');
}

async function verify() {
  assert(state.setupComplete, 'Finish setup before verification');
  for (let index = 0; index < 2; index++) await ensureSession(index, false);
  const snapshots = {};
  for (const game of games) snapshots[game.key] = await snapshot(0, state.rounds[game.key].id);
  const pending = Object.entries(snapshots).filter(([, value]) => !terminal(value.round));
  if (pending.length) {
    console.log(
      JSON.stringify({
        complete: false,
        pending: pending.map(([game, value]) => ({
          game,
          state: value.round.state,
          remainingSeconds: Math.max(
            0,
            Math.ceil((value.round.closesAt - value.serverTime) / 1000)
          ),
        })),
      })
    );
    return;
  }
  const { verifyTogetherRound } = await import(proofModule);
  let totalFees = 0;
  const expectedPoints = [10000, 10000];
  for (const game of games) {
    const saved = state.rounds[game.key],
      round = snapshots[game.key].round;
    assert.equal(round.termsHash, saved.termsHash);
    assert.equal(round.currency, 'GAME_POINTS');
    assert.equal(round.entryAmount, 100);
    assert.equal(round.entries.length, 2);
    assert.equal(round.settlement.funded, 200);
    assert.equal(
      round.settlement.payouts.reduce((sum, payout) => sum + payout.amount, 0) +
        round.settlement.platformFee,
      200
    );
    assert.match(await verifyTogetherRound(round, saved.termsHash), /^Verified:/);
    totalFees += round.settlement.platformFee;
    for (let user = 0; user < 2; user++) {
      const entry = round.entries.find((candidate) => candidate.userId === state.users[user].id);
      assert(entry, 'Both confirmed members must be in the completed receipt');
      assert.equal(entry.id, saved.receipts[user].entryId);
      assert.deepEqual(entry.selection, game.selections[user]);
      expectedPoints[user] += entry.payout - 100;
    }
    if (!saved.postSettlementReplayChecked) {
      const before = (await lobby(0)).balances;
      assert.deepEqual(
        await enter(0, round, game.selections[0], saved.entryRequestIds[0]),
        saved.receipts[0]
      );
      saved.lateRequestId ??= randomUUID();
      await save();
      const late = await enter(0, round, game.selections[0], saved.lateRequestId);
      assert.equal(late.accepted, false);
      assert.deepEqual((await lobby(0)).balances, before);
      assert.deepEqual((await snapshot(0, round.id)).round, round);
      saved.postSettlementReplayChecked = true;
    }
    saved.finalSnapshot = snapshots[game.key];
    await check(
      game.key + ': signed result, payout or refund, fixed receipts and closed-round replay'
    );
  }
  const finalBalances = [];
  for (let user = 0; user < 2; user++) {
    const current = await lobby(user);
    assert.equal(current.cashAvailable, false);
    assert.equal(current.settings.cashEnabled, false);
    assert.equal(current.balances.cashAvailable, 0);
    assert.equal(current.balances.cashReserved, 0);
    assert.equal(current.balances.pointsReserved, 0);
    assert.equal(current.balances.pointsAvailable, expectedPoints[user]);
    finalBalances.push(current.balances);
  }
  assert.equal(
    finalBalances.reduce((sum, balance) => sum + balance.pointsAvailable, 0) + totalFees,
    20000
  );
  await check('All eight pools reconcile exactly; all holds released and real cash untouched');
  state.completedAt ??= new Date().toISOString();
  await save();
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        source: site,
        completedAt: state.completedAt,
        practiceOnly: true,
        checks: state.checks,
        initialPoints: 20000,
        totalFees,
        finalBalances,
        groups: state.groups.map((group) => group.id),
        rounds: Object.fromEntries(games.map((game) => [game.key, snapshots[game.key].round])),
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  console.log('EIGHT_GAME_LIVE_CHECK_COMPLETE');
}

try {
  assert.equal(
    process.env.TOGETHER_LIVE_ACK,
    'practice-release',
    'Explicit practice-release acknowledgement required'
  );
  assert(['setup', 'verify'].includes(process.argv[2]), 'Use setup or verify');
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = {
      version: 1,
      site,
      suffix: randomBytes(5).toString('hex'),
      users: [],
      groups: [],
      rounds: {},
      checks: [],
    };
  }
  assert.equal(state.site, site);
  assert.equal(state.version, 1);
  assert(/^[a-f0-9]{10}$/.test(state.suffix), 'Unexpected QA identity suffix');
  if (process.argv[2] === 'setup') await setup();
  else await verify();
} catch (error) {
  // Never serialize request headers, cookies, passwords, or full response bodies.
  console.error(error.message);
  process.exitCode = 1;
}
