import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { financialNativeDatabase } from '../../test/financial-native-database.js';
import { QUICKNET_CHAIN_HASH, QUICKNET_PROTOCOL, quicknetTargetForCutoff } from './round-entropy.js';
import type * as Draw from './house-round-draw.js';
import type * as Recovery from './house-round-recovery.js';
import type * as Fixtures from '../../test/ledger-integrity-fixtures.js';
import type * as Admission from './house-ticket-admission.js';
import type * as Settlement from './house-ticket-settlement.js';
import type * as Invariants from '../../economy/ledger-invariant-checker.js';

// Public quicknet round 1, verified by drand-client with the pinned chain key.
const GOLDEN = {
  round: 1,
  randomness: '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a',
  signature: 'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b',
};
const GENESIS = 1_692_803_367_000n;
let database: Awaited<ReturnType<typeof financialNativeDatabase>> | undefined;
let owner: PrismaClient;
let draw: typeof Draw;
let recovery: typeof Recovery;
let purchasedFixture: typeof Fixtures.purchasedFixture;
let admitDormantSpinTicket: typeof Admission.admitDormantSpinTicket;
let cancelDormantSpinRound: typeof Settlement.cancelDormantSpinRound;
let settleDormantSpinTicket: typeof Settlement.settleDormantSpinTicket;
let runLedgerInvariantCheck: typeof Invariants.runLedgerInvariantCheck;

async function clock() {
  const [row] = await owner.$queryRaw<Array<{ ms: bigint }>>`
    SELECT pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint AS ms`;
  return row.ms;
}

async function round() {
  const streamId = `entropy${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const roundId = `${streamId}:0`;
  const opensMs = await clock() - 500n;
  const closesMs = opensMs + 4000n;
  await owner.scheduledGameStream.create({ data: { id: streamId, gameKey: 'spin_win',
    rulesId: SPIN90_RULES_ID, mode: 'FINANCIAL', enabled: true, anchorMs: opensMs,
    bettingMs: 4000, revealMs: 1000, resultMs: 1000 } });
  await owner.scheduledGameRound.create({ data: { id: roundId, streamId, sequence: 0n,
    gameKey: 'spin_win', rulesId: SPIN90_RULES_ID, mode: 'FINANCIAL', opensMs, closesMs,
    revealEndsMs: closesMs + 1000n, endsMs: closesMs + 2000n } });
  return { streamId, roundId, closesMs };
}

async function buyer() {
  const bought = await purchasedFixture(120);
  const method = await owner.paymentMethodDefinition.findFirstOrThrow({ where: {
    countryId: bought.country.id, type: 'BANK_TRANSFER', isActive: true,
  } });
  await owner.userPayoutAccount.create({ data: { userId: bought.buyer.id, countryId: bought.country.id,
    methodDefId: method.id, accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' }, status: 'ACTIVE' } });
  return bought;
}

async function proofState(roundId: string) {
  return {
    round: await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: roundId } }),
    seed: await owner.$queryRaw`SELECT * FROM public.house_round_randomness WHERE round_id=${roundId}`,
    pin: await owner.$queryRaw`SELECT * FROM public.house_round_beacon_pins WHERE round_id=${roundId}`,
  };
}

async function waitUntil(ms: bigint) {
  for (let count = 0; count < 150; count++) {
    if (await clock() >= ms) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Throwaway clock did not reach pinned time');
}

/** Test-only clock transplant: the real round-1 signature is already available.
 * Move immutable timing metadata back to 2023 in a replica-mode fixture tx;
 * no amounts, journal entries or financial terms are altered. Import, draw, settlement and recovery
 * afterward execute with ALL normal triggers enabled, with no mocked BLS.
 */
async function historicalClock(f: Awaited<ReturnType<typeof round>>) {
  const closes = GENESIS - 6001n;
  const opens = closes - 4000n;
  await owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw`UPDATE public.scheduled_game_streams SET anchor_ms=${opens} WHERE id=${f.streamId}`;
    await tx.$executeRaw`UPDATE public.scheduled_game_rounds SET opens_ms=${opens},closes_ms=${closes},
      reveal_ends_ms=${closes + 1000n},ends_ms=${closes + 2000n} WHERE id=${f.roundId}`;
    await tx.$executeRaw`UPDATE public.house_round_beacon_pins SET beacon_round=1,beacon_time_ms=${GENESIS},
      pinned_at=pg_catalog.to_timestamp(${Number(opens + 100n) / 1000}) WHERE round_id=${f.roundId}`;
    await tx.$executeRaw`UPDATE public.house_round_randomness
      SET prepared_at=pg_catalog.to_timestamp(${Number(opens + 200n) / 1000}) WHERE round_id=${f.roundId}`;
    await tx.$executeRaw`UPDATE public.scheduled_stake_holds h
      SET created_at=pg_catalog.to_timestamp(${Number(opens + 300n) / 1000})
      FROM public.economic_operations o WHERE o.id=h.hold_operation_id
        AND o.snapshot->'financialTicket'->>'roundId'=${f.roundId}`;
  });
  expect(await owner.$queryRaw`SELECT * FROM public.house_round_randomness_failures()`).toEqual([]);
}

beforeAll(async () => {
  database = await financialNativeDatabase('settlement'); owner = database.client;
  vi.doMock('@socialplay/database', async () => ({ ...await import('@prisma/client'), prisma: owner, default: owner }));
  draw = await import('./house-round-draw.js'); recovery = await import('./house-round-recovery.js');
  ({ purchasedFixture } = await import('../../test/ledger-integrity-fixtures.js'));
  ({ admitDormantSpinTicket } = await import('./house-ticket-admission.js'));
  ({ cancelDormantSpinRound, settleDormantSpinTicket } = await import('./house-ticket-settlement.js'));
  ({ runLedgerInvariantCheck } = await import('../../economy/ledger-invariant-checker.js'));
  const { bootstrapLedgerTestGates } = await import('../../economy/ledger-test-bootstrap.js');
  await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  const runId = await bootstrapLedgerTestGates();
  await owner.gameDefinition.update({ where: { key: 'spin_win' }, data: {
    catalogStatus: 'AVAILABLE', isActive: true, currentRulesVersion: 1,
  } });
  for (const key of ['HOUSE_TICKET_ADMISSION', 'SCHEDULED_STAKE_HOLD'])
    await owner.platformGate.update({ where: { key }, data: { enabled: true, lastInvariantRunId: runId } });
  await owner.$queryRaw`SELECT public.house_record_capital_funding(${`entropy:${randomUUID()}`},${1_000_000n},${'e'.repeat(64)})`;
}, 240_000);
afterAll(async () => { try { await database?.dispose(); } finally { vi.doUnmock('@socialplay/database'); } });

describe('future-beacon dormant financial integration', () => {
  it('pins once before admission and protects the target and proof history', async () => {
    const f = await round();
    const result = await draw.prepareDormantBeaconSpinRandomness(owner, f.roundId);
    expect(result).toMatchObject({ algorithm: QUICKNET_PROTOCOL, chainHash: QUICKNET_CHAIN_HASH,
      beaconRound: quicknetTargetForCutoff(Number(f.closesMs)).beaconRound, isReplay: false });
    expect(result).not.toHaveProperty('seedHex');
    const before = await proofState(f.roundId);
    expect(await draw.prepareDormantBeaconSpinRandomness(owner, f.roundId)).toMatchObject({ ...result, isReplay: true });
    await expect(owner.$executeRaw`UPDATE public.house_round_beacon_pins SET beacon_round=beacon_round+1
      WHERE round_id=${f.roundId}`).rejects.toThrow();
    await expect(owner.$executeRaw`DELETE FROM public.house_round_beacon_pins WHERE round_id=${f.roundId}`).rejects.toThrow();
    await expect(owner.$executeRawUnsafe('TRUNCATE public.house_round_beacon_pins')).rejects.toThrow();
    expect(await proofState(f.roundId)).toEqual(before);
  });

  it('never changes an existing seed-only protocol', async () => {
    const f = await round();
    await draw.prepareDormantSpinRandomness(owner, f.roundId);
    const before = await proofState(f.roundId);
    await expect(draw.prepareDormantBeaconSpinRandomness(owner, f.roundId)).rejects.toThrow('Historical');
    expect(await proofState(f.roundId)).toEqual(before);
  });

  it('waits for the same future event without drawing or refunding', async () => {
    const f = await round();
    await draw.prepareDormantBeaconSpinRandomness(owner, f.roundId);
    const before = await proofState(f.roundId);
    await expect(draw.drawDormantSpinRound(owner, f.roundId)).rejects.toThrow('pending');
    await expect(draw.recordDormantSpinBeacon(owner, f.roundId, GOLDEN)).rejects.toThrow('target');
    await expect(cancelDormantSpinRound(owner, { roundId: f.roundId, reason: 'beacon transport outage' })).rejects.toThrow('must await');
    await expect(owner.$executeRaw`UPDATE public.scheduled_game_rounds SET state='CANCELLED',
      cancel_reason='owner SQL outage' WHERE id=${f.roundId}`).rejects.toThrow('cannot');
    await waitUntil(f.closesMs);
    expect(await recovery.recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ phase: 'WAITING_ENTROPY', processed: 0 });
    expect(await proofState(f.roundId)).toEqual(before);
  });

  it('imports a real BLS proof, agrees with SQL, settles atomically and replays', async () => {
    const bought = await buyer(); const f = await round();
    await draw.prepareDormantBeaconSpinRandomness(owner, f.roundId);
    const holdId = `entropy_${randomUUID().replaceAll('-', '')}`;
    await admitDormantSpinTicket(owner, { userId: bought.buyer.id, roundId: f.roundId, holdId,
      selections: [{ marketId: 'red', amount: 40 }] });
    await historicalClock(f);
    expect(await draw.recordDormantSpinBeacon(owner, f.roundId, GOLDEN)).toMatchObject({ beaconRound: 1, isReplay: false });
    expect(await draw.recordDormantSpinBeacon(owner, f.roundId, GOLDEN)).toMatchObject({ isReplay: true });
    const result = await draw.drawDormantSpinRound(owner, f.roundId);
    const [sql] = await owner.$queryRaw<Array<{ outcome: number }>>`SELECT public.house_spin_outcome(${f.roundId}) AS outcome`;
    expect(result.outcome).toBe(sql.outcome);
    expect(result.beacon).toMatchObject({ beaconRound: 1, randomnessHex: GOLDEN.randomness });
    expect(await recovery.recoverDormantSpinRound(owner, { roundId: f.roundId }))
      .toMatchObject({ phase: 'COMPLETE', settled: 1, committed: 1 });
    const wallet = await owner.wallet.findUniqueOrThrow({ where: { userId: bought.buyer.id } });
    const state = await proofState(f.roundId);
    expect(await recovery.recoverDormantSpinRound(owner, { roundId: f.roundId })).toMatchObject({ committed: 0 });
    expect(await owner.wallet.findUniqueOrThrow({ where: { userId: bought.buyer.id } })).toEqual(wallet);
    expect(await proofState(f.roundId)).toEqual(state);
    expect(await draw.drawDormantSpinRound(owner, f.roundId)).toMatchObject({ outcome: result.outcome, isReplay: true });
    expect((await runLedgerInvariantCheck()).passed).toBe(true);
  });

  it('rejects cryptographic tampering before recording any proof', async () => {
    const f = await round(); await draw.prepareDormantBeaconSpinRandomness(owner, f.roundId); await historicalClock(f);
    const before = await proofState(f.roundId);
    await expect(draw.recordDormantSpinBeacon(owner, f.roundId, { ...GOLDEN, signature: '0'.repeat(96) })).rejects.toThrow();
    expect(await proofState(f.roundId)).toEqual(before);
  });

  it('runtime invariant, draw and direct settlement reject SQL-shaped proof without a valid BLS signature', async () => {
    const bought = await buyer(); const f = await round();
    await draw.prepareDormantBeaconSpinRandomness(owner, f.roundId);
    const holdId = `invalidproof_${randomUUID().replaceAll('-', '')}`;
    await admitDormantSpinTicket(owner, { userId: bought.buyer.id, roundId: f.roundId, holdId,
      selections: [{ marketId: 'red', amount: 40 }] });
    await historicalClock(f);
    // Owner SQL is not a BLS verifier. Demonstrate the independent application
    // backstop rather than treating a 48-byte shape/hash as signed proof.
    await owner.$executeRaw`UPDATE public.house_round_beacon_pins SET signature_hex=${'0'.repeat(96)},
      randomness_hex=pg_catalog.encode(public.digest(pg_catalog.decode(${'0'.repeat(96)},'hex'),'sha256'::text),'hex')
      WHERE round_id=${f.roundId}`;
    await expect(draw.drawDormantSpinRound(owner, f.roundId)).rejects.toThrow();
    // A fully privileged SQL caller can persist shape-valid draw metadata.
    // Even then the direct application settlement must reverify the signature.
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE public.house_round_randomness SET revealed_at=pg_catalog.clock_timestamp()
        WHERE round_id=${f.roundId}`;
      await tx.$executeRaw`UPDATE public.scheduled_game_rounds SET state='DRAWN',
        outcome=public.house_spin_outcome(${f.roundId}),drawn_at=pg_catalog.clock_timestamp() WHERE id=${f.roundId}`;
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });
    const walletBefore = await owner.wallet.findUniqueOrThrow({ where: { userId: bought.buyer.id } });
    await expect(settleDormantSpinTicket(owner, { holdId })).rejects.toThrow();
    expect(await owner.wallet.findUniqueOrThrow({ where: { userId: bought.buyer.id } })).toEqual(walletBefore);
    expect((await owner.scheduledStakeHold.findUniqueOrThrow({ where: { id: holdId } })).state).toBe('HELD');
    expect(await owner.houseTicketResolution.count({ where: { holdId } })).toBe(0);
    const scan = await runLedgerInvariantCheck();
    expect(scan.passed).toBe(false);
    expect(scan.violations.some((violation) => violation.invariant.startsWith('I22 '))).toBe(true);
    expect((await owner.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } })).state).toBe('DRAWN');
  });
});
