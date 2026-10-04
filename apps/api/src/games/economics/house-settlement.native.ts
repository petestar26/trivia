import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type * as LedgerFixtures from '../../test/ledger-integrity-fixtures.js';
import type * as LedgerBootstrap from '../../economy/ledger-test-bootstrap.js';
import type * as CoinLedger from '../../economy/coin-ledger-service.js';
import type * as LedgerInvariant from '../../economy/ledger-invariant-checker.js';
import type * as TicketAdmission from './house-ticket-admission.js';
import type * as TicketSettlement from './house-ticket-settlement.js';
import type * as RoundDraw from './house-round-draw.js';
import { financialNativeDatabase } from '../../test/financial-native-database.js';

let database: Awaited<ReturnType<typeof financialNativeDatabase>> | undefined;
let prisma: PrismaClient;
let purchasedFixture: typeof LedgerFixtures.purchasedFixture;
let uid: typeof LedgerFixtures.uid;
let bootstrapLedgerTestGates: typeof LedgerBootstrap.bootstrapLedgerTestGates;
let creditCoins: typeof CoinLedger.creditCoins;
let runLedgerInvariantCheck: typeof LedgerInvariant.runLedgerInvariantCheck;
let admitDormantSpinTicket: typeof TicketAdmission.admitDormantSpinTicket;
let cancelDormantSpinRound: typeof TicketSettlement.cancelDormantSpinRound;
let settleDormantSpinTicket: typeof TicketSettlement.settleDormantSpinTicket;
let deriveSpinCommittedOutcome: typeof RoundDraw.deriveSpinCommittedOutcome;
let drawDormantSpinRound: typeof RoundDraw.drawDormantSpinRound;
let prepareDormantSpinRandomness: typeof RoundDraw.prepareDormantSpinRandomness;

let runId: string;

async function dbClock() {
  const [clock] = await prisma.$queryRaw<Array<{ now_ms: bigint }>>`
    SELECT floor(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint AS now_ms`;
  return clock.now_ms;
}

async function waitForCutoff(roundId: string) {
  const { closesMs } = await prisma.scheduledGameRound.findUniqueOrThrow({ where: { id: roundId } });
  for (let count = 0; count < 100; count++) {
    if (await dbClock() >= closesMs) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Throwaway database clock never reached the round cutoff');
}

async function setGameEnabled(enabled: boolean) {
  await prisma.gameDefinition.update({ where: { key: 'spin_win' }, data: {
    catalogStatus: enabled ? 'AVAILABLE' : 'COMING_SOON', isActive: enabled,
    currentRulesVersion: enabled ? 1 : null,
  } });
  for (const key of ['HOUSE_TICKET_ADMISSION', 'SCHEDULED_STAKE_HOLD']) {
    await prisma.platformGate.update({ where: { key }, data: { enabled, lastInvariantRunId: runId } });
  }
}

async function createRound() {
  const streamId = `settle${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const roundId = `${streamId}:0`;
  const anchor = await dbClock() - 1000n;
  await prisma.scheduledGameStream.create({ data: {
    id: streamId, gameKey: 'spin_win', rulesId: SPIN90_RULES_ID,
    mode: 'FINANCIAL', enabled: true, anchorMs: anchor,
    bettingMs: 4000, revealMs: 1000, resultMs: 1000,
  } });
  await prisma.scheduledGameRound.create({ data: {
    id: roundId, streamId, sequence: 0n, gameKey: 'spin_win', rulesId: SPIN90_RULES_ID,
    mode: 'FINANCIAL', opensMs: anchor, closesMs: anchor + 4000n,
    revealEndsMs: anchor + 5000n, endsMs: anchor + 6000n,
  } });
  return { streamId, roundId };
}

async function fixture(options: { bonus?: number; winning?: boolean; stake?: number; netReward?: boolean } = {}) {
  const purchased = await purchasedFixture(120);
  const method = await prisma.paymentMethodDefinition.findFirstOrThrow({
    where: { countryId: purchased.country.id, type: 'BANK_TRANSFER', isActive: true },
  });
  await prisma.userPayoutAccount.create({ data: {
    userId: purchased.buyer.id, countryId: purchased.country.id, methodDefId: method.id,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' }, status: 'ACTIVE',
  } });
  const policy = await prisma.countryCasinoPolicy.findFirstOrThrow({
    where: { countryCode: purchased.country.code, state: 'ACTIVE' },
  });
  let bonusLotId: string | null = null;
  if (options.bonus) {
    const grantId = uid('scheduled-bonus');
    const bonus = await prisma.$transaction((tx) => creditCoins(tx, purchased.buyer.id, options.bonus!, {
      type: 'BONUS_GRANT', scopeType: 'TEST', scopeId: grantId,
      referenceType: 'GAME', referenceId: grantId, description: 'Restricted scheduled fixture',
      policy: { id: policy.id, version: policy.version }, requirementAmount: options.bonus! * 2,
      expiresAt: new Date(Date.now() + 86_400_000),
      ...(options.netReward ? { bonusRule: 'NET_WINNINGS_V1' as const } : {}),
    }));
    bonusLotId = bonus.lotId;
  }
  const { streamId, roundId } = await createRound();
  await prepareDormantSpinRandomness(prisma, roundId);
  // The owner-only dormant runner can read the seed. This fixture predicts
  // a result solely to exercise both payout branches; no service takes it.
  const [commit] = await prisma.$queryRaw<Array<{ seed_hex: string }>>`
    SELECT seed_hex FROM public.house_round_randomness WHERE round_id=${roundId}`;
  const outcome = deriveSpinCommittedOutcome(roundId, SPIN90_RULES_ID, commit.seed_hex);
  const selected = options.winning === false ? (outcome + 1) % 37 : outcome;
  const holdId = uid('settlement');
  const selections = [{ marketId: `number:${selected}`, amount: options.stake ?? 40 }];
  const capitalBefore = await prisma.houseCapitalAccount.findUniqueOrThrow({ where: { currency: 'COINS' } });
  const lotsBefore = await prisma.coinProvenance.findMany({
    where: { userId: purchased.buyer.id }, orderBy: { id: 'asc' },
  });
  const accepted = await admitDormantSpinTicket(prisma, {
    userId: purchased.buyer.id, roundId, holdId, selections,
  });
  return { ...purchased, streamId, roundId, holdId, selections, outcome,
    accepted, capitalBefore, lotsBefore, bonusLotId };
}

async function resolution(holdId: string) {
  const rows = await prisma.$queryRaw<Array<{
    hold_id: string; round_id: string; operation_id: string; disposition: string;
    payout: number; house_delta: bigint; released_loss: bigint; coins_balance: number;
  }>>`SELECT * FROM public.house_ticket_resolutions WHERE hold_id=${holdId}`;
  return rows;
}

async function financialSnapshot(userId: string, holdId: string) {
  const [wallet, lots, entries, operations, transactions, sessions, hold, capital, resolved] = await Promise.all([
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),
    prisma.coinProvenance.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.coinLotEntry.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.economicOperation.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.walletTransaction.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.gameSession.findMany({ where: { userId }, orderBy: { id: 'asc' } }),
    prisma.scheduledStakeHold.findUniqueOrThrow({ where: { id: holdId } }),
    prisma.houseCapitalAccount.findUniqueOrThrow({ where: { currency: 'COINS' } }),
    resolution(holdId),
  ]);
  return { wallet, lots, entries, operations, transactions, sessions, hold, capital, resolved };
}

beforeAll(async () => {
  database = await financialNativeDatabase('settlement');
  prisma = database.client;
  // Every fixture and real service uses this file's fresh PostgreSQL client.
  vi.doMock('@socialplay/database', async () => ({
    ...await import('@prisma/client'), prisma, default: prisma,
  }));
  ({ purchasedFixture, uid } = await import('../../test/ledger-integrity-fixtures.js'));
  ({ bootstrapLedgerTestGates } = await import('../../economy/ledger-test-bootstrap.js'));
  ({ creditCoins } = await import('../../economy/coin-ledger-service.js'));
  ({ runLedgerInvariantCheck } = await import('../../economy/ledger-invariant-checker.js'));
  ({ admitDormantSpinTicket } = await import('./house-ticket-admission.js'));
  ({ cancelDormantSpinRound, settleDormantSpinTicket } = await import('./house-ticket-settlement.js'));
  ({ deriveSpinCommittedOutcome, drawDormantSpinRound, prepareDormantSpinRandomness } =
    await import('./house-round-draw.js'));
  await prisma.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  runId = await bootstrapLedgerTestGates();
  await setGameEnabled(true);
  await prisma.$queryRaw`SELECT public.house_record_capital_funding(${`bank:${randomUUID()}`},${1_000_000n},${'c'.repeat(64)})`;
}, 240_000);

afterAll(async () => {
  try { await database?.dispose(); }
  finally { vi.doUnmock('@socialplay/database'); }
});

describe('dormant Spin Win draw and ticket settlement', () => {
  it('unlocks only net reward profit after scheduled settlement, with exact retry', async () => {
    const f = await fixture({ bonus: 40, stake: 80, netReward: true });
    await waitForCutoff(f.roundId);
    await drawDormantSpinRound(prisma, f.roundId);
    const settled = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    expect(settled).toMatchObject({ payout: 2664, coinsBalance: 2744, isReplay: false });
    const lots = await prisma.coinProvenance.findMany({ where: { userId: f.buyer.id } });
    expect(lots.find((lot) => lot.id === f.bonusLotId)).toMatchObject({
      lotClass: 'RESTRICTED', bonusRule: 'NET_WINNINGS_V1', availableAmount: 40,
      reservedAmount: 0, progressAmount: 0,
    });
    expect(lots.filter((lot) => lot.lotClass === 'WITHDRAWABLE')
      .reduce((total, lot) => {
        if (lot.availableAmount === null) throw new Error('Settled lot must have an available amount');
        return total + lot.availableAmount;
      }, 0)).toBe(2704);
    expect(lots.find((lot) => lot.parentLotId === f.bonusLotId)).toMatchObject({
      lotClass: 'WITHDRAWABLE', availableAmount: 1292,
    });
    const beforeRetry = await financialSnapshot(f.buyer.id, f.holdId);
    expect(await settleDormantSpinTicket(prisma, { holdId: f.holdId })).toMatchObject({
      payout: 2664, coinsBalance: 2744, isReplay: true,
    });
    expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(beforeRetry);
  });

  it('requires a pre-admission commitment and rejects an early draw without financial writes', async () => {
    const f = await fixture();
    const empty = await createRound();
    const uncommittedHold = uid('uncommitted');
    const before = await financialSnapshot(f.buyer.id, f.holdId);
    await expect(admitDormantSpinTicket(prisma, { userId: f.buyer.id, roundId: empty.roundId,
      holdId: uncommittedHold, selections: f.selections })).rejects.toThrow(/commitment|randomness/i);
    expect(await prisma.scheduledStakeHold.findUnique({ where: { id: uncommittedHold } })).toBeNull();
    await expect(drawDormantSpinRound(prisma, f.roundId)).rejects.toThrow('cutoff');
    expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(before);
    expect(await prisma.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } }))
      .toMatchObject({ state: 'OPEN', outcome: null, drawnAt: null });
    await cancelDormantSpinRound(prisma, { roundId: f.roundId, reason: 'end early draw fixture' });
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
  });

  it('credits a mixed-funded win to its original restricted and purchased lots without progress', async () => {
    const f = await fixture({ bonus: 40, stake: 80 });
    const afterHold = await prisma.wallet.findUniqueOrThrow({ where: { userId: f.buyer.id } });
    expect(afterHold.coinsBalance).toBe(80);
    expect(f.accepted.lossReserve).toBe(2584n);
    await waitForCutoff(f.roundId);
    const draw = await drawDormantSpinRound(prisma, f.roundId);
    expect(draw.outcome).toBe(f.outcome);
    const settled = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    expect(settled).toMatchObject({ holdId: f.holdId, roundId: f.roundId,
      payout: 2664, coinsBalance: 2744, disposition: 'SETTLED', isReplay: false });
    const afterLots = await prisma.coinProvenance.findMany({ where: { userId: f.buyer.id } });
    expect(afterLots).toHaveLength(f.lotsBefore.length);
    const purchased = afterLots.find((lot) => lot.id === f.purchaseLot.id)!;
    const bonus = afterLots.find((lot) => lot.id === f.bonusLotId)!;
    expect(purchased).toMatchObject({ lotClass: 'WITHDRAWABLE', availableAmount: 1412, reservedAmount: 0 });
    expect(bonus).toMatchObject({ lotClass: 'RESTRICTED', availableAmount: 1332, reservedAmount: 0,
      requirementAmount: 80, progressAmount: 0 });
    for (const before of f.lotsBefore) {
      const after = afterLots.find((lot) => lot.id === before.id)!;
      expect(after).toMatchObject({ sourceOperationId: before.sourceOperationId,
        countryPolicyId: before.countryPolicyId, countryPolicyVersion: before.countryPolicyVersion,
        expiresAt: before.expiresAt, parentLotId: before.parentLotId,
        originalSource: before.originalSource, requirementAmount: before.requirementAmount,
        progressAmount: before.progressAmount });
    }
    const capital = await prisma.houseCapitalAccount.findUniqueOrThrow({ where: { currency: 'COINS' } });
    expect(capital.fundedAmount).toBe(f.capitalBefore.fundedAmount - 2584n);
    expect(capital.reservedAmount).toBe(f.capitalBefore.reservedAmount);
    expect(await resolution(f.holdId)).toMatchObject([{ payout: 2664,
      house_delta: -2584n, released_loss: 2584n, disposition: 'SETTLED' }]);
    expect((await prisma.scheduledStakeHold.findUniqueOrThrow({ where: { id: f.holdId } })).state).toBe('SETTLED');
    expect(await prisma.gameSession.findUniqueOrThrow({ where: { id: `scheduled:${f.holdId}` } })).toMatchObject({
      userId: f.buyer.id, wagerCurrency: 'COINS', rewardCurrency: 'COINS',
      betAmount: 80, rewardAmount: 2664, status: 'COMPLETED',
      responseSnapshot: settled,
    });
  });

  it('loses only the already-held stake and releases the capital reserve', async () => {
    const f = await fixture({ winning: false });
    const afterHold = await financialSnapshot(f.buyer.id, f.holdId);
    await waitForCutoff(f.roundId);
    await drawDormantSpinRound(prisma, f.roundId);
    const result = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    expect(result).toMatchObject({ payout: 0, coinsBalance: 80, disposition: 'SETTLED' });
    const after = await financialSnapshot(f.buyer.id, f.holdId);
    expect(after.wallet.coinsBalance).toBe(afterHold.wallet.coinsBalance);
    expect(after.transactions).toHaveLength(afterHold.transactions.length);
    expect(after.lots.every((lot) => lot.reservedAmount === 0)).toBe(true);
    expect(after.capital.fundedAmount).toBe(f.capitalBefore.fundedAmount + 40n);
    expect(after.capital.reservedAmount).toBe(f.capitalBefore.reservedAmount);
    expect(after.resolved).toMatchObject([{ payout: 0, house_delta: 40n, released_loss: 1292n }]);
  });

  it('persists one draw and settlement snapshot across pauses and changed catalog rules', async () => {
    const f = await fixture();
    await expect(settleDormantSpinTicket(prisma, { holdId: f.holdId })).rejects.toThrow();
    await waitForCutoff(f.roundId);
    const draw = await drawDormantSpinRound(prisma, f.roundId);
    const result = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    const before = await financialSnapshot(f.buyer.id, f.holdId);
    try {
      await setGameEnabled(false);
      await prisma.scheduledGameStream.update({ where: { id: f.streamId }, data: { enabled: false } });
      expect(await drawDormantSpinRound(prisma, f.roundId)).toMatchObject({
        outcome: draw.outcome, seedHex: draw.seedHex, commitmentSha256: draw.commitmentSha256, isReplay: true,
      });
      expect(await settleDormantSpinTicket(prisma, { holdId: f.holdId })).toMatchObject({ ...result, isReplay: true });
      expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(before);
    } finally { await setGameEnabled(true); }
  });

  it('refunds cancellation to exactly its source lots and releases the reserve once', async () => {
    const f = await fixture({ bonus: 40, stake: 80 });
    const reason = 'fixture cancellation before draw';
    const cancellation = await cancelDormantSpinRound(prisma, { roundId: f.roundId, reason });
    const seed = await prisma.houseRoundRandomness.findUniqueOrThrow({ where: { roundId: f.roundId } });
    expect(cancellation).toMatchObject({ seedHex: seed.seedHex,
      commitmentSha256: seed.commitmentSha256, wouldBeOutcome: f.outcome,
      revealedAt: seed.revealedAt, isReplay: false });
    expect(seed).toMatchObject({ cancelledOutcome: f.outcome, revealedAt: expect.any(Date) });
    expect(await cancelDormantSpinRound(prisma, { roundId: f.roundId, reason }))
      .toEqual({ ...cancellation, isReplay: true });
    const result = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    expect(result).toMatchObject({ payout: 80, coinsBalance: 160, disposition: 'CANCELLED', isReplay: false });
    const after = await financialSnapshot(f.buyer.id, f.holdId);
    for (const before of f.lotsBefore) {
      const lot = after.lots.find((row) => row.id === before.id)!;
      expect(lot).toMatchObject({ availableAmount: before.availableAmount,
        reservedAmount: before.reservedAmount, lotClass: before.lotClass,
        requirementAmount: before.requirementAmount, progressAmount: before.progressAmount,
        countryPolicyId: before.countryPolicyId, expiresAt: before.expiresAt });
    }
    expect(after.hold.state).toBe('REFUNDED');
    expect(after.capital).toEqual(f.capitalBefore);
    expect(after.resolved).toMatchObject([{ disposition: 'CANCELLED', payout: 80,
      house_delta: 0n, released_loss: 2584n }]);
    expect(await settleDormantSpinTicket(prisma, { holdId: f.holdId })).toMatchObject({ ...result, isReplay: true });
    expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(after);
    await expect(drawDormantSpinRound(prisma, f.roundId)).rejects.toThrow();
  });

  it('rejects an unaudited cancellation and makes its disclosed would-be result immutable', async () => {
    const f = await fixture();
    const before = await financialSnapshot(f.buyer.id, f.holdId);
    await expect(prisma.$executeRaw`UPDATE public.scheduled_game_rounds
      SET state='CANCELLED',cancel_reason='unrecorded expensive result' WHERE id=${f.roundId}`)
      .rejects.toThrow(/undrawn financial round/i);
    expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(before);
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE public.house_round_randomness
        SET revealed_at=clock_timestamp(),cancelled_outcome=${(f.outcome + 1) % 37}
        WHERE round_id=${f.roundId}`;
    })).rejects.toThrow(/committed outcome/i);
    await expect(prisma.$executeRaw`UPDATE public.house_round_randomness
      SET revealed_at=clock_timestamp(),cancelled_outcome=${f.outcome} WHERE round_id=${f.roundId}`)
      .rejects.toThrow(/financial randomness proof mismatch/i);
    const audit = await cancelDormantSpinRound(prisma, { roundId: f.roundId, reason: 'recorded cancellation test' });
    expect(audit.wouldBeOutcome).toBe(f.outcome);
    await expect(prisma.$executeRaw`UPDATE public.house_round_randomness
      SET cancelled_outcome=${(f.outcome + 1) % 37} WHERE round_id=${f.roundId}`)
      .rejects.toThrow(/immutable/i);
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    expect((await runLedgerInvariantCheck()).passed).toBe(true);
  });

  it('rejects republishing a semantic rules ID and settles with its original published version', async () => {
    const f = await fixture();
    const published = await prisma.gameRules.findFirstOrThrow({
      where: { rules: { path: ['rulesId'], equals: SPIN90_RULES_ID } },
    });
    await expect(prisma.$executeRaw`INSERT INTO public.game_rules
      (id,"gameId",version,mode,family,"wagerCurrency","rewardCurrency",
       rules,"rulesHash","resultSchemaVersion","createdAt")
      SELECT ${uid('duplicate-rules')},"gameId",version+100,mode,family,"wagerCurrency","rewardCurrency",
        rules,"rulesHash","resultSchemaVersion",clock_timestamp()
      FROM public.game_rules WHERE id=${published.id}`).rejects.toMatchObject({
        meta: { code: '23505', message: expect.stringContaining("rules ->> 'rulesId'") },
      });
    await waitForCutoff(f.roundId);
    await drawDormantSpinRound(prisma, f.roundId);
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: `scheduled:${f.holdId}` } });
    expect(session.rulesVersion).toBe(published.version);
  });

  it('cannot cancel an already drawn round or substitute its stored result', async () => {
    const f = await fixture();
    await waitForCutoff(f.roundId);
    const draw = await drawDormantSpinRound(prisma, f.roundId);
    await expect(cancelDormantSpinRound(prisma, { roundId: f.roundId, reason: 'late cancellation' })).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE public.scheduled_game_rounds
      SET outcome=${(draw.outcome + 1) % 37} WHERE id=${f.roundId}`).rejects.toThrow();
    expect((await drawDormantSpinRound(prisma, f.roundId)).outcome).toBe(draw.outcome);
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
  });

  it('serializes a cutoff draw racing audited cancellation into one terminal result', async () => {
    const f = await fixture();
    await waitForCutoff(f.roundId);
    const raced = await Promise.allSettled([
      drawDormantSpinRound(prisma, f.roundId),
      cancelDormantSpinRound(prisma, { roundId: f.roundId, reason: 'audited cutoff race' }),
    ]);
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const round = await prisma.scheduledGameRound.findUniqueOrThrow({ where: { id: f.roundId } });
    const seed = await prisma.houseRoundRandomness.findUniqueOrThrow({ where: { roundId: f.roundId } });
    expect(seed.revealedAt).toBeInstanceOf(Date);
    const settled = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    if (round.state === 'DRAWN') {
      expect(round.outcome).toBe(f.outcome);
      expect(seed.cancelledOutcome).toBeNull();
      expect(settled.disposition).toBe('SETTLED');
    } else {
      expect(round.state).toBe('CANCELLED');
      expect(seed.cancelledOutcome).toBe(f.outcome);
      expect(settled).toMatchObject({ disposition: 'CANCELLED', payout: 40 });
    }
  });

  it('concurrent settlement requests commit one payout and replay one persisted result', async () => {
    const f = await fixture();
    await waitForCutoff(f.roundId);
    await drawDormantSpinRound(prisma, f.roundId);
    const results = await Promise.all([
      settleDormantSpinTicket(prisma, { holdId: f.holdId }),
      settleDormantSpinTicket(prisma, { holdId: f.holdId }),
    ]);
    expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
    expect(results.filter((result) => result.isReplay)).toHaveLength(1);
    expect(results[0].operationId).toBe(results[1].operationId);
    expect(results[0].coinsBalance).toBe(results[1].coinsBalance);
    expect(await resolution(f.holdId)).toHaveLength(1);
    expect((await prisma.wallet.findUniqueOrThrow({ where: { userId: f.buyer.id } })).coinsBalance).toBe(1412);
  });

  it('concurrent draws reveal the same committed seed and result exactly once', async () => {
    const f = await fixture();
    await waitForCutoff(f.roundId);
    const results = await Promise.all([
      drawDormantSpinRound(prisma, f.roundId), drawDormantSpinRound(prisma, f.roundId),
    ]);
    expect(results.filter((result) => !result.isReplay)).toHaveLength(1);
    expect(results.filter((result) => result.isReplay)).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: results[1].outcome,
      seedHex: results[1].seedHex, commitmentSha256: results[1].commitmentSha256,
      drawnAt: results[1].drawnAt });
    expect(results[0].outcome).toBe(f.outcome);
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
  });

  it('rolls back payout, lot journal, hold and capital when the resolution insert fails', async () => {
    const f = await fixture();
    await waitForCutoff(f.roundId);
    await drawDormantSpinRound(prisma, f.roundId);
    const before = await financialSnapshot(f.buyer.id, f.holdId);
    const suffix = randomUUID().replaceAll('-', '');
    const fn = `settlement_fail_${suffix}`;
    const message = `forced settlement resolution failure ${suffix}`;
    await prisma.$executeRawUnsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.hold_id='${f.holdId}' THEN RAISE EXCEPTION '${message}'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON public.house_ticket_resolutions
      FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try {
      await expect(settleDormantSpinTicket(prisma, { holdId: f.holdId })).rejects.toThrow(message);
      expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${fn} ON public.house_ticket_resolutions`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION public.${fn}()`);
    }
    const retried = await settleDormantSpinTicket(prisma, { holdId: f.holdId });
    expect(retried).toMatchObject({ payout: 1332, coinsBalance: 1412, isReplay: false });
  });

  it('rejects forged resolution and a terminal hold without its relational proof', async () => {
    const f = await fixture();
    const before = await financialSnapshot(f.buyer.id, f.holdId);
    const hold = await prisma.scheduledStakeHold.findUniqueOrThrow({ where: { id: f.holdId } });
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO public.house_ticket_resolutions
        (hold_id,round_id,operation_id,disposition,payout,house_delta,released_loss,coins_balance)
        VALUES (${f.holdId},${f.roundId},${hold.holdOperationId},'SETTLED',1332,-1292,1292,1412)`;
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    })).rejects.toThrow();
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE public.scheduled_stake_holds SET state='SETTLED' WHERE id=${f.holdId}`;
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    })).rejects.toThrow();
    expect(await financialSnapshot(f.buyer.id, f.holdId)).toEqual(before);
    await cancelDormantSpinRound(prisma, { roundId: f.roundId, reason: 'end forged resolution fixture' });
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
  });

  it('refuses accidental runtime DML on owner-only resolution records', async () => {
    const f = await fixture();
    const role = `settlement_runtime_${randomUUID().replaceAll('-', '')}`;
    await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
      await prisma.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.house_ticket_resolutions,
        public.scheduled_stake_holds, public.scheduled_game_rounds TO "${role}"`);
      const hold = await prisma.scheduledStakeHold.findUniqueOrThrow({ where: { id: f.holdId } });
      await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        await tx.$executeRaw`INSERT INTO public.house_ticket_resolutions
          (hold_id,round_id,operation_id,disposition,payout,house_delta,released_loss,coins_balance)
          VALUES (${f.holdId},${f.roundId},${hold.holdOperationId},'SETTLED',1332,-1292,1292,1412)`;
      })).rejects.toThrow();
      expect(await resolution(f.holdId)).toHaveLength(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
    await cancelDormantSpinRound(prisma, { roundId: f.roundId, reason: 'end restricted role fixture' });
    await settleDormantSpinTicket(prisma, { holdId: f.holdId });
  });

  it('reconciles committed house funds, active reservations and the complete Coin journal', async () => {
    const [totals] = await prisma.$queryRaw<Array<{ funds: bigint; reserved: bigint }>>`
      SELECT
        (SELECT COALESCE(sum(amount),0) FROM public.house_capital_fundings) +
        (SELECT COALESCE(sum(house_delta),0) FROM public.house_ticket_resolutions) AS funds,
        (SELECT COALESCE(sum(r.reserved_loss),0) FROM public.house_round_reservations r
         WHERE NOT EXISTS (SELECT 1 FROM public.house_ticket_resolutions t WHERE r.round_id='ticket:'||t.hold_id)) AS reserved`;
    const capital = await prisma.houseCapitalAccount.findUniqueOrThrow({ where: { currency: 'COINS' } });
    expect(capital.fundedAmount).toBe(BigInt(String(totals.funds)));
    expect(capital.reservedAmount).toBe(BigInt(String(totals.reserved)));
    expect(await runLedgerInvariantCheck()).toMatchObject({ passed: true, violations: [] });
  });
});
