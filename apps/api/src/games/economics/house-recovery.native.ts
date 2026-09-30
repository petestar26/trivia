import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import type * as LedgerFixtures from '../../test/ledger-integrity-fixtures.js';
import type * as Bootstrap from '../../economy/ledger-test-bootstrap.js';
import type * as Admission from './house-ticket-admission.js';
import type * as Draw from './house-round-draw.js';
import type * as Settlement from './house-ticket-settlement.js';
import type * as Recovery from './house-round-recovery.js';
import { financialNativeDatabase } from '../../test/financial-native-database.js';

let database: Awaited<ReturnType<typeof financialNativeDatabase>> | undefined;
let owner: PrismaClient;
let purchasedFixture: typeof LedgerFixtures.purchasedFixture;
let bootstrapLedgerTestGates: typeof Bootstrap.bootstrapLedgerTestGates;
let admitDormantSpinTicket: typeof Admission.admitDormantSpinTicket;
let prepareDormantSpinRandomness: typeof Draw.prepareDormantSpinRandomness;
let cancelDormantSpinRound: typeof Settlement.cancelDormantSpinRound;
let getDormantSpinRecoveryStatus: typeof Recovery.getDormantSpinRecoveryStatus;
let recoverDormantSpinRound: typeof Recovery.recoverDormantSpinRound;

async function dbClock() {
  const [row] = await owner.$queryRaw<Array<{ now_ms: bigint }>>`
    SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint AS now_ms`;
  return row.now_ms;
}

async function fixture(ticketCount = 1, prepare = true) {
  const bought = await purchasedFixture(120);
  const method = await owner.paymentMethodDefinition.findFirstOrThrow({
    where: { countryId: bought.country.id, type: 'BANK_TRANSFER', isActive: true },
  });
  await owner.userPayoutAccount.create({ data: {
    userId: bought.buyer.id, countryId: bought.country.id, methodDefId: method.id,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' }, status: 'ACTIVE',
  } });
  const streamId = `recovery${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const roundId = `${streamId}:0`;
  const opensMs = await dbClock() - 500n;
  const closesMs = opensMs + 4000n;
  await owner.scheduledGameStream.create({ data: {
    id: streamId, gameKey: 'spin_win', rulesId: SPIN90_RULES_ID, mode: 'FINANCIAL', enabled: true,
    anchorMs: opensMs, bettingMs: 4000, revealMs: 1000, resultMs: 1000,
  } });
  await owner.scheduledGameRound.create({ data: {
    id: roundId, streamId, sequence: 0n, gameKey: 'spin_win', rulesId: SPIN90_RULES_ID, mode: 'FINANCIAL',
    opensMs, closesMs, revealEndsMs: closesMs + 1000n, endsMs: closesMs + 2000n,
  } });
  if (prepare) await prepareDormantSpinRandomness(owner, roundId);
  const holds: string[] = [];
  for (let index = 0; index < ticketCount; index++) {
    const holdId = `recovery_${randomUUID().replaceAll('-', '')}_${index}`;
    await admitDormantSpinTicket(owner, { userId: bought.buyer.id, roundId, holdId,
      selections: [{ marketId: `number:${index}`, amount: 40 }] });
    holds.push(holdId);
  }
  return { ...bought, roundId, holds, closesMs };
}

async function waitForCutoff(closesMs: bigint) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await dbClock() >= closesMs) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Throwaway database never reached cutoff');
}

async function snapshot(userId: string) {
  return {
    wallet: await owner.wallet.findUniqueOrThrow({ where: { userId } }),
    lots: await owner.coinProvenance.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    entries: await owner.coinLotEntry.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    operations: await owner.economicOperation.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    sessions: await owner.gameSession.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    capital: await owner.houseCapitalAccount.findUniqueOrThrow({ where: { currency: 'COINS' } }),
  };
}

beforeAll(async () => {
  database = await financialNativeDatabase('settlement');
  owner = database.client;
  vi.doMock('@socialplay/database', async () => ({ ...await import('@prisma/client'), prisma: owner, default: owner }));
  ({ purchasedFixture } = await import('../../test/ledger-integrity-fixtures.js'));
  ({ bootstrapLedgerTestGates } = await import('../../economy/ledger-test-bootstrap.js'));
  ({ admitDormantSpinTicket } = await import('./house-ticket-admission.js'));
  ({ prepareDormantSpinRandomness } = await import('./house-round-draw.js'));
  ({ cancelDormantSpinRound } = await import('./house-ticket-settlement.js'));
  ({ getDormantSpinRecoveryStatus, recoverDormantSpinRound } = await import('./house-round-recovery.js'));
  await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const runId = await bootstrapLedgerTestGates();
  await owner.gameDefinition.update({ where: { key: 'spin_win' }, data: {
    catalogStatus: 'AVAILABLE', isActive: true, currentRulesVersion: 1,
  } });
  for (const key of ['HOUSE_TICKET_ADMISSION', 'SCHEDULED_STAKE_HOLD'])
    await owner.platformGate.update({ where: { key }, data: { enabled: true, lastInvariantRunId: runId } });
  await owner.$queryRaw`SELECT public.house_record_capital_funding(${`bank:${randomUUID()}`},${1_000_000n},${'c'.repeat(64)})`;
}, 240_000);

afterAll(async () => {
  try { await database?.dispose(); }
  finally { vi.doUnmock('@socialplay/database'); }
});

describe('bounded dormant financial recovery', () => {
  it('requires an explicit write mode for proof preparation/import and bounds CLI input', async () => {
    const { parseRecoveryCommand } = await import('../../scripts/house-round-recovery.js');
    expect(parseRecoveryCommand(['--round=round:0'])).toMatchObject({ run: false, limit: 10 });
    expect(parseRecoveryCommand(['--round', 'round:0', '--run', '--limit=100', '--prepare-beacon',
      '--beacon-proof', '/tmp/proof.json'])).toMatchObject({ run: true, limit: 100, prepareBeacon: true });
    for (const args of [
      ['--round=round:0', '--prepare-beacon'], ['--round=round:0', '--beacon-proof=proof.json'],
      ['--round=round:0', '--limit=101'], ['--round=round:0', '--limit=0'],
      ['--round=round:0', '--limit=1.5'], ['--round=round:0', '--limit=1e1'],
      ['--round=round:0', '--run', '--run'], ['--round=round:0', '--unknown'],
    ]) expect(() => parseRecoveryCommand(args)).toThrow();
  });

  it('status and an early recovery preserve all financial state', async () => {
    const f = await fixture();
    const before = await snapshot(f.buyer.id);
    expect(await getDormantSpinRecoveryStatus(owner, f.roundId))
      .toMatchObject({ phase: 'WAITING_CUTOFF', total: 1, pending: 1, grossPayout: '0' });
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ phase: 'WAITING_CUTOFF', processed: 0, committed: 0 });
    expect(await snapshot(f.buyer.id)).toEqual(before);
    await cancelDormantSpinRound(owner, { roundId: f.roundId, reason: 'finish early recovery fixture' });
    await recoverDormantSpinRound(owner, { roundId: f.roundId });
  });

  it('settles one bounded batch, resumes the stored result and makes completed replay read-only', async () => {
    const f = await fixture(3);
    await waitForCutoff(f.closesMs);
    const first = await recoverDormantSpinRound(owner, { roundId: f.roundId, limit: 1 });
    expect(first).toMatchObject({ state: 'DRAWN', phase: 'READY_SETTLEMENT', total: 3,
      pending: 2, settled: 1, processed: 1, committed: 1, hasMore: true });
    const drawn = await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } });
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId, limit: 100 }))
      .toMatchObject({ phase: 'COMPLETE', pending: 0, settled: 3, processed: 2, committed: 2 });
    expect(await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } })).toEqual(drawn);
    const before = await snapshot(f.buyer.id);
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ phase: 'COMPLETE', processed: 0, committed: 0, replayed: 0 });
    expect(await snapshot(f.buyer.id)).toEqual(before);
  });

  it('fails closed on a missing commitment after cutoff without cancelling the round', async () => {
    const f = await fixture(0, false);
    await waitForCutoff(f.closesMs);
    const before = await snapshot(f.buyer.id);
    await expect(recoverDormantSpinRound(owner, { roundId: f.roundId })).rejects.toThrow('commitment');
    expect(await snapshot(f.buyer.id)).toEqual(before);
    expect((await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } })).state).toBe('OPEN');
    // Manual legacy empty-round cancellation must not evaluate a missing seed.
    await cancelDormantSpinRound(owner, { roundId: f.roundId, reason: 'finish empty legacy fixture' });
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ state: 'CANCELLED', phase: 'COMPLETE', refunded: 0 });
    // Retain the empty blocked round as evidence until this file's private
    // database is dropped; recovery must not invent a seed or cancellation.
  });

  it('concurrent coordinators discharge each ticket once', async () => {
    const f = await fixture(3);
    await waitForCutoff(f.closesMs);
    const results = await Promise.all([
      recoverDormantSpinRound(owner, { roundId: f.roundId, limit: 3 }),
      recoverDormantSpinRound(owner, { roundId: f.roundId, limit: 3 }),
    ]);
    expect(results.every((result) => result.phase === 'COMPLETE')).toBe(true);
    expect(results.reduce((count, result) => count + result.committed, 0)).toBe(3);
    expect(await owner.houseTicketResolution.count({ where: { roundId: f.roundId } })).toBe(3);
    expect(await owner.gameSession.count({ where: { userId: f.buyer.id } })).toBe(3);
  });

  it('refunds a stored cancellation without attempting a draw', async () => {
    const f = await fixture(2);
    await cancelDormantSpinRound(owner, { roundId: f.roundId, reason: 'recover already cancelled round' });
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId, limit: 1 }))
      .toMatchObject({ state: 'CANCELLED', refunded: 1, pending: 1 });
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ state: 'CANCELLED', phase: 'COMPLETE', refunded: 2, grossPayout: '80' });
    expect((await owner.wallet.findUniqueOrThrow({ where: { userId: f.buyer.id } })).coinsBalance).toBe(120);
    expect((await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } })).outcome).toBeNull();
  });

  it('retains the first committed ticket on failure and resumes the failed ticket after repair', async () => {
    const f = await fixture(3);
    await waitForCutoff(f.closesMs);
    const ordered = [...f.holds].sort();
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `recovery_block_${suffix}`;
    const triggerName = `recovery_block_${suffix}`;
    // Generated IDs contain only letters/digits/underscores, never SQL input.
    await owner.$executeRawUnsafe(`CREATE FUNCTION public.${functionName}() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $body$ BEGIN
      IF NEW.hold_id='${ordered[1]}' THEN RAISE EXCEPTION 'forced recovery stop'; END IF;
      RETURN NEW; END $body$`);
    await owner.$executeRawUnsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.house_ticket_resolutions
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    try {
      await expect(recoverDormantSpinRound(owner, { roundId: f.roundId, limit: 3 }))
        .rejects.toMatchObject({ name: 'HouseRoundRecoveryError', processed: 1, blockedHoldId: ordered[1] });
      expect(await getDormantSpinRecoveryStatus(owner, f.roundId))
        .toMatchObject({ state: 'DRAWN', settled: 1, pending: 2 });
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER ${triggerName} ON public.house_ticket_resolutions`);
      await owner.$executeRawUnsafe(`DROP FUNCTION public.${functionName}()`);
    }
    expect(await recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ phase: 'COMPLETE', settled: 3, committed: 2 });
  });

  it('refuses runtime credentials and invalid limits without financial changes', async () => {
    const f = await fixture();
    const before = await snapshot(f.buyer.id);
    for (const limit of [0, 101, 1.5, NaN])
      await expect(recoverDormantSpinRound(owner, { roundId: f.roundId, limit })).rejects.toThrow('limit');
    const role = `playqube_recovery_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    await owner.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
    const runtimeUrl = new URL(database!.url);
    runtimeUrl.username = role;
    runtimeUrl.password = '';
    const runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
    try {
      await expect(getDormantSpinRecoveryStatus(runtime, f.roundId)).rejects.toThrow('owner-only');
      await expect(recoverDormantSpinRound(runtime, { roundId: f.roundId })).rejects.toThrow('owner-only');
    } finally {
      await runtime.$disconnect();
      await owner.$executeRawUnsafe(`DROP ROLE ${role}`);
    }
    expect(await snapshot(f.buyer.id)).toEqual(before);
    await cancelDormantSpinRound(owner, { roundId: f.roundId, reason: 'finish refused runtime fixture' });
    await recoverDormantSpinRound(owner, { roundId: f.roundId });
  });
});
