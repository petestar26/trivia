import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { purchasedFixture, uid } from '../../test/ledger-integrity-fixtures.js';
import { bootstrapLedgerTestGates } from '../../economy/ledger-test-bootstrap.js';
import {
  creditCoins,
  reserveScheduledStakeCoins,
  refundScheduledStakeCoins,
} from '../../economy/coin-ledger-service.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
) {
  throw new Error('Scheduled stake tests require the acknowledged isolated throwaway database');
}
process.env.TEST_LEDGER_DB_NAME = 'playqube_scheduled_throwaway';
let runId: string;
async function gate(enabled: boolean) {
  await prisma.platformGate.update({
    where: { key: 'SCHEDULED_STAKE_HOLD' },
    data: { enabled, lastInvariantRunId: runId },
  });
}
async function fixture() {
  const f = await purchasedFixture(400);
  const policy = await prisma.countryCasinoPolicy.findFirstOrThrow({
    where: { countryCode: f.country.code },
  });
  const args = {
    holdId: uid('hold'),
    amount: 80,
    policy: { id: policy.id, version: policy.version },
    gameKey: 'spin_win' as const,
    rulesId: 'single-zero-rtp90-v2' as const,
  };
  return { ...f, args };
}
async function snapshot(userId: string) {
  return {
    wallet: await prisma.wallet.findUnique({ where: { userId } }),
    lots: await prisma.coinProvenance.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    entries: await prisma.coinLotEntry.count({ where: { userId } }),
    operations: await prisma.economicOperation.count({ where: { userId } }),
    transactions: await prisma.walletTransaction.count({ where: { userId } }),
  };
}
beforeAll(async () => {
  // Matches the documented isolated owner setup on PG13 and PG16.
  await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  runId = await bootstrapLedgerTestGates();
  await gate(true);
});
afterAll(async () => {
  try {
    await gate(false);
  } finally {
    await prisma.$disconnect();
  }
});

describe('scheduled stakes preserve original Coin sources', () => {
  it('holds and refunds once; replay returns stored balances after a later change', async () => {
    const { buyer, args, purchaseLot } = await fixture();
    const hold = await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    expect(hold.coinsBalance).toBe(320);
    expect(await prisma.coinProvenance.findUnique({ where: { id: purchaseLot.id } })).toMatchObject(
      { availableAmount: 320, reservedAmount: 80 }
    );
    const held = await snapshot(buyer.id);
    expect(
      await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args))
    ).toMatchObject({ ...hold, isReplay: true });
    expect(await snapshot(buyer.id)).toEqual(held);
    const refund = await prisma.$transaction((tx) =>
      refundScheduledStakeCoins(tx, buyer.id, args.holdId)
    );
    expect(refund.coinsBalance).toBe(400);
    expect(await prisma.coinProvenance.findUnique({ where: { id: purchaseLot.id } })).toMatchObject(
      { availableAmount: 400, reservedAmount: 0, lotClass: 'WITHDRAWABLE' }
    );
    const refunded = await snapshot(buyer.id);
    expect(
      await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId))
    ).toMatchObject({ ...refund, isReplay: true });
    expect(
      await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args))
    ).toMatchObject({ coinsBalance: 320, isReplay: true });
    expect(await snapshot(buyer.id)).toEqual(refunded);
  });
  it('preserves restricted lot, obligation, expiry and lineage across a refund', async () => {
    const { buyer, args } = await fixture();
    await prisma.$transaction((tx) =>
      creditCoins(tx, buyer.id, 120, {
        type: 'BONUS_GRANT',
        scopeType: 'TEST',
        scopeId: uid('bonus'),
        referenceType: 'GAME',
        description: 'Restricted test reward',
        policy: args.policy,
        requirementAmount: 600,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    );
    const before = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: buyer.id, lotClass: 'RESTRICTED' },
    });
    await prisma.$transaction((tx) =>
      reserveScheduledStakeCoins(tx, buyer.id, { ...args, amount: 200 })
    );
    const held = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: before.id } });
    expect(held.reservedAmount).toBe(120);
    expect(held.requirementAmount).toBe(600);
    await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId));
    const after = await prisma.coinProvenance.findUniqueOrThrow({ where: { id: before.id } });
    for (const key of [
      'availableAmount',
      'reservedAmount',
      'lotClass',
      'requirementAmount',
      'progressAmount',
      'expiresAt',
      'sourceOperationId',
      'originalSource',
    ] as const)
      expect(after[key]).toEqual(before[key]);
  });
  it('refuses changed terms and cross-user replay without any writes', async () => {
    const { buyer, args } = await fixture();
    const other = await fixture();
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    const before = await snapshot(buyer.id);
    await expect(
      prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, { ...args, amount: 40 }))
    ).rejects.toThrow('different terms');
    await expect(
      prisma.$transaction((tx) => refundScheduledStakeCoins(tx, other.buyer.id, args.holdId))
    ).rejects.toThrow('not found');
    expect(await snapshot(buyer.id)).toEqual(before);
  });
  it('serializes concurrent holds and refunds across separate transactions', async () => {
    const { buyer, args } = await fixture();
    const holds = await Promise.all(
      [0, 1].map(() => prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args)))
    );
    expect(holds.filter((x) => !x.isReplay)).toHaveLength(1);
    const refunds = await Promise.all(
      [0, 1].map(() =>
        prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId))
      )
    );
    expect(refunds.filter((x) => !x.isReplay)).toHaveLength(1);
    expect((await snapshot(buyer.id)).wallet?.coinsBalance).toBe(400);
  });
  it('prevents concurrent different holds from overspending the wallet', async () => {
    const { buyer, args } = await fixture();
    const attempts = [args.holdId, uid('other-hold')].map((holdId) => ({
      ...args,
      holdId,
      amount: 300,
    }));
    const results = await Promise.allSettled(
      attempts.map((terms) =>
        prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, terms))
      )
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await snapshot(buyer.id)).wallet?.coinsBalance).toBe(100);
    const held = await prisma.scheduledStakeHold.findFirstOrThrow({ where: { userId: buyer.id } });
    await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, held.id));
    expect((await snapshot(buyer.id)).wallet?.coinsBalance).toBe(400);
  });
  it('rejects an unrelated reversal operation that would block the real refund', async () => {
    const { buyer, args } = await fixture();
    const held = await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.economicOperation.create({
          data: {
            type: 'COMPENSATION',
            userId: buyer.id,
            createdBy: buyer.id,
            scopeType: 'TEST',
            scopeId: uid('forged-reversal'),
            reversesOperationId: held.holdOperationId,
          },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      })
    ).rejects.toThrow('scheduled stake proof mismatch');
    expect(
      (await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId)))
        .coinsBalance
    ).toBe(400);
  });
  it('rolls back a failure after hold creation', async () => {
    const { buyer, args } = await fixture();
    const before = await snapshot(buyer.id);
    await expect(
      prisma.$transaction(async (tx) => {
        await reserveScheduledStakeCoins(tx, buyer.id, args);
        throw new Error('forced-after-hold');
      })
    ).rejects.toThrow('forced-after-hold');
    expect(await snapshot(buyer.id)).toEqual(before);
    expect(await prisma.scheduledStakeHold.findUnique({ where: { id: args.holdId } })).toBeNull();
  });
  it('pausing new holds still permits source-preserving refunds', async () => {
    const { buyer, args } = await fixture();
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    await gate(false);
    try {
      await expect(
        prisma.$transaction((tx) =>
          reserveScheduledStakeCoins(tx, buyer.id, { ...args, holdId: uid('disabled') })
        )
      ).rejects.toThrow('disabled');
      expect(
        (await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId)))
          .coinsBalance
      ).toBe(400);
    } finally {
      await gate(true);
    }
  });
  it('ordinary SQL cannot insert an orphan operation or edit approved hold terms', async () => {
    const { buyer, args } = await fixture();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.economicOperation.create({
          data: {
            type: 'SCHEDULED_STAKE_HOLD',
            createdBy: buyer.id,
            userId: buyer.id,
            scopeType: 'SCHEDULED_STAKE',
            scopeId: args.holdId,
            countryPolicyId: args.policy.id,
            countryPolicyVersion: args.policy.version,
          },
        });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      })
    ).rejects.toThrow('scheduled stake proof mismatch');
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    await expect(
      prisma.scheduledStakeHold.update({ where: { id: args.holdId }, data: { amount: 40 } })
    ).rejects.toThrow('immutable');
    expect(
      await prisma.$queryRawUnsafe('SELECT * FROM public.scheduled_stake_integrity_failures()')
    ).toEqual([]);
  });
});
