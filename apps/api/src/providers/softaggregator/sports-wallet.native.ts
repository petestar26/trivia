import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { createSportsWallet } from './sports-wallet.js';
import { SPORTS_GAME_ID } from './sports-config.js';
import type { TestMovement } from './test-wallet.js';
import {
  activateTestWithdrawalPolicy,
  mintTestPurchasedCoins,
  nextTestCountryCode,
} from '../../test/financial-policy-fixtures.js';
import { applySportsCashMovement, creditCoins } from '../../economy/coin-ledger-service.js';
import { runLedgerInvariantCheck } from '../../economy/ledger-invariant-checker.js';

const url = new URL(process.env.DATABASE_URL ?? 'https://invalid');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Disposable local database required');
let countryId: string, countryCode: string, methodId: string, policyId: string;
beforeAll(async () => {
  const admin = await prisma.user.create({
    data: { username: `sports_admin_${randomUUID()}`, role: 'ADMIN' },
  });
  const country = await prisma.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Sports test jurisdiction',
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
      name: 'Sports fixture',
      fieldSchema: {},
      isActive: true,
    },
  });
  methodId = method.id;
  await activateTestWithdrawalPolicy(countryId, admin.id);
  const policy = await prisma.countryCasinoPolicy.findFirstOrThrow({ where: { countryCode } });
  policyId = policy.id;
  const run = await runLedgerInvariantCheck();
  expect(run.passed, JSON.stringify(run.violations)).toBe(true);
  for (const key of ['SPORTSBOOK_PLAY', 'CASINO_PLAY'])
    await prisma.platformGate.update({
      where: { key },
      data: { enabled: true, lastInvariantRunId: run.runId },
    });
});
afterAll(async () => {
  await prisma.$disconnect();
});
async function fixture(cash = 0, live = true) {
  const user = await prisma.user.create({ data: { username: `sports_${randomUUID()}` } });
  await prisma.userPayoutAccount.create({
    data: { userId: user.id, countryId, methodDefId: methodId, accountDetails: {} },
  });
  const env = {
    SOFTAGGREGATOR_SPORTS_CALLBACK_ENABLED: 'true',
    SOFTAGGREGATOR_SPORTS_LIVE_ENABLED: String(live),
    SOFTAGGREGATOR_SPORTS_COUNTRY: countryCode,
  };
  const wallet = createSportsWallet(prisma, env);
  if (cash) await mintTestPurchasedCoins(user.id, cash);
  const player = await wallet.ensurePlayer(user.id);
  const movement = (patch: Partial<TestMovement> = {}): TestMovement => ({
    username: player.username,
    currency: 'ETB',
    action: 'debit',
    callId: randomUUID(),
    amount: 100,
    roundId: 'fixture-round',
    gameId: SPORTS_GAME_ID,
    rollback: '0',
    ...patch,
  });
  return { user, env, wallet, player, movement };
}
it('starts at zero, creates no practice grant, and rejects preview stakes and credits', async () => {
  const f = await fixture(0, false);
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({
    balanceMinor: 0,
    canBet: false,
    liveEnabled: false,
  });
  expect(await f.wallet.apply(f.movement({ action: 'balance' }))).toEqual({ error: 0, balance: 0 });
  expect(await f.wallet.apply(f.movement())).toEqual({ error: 2, balance: 0 });
  expect(await f.wallet.apply(f.movement({ action: 'credit', amount: 5000 }))).toEqual({
    error: 2,
    balance: 0,
  });
  expect(await prisma.walletTransaction.count({ where: { userId: f.user.id } })).toBe(0);
  expect(await prisma.$queryRaw`SELECT * FROM sg_test_players WHERE user_id=${f.user.id}`).toEqual(
    []
  );
});
it('shows funded cash but keeps provider betting balance zero until live play is enabled', async () => {
  const f = await fixture(500, false);
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({ balanceMinor: 500, canBet: false });
  expect(await f.wallet.apply(f.movement({ action: 'balance' }))).toEqual({ error: 0, balance: 0 });
  expect((await f.wallet.apply(f.movement())).error).toBe(2);
  f.env.SOFTAGGREGATOR_SPORTS_LIVE_ENABLED = 'true';
  expect(await f.wallet.apply(f.movement({ action: 'balance' }))).toEqual({
    error: 0,
    balance: 500,
  });
  expect(await f.wallet.apply(f.movement())).toEqual({ error: 0, balance: 400 });
});
it('debits and pays out atomically, replays once, and rejects conflicting retries', async () => {
  const f = await fixture(500);
  const debit = f.movement({ amount: 125 });
  const replies = await Promise.all([f.wallet.apply(debit), f.wallet.apply(debit)]);
  expect(replies).toEqual([
    { error: 0, balance: 375 },
    { error: 0, balance: 375 },
  ]);
  const credit = f.movement({ action: 'credit', amount: 250 });
  expect(await f.wallet.apply(credit)).toEqual({ error: 0, balance: 625 });
  expect(await f.wallet.apply(credit)).toEqual({ error: 0, balance: 625 });
  expect(await f.wallet.apply({ ...credit, amount: 251 })).toEqual({ error: 2, balance: 0 });
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({ balanceMinor: 625 });
  expect(
    await prisma.economicOperation.count({
      where: { userId: f.user.id, type: { in: ['SPORTS_DEBIT', 'SPORTS_CREDIT'] } },
    })
  ).toBe(2);
  expect(
    await prisma.coinProvenance.findMany({
      where: { userId: f.user.id, provenanceType: 'GAME_WIN' },
      select: { lotClass: true, availableAmount: true },
    })
  ).toEqual([{ lotClass: 'WITHDRAWABLE', availableAmount: 250 }]);
});
it('serializes competing stakes so the balance cannot be overspent', async () => {
  const f = await fixture(500);
  const result = await Promise.all([
    f.wallet.apply(f.movement({ amount: 400 })),
    f.wallet.apply(f.movement({ amount: 400 })),
  ]);
  expect(result.map((r) => r.error).sort()).toEqual([0, 1]);
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({ balanceMinor: 100 });
});
it('retains failed-stake receipts without turning a retry into a later funded bet', async () => {
  const f = await fixture(100);
  const m = f.movement({ amount: 200 });
  expect(await f.wallet.apply(m)).toEqual({ error: 1, balance: 100 });
  await mintTestPurchasedCoins(f.user.id, 500);
  expect(await f.wallet.apply(m)).toEqual({ error: 1, balance: 100 });
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({ balanceMinor: 600 });
});
it('settles signed payouts after pause and suspension but rejects new stakes', async () => {
  const f = await fixture(500);
  await f.wallet.apply(f.movement({ amount: 200 }));
  f.env.SOFTAGGREGATOR_SPORTS_LIVE_ENABLED = 'false';
  expect((await f.wallet.apply(f.movement())).error).toBe(2);
  expect(await f.wallet.apply(f.movement({ action: 'credit', amount: 350 }))).toEqual({
    error: 0,
    balance: 650,
  });
  await prisma.user.update({ where: { id: f.user.id }, data: { status: 'SUSPENDED' } });
  expect((await f.wallet.apply(f.movement())).error).toBe(2);
  expect(await f.wallet.apply(f.movement({ action: 'credit', amount: 50 }))).toEqual({
    error: 0,
    balance: 700,
  });
});
it('keeps rewards non-withdrawable and unavailable to cash-only sports', async () => {
  const f = await fixture();
  await prisma.$transaction((tx) =>
    creditCoins(tx, f.user.id, 1000, {
      type: 'BONUS_GRANT',
      scopeType: 'SPORTS_TEST',
      scopeId: randomUUID(),
      referenceType: 'REWARD',
      description: 'Restricted fixture',
      policy: { id: policyId, version: 1 },
      requirementAmount: 1000,
      bonusRule: 'NET_WINNINGS_V1',
    })
  );
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({
    balanceMinor: 0,
    rewardBalanceMinor: 1000,
    canBet: false,
  });
  expect((await f.wallet.apply(f.movement())).error).not.toBe(0);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.user.id } })).coinsBalance
  ).toBe(1000);
});
it('accepts zero-amount receipts and independent live bonus credits without fabricating a debit', async () => {
  const f = await fixture(100);
  expect(await f.wallet.apply(f.movement({ amount: 0 }))).toEqual({ error: 0, balance: 100 });
  expect(await f.wallet.apply(f.movement({ action: 'credit', amount: 77 }))).toEqual({
    error: 0,
    balance: 177,
  });
});
it('rejects unknown users, other products, test identities, and reused IDs across players', async () => {
  const a = await fixture(100),
    b = await fixture(100);
  const m = a.movement({ amount: 10 });
  await a.wallet.apply(m);
  expect(await b.wallet.apply({ ...m, username: b.player.username })).toEqual({
    error: 2,
    balance: 0,
  });
  for (const patch of [
    { gameId: 'casino/slot' },
    { username: 'st_' + 'a'.repeat(32) },
    { username: 'sr_' + 'f'.repeat(32) },
  ])
    expect((await a.wallet.apply(a.movement(patch))).error).toBe(2);
});
it('enforces both platform gates even with funded wallets and live environment enabled', async () => {
  const f = await fixture(100);
  await prisma.platformGate.update({ where: { key: 'SPORTSBOOK_PLAY' }, data: { enabled: false } });
  try {
    expect(await f.wallet.apply(f.movement({ action: 'balance' }))).toEqual({
      error: 0,
      balance: 0,
    });
    expect((await f.wallet.apply(f.movement())).error).toBe(2);
  } finally {
    const run = await runLedgerInvariantCheck();
    expect(run.passed, JSON.stringify(run.violations)).toBe(true);
    await prisma.platformGate.update({
      where: { key: 'SPORTSBOOK_PLAY' },
      data: { enabled: true, lastInvariantRunId: run.runId },
    });
  }
});
it('refuses unwitnessed money writes and immutable receipt changes at the database boundary', async () => {
  const f = await fixture(100);
  await expect(
    prisma.$transaction(async (tx) => {
      await applySportsCashMovement(tx, f.user.id, {
        callId: randomUUID(),
        action: 'credit',
        amount: 200,
        requestHash: 'a'.repeat(64),
        policy: { id: policyId, version: 1 },
        roundId: 'missing',
        gameId: SPORTS_GAME_ID,
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    })
  ).rejects.toThrow();
  expect(await f.wallet.snapshot(f.user.id)).toMatchObject({ balanceMinor: 100 });
  const m = f.movement({ amount: 10 });
  await f.wallet.apply(m);
  await expect(
    prisma.$executeRaw`UPDATE sg_sports_movements SET amount_minor=1 WHERE call_id=${m.callId}`
  ).rejects.toThrow();
  await expect(
    prisma.$executeRaw`DELETE FROM sg_sports_movements WHERE call_id=${m.callId}`
  ).rejects.toThrow();
});
it('reconciles the whole ledger after sports stakes, refunds, and winnings', async () => {
  const run = await runLedgerInvariantCheck();
  expect(run.passed, JSON.stringify(run.violations)).toBe(true);
});
