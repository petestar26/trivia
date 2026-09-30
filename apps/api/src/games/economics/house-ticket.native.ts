import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { randomUUID } from 'node:crypto';
import type { GameDefinition } from '@prisma/client';
import { purchasedFixture, uid } from '../../test/ledger-integrity-fixtures.js';
import { bootstrapLedgerTestGates } from '../../economy/ledger-test-bootstrap.js';
import { admitDormantSpinTicket } from './house-ticket-admission.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/playqube_scheduled_throwaway' ||
    process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') {
  throw new Error('Financial admission tests require the acknowledged isolated throwaway database');
}
process.env.TEST_LEDGER_DB_NAME = 'playqube_scheduled_throwaway';

const streamId = `fin${randomUUID().replaceAll('-', '').slice(0, 18)}`;
const roundId = `${streamId}:0`;
const bets = [{ marketId: 'number:7', amount: 40 }];
let buyerId: string;
let original: Pick<GameDefinition, 'catalogStatus' | 'isActive' | 'currentRulesVersion'>;
let runId: string;

beforeAll(async () => {
  await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  runId = await bootstrapLedgerTestGates();
  const fixture = await purchasedFixture(1000);
  buyerId = fixture.buyer.id;
  const method = await prisma.paymentMethodDefinition.findFirstOrThrow({
    where: { countryId: fixture.country.id, type: 'BANK_TRANSFER', isActive: true },
  });
  await prisma.userPayoutAccount.create({ data: {
    userId: buyerId, countryId: fixture.country.id, methodDefId: method.id,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' }, status: 'ACTIVE',
  } });
  const game = await prisma.gameDefinition.findUniqueOrThrow({ where: { key: 'spin_win' } });
  original = { catalogStatus: game.catalogStatus, isActive: game.isActive,
    currentRulesVersion: game.currentRulesVersion };
  await prisma.gameDefinition.update({ where: { id: game.id }, data: {
    catalogStatus: 'AVAILABLE', isActive: true, currentRulesVersion: 1,
  } });
  for (const key of ['HOUSE_TICKET_ADMISSION', 'SCHEDULED_STAKE_HOLD']) {
    await prisma.platformGate.update({ where: { key }, data: { enabled: true, lastInvariantRunId: runId } });
  }
  const [{ now_ms: now }] = await prisma.$queryRaw<Array<{ now_ms: bigint }>>`
    SELECT floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms`;
  const anchor = now - 1000n;
  await prisma.scheduledGameStream.create({ data: {
    id: streamId, gameKey: 'spin_win', rulesId: SPIN90_RULES_ID,
    mode: 'FINANCIAL', enabled: true, anchorMs: anchor,
    bettingMs: 3_600_000, revealMs: 1000, resultMs: 1000,
  } });
  await prisma.scheduledGameRound.create({ data: {
    id: roundId, streamId, sequence: 0n, gameKey: 'spin_win', rulesId: SPIN90_RULES_ID,
    mode: 'FINANCIAL', opensMs: anchor, closesMs: anchor + 3_600_000n,
    revealEndsMs: anchor + 3_601_000n, endsMs: anchor + 3_602_000n,
  } });
  await prisma.$queryRaw`SELECT public.house_record_capital_funding(${`bank:${randomUUID()}`},${1292n},${'a'.repeat(64)})`;
});
afterAll(async () => {
  try {
    await prisma.scheduledGameStream.update({ where: { id: streamId }, data: { enabled: false } }).catch(() => undefined);
    if (original) await prisma.gameDefinition.update({ where: { key: 'spin_win' }, data: original });
    for (const key of ['HOUSE_TICKET_ADMISSION', 'SCHEDULED_STAKE_HOLD']) {
      await prisma.platformGate.update({ where: { key }, data: { enabled: false } });
    }
  } finally { await prisma.$disconnect(); }
});

describe('dormant financial ticket atomic admission', () => {
  it('blocks a non-owner from deleting financial schedules', async () => {
    const role = `fin_delete_${randomUUID().replaceAll('-', '')}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await prisma.$executeRawUnsafe(`GRANT SELECT, DELETE ON public.scheduled_game_streams,
        public.scheduled_game_rounds TO "${role}"`);
      for (const [table, id] of [
        ['scheduled_game_rounds', roundId], ['scheduled_game_streams', streamId],
      ]) {
        await expect(prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
          await tx.$executeRawUnsafe(`DELETE FROM public.${table} WHERE id=$1`, id);
        })).rejects.toThrow('financial rounds are owner-only');
      }
    } finally {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
  });

  it('holds 40 Coins and books 1292 operator loss capacity exactly once', async () => {
    const holdId = uid('ticket');
    const input = { userId: buyerId, roundId, holdId, selections: bets };
    const accepted = await admitDormantSpinTicket(prisma, input);
    expect(accepted).toMatchObject({ coinsBalance: 960, lossReserve: 1292n, isReplay: false });
    const hold = await prisma.scheduledStakeHold.findUniqueOrThrow({ where: { id: holdId } });
    expect(hold).toMatchObject({ amount: 40, state: 'HELD' });
    const reserve = await prisma.houseRoundReservation.findUniqueOrThrow({ where: { roundId: `ticket:${holdId}` } });
    expect(reserve).toMatchObject({ stakeTotal: 40n, reservedLoss: 1292n });
    const again = await admitDormantSpinTicket(prisma, input);
    expect(again).toMatchObject({ ...accepted, isReplay: true });
    await expect(admitDormantSpinTicket(prisma, { ...input,
      selections: [{ marketId: 'number:8', amount: 40 }] })).rejects.toThrow('different terms');
  });

  it('cannot hold another ticket when house capital is exhausted', async () => {
    const holdId = uid('ticket');
    const before = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    await expect(admitDormantSpinTicket(prisma, { userId: buyerId, roundId, holdId, selections: bets }))
      .rejects.toThrow('House exposure limit reached');
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).coinsBalance)
      .toBe(before.coinsBalance);
    expect(await prisma.scheduledStakeHold.findUnique({ where: { id: holdId } })).toBeNull();
    expect(await prisma.houseRoundReservation.findUnique({ where: { roundId: `ticket:${holdId}` } })).toBeNull();
  });

  it('admits only one of two competing tickets for the last funded capacity', async () => {
    await prisma.$queryRaw`SELECT public.house_record_capital_funding(${`bank:${randomUUID()}`},${1292n},${'b'.repeat(64)})`;
    const before = await prisma.wallet.findUniqueOrThrow({ where: { userId: buyerId } });
    const requests = [8, 9].map((number) => ({
      userId: buyerId, roundId, holdId: uid('race'),
      selections: [{ marketId: `number:${number}`, amount: 40 }],
    }));
    const outcomes = await Promise.allSettled(requests.map((input) => admitDormantSpinTicket(prisma, input)));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect(String(loser?.reason)).toContain('House exposure limit reached');
    const holds = await prisma.scheduledStakeHold.findMany({ where: { id: { in: requests.map((r) => r.holdId) } } });
    expect(holds).toHaveLength(1);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: buyerId } })).coinsBalance)
      .toBe(before.coinsBalance - 40);
    expect(await prisma.houseRoundReservation.count({ where: { roundId: { in: requests.map((r) => `ticket:${r.holdId}`) } } }))
      .toBe(1);
  });

  it('refuses a new ticket after pause but replays an accepted ticket', async () => {
    const [hold] = await prisma.scheduledStakeHold.findMany({ where: { userId: buyerId }, orderBy: { createdAt: 'asc' } });
    await prisma.scheduledGameStream.update({ where: { id: streamId }, data: { enabled: false } });
    await expect(admitDormantSpinTicket(prisma, { userId: buyerId, roundId,
      holdId: uid('paused'), selections: bets })).rejects.toThrow('Round is not accepting wagers');
    const replay = await admitDormantSpinTicket(prisma, { userId: buyerId, roundId,
      holdId: hold.id, selections: bets });
    expect(replay.isReplay).toBe(true);
  });
});
