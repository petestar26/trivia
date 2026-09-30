import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { PrismaClient } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import { disableTestPolicy } from '../../ledger/test-policy-fixture.js';
import { runLedgerInvariantCheckInTransaction } from '../../economy/ledger-invariant-checker.js';
import { applyRuntimeAccess } from '../../scripts/ledger-runtime-access.js';
import { purchasedFixture, uid } from '../../test/ledger-integrity-fixtures.js';
import { bootstrapLedgerTestGates } from '../../economy/ledger-test-bootstrap.js';
import {
  creditCoins,
  settleWagerCoins,
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
  it('does not convert a restricted source while part of it remains reserved', async () => {
    const { buyer, args } = await fixture();
    const marker = 'rollback-conversion-probe';
    await expect(
      prisma.$transaction(async (tx) => {
        await creditCoins(tx, buyer.id, 120, {
          type: 'BONUS_GRANT',
          scopeType: 'TEST',
          scopeId: uid('bonus'),
          referenceType: 'GAME',
          description: 'Held bonus probe',
          policy: args.policy,
          requirementAmount: 40,
        });
        const source = await tx.coinProvenance.findFirstOrThrow({
          where: { userId: buyer.id, lotClass: 'RESTRICTED' },
        });
        await reserveScheduledStakeCoins(tx, buyer.id, { ...args, amount: 40 });
        await settleWagerCoins(tx, buyer.id, {
          sessionId: uid('probe-session'),
          idempotencyKey: uid('probe-request'),
          gameKey: 'dice',
          stake: 40,
          payout: 40,
          policy: args.policy,
          responseSnapshot: (coinsBalance) => ({ coinsBalance }),
        });
        expect(await tx.coinProvenance.findUnique({ where: { id: source.id } })).toMatchObject({
          state: 'OPEN',
          lotClass: 'RESTRICTED',
          reservedAmount: 40,
          availableAmount: 80,
          requirementAmount: 40,
          progressAmount: 40,
        });
        await refundScheduledStakeCoins(tx, buyer.id, args.holdId);
        expect(await tx.coinProvenance.findUnique({ where: { id: source.id } })).toMatchObject({
          state: 'OPEN',
          lotClass: 'RESTRICTED',
          reservedAmount: 0,
          availableAmount: 120,
          requirementAmount: 40,
          progressAmount: 40,
        });
        throw new Error(marker);
      })
    ).rejects.toThrow(marker);
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
  it('holds and refunds through the documented restricted runtime role', async () => {
    const { buyer, args } = await fixture();
    const role = `stake_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(24).toString('hex');
    const runtimeUrl = new URL(url);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
    let created = false;
    try {
      await prisma.$executeRawUnsafe(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      );
      created = true;
      expect(await applyRuntimeAccess(prisma, role, role, randomBytes(32).toString('hex'))).toEqual(
        []
      );
      await expect(
        runtime.$queryRawUnsafe('SELECT secret FROM public.ledger_approval_keys')
      ).rejects.toThrow('permission denied');
      const [permissions] = await runtime.$queryRawUnsafe<
        {
          delete: boolean;
          amount: boolean;
          state: boolean;
          refund: boolean;
        }[]
      >(`SELECT
        pg_catalog.has_table_privilege(current_user,'public.scheduled_stake_holds','DELETE') AS delete,
        pg_catalog.has_column_privilege(current_user,'public.scheduled_stake_holds','amount','UPDATE') AS amount,
        pg_catalog.has_column_privilege(current_user,'public.scheduled_stake_holds','state','UPDATE') AS state,
        pg_catalog.has_column_privilege(current_user,'public.scheduled_stake_holds','refund_operation_id','UPDATE') AS refund`);
      expect(permissions).toEqual({ delete: false, amount: false, state: true, refund: true });
      const hold = await runtime.$transaction((tx) =>
        reserveScheduledStakeCoins(tx, buyer.id, args)
      );
      expect(hold.holdId).toBe(args.holdId);
      expect(hold.coinsBalance).toBe(320);
      expect(await runtime.$queryRaw`SELECT current_database() AS name`)
        .toEqual(await prisma.$queryRaw`SELECT current_database() AS name`);
      expect(await runtime.$queryRaw`SELECT current_schema() AS name`)
        .toEqual(await prisma.$queryRaw`SELECT current_schema() AS name`);
      expect((await runtime.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).coinsBalance)
        .toBe(320);
      expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).coinsBalance)
        .toBe(320);
      expect(await prisma.scheduledStakeHold.findUnique({ where: { id: args.holdId }, select: { userId: true } }))
        .toEqual({ userId: buyer.id });
      expect(await runtime.scheduledStakeHold.findUnique({ where: { id: args.holdId }, select: { userId: true } }))
        .toEqual({ userId: buyer.id });
      expect(await runtime.scheduledStakeHold.findUnique({ where: { id: args.holdId },
        include: { refundOperation: true } })).toMatchObject({ userId: buyer.id, state: 'HELD' });
      const refund = await runtime.$transaction((tx) =>
        refundScheduledStakeCoins(tx, buyer.id, args.holdId)
      );
      expect(refund.coinsBalance).toBe(400);
    } finally {
      await runtime.$disconnect();
      if (created) {
        await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
        await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
      }
    }
  });
  it('rejects a runtime transfer draining aggregate hold backing, then refunds both holds', async () => {
    const { buyer, args, purchaseLot } = await fixture();
    const otherHold = { ...args, holdId: uid('second-hold') };
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, otherHold));
    await prisma.$transaction((tx) =>
      creditCoins(tx, buyer.id, 40, {
        type: 'BONUS_GRANT',
        scopeType: 'TEST',
        scopeId: uid('recipient'),
        referenceType: 'GAME',
        description: 'Restricted transfer recipient',
        policy: args.policy,
        requirementAmount: 200,
      })
    );
    const recipient = await prisma.coinProvenance.findFirstOrThrow({
      where: { userId: buyer.id, lotClass: 'RESTRICTED' },
    });
    const before = await snapshot(buyer.id);
    const role = `stake_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(24).toString('hex');
    const runtimeUrl = new URL(url);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
    let created = false;
    try {
      await prisma.$executeRawUnsafe(
        `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`
      );
      created = true;
      expect(await applyRuntimeAccess(prisma, role, role, randomBytes(32).toString('hex'))).toEqual(
        []
      );
      // Ordinary runtime DML, all triggers enabled. This is balanced and its
      // destination is restricted; the assertion requires the new backing
      // guard, not an unrelated withdrawable-mint or wallet-equality refusal.
      await expect(
        runtime.$transaction(async (tx) => {
          const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: buyer.id } });
          const receipt = await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              userId: buyer.id,
              currency: 'COINS',
              type: 'COIN_CREDIT',
              ledgerType: 'CREDIT',
              amount: 80,
              balanceBefore: wallet.coinsBalance,
              balanceAfter: wallet.coinsBalance + 80,
              referenceType: 'GAME',
              description: 'Backing regression',
            },
          });
          const operation = await tx.economicOperation.create({
            data: {
              type: 'P2P_TRANSFER',
              userId: buyer.id,
              createdBy: buyer.id,
              scopeType: 'TEST',
              scopeId: uid('drain'),
              walletTransactionIds: [receipt.id],
            },
          });
          await tx.coinLotEntry.create({
            data: {
              operationId: operation.id,
              userId: buyer.id,
              lotId: purchaseLot.id,
              entryType: 'TRANSFER_OUT',
              reservedDelta: -80,
              counterpartyLotId: recipient.id,
              sequence: 0,
            },
          });
          await tx.coinLotEntry.create({
            data: {
              operationId: operation.id,
              userId: buyer.id,
              lotId: recipient.id,
              entryType: 'TRANSFER_IN',
              availableDelta: 80,
              counterpartyLotId: purchaseLot.id,
              sequence: 1,
            },
          });
          await tx.wallet.update({
            where: { id: wallet.id },
            data: { coinsBalance: { increment: 80 } },
          });
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        })
      ).rejects.toThrow('scheduled stake backing mismatch');
      expect(await snapshot(buyer.id)).toEqual(before);
      expect(
        (await runtime.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId)))
          .coinsBalance
      ).toBe(360);
      expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: buyer.id } })).coinsBalance)
        .toBe(360);
      expect(await runtime.scheduledStakeHold.findUnique({ where: { id: otherHold.holdId },
        select: { userId: true, state: true, refundOperationId: true } }))
        .toEqual({ userId: buyer.id, state: 'HELD', refundOperationId: null });
      const secondRefund = await runtime.$transaction((tx) =>
        refundScheduledStakeCoins(tx, buyer.id, otherHold.holdId));
      expect(secondRefund).toMatchObject({ coinsBalance: 440, isReplay: false });
      expect(
        (
          await runtime.$transaction((tx) =>
            refundScheduledStakeCoins(tx, buyer.id, otherHold.holdId)
          )
        ).isReplay
      ).toBe(true);
    } finally {
      await runtime.$disconnect();
      if (created) {
        await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
        await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
      }
    }
  });
  it('I17 counts all active holds sharing a lot, not each hold in isolation', async () => {
    const { buyer, args, purchaseLot } = await fixture();
    const second = { ...args, holdId: uid('second-hold') };
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, second));
    await expect(
      prisma.$transaction(async (tx) => {
        // Observe an invalid intermediate state with constraints still deferred;
        // always roll it back. No trigger is disabled.
        const operation = await tx.economicOperation.create({
          data: {
            type: 'P2P_TRANSFER',
            userId: buyer.id,
            createdBy: buyer.id,
            scopeType: 'TEST',
            scopeId: uid('scan-drain'),
          },
        });
        await tx.coinLotEntry.create({
          data: {
            operationId: operation.id,
            lotId: purchaseLot.id,
            userId: buyer.id,
            entryType: 'TRANSFER_OUT',
            reservedDelta: -80,
            counterpartyLotId: purchaseLot.id,
            sequence: 0,
          },
        });
        const violations = await tx.$queryRawUnsafe<{ id: string }[]>(
          'SELECT id FROM public.scheduled_stake_integrity_failures()'
        );
        expect(violations.map((v) => v.id).sort()).toEqual([args.holdId, second.holdId].sort());
        throw new Error('rollback-backing-scan');
      })
    ).rejects.toThrow('rollback-backing-scan');
    await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId));
    await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, second.holdId));
  });
  it('requires a published active policy but refunds a superseded version', async () => {
    const { buyer, args, country } = await fixture();
    const draft = await prisma.countryCasinoPolicy.create({
      data: {
        countryCode: country.code,
        version: args.policy.version + 1,
        state: 'DRAFT',
      },
    });
    const before = await snapshot(buyer.id);
    const draftArgs = { ...args, policy: { id: draft.id, version: draft.version } };
    await expect(
      prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, draftArgs))
    ).rejects.toThrow('active published policy');
    await expect(
      prisma.$transaction(async (tx) => {
        const op = await tx.economicOperation.create({
          data: {
            type: 'SCHEDULED_STAKE_HOLD',
            userId: buyer.id,
            createdBy: buyer.id,
            scopeType: 'SCHEDULED_STAKE',
            scopeId: args.holdId,
            countryPolicyId: draft.id,
            countryPolicyVersion: draft.version,
          },
        });
        await tx.scheduledStakeHold.create({
          data: {
            id: args.holdId,
            userId: buyer.id,
            amount: args.amount,
            policyId: draft.id,
            policyVersion: draft.version,
            gameKey: args.gameKey,
            rulesId: args.rulesId,
            holdOperationId: op.id,
          },
        });
      })
    ).rejects.toThrow('active published policy');
    expect(await snapshot(buyer.id)).toEqual(before);
    await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args));
    await disableTestPolicy(args.policy.id, country.code);
    expect(
      (await prisma.$transaction((tx) => reserveScheduledStakeCoins(tx, buyer.id, args))).isReplay
    ).toBe(true);
    expect(
      (await prisma.$transaction((tx) => refundScheduledStakeCoins(tx, buyer.id, args.holdId)))
        .coinsBalance
    ).toBe(400);
    expect(
      await prisma.$queryRawUnsafe('SELECT * FROM public.scheduled_stake_integrity_failures()')
    ).toEqual([]);
  });
  it.each([
    ['scheduled_stake_holds', 'scheduled_stake_hold_no_truncate'],
    ['coin_provenance', 'scheduled_stake_lot_backing'],
    ['coin_provenance', 'coin_lot_row_guard'],
    ['coin_lot_entries', 'coin_lot_entry_validate'],
    ['coin_lot_entries', 'coin_lot_entry_apply'],
  ])('I3 reports a missing %s.%s trigger', async (table, trigger) => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`DROP TRIGGER "${trigger}" ON public."${table}"`);
          const scan = await runLedgerInvariantCheckInTransaction(tx, null);
          expect(scan.violations.find((v) => v.invariant.startsWith('I3 '))?.sample).toContain(
            trigger
          );
          throw new Error('rollback-trigger-probe');
        },
        { timeout: 30000 }
      )
    ).rejects.toThrow('rollback-trigger-probe');
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
