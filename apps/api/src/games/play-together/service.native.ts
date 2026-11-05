import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { prisma } from '@socialplay/database';
import {
  TOGETHER_GAMES,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherSeedCommitment,
  togetherTermsHash,
  quicknetTargetForCutoff,
  deriveTogetherOutcome,
  rankTogether,
  type TogetherTerms,
  type TogetherCurrency,
  type TogetherGame,
} from '@socialplay/shared';
import { createTogetherService } from './service.js';
import { createGroupPvpService } from '../group-pvp/service.js';
import { round, entries, tickets, execute, type Tx } from './store.js';
import { applyBalanceChanges, getOrCreateWallet } from '../../economy/wallet-service.js';
import { creditCoins, reserveTogetherCash } from '../../economy/coin-ledger-service.js';
import { runLedgerInvariantCheck } from '../../economy/ledger-invariant-checker.js';
import {
  mintTestPurchasedCoins,
  nextTestCountryCode,
  activateTestWithdrawalPolicy,
} from '../../test/financial-policy-fixtures.js';
import { createSportsWallet } from '../../providers/softaggregator/sports-wallet.js';
import { SPORTS_GAME_ID } from '../../providers/softaggregator/sports-config.js';

// These tests exercise real PostgreSQL constraints and real wallet journals.
// Only external randomness is synthetic; cryptographic verification has its
// own unmocked contract tests. There is no production verification bypass.
vi.mock('../economics/round-entropy.js', async () => {
  const original = await vi.importActual<typeof import('../economics/round-entropy.js')>(
    '../economics/round-entropy.js'
  );
  return {
    ...original,
    verifyQuicknetBeacon: async (
      cutoff: number | Date,
      raw: { round: number; signature: string }
    ) => {
      expect(raw.round).toBe(quicknetTargetForCutoff(cutoff).beaconRound);
      expect(raw.signature).toBe('native-synthetic-beacon');
      return {};
    },
  };
});
const source = process.env.DATABASE_URL;
const url = source ? new URL(source) : null;
if (
  !url ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.searchParams.has('host') ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged disposable local database required');
const env = { PLAY_TOGETHER_CASH_ENABLED: 'true' };
const beacon = (cutoff: number) => ({
  round: quicknetTargetForCutoff(cutoff).beaconRound,
  signature: 'native-synthetic-beacon',
  randomness: 'cd'.repeat(32),
});
const service = createTogetherService(prisma, {
  env,
  workerReady: () => true,
  fetchBeacon: async (cutoff) => beacon(cutoff),
});
let adminId: string, countryId: string, countryCode: string, methodId: string, policyId: string;
beforeAll(async () => {
  const admin = await prisma.user.create({
    data: { username: 'together_admin_' + randomUUID(), role: 'ADMIN' },
  });
  adminId = admin.id;
  const country = await prisma.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Disposable group country',
      currencyCode: 'ETB',
      isActive: true,
    },
  });
  countryId = country.id;
  countryCode = country.code;
  const method = await prisma.paymentMethodDefinition.create({
    data: {
      countryId,
      type: 'BANK_TRANSFER',
      name: 'Group fixture',
      fieldSchema: {},
      isActive: true,
    },
  });
  methodId = method.id;
  await activateTestWithdrawalPolicy(countryId, adminId);
  policyId = (await prisma.countryCasinoPolicy.findFirstOrThrow({ where: { countryCode } })).id;
  const scan = await runLedgerInvariantCheck();
  expect(scan.passed, JSON.stringify(scan.violations)).toBe(true);
  for (const key of ['CASINO_PLAY', 'GROUP_PLAY', 'SPORTSBOOK_PLAY'])
    await prisma.platformGate.update({
      where: { key },
      data: { enabled: true, lastInvariantRunId: scan.runId },
    });
  const s = await service.settings(adminId);
  await service.settings(adminId, {
    ...s,
    cashEnabled: true,
    publicRoomsEnabled: true,
    enabledGames: TOGETHER_GAMES.map((g) => g.key),
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});
async function fixture(
  currency: TogetherCurrency = 'ETB',
  short = false,
  cash = 10000,
  game: TogetherGame = 'number_challenge'
) {
  const users: string[] = [];
  for (let i = 0; i < 3; i++) {
    const user = await prisma.user.create({ data: { username: 'together_' + randomUUID() } });
    await prisma.userPayoutAccount.create({
      data: { userId: user.id, countryId, methodDefId: methodId, accountDetails: {} },
    });
    if (cash) await mintTestPurchasedCoins(user.id, cash);
    await getOrCreateWallet(user.id);
    await prisma.$transaction((tx) =>
      applyBalanceChanges(tx, user.id, [
        {
          currency: 'GAME_POINTS',
          amount: 10000,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'ADMIN',
          description: 'Disposable group practice fixture',
        },
      ])
    );
    users.push(user.id);
  }
  const group = await prisma.group.create({
    data: {
      ownerId: users[0],
      name: 'Disposable group',
      isPrivate: true,
      members: {
        create: users.map((userId, i) => ({
          userId,
          role: i ? ('MEMBER' as const) : ('OWNER' as const),
        })),
      },
    },
  });
  let roundId: string;
  if (!short)
    roundId = await service.create(users[0], {
      groupId: group.id,
      game,
      currency,
      entryAmount: 1000,
      minPlayers: 2,
      maxPlayers: 20,
      lobbySeconds: 120,
      requestId: randomUUID(),
    });
  else {
    const s = await service.settings(adminId),
      id = randomUUID(),
      seed = randomBytes(32).toString('hex');
    const closesAt = Date.now() + 1500;
    const t: TogetherTerms = {
      id,
      groupId: group.id,
      game,
      currency,
      entryAmount: 1000,
      feeBps: 700,
      settingsVersion: s.version,
      minPlayers: 2,
      maxPlayers: 20,
      closesAt,
      rulesId: TOGETHER_RULES_ID,
      feePolicy: TOGETHER_FEE_POLICY,
      seedCommitment: togetherSeedCommitment(id, seed),
      beaconRound: quicknetTargetForCutoff(closesAt).beaconRound,
    };
    await prisma.$transaction((tx) =>
      execute(
        tx,
        'INSERT INTO play_together_rounds(id,group_id,creator_id,request_id,request_hash,game,currency,entry_amount,fee_bps,policy_version,rules_id,min_players,max_players,closes_at,recovery_deadline,seed,seed_commitment,terms_hash,beacon_round) VALUES($1,$2,$3,$4,$5,$6,$7,1000,700,$8,$9,2,20,$10,$11,$12,$13,$14,$15)',
        id,
        group.id,
        users[0],
        randomUUID(),
        'a'.repeat(64),
        game,
        currency,
        s.version,
        TOGETHER_RULES_ID,
        new Date(closesAt),
        new Date(closesAt + 600000),
        seed,
        t.seedCommitment,
        togetherTermsHash(t),
        t.beaconRound
      )
    );
    roundId = id;
  }
  const snapshot = await service.snapshot(users[0], roundId);
  const stored = await prisma.$transaction((tx) => round(tx, roundId, false));
  const proof = { seed: stored.seed, beacon: beacon(snapshot.round.closesAt) };
  const target = deriveTogetherOutcome(
    snapshot.round,
    [
      { id: 'a', userId: users[0], selection: [1] },
      { id: 'b', userId: users[1], selection: [1] },
    ],
    proof
  ).numbers[0];
  const confirm = (
    index: number,
    selection = [index ? (target === 100 ? 1 : target + 1) : target],
    requestId = randomUUID()
  ) =>
    service.enter(users[index], roundId, {
      requestId,
      termsHash: snapshot.round.termsHash,
      selection,
    });
  return { users, groupId: group.id, roundId, currency, snapshot, confirm, target, proof };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function close(f: Fixture, persistDraw = true) {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, f.snapshot.round.closesAt - Date.now() + 10))
  );
  await service.recover(f.roundId);
  if (!persistDraw) return;
  // Simulate a crash immediately after persisting a valid, immutable result.
  await prisma.$transaction(async (tx) => {
    const r = await round(tx, f.roundId);
    if (r.state !== 'LOCKED') return;
    const list = await entries(tx, f.roundId),
      outcome = deriveTogetherOutcome(f.snapshot.round, tickets(list), f.proof);
    await execute(
      tx,
      "UPDATE play_together_rounds SET state='DRAWN',outcome=$2::jsonb,proof=$3::jsonb,ranking=$4::jsonb WHERE id=$1",
      r.id,
      JSON.stringify(outcome),
      JSON.stringify(f.proof),
      JSON.stringify(rankTogether(r.game, tickets(list), outcome))
    );
    await execute(tx, 'SET CONSTRAINTS ALL IMMEDIATE');
  });
}
async function wallet(userId: string) {
  return prisma.wallet.findUniqueOrThrow({ where: { userId } });
}
it('requires the owner to publish terms and every member to authorize their own entry', async () => {
  const f = await fixture();
  await expect(
    createGroupPvpService(prisma).create(f.groupId, f.users[0], 'dice', 100, randomUUID())
  ).rejects.toThrow('shared round');
  await expect(
    service.create(f.users[1], {
      groupId: f.groupId,
      game: 'dice',
      currency: 'ETB',
      entryAmount: 1000,
      minPlayers: 2,
      maxPlayers: 20,
      lobbySeconds: 120,
      requestId: randomUUID(),
    })
  ).rejects.toThrow('owner');
  expect((await wallet(f.users[1])).coinsBalance).toBe(10000);
  await f.confirm(0);
  expect((await wallet(f.users[1])).coinsBalance).toBe(10000);
  const other = await service.snapshot(f.users[1], f.roundId);
  expect(other.round.entries[0].selection).toBeNull();
  expect(JSON.stringify(other)).not.toContain(f.proof.seed);
  expect(other.round.entries[0].walletTransactionId).toBe('');
});
it('reserves only once across double taps, persists the receipt and rejects conflicting retries', async () => {
  const f = await fixture(),
    requestId = randomUUID();
  const replies = await Promise.all([f.confirm(0, [1], requestId), f.confirm(0, [1], requestId)]);
  expect(replies[0]).toEqual(replies[1]);
  expect((await wallet(f.users[0])).coinsBalance).toBe(9000);
  expect((await service.snapshot(f.users[0], f.roundId)).balances.cashReserved).toBe(1000);
  await expect(f.confirm(0, [2], requestId)).rejects.toThrow('different');
  expect((await f.confirm(0, [1])).accepted).toBe(false);
});
it('remembers insufficient funds so a later deposit never turns the old request into a bet', async () => {
  const f = await fixture('ETB', false, 0),
    requestId = randomUUID();
  const first = await f.confirm(0, [1], requestId);
  expect(first.accepted).toBe(false);
  await mintTestPurchasedCoins(f.users[0], 2000);
  expect(await f.confirm(0, [1], requestId)).toEqual(first);
  expect((await wallet(f.users[0])).coinsBalance).toBe(2000);
  expect((await f.confirm(0, [1])).accepted).toBe(true);
});
it('does not allow rewards or practice points to fund real-Birr entries', async () => {
  const f = await fixture('ETB', false, 0);
  await prisma.$transaction((tx) =>
    creditCoins(tx, f.users[0], 5000, {
      type: 'BONUS_GRANT',
      scopeType: 'GROUP_TEST',
      scopeId: randomUUID(),
      referenceType: 'REWARD',
      description: 'Disposable restricted reward',
      policy: { id: policyId, version: 1 },
      requirementAmount: 5000,
      bonusRule: 'NET_WINNINGS_V1',
    })
  );
  expect((await f.confirm(0)).accepted).toBe(false);
  expect((await wallet(f.users[0])).coinsBalance).toBe(5000);
  expect((await wallet(f.users[0])).gamePointsBalance).toBe(10000);
});
it('serializes group and sportsbook spending against the same available wallet', async () => {
  const f = await fixture('ETB', false, 1500);
  const sports = createSportsWallet(prisma, {
    SOFTAGGREGATOR_SPORTS_LIVE_ENABLED: 'true',
    SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED: 'true',
    SOFTAGGREGATOR_SPORTS_COUNTRY: countryCode,
  });
  const player = await sports.ensurePlayer(f.users[0]);
  const [group, bet] = await Promise.all([
    f.confirm(0),
    sports.apply({
      username: player.username,
      currency: 'ETB',
      action: 'debit',
      amount: 1000,
      callId: randomUUID(),
      roundId: 'concurrent-group',
      gameId: SPORTS_GAME_ID,
      rollback: '0',
    }),
  ]);
  expect(Number(group.accepted) + Number(bet.error === 0)).toBe(1);
  expect((await wallet(f.users[0])).coinsBalance).toBe(500);
});
it('preserves groups with shared-round history and returns a clear conflict before deleting members', async () => {
  const f = await fixture('GAME_POINTS');
  const { buildServer } = await import('../../server.js');
  const server = await buildServer();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: f.users[0] } });
    const token = server.jwt.sign({ sub: user.id, username: user.username, roles: ['USER'] });
    const before = await prisma.groupMember.count({ where: { groupId: f.groupId } });
    for (const closed of [false, true]) {
      if (closed) await service.cancel(user.id, f.roundId);
      const response = await server.inject({
        method: 'DELETE',
        url: '/api/v1/groups/' + f.groupId,
        headers: { authorization: 'Bearer ' + token },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.message).toContain('game or gift history');
      expect(await prisma.groupMember.count({ where: { groupId: f.groupId } })).toBe(before);
      expect(await prisma.group.count({ where: { id: f.groupId } })).toBe(1);
    }
  } finally {
    await server.close();
  }
});

it('refunds once before closure and requires a fresh confirmation after cancellation', async () => {
  const f = await fixture(),
    accepted = await f.confirm(0);
  if (!accepted.accepted) throw Error('fixture admission failed');
  await Promise.all([
    service.withdraw(f.users[0], f.roundId, accepted.entryId),
    service.withdraw(f.users[0], f.roundId, accepted.entryId),
  ]);
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
  expect((await f.confirm(0, [9])).accepted).toBe(true);
  await service.withdraw(f.users[0], f.roundId, accepted.entryId);
  expect((await wallet(f.users[0])).coinsBalance).toBe(9000);
});
it('returns a removed member’s own funds before closure', async () => {
  const f = await fixture(),
    a = await f.confirm(1);
  if (!a.accepted) throw Error('fixture admission failed');
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId: f.groupId, userId: f.users[1] } },
    data: { status: 'LEFT' },
  });
  await service.withdraw(f.users[1], f.roundId, a.entryId);
  expect((await wallet(f.users[1])).coinsBalance).toBe(10000);
});
it('starts with confirmed players and ignores spectators, then locks selections and refunds', async () => {
  const f = await fixture('ETB', true);
  const a = await f.confirm(0);
  await f.confirm(1);
  await close(f);
  if (!a.accepted) throw Error('fixture admission failed');
  await expect(service.withdraw(f.users[0], f.roundId, a.entryId)).rejects.toThrow('closed');
  expect((await f.confirm(2)).accepted).toBe(false);
  await expect(service.cancel(f.users[0], f.roundId)).rejects.toThrow('closed');
  await expect(
    prisma.$executeRawUnsafe(
      "UPDATE play_together_entries SET selection='[99]'::jsonb WHERE id=$1",
      a.entryId
    )
  ).rejects.toThrow();
  await expect(
    prisma.$executeRawUnsafe('UPDATE play_together_rounds SET fee_bps=0 WHERE id=$1', f.roundId)
  ).rejects.toThrow();
});
it('recovers a saved outcome and pays exactly once under competing workers', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0);
  await f.confirm(1);
  await close(f);
  await Promise.all([service.recover(f.roundId), service.recover(f.roundId)]);
  const s = await service.snapshot(f.users[0], f.roundId);
  expect(s.round.state).toBe('PAID');
  expect(s.round.settlement).toMatchObject({ funded: 2000, platformFee: 70, winnerCount: 1 });
  expect((await wallet(f.users[0])).coinsBalance).toBe(10930);
  expect((await wallet(f.users[1])).coinsBalance).toBe(9000);
  expect(s.balances.cashReserved).toBe(0);
  expect(
    await prisma.economicOperation.count({ where: { userId: f.users[0], type: 'TOGETHER_PRIZE' } })
  ).toBe(1);
  await expect(
    prisma.$executeRawUnsafe(
      'UPDATE play_together_rounds SET outcome=\'{\"numbers\":[99]}\'::jsonb WHERE id=$1',
      f.roundId
    )
  ).rejects.toThrow();
});
it('refunds all-tie rounds without a fee', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0, [5]);
  await f.confirm(1, [5]);
  await close(f);
  await service.recover(f.roundId);
  const s = await service.snapshot(f.users[0], f.roundId);
  expect(s.round.state).toBe('REFUNDED');
  expect(s.round.settlement?.platformFee).toBe(0);
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
  expect((await wallet(f.users[1])).coinsBalance).toBe(10000);
});
it('refunds too few players and rejects late entries without a charge', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0);
  await close(f, false);
  expect((await service.snapshot(f.users[0], f.roundId)).round.state).toBe('REFUNDED');
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
  expect((await f.confirm(1)).accepted).toBe(false);
  expect((await wallet(f.users[1])).coinsBalance).toBe(10000);
});
it('pays accepted cash entries after pause, suspension and group closure', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0);
  await f.confirm(1);
  await close(f);
  await prisma.user.update({ where: { id: f.users[0] }, data: { status: 'SUSPENDED' } });
  await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
  const paused = createTogetherService(prisma, {
    env: { PLAY_TOGETHER_CASH_ENABLED: 'false', PLAY_TOGETHER_ENABLED: 'false' },
    workerReady: () => false,
  });
  await paused.recover(f.roundId);
  expect((await wallet(f.users[0])).coinsBalance).toBe(10930);
});
it('keeps practice settlement entirely outside the real-Birr ledger', async () => {
  const f = await fixture('GAME_POINTS', true);
  await f.confirm(0);
  await f.confirm(1);
  await close(f);
  await service.recover(f.roundId);
  expect((await wallet(f.users[0])).gamePointsBalance).toBe(10930);
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
  expect(
    await prisma.economicOperation.count({
      where: { userId: f.users[0], type: { in: ['TOGETHER_HOLD', 'TOGETHER_PRIZE'] } },
    })
  ).toBe(0);
});
it('cannot create a cash hold without an accepted entry witness', async () => {
  const f = await fixture();
  await expect(
    prisma.$transaction(async (tx) => {
      await reserveTogetherCash(tx, f.users[0], {
        entryId: randomUUID(),
        roundId: f.roundId,
        amount: 1000,
        policy: { id: policyId, version: 1 },
      });
      await execute(tx, 'SET CONSTRAINTS ALL IMMEDIATE');
    })
  ).rejects.toThrow();
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
});
it('cannot attach an unwitnessed cash operation to an existing practice entry with null cash references', async () => {
  const f = await fixture('GAME_POINTS'),
    accepted = await f.confirm(0);
  if (!accepted.accepted) throw Error('fixture admission failed');
  await expect(
    prisma.$transaction(async (tx) => {
      await reserveTogetherCash(tx, f.users[0], {
        entryId: accepted.entryId,
        roundId: f.roundId,
        amount: 1000,
        policy: { id: policyId, version: 1 },
      });
      await execute(tx, 'SET CONSTRAINTS ALL IMMEDIATE');
    })
  ).rejects.toThrow();
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
});
it('allows one bounded daily practice refill without creating cash', async () => {
  const user = await prisma.user.create({ data: { username: 'refill_' + randomUUID() } });
  const replies = await Promise.all([
    service.refillPractice(user.id),
    service.refillPractice(user.id),
  ]);
  expect(replies.reduce((n, r) => n + r.added, 0)).toBe(10000);
  expect((await wallet(user.id)).gamePointsBalance).toBe(10000);
  expect((await wallet(user.id)).coinsBalance).toBe(0);
  expect(await prisma.economicOperation.count({ where: { userId: user.id } })).toBe(0);
});
it('keeps funded cash entries closed when live activation is off', async () => {
  const f = await fixture();
  const closed = createTogetherService(prisma, {
    env: { PLAY_TOGETHER_CASH_ENABLED: 'false' },
    workerReady: () => true,
  });
  expect(
    (
      await closed.enter(f.users[0], f.roundId, {
        requestId: randomUUID(),
        termsHash: f.snapshot.round.termsHash,
        selection: [1],
      })
    ).accepted
  ).toBe(false);
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
});
it.each(TOGETHER_GAMES)(
  'settles $name through the real cash ledger using the published ranking',
  async (game) => {
    const f = await fixture('ETB', true, 10000, game.key);
    for (let i = 0; i < 2; i++) {
      const picks = Array.from({ length: game.picks }, (_, p) =>
        game.key === 'blackjack' || game.key === 'virtual_football_3d'
          ? (i + p) % 3
          : game.min + p + i
      );
      expect((await f.confirm(i, picks)).accepted).toBe(true);
    }
    await close(f);
    await service.recover(f.roundId);
    const s = await service.snapshot(f.users[0], f.roundId);
    expect(['PAID', 'REFUNDED']).toContain(s.round.state);
    expect(
      (await wallet(f.users[0])).coinsBalance +
        (await wallet(f.users[1])).coinsBalance +
        s.round.settlement!.platformFee
    ).toBe(20000);
  }
);
it('pins fees to existing rounds and rejects stale or unauthorized configuration edits', async () => {
  const f = await fixture(),
    before = await service.settings(adminId);
  await expect(service.settings(f.users[1], { ...before, feeBps: 800 })).rejects.toThrow(
    'Administrator'
  );
  await service.settings(adminId, { ...before, feeBps: 800 });
  await expect(service.settings(adminId, { ...before, feeBps: 900 })).rejects.toThrow('elsewhere');
  expect((await service.snapshot(f.users[0], f.roundId)).round.feeBps).toBe(before.feeBps);
  const latest = await service.settings(adminId);
  await service.settings(adminId, { ...latest, feeBps: 700 });
});
it('shares one public round without treating opening it as paid participation', async () => {
  const f = await fixture();
  const ids = await Promise.all([
    service.openPublic(f.users[0], 'dice', 'GAME_POINTS'),
    service.openPublic(f.users[1], 'dice', 'GAME_POINTS'),
  ]);
  expect(ids[0]).toBe(ids[1]);
  const s = await service.snapshot(f.users[0], ids[0]);
  expect(s.round.entries).toEqual([]);
  expect(s.round.creatorId).toBeNull();
  expect((await wallet(f.users[0])).gamePointsBalance).toBe(10000);
});
it('runs the complete scheduled draw path with a pinned synthetic beacon', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0);
  await f.confirm(1);
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, quicknetTargetForCutoff(f.snapshot.round.closesAt).beaconTimeMs - Date.now() + 10)
    )
  );
  await service.recover(f.roundId);
  expect((await service.snapshot(f.users[0], f.roundId)).round.state).toBe('PAID');
});
it('rolls back every wallet payment on interrupted settlement and retries the saved result once', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0);
  await f.confirm(1);
  await close(f);
  let interrupted = false;
  const brokenDb = {
    $transaction: (fn: (tx: Tx) => Promise<unknown>, options: unknown) =>
      prisma.$transaction(
        async (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === '$executeRawUnsafe')
                  return async (sql: string, ...values: unknown[]) => {
                    const result = await target.$executeRawUnsafe(sql, ...values);
                    if (sql.includes('settlement=$3::jsonb')) {
                      interrupted = true;
                      throw Error('Simulated connection interruption before commit');
                    }
                    return result;
                  };
                return Reflect.get(target, key);
              },
            })
          ),
        options as never
      ),
  } as unknown as typeof prisma;
  const broken = createTogetherService(brokenDb, { env, workerReady: () => true });
  await expect(broken.recover(f.roundId)).rejects.toThrow('interruption');
  expect(interrupted).toBe(true);
  expect((await wallet(f.users[0])).coinsBalance).toBe(9000);
  expect((await wallet(f.users[1])).coinsBalance).toBe(9000);
  const saved = await service.snapshot(f.users[0], f.roundId);
  expect(saved.round.state).toBe('DRAWN');
  expect(saved.round.entries.every((e) => e.state === 'ACCEPTED')).toBe(true);
  await service.recover(f.roundId);
  await service.recover(f.roundId);
  const paid = await service.snapshot(f.users[0], f.roundId);
  expect(paid.round.outcome).toEqual(saved.round.outcome);
  expect(paid.round.state).toBe('PAID');
  expect((await wallet(f.users[0])).coinsBalance).toBe(10930);
});
it('rejects a confirmation delayed past closure by a wallet lock without deducting funds', async () => {
  const f = await fixture('ETB', true);
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lockReady = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const blocker = prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe('SELECT id FROM wallets WHERE "userId"=$1 FOR UPDATE', f.users[0]);
    locked();
    await gate;
  });
  await lockReady;
  const entry = f.confirm(0);
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, f.snapshot.round.closesAt - Date.now() + 50))
  );
  release();
  await blocker;
  expect((await entry).accepted).toBe(false);
  expect((await wallet(f.users[0])).coinsBalance).toBe(10000);
});
it('shares a tied winning profit and charges the published fee once', async () => {
  const f = await fixture('ETB', true);
  await f.confirm(0, [f.target]);
  await f.confirm(1, [f.target]);
  await f.confirm(2, [f.target === 100 ? 1 : f.target + 1]);
  await close(f);
  await service.recover(f.roundId);
  const s = await service.snapshot(f.users[0], f.roundId);
  expect(s.round.settlement).toMatchObject({ funded: 3000, platformFee: 70, winnerCount: 2 });
  expect((await wallet(f.users[0])).coinsBalance).toBe(10465);
  expect((await wallet(f.users[1])).coinsBalance).toBe(10465);
  expect((await wallet(f.users[2])).coinsBalance).toBe(9000);
});
it('keeps processing other due rounds when one draw relay fails', async () => {
  const a = await fixture('ETB', true);
  await a.confirm(0);
  await a.confirm(1);
  await close(a, false);
  const b = await fixture('ETB', true);
  await b.confirm(0);
  await close(b, false);
  const noBeacon = createTogetherService(prisma, {
    env,
    workerReady: () => true,
    fetchBeacon: async () => {
      throw Error('Relay unavailable');
    },
  });
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.max(0, quicknetTargetForCutoff(a.snapshot.round.closesAt).beaconTimeMs - Date.now() + 10)
    )
  );
  await expect(noBeacon.recover(a.roundId)).rejects.toThrow('Relay unavailable');
  expect((await service.snapshot(a.users[0], a.roundId)).round.state).toBe('LOCKED');
  await noBeacon.recover(b.roundId);
  expect((await service.snapshot(b.users[0], b.roundId)).round.state).toBe('REFUNDED');
});
it('confirms and settles using restricted runtime privileges without permission to rewrite terms', async () => {
  const role = 'together_test_' + randomUUID().replaceAll('-', '');
  await prisma.$executeRawUnsafe('CREATE ROLE ' + role + ' NOLOGIN');
  try {
    await prisma.$queryRawUnsafe('SELECT public.ledger_apply_runtime_grants($1)::text', role);
    const f = await fixture('ETB', true);
    const runtimeDb = {
      $transaction: (fn: (tx: Tx) => Promise<unknown>, options: unknown) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE ' + role);
          return fn(tx);
        }, options as never),
    } as unknown as typeof prisma;
    const runtime = createTogetherService(runtimeDb, { env, workerReady: () => true });
    const body = (selection: number[]) => ({
      requestId: randomUUID(),
      termsHash: f.snapshot.round.termsHash,
      selection,
    });
    expect((await runtime.enter(f.users[0], f.roundId, body([f.target]))).accepted).toBe(true);
    expect(
      (await runtime.enter(f.users[1], f.roundId, body([f.target === 100 ? 1 : f.target + 1])))
        .accepted
    ).toBe(true);
    await expect(
      runtimeDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'UPDATE play_together_rounds SET fee_bps=0 WHERE id=$1',
          f.roundId
        );
      })
    ).rejects.toThrow();
    await close(f);
    await runtime.recover(f.roundId);
    expect((await service.snapshot(f.users[0], f.roundId)).round.state).toBe('PAID');
  } finally {
    await prisma.$executeRawUnsafe('DROP OWNED BY ' + role);
    await prisma.$executeRawUnsafe('DROP ROLE ' + role);
  }
});
it('reconciles cash reservations, refunds, fees and winnings after the full suite', async () => {
  const result = await runLedgerInvariantCheck();
  expect(result.passed, JSON.stringify(result.violations)).toBe(true);
});
