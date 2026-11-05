// Authenticated practice-only acceptance on the existing Salem Bet deployment.
// Run setup once, start the shared browser check, then verify after the deadline. Repeating either
// command reuses the saved identities, publication receipts and entry receipts.
// This script never enables a game, changes settings, or funds real cash.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';

const site = 'https://salem.bet';
const statePath = '/private/tmp/salem-shared-live-state.json';
const reportPath = '/private/tmp/salem-shared-live-report.json';
const proofModule = '/private/tmp/salem-group-live-proof.mjs';
// The public achievement API intentionally omits definition IDs. A read-only
// database lookup supplies this one nonsecret definition when an award exists.
const achievementDefinitionPath = '/private/tmp/salem-eight-achievement-definition.json';
const games = [
  {
    key: 'roulette_keno',
    selections: [
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ],
  },
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
  }).catch((error) => {
    throw new Error(`${method} ${path}: ${error.message}`);
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
  return { status: response.status, data: result.data ?? result, meta: result.meta };
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
    const username = `qa_shared_${state.suffix}_${index}`;
    user = state.users[index] = {
      username,
      email: username + '@example.invalid',
      password: 'Qa9!' + randomBytes(24).toString('base64url'),
      cookies: {},
    };
    await save();
  }
  assert.equal(user.username, `qa_shared_${state.suffix}_${index}`);
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

async function pointJournal(user) {
  const rows = [];
  let total, pages;
  for (let page = 1; page <= (pages ?? 1); page++) {
    const result = await request(
      user,
      '/wallet/transactions?currency=gamePoints&limit=100&page=' + page
    );
    assert(Array.isArray(result.data), 'Wallet journal must contain transaction rows');
    assert.equal(result.meta?.page, page);
    assert(
      Number.isInteger(result.meta.total) && result.meta.total >= 0 && result.meta.total <= 1000,
      'Unexpected QA journal size; investigate before continuing'
    );
    assert.equal(result.meta.totalPages, Math.ceil(result.meta.total / 100));
    if (total !== undefined)
      assert.equal(result.meta.total, total, 'Journal changed during pagination');
    total = result.meta.total;
    pages = result.meta.totalPages;
    rows.push(...result.data);
  }
  assert.equal(rows.length, total, 'Complete wallet journal required');
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'Duplicate journal rows');
  for (const row of rows) {
    assert.equal(row.currency, 'GAME_POINTS');
    assert(
      ['GAME_POINT_CREDIT', 'GAME_POINT_DEBIT'].includes(row.type),
      'Unexpected practice transaction type'
    );
    assert(Number.isSafeInteger(row.amount) && row.amount > 0);
    assert(Number.isSafeInteger(row.balanceBefore) && row.balanceBefore >= 0);
    assert(Number.isSafeInteger(row.balanceAfter) && row.balanceAfter >= 0);
    assert.equal(
      row.balanceAfter - row.balanceBefore,
      row.type === 'GAME_POINT_CREDIT' ? row.amount : -row.amount,
      'Journal balance change must equal its recorded amount'
    );
  }
  return rows;
}

async function setup() {
  await call(null, '/play-together/', 'GET', undefined, [401]);
  for (let index = 0; index < 3; index++) {
    await ensureSession(index, true);
    const current = await lobby(index);
    assert.equal(current.cashAvailable, false);
    assert.equal(current.settings.cashEnabled, false);
    assert.equal(current.workerReady, true);
    assert.equal(current.balances.cashAvailable, 0);
    assert(current.settings.enabledGames.includes('roulette_keno'));
    if (state.users[index].initialPoints === undefined) {
      assert.equal(current.balances.pointsReserved, 0);
      assert(
        current.balances.pointsAvailable === 0 ||
          (index < 2 && current.balances.pointsAvailable === 10000),
        'Unexpected initial QA balance; investigate before funding'
      );
      if (index < 2) await call(index, '/play-together/practice-points', 'POST');
      const funded = await lobby(index);
      assert.equal(funded.balances.pointsAvailable, index < 2 ? 10000 : 0);
      assert.equal(funded.balances.pointsReserved, 0);
      state.users[index].initialPoints = index < 2 ? 10000 : 0;
      await save();
    }
  }
  const group = (state.groups[0] ??= { name: `Shared viewing check ${state.suffix}` });
  if (!group.id) {
    const matches = (await lobby(0)).groups.filter(
      (g) => g.name === group.name && g.ownerId === state.users[0].id
    );
    assert(matches.length <= 1);
    if (matches.length) group.id = matches[0].id;
    else {
      assert(!group.createStarted, 'Prior QA group creation is uncertain; inspect before retrying');
      group.createStarted = true;
      await save();
      const created = await call(
        0,
        '/groups/',
        'POST',
        {
          name: group.name,
          description: 'Private shared-viewing release check using free practice points.',
          isPrivate: false,
        },
        [201]
      );
      assert.equal(created.ownerId, state.users[0].id);
      group.id = created.id;
    }
    await save();
  }
  for (let user = 1; user < 3; user++) {
    const member = await call(user, '/groups/' + group.id);
    if (!member.isMember) {
      assert.equal(member.isPrivate, false, 'Join QA members before making group private');
      await call(user, '/groups/' + group.id + '/join', 'POST');
    }
  }
  await call(0, '/groups/' + group.id, 'PUT', { isPrivate: true });
  const joined = await call(2, '/groups/' + group.id);
  assert.equal(joined.isMember, true);
  assert.equal(joined.isPrivate, true);
  assert.equal(joined.memberCount, 3);
  state.round ??= {
    game: 'roulette_keno',
    publishRequestId: randomUUID(),
    entryRequestIds: [randomUUID(), randomUUID()],
    receipts: [],
  };
  await save();
  const created = await call(
    0,
    '/play-together/rounds',
    'POST',
    publication(group.id, 'roulette_keno', state.round.publishRequestId)
  );
  if (state.round.id) assert.equal(created.roundId, state.round.id);
  state.round.id = created.roundId;
  await save();
  let current = await snapshot(0, state.round.id);
  if (!state.round.termsHash) {
    assert.equal(current.round.entries.length, 0);
    state.round.termsHash = current.round.termsHash;
    await save();
  }
  assert.equal(current.round.termsHash, state.round.termsHash);
  if (!state.setupComplete) {
    assert.equal(
      current.round.state,
      'OPEN',
      'Incomplete QA setup expired; do not silently replace the round'
    );
    assert(current.serverTime < current.round.closesAt);
    for (let user = 0; user < 2; user++) {
      const receipt = await enter(
        user,
        current.round,
        games[0].selections[user],
        state.round.entryRequestIds[user]
      );
      assert.equal(receipt.accepted, true);
      if (state.round.receipts[user]) assert.deepEqual(receipt, state.round.receipts[user]);
      state.round.receipts[user] = receipt;
      await save();
    }
    const views = [],
      activity = [];
    for (let user = 0; user < 3; user++) {
      views.push(await snapshot(user, state.round.id));
      activity.push(await call(user, '/play-together/groups/' + group.id + '/activity'));
    }
    assert(views.every((view) => view.round.state === 'OPEN'));
    for (let user = 0; user < 3; user++) {
      assert.deepEqual(activity[user].activeRound, activity[0].activeRound);
      assert.equal(activity[user].latestResult, null);
      assert.equal(activity[user].activeRound.id, state.round.id);
      assert.equal(activity[user].activeRound.participants, 2);
      assert.equal(views[user].round.entries.length, 2);
      for (const entry of views[user].round.entries) {
        if (entry.userId !== state.users[user].id) {
          assert.equal(entry.selection, null);
          assert.equal(entry.walletTransactionId, '');
        }
      }
      assert.equal(views[user].round.proof, null);
      assert.equal(views[user].round.outcome, null);
    }
    assert.equal(
      views[2].round.entries.some((entry) => entry.userId === state.users[2].id),
      false
    );
    assert.equal(views[2].balances.pointsReserved, 0);
    state.round.openSnapshots = views;
    state.round.openActivity = activity;
    state.setupComplete = true;
    await check(
      'Owner, member and unentered spectator discover the same open round; other picks remain sealed'
    );
  }
  console.log(
    JSON.stringify({
      ready: true,
      roundId: state.round.id,
      closesAt: current.round.closesAt,
      remainingSeconds: Math.max(
        0,
        Math.ceil((current.round.closesAt - current.serverTime) / 1000)
      ),
      spectatorEntered: false,
    })
  );
}

async function reconcile(user, view) {
  const rows = await pointJournal(user),
    matched = new Set();
  const refills = rows.filter(
    (row) =>
      row.referenceType === 'GAME' &&
      /^together-practice:\d{4}-\d{2}-\d{2}$/.test(row.referenceId ?? '')
  );
  assert.equal(refills.length, user < 2 ? 1 : 0, 'The spectator must not require practice funding');
  if (user < 2) {
    const refill = refills[0];
    assert.equal(refill.type, 'GAME_POINT_CREDIT');
    assert.equal(refill.amount, 10000);
    assert.equal(refill.balanceBefore, 0);
    assert.equal(refill.balanceAfter, 10000);
    matched.add(refill.id);
  }
  const own = view.round.entries.filter((entry) => entry.userId === state.users[user].id);
  assert.equal(own.length, user < 2 ? 1 : 0, 'Viewing must never create a spectator entry');
  let gameNet = 0;
  if (own.length) {
    const entry = own[0];
    assert.equal(entry.id, state.round.receipts[user].entryId);
    const hold = rows.find((row) => row.id === entry.walletTransactionId);
    assert(hold);
    assert.equal(hold.type, 'GAME_POINT_DEBIT');
    assert.equal(hold.referenceType, 'GAME');
    assert.equal(hold.referenceId, entry.id);
    assert.equal(hold.amount, 100);
    matched.add(hold.id);
    gameNet = entry.payout - 100;
    if (entry.payout > 0) {
      const credit = rows.find((row) => row.id === entry.payoutTransactionId);
      assert(credit);
      assert.equal(credit.type, 'GAME_POINT_CREDIT');
      assert.equal(credit.referenceType, 'GAME');
      assert.equal(credit.referenceId, entry.id);
      assert.equal(credit.amount, entry.payout);
      matched.add(credit.id);
    } else assert.equal(entry.payoutTransactionId, null);
  }
  const remaining = rows.filter((row) => !matched.has(row.id));
  assert(remaining.length <= 1, 'Unexplained or duplicated wallet activity');
  const awards = (await call(user, '/achievements/')).filter((item) => item.key === 'first_group');
  assert.equal(awards.length, remaining.length);
  const externalAwards = [];
  if (remaining.length) {
    const definition = JSON.parse(await readFile(achievementDefinitionPath, 'utf8'));
    assert.equal(definition.key, 'first_group');
    assert.equal(definition.gamePointReward, 20);
    const award = remaining[0];
    assert.equal(award.referenceType, 'ACHIEVEMENT');
    assert.equal(award.referenceId, definition.id);
    assert.equal(award.type, 'GAME_POINT_CREDIT');
    assert.equal(award.amount, 20);
    assert.equal(award.description, 'ACHIEVEMENT reward');
    assert(Number.isFinite(Date.parse(award.createdAt)));
    assert(Number.isFinite(Date.parse(awards[0].unlockedAt)));
    externalAwards.push({
      userId: state.users[user].id,
      key: definition.key,
      achievementId: definition.id,
      transactionId: award.id,
      amount: 20,
      createdAt: award.createdAt,
      unlockedAt: awards[0].unlockedAt,
    });
    matched.add(award.id);
  }
  assert.equal(matched.size, rows.length);
  const expected =
    state.users[user].initialPoints +
    gameNet +
    externalAwards.reduce((sum, row) => sum + row.amount, 0);
  const sum = rows.reduce(
    (balance, row) => balance + (row.type === 'GAME_POINT_CREDIT' ? row.amount : -row.amount),
    0
  );
  assert.equal(sum, expected);
  assert.equal(view.balances.pointsAvailable, expected);
  assert.equal(view.balances.pointsReserved, 0);
  assert.equal(view.balances.cashAvailable, 0);
  assert.equal(view.balances.cashReserved, 0);
  return {
    userId: state.users[user].id,
    role: user === 0 ? 'owner' : user === 1 ? 'player' : 'spectator',
    gameNet,
    expected,
    externalAwards,
    transactionIds: rows.map((row) => row.id),
  };
}

async function verify() {
  assert(state.setupComplete, 'Complete setup first');
  for (let user = 0; user < 3; user++) await ensureSession(user, false);
  const views = [];
  for (let user = 0; user < 3; user++) views.push(await snapshot(user, state.round.id));
  if (!views.every((view) => terminal(view.round))) {
    console.log(JSON.stringify({ complete: false, states: views.map((view) => view.round.state) }));
    return;
  }
  const { verifyTogetherRound } = await import(proofModule);
  const round = views[0].round;
  assert.equal(round.settlement.funded, 200);
  assert.equal(
    round.settlement.payouts.reduce((sum, p) => sum + p.amount, 0) + round.settlement.platformFee,
    200
  );
  const activities = [];
  for (let user = 0; user < 3; user++) {
    const view = views[user];
    assert.equal(view.round.entries.length, 2);
    for (const field of [
      'id',
      'game',
      'state',
      'termsHash',
      'rosterHash',
      'outcome',
      'ranking',
      'settlement',
      'proof',
      'paidAt',
    ])
      assert.deepEqual(view.round[field], round[field]);
    assert.match(await verifyTogetherRound(view.round, state.round.termsHash), /^Verified:/);
    const activity = await call(user, '/play-together/groups/' + state.groups[0].id + '/activity');
    assert.equal(activity.activeRound, null);
    assert.equal(activity.latestResult.id, state.round.id);
    if (user) assert.deepEqual(activity.latestResult, activities[0].latestResult);
    activities.push(activity);
  }
  assert.equal(
    round.entries.some((entry) => entry.userId === state.users[2].id),
    false
  );
  const reconciliation = [];
  for (let user = 0; user < 3; user++) reconciliation.push(await reconcile(user, views[user]));
  assert.equal(reconciliation[2].gameNet, 0);
  const externalAwards = reconciliation.flatMap((result) => result.externalAwards);
  const totalAwards = externalAwards.reduce((sum, award) => sum + award.amount, 0);
  assert.equal(
    views.reduce((sum, view) => sum + view.balances.pointsAvailable, 0) +
      round.settlement.platformFee,
    20000 + totalAwards
  );
  await check(
    'All three members receive the identical signed outcome, payouts and immutable shared-reveal time'
  );
  await check(
    'Spectator has no game debit, credit, hold or entry; first-group awards are reconciled separately'
  );
  state.round.finalSnapshots = views;
  state.round.finalActivity = activities;
  state.completedAt ??= new Date().toISOString();
  await save();
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        completedAt: state.completedAt,
        site,
        practiceOnly: true,
        checks: state.checks,
        users: state.users.map((user) => ({ id: user.id, username: user.username })),
        groups: state.groups.map((group) => group.id),
        roundId: round.id,
        paidAt: round.paidAt,
        sharedRevealStartsAt: round.paidAt + 3000,
        sharedRevealEndsAt: round.paidAt + 15000,
        round: views[0].round,
        reconciliation,
        externalAwards,
        totalAwards,
        fee: round.settlement.platformFee,
        finalBalances: views.map((view) => view.balances),
      },
      null,
      2
    ) + '\n',
    { mode: 0o600 }
  );
  console.log('SHARED_GROUP_LIVE_CHECK_COMPLETE');
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
      round: null,
      checks: [],
    };
  }
  assert.equal(state.site, site);
  assert.equal(state.version, 1);
  assert(/^[a-f0-9]{10}$/.test(state.suffix));
  if (process.argv[2] === 'setup') await setup();
  else await verify();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
