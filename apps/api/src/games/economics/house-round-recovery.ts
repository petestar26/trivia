import type { Prisma, PrismaClient } from '@prisma/client';
import { SPIN90_RULES_ID } from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';
import { identifier } from './money.js';
import { drawDormantSpinRound, getDormantSpinEntropyAvailability } from './house-round-draw.js';
import { settleDormantSpinTicket } from './house-ticket-settlement.js';

export const DEFAULT_RECOVERY_LIMIT = 10;
export const MAX_RECOVERY_LIMIT = 100;
export type RecoveryPhase = 'WAITING_CUTOFF' | 'WAITING_ENTROPY' | 'READY_DRAW' |
  'READY_SETTLEMENT' | 'COMPLETE';

export interface HouseRoundRecoveryStatus {
  roundId: string;
  state: 'OPEN' | 'DRAWN' | 'CANCELLED';
  phase: RecoveryPhase;
  outcome: number | null;
  total: number;
  pending: number;
  settled: number;
  refunded: number;
  grossPayout: string;
  releasedLoss: string;
  hasMore: boolean;
}

/** Carries progress without exposing database exceptions or connection details. */
export class HouseRoundRecoveryError extends Error {
  readonly code = 'HOUSE_RECOVERY_BLOCKED';
  constructor(readonly roundId: string, readonly processed: number, readonly blockedHoldId: string | null) {
    super('Financial recovery stopped; retained results must be resumed after the blocker is resolved');
    this.name = 'HouseRoundRecoveryError';
  }
}

async function requireOwner(tx: Prisma.TransactionClient): Promise<void> {
  const [access] = await tx.$queryRaw<Array<{ owner: boolean }>>`
    SELECT (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=CURRENT_USER)=relowner AS owner
    FROM pg_catalog.pg_class WHERE oid='public.house_ticket_resolutions'::regclass`;
  if (!access?.owner) throw ApiError.forbidden('Financial recovery is owner-only');
}

/** Status uses one read-only snapshot. It cannot publish a draw or release a hold. */
export async function getDormantSpinRecoveryStatus(owner: PrismaClient, roundId: string): Promise<HouseRoundRecoveryStatus> {
  identifier(roundId, 'Round ID');
  return owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await requireOwner(tx);
    const [round] = await tx.$queryRaw<Array<{
      id: string; game_key: string; rules_id: string; mode: string;
      state: 'OPEN' | 'DRAWN' | 'CANCELLED'; outcome: number | null;
      closes_ms: bigint; now_ms: bigint;
    }>>`SELECT id,game_key,rules_id,mode,state,outcome,closes_ms,
      pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::bigint AS now_ms
      FROM public.scheduled_game_rounds WHERE id=${roundId}`;
    if (!round) throw ApiError.notFound('Financial round not found');
    if (round.mode !== 'FINANCIAL' || round.game_key !== 'spin_win' || round.rules_id !== SPIN90_RULES_ID)
      throw ApiError.conflict('Round does not match dormant financial Spin rules');
    const [invalid] = await tx.$queryRaw<Array<{ invalid: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM public.house_financial_hold_failures())
        OR EXISTS(SELECT 1 FROM public.house_capital_failures())
        OR EXISTS(SELECT 1 FROM public.house_round_randomness_failures() WHERE id=${roundId}) AS invalid`;
    if (invalid.invalid) throw ApiError.conflict('Financial recovery proof mismatch');
    const [counts] = await tx.$queryRaw<Array<{
      total: bigint; pending: bigint; settled: bigint; refunded: bigint;
      gross_payout: bigint; released_loss: bigint;
    }>>`SELECT pg_catalog.count(*) AS total,
      pg_catalog.count(*) FILTER(WHERE h.state='HELD') AS pending,
      pg_catalog.count(*) FILTER(WHERE h.state='SETTLED') AS settled,
      pg_catalog.count(*) FILTER(WHERE h.state='REFUNDED') AS refunded,
      COALESCE(pg_catalog.sum(z.payout),0)::bigint AS gross_payout,
      COALESCE(pg_catalog.sum(z.released_loss),0)::bigint AS released_loss
      FROM public.scheduled_stake_holds h
      JOIN public.economic_operations o ON o.id=h.hold_operation_id
      LEFT JOIN public.house_ticket_resolutions z ON z.hold_id=h.id
      WHERE o.snapshot->'financialTicket'->>'roundId'=${roundId}`;
    const count = (value: bigint) => {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw ApiError.conflict('Recovery count exceeds supported range');
      return Number(value);
    };
    const pending = count(counts.pending);
    // Also reverify a recorded independent proof for terminal status. A
    // completed batch must not make an invalid proof disappear from checks.
    const entropy = await getDormantSpinEntropyAvailability(tx, roundId);
    if (round.state === 'DRAWN' && entropy !== 'READY')
      throw ApiError.conflict('Financial recovery proof mismatch');
    let phase: RecoveryPhase;
    if (round.state !== 'OPEN') phase = pending === 0 ? 'COMPLETE' : 'READY_SETTLEMENT';
    else if (round.now_ms < round.closes_ms) phase = 'WAITING_CUTOFF';
    else {
      if (entropy === 'NOT_PREPARED') throw ApiError.conflict('Financial recovery has no pre-admission commitment');
      phase = entropy === 'PENDING' ? 'WAITING_ENTROPY' : 'READY_DRAW';
    }
    return { roundId, state: round.state, phase, outcome: round.outcome,
      total: count(counts.total), pending, settled: count(counts.settled), refunded: count(counts.refunded),
      grossPayout: counts.gross_payout.toString(), releasedLoss: counts.released_loss.toString(), hasMore: pending > 0 };
  }, { isolationLevel: 'RepeatableRead', timeout: 20_000, maxWait: 5_000 });
}

function rolledBackTransient(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: unknown; meta?: { code?: unknown } };
  return detail.code === 'P2034' || detail.meta?.code === '40001' || detail.meta?.code === '40P01';
}

async function retryRolledBack<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || !rolledBackTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/** Explicit owner operation, bounded to one batch. It never cancels a round.
 * Draw and each settlement own separate transactions. No stream/row lock is
 * retained while acquiring a ticket's user -> treasury -> schedule locks.
 */
export async function recoverDormantSpinRound(owner: PrismaClient, args: { roundId: string; limit?: number }) {
  identifier(args.roundId, 'Round ID');
  const limit = args.limit ?? DEFAULT_RECOVERY_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECOVERY_LIMIT)
    throw ApiError.badRequest('Recovery limit must be an integer from 1 to 100');
  let status = await getDormantSpinRecoveryStatus(owner, args.roundId);
  if (['WAITING_CUTOFF', 'WAITING_ENTROPY', 'COMPLETE'].includes(status.phase))
    return { ...status, processed: 0, committed: 0, replayed: 0 };
  let processed = 0;
  let committed = 0;
  let replayed = 0;
  let blockedHoldId: string | null = null;
  try {
    if (status.state === 'OPEN' || status.state === 'DRAWN')
      await retryRolledBack(() => drawDormantSpinRound(owner, args.roundId));
    // A concurrent draw/cancel or recovery may have won. Inspect stored state,
    // not the state observed before the terminal result transaction.
    status = await getDormantSpinRecoveryStatus(owner, args.roundId);
    if (status.state === 'OPEN') throw ApiError.conflict('Financial round has no terminal result');
    const pending = await owner.$queryRaw<Array<{ id: string }>>`
      SELECT h.id FROM public.scheduled_stake_holds h
      JOIN public.economic_operations o ON o.id=h.hold_operation_id
      WHERE h.state='HELD' AND o.snapshot->'financialTicket'->>'roundId'=${args.roundId}
      ORDER BY h.id COLLATE "C" LIMIT ${limit}`;
    for (const ticket of pending) {
      blockedHoldId = ticket.id;
      const result = await retryRolledBack(() => settleDormantSpinTicket(owner, { holdId: ticket.id }));
      processed++;
      if (result.isReplay) replayed++; else committed++;
    }
    return { ...await getDormantSpinRecoveryStatus(owner, args.roundId), processed, committed, replayed };
  } catch {
    throw new HouseRoundRecoveryError(args.roundId, processed, blockedHoldId);
  }
}
