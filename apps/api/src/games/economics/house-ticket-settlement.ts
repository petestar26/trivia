import type { PrismaClient } from '@prisma/client';
import { parseSpin90Bets, SPIN90_RULES_ID } from '@socialplay/shared';
import { ApiError } from '../../middleware/error-handler.js';
import { flushCoinLedgerConstraints, resolveFinancialStakeCoins } from '../../economy/coin-ledger-service.js';
import type { EconomicTx } from '../../economy/coin-ledger-service.js';
import { quoteSpin90Ticket } from './models.js';
import { deriveSpinCommittedOutcome, verifySpinSeedCommitment } from './house-round-draw.js';

/** Internal owner adapter only. Never give this credential to API/worker.
 * Draw/reveal is durable before any payout; a retry resumes that result even
 * after catalog, eligibility or policy changes. Each ticket completes as one
 * transaction, so interrupted round processing can resume pending tickets.
 */
async function requireOwner(tx: EconomicTx) {
  const [role] = await tx.$queryRaw<Array<{ owner: boolean }>>`
    SELECT (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER)=relowner AS owner
    FROM pg_catalog.pg_class WHERE oid='public.house_ticket_resolutions'::regclass`;
  if (!role?.owner) throw ApiError.forbidden('Financial settlement is owner-only');
}

export async function settleDormantSpinTicket(owner: PrismaClient, args: { holdId: string }) {
  if (!/^[A-Za-z0-9_-]{1,121}$/.test(args.holdId)) throw ApiError.badRequest('Invalid financial hold ID');
  return owner.$transaction(async (tx) => {
    await requireOwner(tx);
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'house-ticket:' + args.holdId},0))) AS lock_wait`;
    const prior = await tx.$queryRaw<Array<{
      hold_id: string; round_id: string; operation_id: string; disposition: 'SETTLED' | 'CANCELLED';
      payout: number; coins_balance: number;
    }>>`SELECT hold_id,round_id,operation_id,disposition,payout,coins_balance
      FROM public.house_ticket_resolutions WHERE hold_id=${args.holdId}`;
    if (prior[0]) return {
      holdId: prior[0].hold_id, roundId: prior[0].round_id, operationId: prior[0].operation_id,
      disposition: prior[0].disposition, payout: prior[0].payout,
      coinsBalance: prior[0].coins_balance, isReplay: true,
    };
    const hold = await tx.scheduledStakeHold.findUnique({ where: { id: args.holdId }, include: { holdOperation: true } });
    const saved = (hold?.holdOperation.snapshot as Record<string, unknown> | null)?.financialTicket as
      { roundId?: string; bets?: string; payouts?: number[] } | undefined;
    if (!hold || !saved || typeof saved.roundId !== 'string' || typeof saved.bets !== 'string')
      throw ApiError.notFound('Financial ticket not found');
    if (hold.state !== 'HELD' || hold.gameKey !== 'spin_win' || hold.rulesId !== SPIN90_RULES_ID)
      throw ApiError.conflict('Financial ticket is not pending');
    // Preserve admission's user -> treasury -> schedule -> wallet order.
    // Eligibility controls NEW wagers, never fulfillment of an existing one.
    await tx.$queryRaw`SELECT id FROM public.users WHERE id=${hold.userId} FOR SHARE`;
    await tx.$queryRaw`SELECT currency FROM public.house_capital_accounts WHERE currency='COINS' FOR UPDATE`;
    const stream = await tx.scheduledGameRound.findUnique({ where: { id: saved.roundId }, select: { streamId: true } });
    if (!stream) throw ApiError.conflict('Financial round not found');
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'scheduled-round:' + stream.streamId},0))) AS lock_wait`;
    const [round] = await tx.$queryRaw<Array<{
      id: string; mode: string; state: string; outcome: number | null; cancel_reason: string | null;
    }>>`SELECT id,mode,state,outcome,cancel_reason FROM public.scheduled_game_rounds
      WHERE id=${saved.roundId} FOR UPDATE`;
    if (!round || round.mode !== 'FINANCIAL' || !['DRAWN','CANCELLED'].includes(round.state))
      throw ApiError.conflict('Financial round has no terminal result');
    const bets = parseSpin90Bets(JSON.parse(saved.bets));
    const quote = quoteSpin90Ticket(bets).ticket;
    if (quote.stake !== BigInt(hold.amount) || JSON.stringify(quote.payouts.map(Number)) !== JSON.stringify(saved.payouts))
      throw ApiError.conflict('Financial ticket quote proof mismatch');
    const disposition = round.state === 'CANCELLED' ? 'CANCELLED' : 'SETTLED';
    if (disposition === 'SETTLED' && (round.outcome === null || round.outcome < 0 || round.outcome > 36))
      throw ApiError.conflict('Financial round outcome is invalid');
    const payout = disposition === 'CANCELLED' ? hold.amount : Number(quote.payouts[round.outcome!]);
    const resolved = await resolveFinancialStakeCoins(tx, hold.userId, {
      holdId: hold.id, roundId: round.id, disposition, payout, outcome: round.outcome,
      ...(round.cancel_reason ? { reason: round.cancel_reason } : {}),
    });
    const game = await tx.gameDefinition.findUniqueOrThrow({ where: { key: 'spin_win' } });
    // The semantic-rules unique index maps the admission's immutable rulesId
    // to exactly one published version; republishing that ID is rejected.
    const rules = await tx.gameRules.findFirstOrThrow({ where: {
      gameId: game.id, rules: { path: ['rulesId'], equals: hold.rulesId },
    } });
    const response = { holdId: hold.id, roundId: round.id, operationId: resolved.operationId,
      disposition, payout, coinsBalance: resolved.coinsBalance, isReplay: false };
    const session = await tx.gameSession.create({ data: {
      id: `scheduled:${hold.id}`, userId: hold.userId, gameId: game.id,
      status: disposition === 'SETTLED' ? 'COMPLETED' : 'CANCELLED',
      betAmount: hold.amount, rewardAmount: payout, isWin: payout > hold.amount,
      completedAt: new Date(), mode: rules.mode, family: rules.family,
      wagerCurrency: rules.wagerCurrency, rewardCurrency: rules.rewardCurrency, rulesVersion: rules.version,
      resultSchemaVersion: rules.resultSchemaVersion,
      settlementDebitCurrency: 'COINS', settlementCreditCurrency: payout > 0 ? 'COINS' : null,
      selections: bets.map((bet) => ({ marketId: bet.marketId, amount: bet.amount })),
      requestSnapshot: { holdId: hold.id, roundId: round.id, rulesId: hold.rulesId },
      result: { outcome: round.outcome, disposition, payout, roundId: round.id }, responseSnapshot: response,
    } });
    await tx.$queryRaw`SELECT public.house_discharge_ticket(${hold.id},${resolved.operationId},
      ${disposition},${payout}::integer,${resolved.coinsBalance}::integer,${session.id})`;
    // Prove ALL linked records before Prisma resolves the callback.
    await flushCoinLedgerConstraints(tx);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return response;
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000, maxWait: 5_000 });
}

/** Cancellation is irrevocable and possible only before a durable draw.
 * It discloses the committed seed and would-be outcome for audit. This does
 * not prevent an owner who already knows the seed from selecting a void;
 * independent entropy remains required before live activation.
 * Pending tickets then refund through the SAME atomic
 * resolution path. A crash cannot turn a drawn winner into a void/refund.
 */
export async function cancelDormantSpinRound(owner: PrismaClient, args: { roundId: string; reason: string }) {
  if (!/^[A-Za-z0-9_:-]{1,128}$/.test(args.roundId) || typeof args.reason !== 'string' ||
    args.reason.trim().length < 8 || args.reason.length > 500)
    throw ApiError.badRequest('Invalid cancellation evidence');
  return owner.$transaction(async (tx) => {
    await requireOwner(tx);
    const stream = await tx.scheduledGameRound.findUnique({ where: { id: args.roundId }, select: { streamId: true } });
    if (!stream) throw ApiError.notFound('Financial round not found');
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'scheduled-round:' + stream.streamId},0))) AS lock_wait`;
    const [round] = await tx.$queryRaw<Array<{ mode: string; state: string; rules_id: string; cancel_reason: string | null }>>`
      SELECT mode,state,rules_id,cancel_reason FROM public.scheduled_game_rounds WHERE id=${args.roundId} FOR UPDATE`;
    if (round.mode !== 'FINANCIAL') throw ApiError.conflict('Only a financial round can be cancelled');
    const [seed] = await tx.$queryRaw<Array<{
      seed_hex: string; commitment_sha256: string; revealed_at: Date | null; cancelled_outcome: number | null;
    }>>`SELECT seed_hex,commitment_sha256,revealed_at,cancelled_outcome
      FROM public.house_round_randomness WHERE round_id=${args.roundId} FOR UPDATE`;
    const audit = () => ({ roundId: args.roundId, seedHex: seed?.seed_hex ?? null,
      commitmentSha256: seed?.commitment_sha256 ?? null,
      wouldBeOutcome: seed?.cancelled_outcome ?? null, revealedAt: seed?.revealed_at ?? null });
    if (round.state === 'CANCELLED') {
      if (round.cancel_reason !== args.reason) throw ApiError.conflict('Cancellation reason differs from stored evidence');
      return { ...audit(), isReplay: true };
    }
    if (round.state !== 'OPEN') throw ApiError.conflict('A drawn round must honor its result');
    if (seed) {
      if (!verifySpinSeedCommitment(args.roundId, round.rules_id, seed.seed_hex, seed.commitment_sha256))
        throw ApiError.conflict('Cancellation commitment mismatch');
      const outcome = deriveSpinCommittedOutcome(args.roundId, round.rules_id, seed.seed_hex);
      const [recorded] = await tx.$queryRaw<Array<{ revealed_at: Date }>>`
        UPDATE public.house_round_randomness
        SET revealed_at=pg_catalog.clock_timestamp(),cancelled_outcome=${outcome}
        WHERE round_id=${args.roundId} RETURNING revealed_at`;
      seed.cancelled_outcome = outcome;
      seed.revealed_at = recorded.revealed_at;
    }
    await tx.scheduledGameRound.update({ where: { id: args.roundId }, data: {
      state: 'CANCELLED', cancelReason: args.reason,
    } });
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return { ...audit(), isReplay: false };
  }, { isolationLevel: 'ReadCommitted', timeout: 20_000 });
}
