import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { playGame } from '../games/game-play.js';
import { mintTestPurchasedCoins } from '../test/financial-policy-fixtures.js';
import { activateTestPolicy, disableTestPolicy } from './test-policy-fixture.js';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';

const key = (prefix: string) => `${prefix}-${randomUUID()}`;

beforeAll(async () => {
  // A fresh migration keeps G0 gates disabled until the real DB invariant
  // checker passes. This test-only bootstrap enforces that sequence.
  await bootstrapLedgerTestGates();
});

async function playableUser() {
  const tag = randomUUID().replaceAll('-', '');
  let countryCode = '';
  let country: Awaited<ReturnType<typeof prisma.country.create>> | undefined;
  const start = Number.parseInt(tag.slice(0, 8), 16) % 1296;
  for (let offset = 0; offset < 1296; offset++) {
    countryCode = `Z${((start + offset) % 1296).toString(36).toUpperCase().padStart(2, '0')}`;
    try {
      country = await prisma.country.create({
        data: { code: countryCode, name: `Ledger replay ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
      });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }
  if (!country) throw new Error('No unused replay fixture country code');
  const method = await prisma.paymentMethodDefinition.create({
    data: { countryId: country.id, type: 'BANK_TRANSFER', name: `Replay ${tag}`, fieldSchema: {}, isActive: true },
  });
  const user = await prisma.user.create({
    data: { email: `ledger-replay-${tag}@test.local`, username: `lrep_${tag.slice(0, 12)}`, passwordHash: 'fixture-only', displayName: 'Ledger replay user' },
  });
  const admin = await prisma.user.create({
    data: { email: `ledger-replay-admin-${tag}@test.local`, username: `lradmin_${tag.slice(0, 11)}`,
      passwordHash: 'fixture-only', displayName: 'Ledger replay administrator', role: 'ADMIN' },
  });
  await prisma.userPayoutAccount.create({
    data: { userId: user.id, countryId: country.id, methodDefId: method.id, accountDetails: { label: 'test' }, status: 'ACTIVE' },
  });
  const policy = await prisma.countryCasinoPolicy.create({
    data: {
      countryCode, version: 1, status: 'ENABLED', enabledAt: new Date(),
      minWithdrawal: 100, maxWithdrawal: 100000, dailyWithdrawalLimit: 100000,
      monthlyWithdrawalLimit: 1000000, playthroughMultiplier: 2,
      qualifyingGames: ['dice'], maxQualifyingStake: 1000, holdingPeriodHours: 0,
      giftDailyLimit: 100000, kycTierRequired: 0, supportedPaymentMethods: ['BANK_TRANSFER'],
      withdrawalFeePercent: 0, manualReviewThreshold: 100000,
    },
  });
  await activateTestPolicy(policy.id, countryCode, admin.id);
  await mintTestPurchasedCoins(user.id, 1000);
  return { user, policy, countryCode };
}

async function economicSnapshot(userId: string) {
  const [wallet, sessions, transactions, lots, allocations] = await Promise.all([
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),
    prisma.gameSession.count({ where: { userId } }),
    prisma.walletTransaction.count({ where: { userId } }),
    prisma.coinProvenance.count({ where: { userId } }),
    prisma.coinAllocation.count({ where: { userId } }),
  ]);
  const [operations, entries] = await Promise.all([
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM economic_operations WHERE "userId"=${userId}`,
    prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM coin_lot_entries WHERE "userId"=${userId}`,
  ]);
  return { balance: wallet.coinsBalance, sessions, transactions, lots, allocations,
    operations: Number(operations[0].count), entries: Number(entries[0].count) };
}

afterAll(async () => prisma.$disconnect());

describe('T12/I14: exact historical play replay', () => {
  it('returns its stored snapshot with zero writes after the current maximum bet falls', async () => {
    const { user } = await playableUser();
    const args = { userId: user.id, gameKey: 'dice', betAmount: 100, idempotencyKey: key('lower-bound') };
    const first = await playGame(args);
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'dice' } });
    const before = await economicSnapshot(user.id);
    await prisma.gameDefinition.update({ where: { id: game.id }, data: { maxBet: 99 } });
    try {
      const replay = await playGame(args);
      expect(replay).toMatchObject({ sessionId: first.sessionId, result: first.result, rewardAmount: first.rewardAmount, isReplay: true });
      expect(await economicSnapshot(user.id)).toEqual(before);
    } finally {
      await prisma.gameDefinition.update({ where: { id: game.id }, data: { maxBet: game.maxBet } });
    }
  });

  it('returns its stored snapshot with zero writes after the game is no longer AVAILABLE', async () => {
    const { user } = await playableUser();
    const args = { userId: user.id, gameKey: 'dice', betAmount: 100, idempotencyKey: key('retired') };
    const first = await playGame(args);
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'dice' } });
    const before = await economicSnapshot(user.id);
    await prisma.gameDefinition.update({ where: { id: game.id }, data: { catalogStatus: 'COMING_SOON' } });
    try {
      const replay = await playGame(args);
      expect(replay.sessionId).toBe(first.sessionId);
      expect(replay.isReplay).toBe(true);
      expect(await economicSnapshot(user.id)).toEqual(before);
    } finally {
      await prisma.gameDefinition.update({ where: { id: game.id }, data: { catalogStatus: game.catalogStatus } });
    }
  });

  it('returns its stored snapshot with zero writes after current mode changes', async () => {
    const { user } = await playableUser();
    const args = { userId: user.id, gameKey: 'dice', betAmount: 100, idempotencyKey: key('mode-change') };
    const first = await playGame(args);
    const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'dice' } });
    const before = await economicSnapshot(user.id);
    await prisma.gameDefinition.update({ where: { id: game.id }, data: { catalogStatus: 'COMING_SOON', currentRulesVersion: null, mode: 'BONUS', wagerCurrency: null } });
    try {
      const replay = await playGame(args);
      expect(replay.sessionId).toBe(first.sessionId);
      expect(replay.isReplay).toBe(true);
      expect(await economicSnapshot(user.id)).toEqual(before);
    } finally {
      await prisma.gameDefinition.update({ where: { id: game.id }, data: { catalogStatus: game.catalogStatus, currentRulesVersion: game.currentRulesVersion, mode: game.mode, wagerCurrency: game.wagerCurrency } });
    }
  });

  it('returns its stored snapshot with zero writes after policy disable and account suspension', async () => {
    const { user, policy, countryCode } = await playableUser();
    const args = { userId: user.id, gameKey: 'dice', betAmount: 100, idempotencyKey: key('policy-off') };
    const first = await playGame(args);
    const before = await economicSnapshot(user.id);
    await disableTestPolicy(policy.id, countryCode);
    await prisma.user.update({ where: { id: user.id }, data: { status: 'SUSPENDED' } });
    const replay = await playGame(args);
    expect(replay.sessionId).toBe(first.sessionId);
    expect(replay.isReplay).toBe(true);
    expect(await economicSnapshot(user.id)).toEqual(before);
  });
});
