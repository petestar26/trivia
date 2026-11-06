import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { prisma } from '@socialplay/database';
import {
  TOGETHER_GAMES,
  TOGETHER_GAME_DURATION_MS,
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherTermsHash,
  togetherSeedCommitment,
  quicknetTargetForCutoff,
  type TogetherGame,
  type TogetherTerms,
} from '@socialplay/shared';
import { createTogetherService } from './service.js';
import { execute, round, policy, type Tx } from './store.js';
import { applyBalanceChanges, getOrCreateWallet } from '../../economy/wallet-service.js';
import { canWatchTogether } from './events.js';
import { runTogetherJobs } from './jobs.js';

const url = new URL(process.env.DATABASE_URL ?? 'https://invalid');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.searchParams.has('host') ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Acknowledged disposable local database required');
// Only the external entropy source is synthetic. PostgreSQL time, locks,
// constraints, journals, jobs, and request receipts are real.
vi.mock('../economics/round-entropy.js', () => ({
  verifyQuicknetBeacon: async (cutoff: Date, beacon: { round: number }) => {
    expect(beacon.round).toBe(quicknetTargetForCutoff(cutoff).beaconRound);
  },
}));
const service = createTogetherService(prisma, {
  workerReady: () => true,
  fetchBeacon: async (cutoff) => ({
    round: quicknetTargetForCutoff(cutoff).beaconRound,
    signature: 'synthetic-native-only',
    randomness: 'ab'.repeat(32),
  }),
});
afterAll(() => prisma.$disconnect());
const waitUntil = async (time: number) => {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, time - Date.now() + 15)));
};

async function fixture(game: TogetherGame = 'spin_win', deadlineMs = 2500) {
  const users = await Promise.all(
    Array.from({ length: 10 }, () =>
      prisma.user.create({ data: { username: 'shared_disposable_' + randomUUID() } })
    )
  );
  const group = await prisma.group.create({
    data: {
      ownerId: users[0].id,
      name: 'Disposable shared lifecycle',
      isPrivate: true,
      expiresAt: new Date(Date.now() + 25000),
      members: {
        create: users.map((u, i) => ({ userId: u.id, role: i === 0 ? 'OWNER' : 'MEMBER' })),
      },
    },
  });
  for (const user of users.slice(0, 3)) {
    await getOrCreateWallet(user.id);
    await prisma.$transaction((tx) =>
      applyBalanceChanges(tx, user.id, [
        {
          currency: 'GAME_POINTS',
          amount: 10000,
          ledgerType: 'CREDIT',
          transactionType: 'GAME_POINT_CREDIT',
          referenceType: 'ADMIN',
          description: 'Isolated shared-game fixture',
        },
      ])
    );
  }
  const id = randomUUID(),
    seed = randomBytes(32).toString('hex'),
    closesAt = Date.now() + deadlineMs;
  const s = await prisma.$transaction((tx) => policy(tx));
  const terms: TogetherTerms = {
    id,
    groupId: group.id,
    game,
    currency: 'GAME_POINTS',
    entryAmount: 100,
    feeBps: s.feeBps,
    settingsVersion: s.version,
    minPlayers: 2,
    maxPlayers: 20,
    closesAt,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: togetherSeedCommitment(id, seed),
    beaconRound: quicknetTargetForCutoff(closesAt).beaconRound,
    termsVersion: 2,
    presentationVersion: 2,
    presentationDurationMs: TOGETHER_GAME_DURATION_MS[game],
  };
  await prisma.$transaction((tx) =>
    execute(
      tx,
      'INSERT INTO play_together_rounds(id,group_id,creator_id,request_id,request_hash,game,currency,entry_amount,fee_bps,policy_version,rules_id,min_players,max_players,closes_at,recovery_deadline,seed,seed_commitment,terms_hash,beacon_round,presentation_version,presentation_duration_ms) ' +
        "VALUES($1,$2,$3,$4,$5,$6,'GAME_POINTS',100,$7,$8,$9,2,20,$10,$11,$12,$13,$14,$15,2,$16)",
      id,
      group.id,
      users[0].id,
      randomUUID(),
      'c'.repeat(64),
      game,
      s.feeBps,
      s.version,
      TOGETHER_RULES_ID,
      new Date(closesAt),
      new Date(closesAt + 600000),
      seed,
      terms.seedCommitment,
      togetherTermsHash(terms),
      terms.beaconRound,
      terms.presentationDurationMs
    )
  );
  return { id, users, group, terms };
}

it('expired leases recover and a broken job cannot block healthy round refunds', async () => {
  const fixtures = await Promise.all(Array.from({ length: 5 }, () => fixture('spin_win', 1800)));
  await waitUntil(Math.max(...fixtures.map((f) => f.terms.closesAt)));
  const [broken, leased, ...healthy] = fixtures;
  // The preceding legacy suite deliberately retains some active obligations.
  // Give this test's four eligible jobs the next batch without changing or
  // deleting those unrelated fixtures. The worker's production limit stays four.
  await prisma.$executeRawUnsafe(
    "UPDATE play_together_jobs SET next_attempt_at='2000-01-01'::timestamptz WHERE round_id=ANY($1::text[])",
    fixtures.map((f) => f.id)
  );
  await prisma.$executeRawUnsafe(
    "UPDATE play_together_jobs SET lease_token='abandoned-worker',lease_until=clock_timestamp()+interval '60 seconds' WHERE round_id=$1",
    leased.id
  );
  const calls: string[] = [];
  const recover = async (id: string) => {
    calls.push(id);
    if (id === broken.id) throw Error('One isolated failed obligation');
    await service.recover(id);
  };
  await runTogetherJobs(prisma, recover, randomUUID(), true);
  expect(calls).toContain(broken.id);
  expect(calls).not.toContain(leased.id);
  for (const f of healthy)
    expect((await service.snapshot(f.users[0].id, f.id)).round.state).toBe('REFUNDED');
  const [failed] = await prisma.$queryRawUnsafe<{ attempts: number; delayed: boolean }[]>(
    'SELECT attempts,next_attempt_at>clock_timestamp() AS delayed FROM play_together_jobs WHERE round_id=$1',
    broken.id
  );
  expect(failed.attempts).toBe(1);
  expect(failed.delayed).toBe(true);
  await prisma.$executeRawUnsafe(
    "UPDATE play_together_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE round_id=$1",
    leased.id
  );
  await runTogetherJobs(prisma, recover, randomUUID(), true);
  expect(calls.filter((id) => id === broken.id)).toHaveLength(1);
  expect((await service.snapshot(leased.users[0].id, leased.id)).round.state).toBe('REFUNDED');
  // Complete the deliberately broken fixture through its normal refund path.
  await service.recover(broken.id);
});

it('ten members watch one complete spin, exactly three authorize funds, then recover one settlement', async () => {
  const f = await fixture();
  const requests = f.users
    .slice(0, 3)
    .map(() => ({ requestId: randomUUID(), termsHash: togetherTermsHash(f.terms), selection: [] }));
  const before = await Promise.all(f.users.map((u) => service.snapshot(u.id, f.id)));
  expect(before.every((s) => s.round.entries.length === 0)).toBe(true);
  expect(before.slice(3).every((s) => s.balances.pointsAvailable === 0)).toBe(true);
  // Concurrent duplicate confirmations are payload-bound and debit once.
  const accepted = await Promise.all(
    requests.flatMap((request, i) => [
      service.enter(f.users[i].id, f.id, request),
      service.enter(f.users[i].id, f.id, request),
    ])
  );
  expect(accepted.every((r) => r.accepted)).toBe(true);
  for (let i = 0; i < 3; i++) expect(accepted[i * 2]).toEqual(accepted[i * 2 + 1]);
  const rejected = await service.enter(f.users[3].id, f.id, {
    requestId: randomUUID(),
    termsHash: togetherTermsHash(f.terms),
    selection: [],
  });
  expect(rejected.accepted).toBe(false);
  await waitUntil(quicknetTargetForCutoff(f.terms.closesAt).beaconTimeMs);
  await Promise.all([service.recover(f.id), service.recover(f.id)]);
  const countdown = await Promise.all(f.users.map((u) => service.snapshot(u.id, f.id)));
  const view = countdown[0].round;
  expect(view.state).toBe('DRAWN');
  expect(view.outcome).toBeNull();
  expect(view.proof).toBeNull();
  expect(view.ranking).toEqual([]);
  expect(view.settlement).toBeNull();
  expect(view.entries).toHaveLength(3);
  expect(view.presentation!.startsAt).toBeGreaterThan(countdown[0].serverTime);
  expect(new Set(countdown.map((s) => s.round.presentation!.startsAt)).size).toBe(1);
  expect(
    countdown
      .slice(3)
      .every((s) => s.balances.pointsAvailable === 0 && s.balances.pointsReserved === 0)
  ).toBe(true);
  expect(view.entries.every((e) => e.payout === null && e.state === 'ACCEPTED')).toBe(true);
  await expect(
    prisma.$executeRawUnsafe("UPDATE play_together_rounds SET state='PAID' WHERE id=$1", f.id)
  ).rejects.toThrow('finish');
  await expect(
    prisma.$executeRawUnsafe(
      "UPDATE play_together_entries SET state='REFUNDED' WHERE round_id=$1",
      f.id
    )
  ).rejects.toThrow('finish');
  await expect(
    prisma.$executeRawUnsafe(
      "UPDATE play_together_rounds SET presentation_starts_at=presentation_starts_at+interval '1 second' WHERE id=$1",
      f.id
    )
  ).rejects.toThrow('timeline');
  await expect(
    service.create(f.users[0].id, {
      groupId: f.group.id,
      game: 'dice',
      currency: 'GAME_POINTS',
      entryAmount: 100,
      minPlayers: 2,
      maxPlayers: 20,
      lobbySeconds: 120,
      requestId: randomUUID(),
    })
  ).rejects.toThrow(/current round|closing time/);
  await expect(
    prisma.$executeRawUnsafe(
      'INSERT INTO play_together_rounds(id,group_id,creator_id,request_id,request_hash,game,currency,entry_amount,fee_bps,policy_version,rules_id,min_players,max_players,created_at,closes_at,recovery_deadline,seed,seed_commitment,terms_hash,beacon_round) SELECT $2,group_id,creator_id,$3,request_hash,game,currency,entry_amount,fee_bps,policy_version,rules_id,min_players,max_players,created_at,closes_at,recovery_deadline,seed,seed_commitment,terms_hash,beacon_round FROM play_together_rounds WHERE id=$1',
      f.id,
      randomUUID(),
      randomUUID()
    )
  ).rejects.toMatchObject({ meta: { code: '23505' } });
  await waitUntil(view.presentation!.startsAt + 300);
  const late = await service.snapshot(f.users[9].id, f.id);
  expect(late.round.presentation!.startsAt).toBe(view.presentation!.startsAt);
  expect(late.round.outcome).toBeNull();
  // Group closure and owner departure cannot erase accepted obligations.
  await prisma.groupMember.update({
    where: { groupId_userId: { groupId: f.group.id, userId: f.users[0].id } },
    data: { status: 'LEFT' },
  });
  expect(await canWatchTogether(prisma, f.users[0].id, f.id)).toBe(true);
  expect((await service.snapshot(f.users[0].id, f.id)).round.outcome).toBeNull();
  await waitUntil(view.presentation!.finishesAt);
  expect(Date.now()).toBeGreaterThan(f.group.expiresAt.getTime());
  // Result is public at finish even if a worker is temporarily offline.
  const pending = await service.snapshot(f.users[9].id, f.id);
  expect(pending.round.state).toBe('DRAWN');
  expect(pending.round.proof).not.toBeNull();
  expect(pending.round.settlement).toBeNull();
  const saved = await prisma.$transaction((tx) => round(tx, f.id, false));
  await Promise.all([service.tick(), service.tick(), service.recover(f.id)]);
  const paid = await service.snapshot(f.users[0].id, f.id);
  expect(paid.round.state).toBe('PAID');
  expect(paid.round.outcome).toEqual(saved.outcome);
  expect(paid.round.presentation!.startsAt).toBe(view.presentation!.startsAt);
  expect(
    paid.round.entries.reduce((sum, e) => sum + e.payout!, 0) + paid.round.settlement!.platformFee
  ).toBe(300);
  expect(paid.round.entries.every((e) => e.state === 'SETTLED')).toBe(true);
  expect(
    await prisma.walletTransaction.count({
      where: { userId: { in: f.users.slice(3).map((u) => u.id) } },
    })
  ).toBe(0);
  expect(
    await prisma.walletTransaction.count({
      where: { userId: { in: f.users.slice(0, 3).map((u) => u.id) }, ledgerType: 'DEBIT' },
    })
  ).toBe(3);
  const again = await service.snapshot(f.users[0].id, f.id);
  expect(again.round.settlement).toEqual(paid.round.settlement);
  expect(again.round.paidAt).toBe(paid.round.paidAt);
}, 90000);

it('all eleven remaining games release only elapsed events and defer outcome refunds until their pinned finish', async () => {
  const cases = await Promise.all(
    TOGETHER_GAMES.filter((g) => g.key !== 'spin_win').map(async (game) => {
      const f = await fixture(game.key, 6000);
      const selection = ['blackjack', 'virtual_football_3d'].includes(game.key)
        ? Array(game.picks).fill(0)
        : ['sky_crash', 'crash_point'].includes(game.key)
          ? [2000]
          : Array.from({ length: game.picks }, (_, i) => game.min + i);
      await Promise.all(
        f.users.slice(0, 3).map((u) =>
          service.enter(u.id, f.id, {
            requestId: randomUUID(),
            termsHash: togetherTermsHash(f.terms),
            selection,
          })
        )
      );
      return f;
    })
  );
  await waitUntil(
    Math.max(...cases.map((f) => quicknetTargetForCutoff(f.terms.closesAt).beaconTimeMs))
  );
  await Promise.all(cases.map((f) => service.recover(f.id)));
  const schedules = await Promise.all(
    cases.map(async (f) => {
      const internal = await prisma.$transaction((tx) => round(tx, f.id, false));
      const snap = await service.snapshot(f.users[9].id, f.id);
      expect(snap.round.state).toBe('DRAWN');
      expect(snap.round.presentation!.finishesAt - snap.round.presentation!.startsAt).toBe(
        TOGETHER_GAME_DURATION_MS[f.terms.game]
      );
      expect(snap.round.outcome).toBeNull();
      expect(snap.round.proof).toBeNull();
      expect(snap.round.ranking).toEqual([]);
      expect(snap.round.presentation!.events).toEqual([]);
      expect(JSON.stringify(snap)).not.toContain(internal.seed);
      await service.recover(f.id);
      expect((await service.snapshot(f.users[0].id, f.id)).balances.pointsReserved).toBe(100);
      return {
        f,
        internal,
        start: snap.round.presentation!.startsAt,
        finish: snap.round.presentation!.finishesAt,
      };
    })
  );
  await waitUntil(Math.max(...schedules.map((s) => s.start)) + 3500);
  for (const s of schedules) {
    const snap = await service.snapshot(s.f.users[8].id, s.f.id);
    const seen = snap.round.presentation!.events;
    expect(seen.every((e) => e.atMs <= snap.serverTime - s.start)).toBe(true);
    expect(seen).toEqual(
      s.internal.presentation_data!.filter((e) => e.atMs <= snap.serverTime - s.start)
    );
    expect(snap.round.proof).toBeNull();
    expect(snap.round.settlement).toBeNull();
    expect(snap.round.entries.every((e) => e.state === 'ACCEPTED' && e.payout === null)).toBe(true);
    expect(snap.round.eventSequence).toBeGreaterThan(4);
  }
  await waitUntil(Math.max(...schedules.map((s) => s.finish)));
  // New service instances simulate process restart; duplicate recoveries must
  // consume exactly the persisted draw and recording, including all-tied refunds.
  const restarted = createTogetherService(prisma, {
    workerReady: () => true,
    fetchBeacon: async () => {
      throw Error('A committed game must never fetch a new draw');
    },
  });
  for (const s of schedules) {
    await Promise.all([restarted.recover(s.f.id), service.recover(s.f.id)]);
    const final = await service.snapshot(s.f.users[9].id, s.f.id);
    expect(['PAID', 'REFUNDED']).toContain(final.round.state);
    expect(final.round.outcome).toEqual(s.internal.outcome);
    expect(final.round.presentation!.events).toEqual(s.internal.presentation_data);
    expect(final.round.presentation!.finishesAt).toBe(s.finish);
    expect(final.round.paidAt).toBeGreaterThanOrEqual(s.finish);
    if (s.f.terms.game !== 'dice') expect(final.round.settlement!.refunds).toBe(true);
    expect(
      final.round.entries.reduce((sum, e) => sum + e.payout!, 0) +
        final.round.settlement!.platformFee
    ).toBe(300);
    expect(final.balances.pointsAvailable).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId: s.f.users[9].id } })).toBe(0);
  }
}, 150000);

it('a separately restricted practice worker can recover obligations but cannot alter cash, credentials or unbacked points', async () => {
  const role = 'salem_shared_round_worker_' + randomBytes(5).toString('hex');
  await prisma.$executeRawUnsafe(
    'CREATE ROLE ' + role + ' NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS'
  );
  try {
    await prisma.$queryRawUnsafe('SELECT public.grant_together_practice_worker($1)::text', role);
    const asRole = <T>(fn: (tx: Tx) => Promise<T>) =>
      prisma.$transaction(
        async (tx) => {
          await execute(tx, 'SET LOCAL ROLE ' + role);
          return fn(tx);
        },
        { timeout: 30000 }
      );
    const runtimeDb = {
      $transaction: asRole,
      $queryRawUnsafe: (sql: string, ...values: unknown[]) =>
        asRole((tx) => tx.$queryRawUnsafe(sql, ...values)),
      $executeRawUnsafe: (sql: string, ...values: unknown[]) =>
        asRole((tx) => tx.$executeRawUnsafe(sql, ...values)),
    } as unknown as typeof prisma;
    const f = await fixture('number_challenge');
    await Promise.all(
      f.users.slice(0, 3).map((user) =>
        service.enter(user.id, f.id, {
          requestId: randomUUID(),
          termsHash: togetherTermsHash(f.terms),
          selection: [50],
        })
      )
    );
    await expect(
      asRole((tx) => tx.$queryRawUnsafe('SELECT "passwordHash" FROM users'))
    ).rejects.toThrow('permission');
    await expect(
      asRole((tx) =>
        execute(
          tx,
          'UPDATE wallets SET "coinsBalance"="coinsBalance"+1 WHERE "userId"=$1',
          f.users[0].id
        )
      )
    ).rejects.toThrow('permission');
    await expect(
      asRole((tx) => execute(tx, 'INSERT INTO economic_operations(id) VALUES($1)', randomUUID()))
    ).rejects.toThrow('permission');
    await expect(
      asRole(async (tx) => {
        await execute(
          tx,
          'UPDATE wallets SET "gamePointsBalance"="gamePointsBalance"+1 WHERE "userId"=$1',
          f.users[0].id
        );
        await execute(tx, 'SET CONSTRAINTS ALL IMMEDIATE');
      })
    ).rejects.toThrow('exact current transaction credits');
    const worker = createTogetherService(runtimeDb, {
      practiceWorker: true,
      workerReady: () => true,
      fetchBeacon: async (cutoff) => ({
        round: quicknetTargetForCutoff(cutoff).beaconRound,
        signature: 'synthetic-native-only',
        randomness: 'ab'.repeat(32),
      }),
    });
    await waitUntil(quicknetTargetForCutoff(f.terms.closesAt).beaconTimeMs);
    await worker.recover(f.id);
    const prepared = await service.snapshot(f.users[0].id, f.id);
    expect(prepared.round.state).toBe('DRAWN');
    await waitUntil(prepared.round.presentation!.finishesAt);
    await worker.recover(f.id);
    await worker.tick();
    expect((await service.snapshot(f.users[0].id, f.id)).round.state).toBe('REFUNDED');
  } finally {
    await prisma.$executeRawUnsafe('DROP OWNED BY ' + role);
    await prisma.$executeRawUnsafe('DROP ROLE ' + role);
    await prisma.$executeRawUnsafe(
      'DELETE FROM together_practice_worker_roles WHERE role_name=$1::name',
      role
    );
  }
}, 90000);
