import { createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

// W-1D3: withdrawal timeout sweep.
//
// Handles two deadlines that W-1D0/W-1D1 set but nothing ever consumed:
//   T1: PAYOUT_IN_PROGRESS with paymentSubmissionDeadlineAt elapsed —
//       the assigned agent never submitted payment.
//   T2: PAYMENT_SUBMITTED with confirmationDeadlineAt elapsed — the user
//       never confirmed receipt (and never opened a dispute either).
//
// Both timeouts escalate to DISPUTED, never auto-COMPLETE and never
// auto-refund. This mirrors the exact reasoning W-1D1 already established
// for cancelHeldWithdrawal (see that file's header): the agent may have a
// real fiat transfer in flight even without a recorded confirmation, so
// only a human admin reviewing evidence may release coins or refund them.
// This module therefore moves ZERO money — it only ever writes
// Withdrawal.status/disputedAt, one WithdrawalDispute row, one
// WithdrawalOperation row, and one AuditLog row. The actual money-moving
// resolution stays entirely inside dispute-service.ts's
// resolveWithdrawalDispute, unmodified by this file.
//
// Both sweep functions set openedFromStatus correctly (PAYOUT_IN_PROGRESS
// for T1, PAYMENT_SUBMITTED for T2), which is the only thing
// resolveWithdrawalDispute actually branches on — so its existing rules
// apply to a system-opened dispute automatically, with no changes needed
// there: T1 disputes require adminVerifiedPayment to resolve COMPLETED,
// T2 disputes forbid it.

const SYSTEM_ACTOR = 'SYSTEM';
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 500;

// Arbitrary, application-specific advisory-lock key. pg_try_advisory_xact_lock
// takes a bigint; any fixed constant works as long as it doesn't collide with
// another lock key elsewhere in the app (none exists today).
const ADVISORY_LOCK_KEY = 827364501;

export type TimeoutSweepOutcomeResult = 'ESCALATED' | 'SKIPPED';

export type TimeoutSweepSkipReason =
  | 'DEADLINE_NOT_ELAPSED'
  | 'STATUS_ALREADY_CHANGED'
  | 'ACTIVE_DISPUTE_EXISTS'
  | 'ALREADY_PROCESSED';

export interface TimeoutSweepOutcome {
  withdrawalId: string;
  result: TimeoutSweepOutcomeResult;
  disputeId?: string;
  reason?: TimeoutSweepSkipReason;
}

export interface TimeoutSweepBatchResult {
  candidatesFound: number;
  escalatedCount: number;
  skippedCount: number;
  outcomes: TimeoutSweepOutcome[];
}

export interface TimeoutSweepSummary {
  ranAt: string;
  lockAcquired: boolean;
  payoutDeadline: TimeoutSweepBatchResult;
  confirmationDeadline: TimeoutSweepBatchResult;
}

function normalizeBatchSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.floor(value), 1), MAX_BATCH_SIZE);
}

function hashOperation(action: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ action, ...payload })).digest('hex');
}

function emptyBatchResult(): TimeoutSweepBatchResult {
  return { candidatesFound: 0, escalatedCount: 0, skippedCount: 0, outcomes: [] };
}

function summarizeOutcomes(candidateCount: number, outcomes: TimeoutSweepOutcome[]): TimeoutSweepBatchResult {
  const escalatedCount = outcomes.filter((o) => o.result === 'ESCALATED').length;
  return {
    candidatesFound: candidateCount,
    escalatedCount,
    skippedCount: outcomes.length - escalatedCount,
    outcomes,
  };
}

// ─── T1: PAYOUT_IN_PROGRESS → DISPUTED on paymentSubmissionDeadlineAt ───

async function escalatePayoutInProgressTimeout(tx: any, withdrawalId: string): Promise<TimeoutSweepOutcome> {
  const action = 'SYSTEM_TIMEOUT_ESCALATE_PAYOUT';
  const idempotencyKey = `system:payout-deadline:${withdrawalId}`;
  const requestHash = hashOperation(action, { withdrawalId });

  // Re-lock and re-read from scratch — the batch SELECT below already held
  // FOR UPDATE, but that lock was on a short-lived read; this is the
  // authoritative check inside the same transaction that will write.
  const rows = await tx.$queryRaw<{ id: string; status: string; paymentSubmissionDeadlineAt: Date | null }[]>`
    SELECT id, status, "paymentSubmissionDeadlineAt"
    FROM withdrawals
    WHERE id = ${withdrawalId}
    FOR UPDATE
  `;
  const withdrawal = rows[0];
  if (!withdrawal) return { withdrawalId, result: 'SKIPPED', reason: 'STATUS_ALREADY_CHANGED' };

  const existingOp = await tx.withdrawalOperation.findUnique({
    where: { withdrawalId_action_idempotencyKey: { withdrawalId, action, idempotencyKey } },
  });
  if (existingOp) return { withdrawalId, result: 'SKIPPED', reason: 'ALREADY_PROCESSED' };

  if (withdrawal.status !== 'PAYOUT_IN_PROGRESS') {
    return { withdrawalId, result: 'SKIPPED', reason: 'STATUS_ALREADY_CHANGED' };
  }
  if (!withdrawal.paymentSubmissionDeadlineAt || withdrawal.paymentSubmissionDeadlineAt > new Date()) {
    return { withdrawalId, result: 'SKIPPED', reason: 'DEADLINE_NOT_ELAPSED' };
  }

  // Every dispute-creating path in this codebase (openUserWithdrawalDispute,
  // escalateWithdrawalToDispute, and this function) locks the Withdrawal row
  // FOR UPDATE before touching withdrawal_disputes, and this whole sweep
  // additionally holds a single advisory lock for its own duration (see
  // sweepWithdrawalTimeouts) — so two writers can never reach this check for
  // the SAME withdrawal at the same time. The active-dispute race this check
  // guards against is therefore expected-unreachable, kept as defense in
  // depth, matching the "should be unreachable" idiom used throughout
  // dispute-service.ts and liquidity-service.ts for equivalent invariants.
  const activeDispute = await tx.withdrawalDispute.findFirst({
    where: { withdrawalId, status: { in: ['OPEN', 'ASSIGNED'] } },
  });
  if (activeDispute) return { withdrawalId, result: 'SKIPPED', reason: 'ACTIVE_DISPUTE_EXISTS' };

  const now = new Date();
  const dispute = await tx.withdrawalDispute.create({
    data: {
      withdrawalId,
      openedBy: SYSTEM_ACTOR,
      reason: 'AGENT_UNRESPONSIVE',
      description:
        'Automatically escalated by the withdrawal timeout sweep: the assigned agent did not submit payment before the payment-submission deadline.',
      status: 'OPEN',
      openedFromStatus: 'PAYOUT_IN_PROGRESS',
      escalationReason: 'PAYMENT_DEADLINE_ELAPSED',
      idempotencyKey,
    },
  });

  const transition = await tx.withdrawal.updateMany({
    where: { id: withdrawalId, status: 'PAYOUT_IN_PROGRESS' },
    data: { status: 'DISPUTED', disputedAt: now },
  });
  if (transition.count !== 1) {
    throw ApiError.internal('Withdrawal left PAYOUT_IN_PROGRESS during system timeout escalation');
  }

  await tx.withdrawalOperation.create({
    data: {
      withdrawalId,
      actorUserId: SYSTEM_ACTOR,
      action,
      idempotencyKey,
      requestHash,
      resultType: 'WithdrawalDispute',
      resultId: dispute.id,
    },
  });

  await tx.auditLog.create({
    data: {
      userId: SYSTEM_ACTOR,
      action: 'WITHDRAWAL_SYSTEM_TIMEOUT_ESCALATED',
      entity: 'WithdrawalDispute',
      entityId: dispute.id,
      oldData: { withdrawalId, withdrawalStatus: 'PAYOUT_IN_PROGRESS' },
      newData: { withdrawalId, withdrawalStatus: 'DISPUTED', escalationReason: 'PAYMENT_DEADLINE_ELAPSED' },
    },
  });

  return { withdrawalId, result: 'ESCALATED', disputeId: dispute.id };
}

async function sweepPayoutInProgressBatch(tx: any, batchSize: number): Promise<TimeoutSweepBatchResult> {
  const candidateRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM withdrawals
    WHERE status = 'PAYOUT_IN_PROGRESS'
      AND "paymentSubmissionDeadlineAt" IS NOT NULL
      AND "paymentSubmissionDeadlineAt" <= now()
    ORDER BY "paymentSubmissionDeadlineAt" ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `;

  const outcomes: TimeoutSweepOutcome[] = [];
  for (const row of candidateRows) {
    outcomes.push(await escalatePayoutInProgressTimeout(tx, row.id));
  }
  return summarizeOutcomes(candidateRows.length, outcomes);
}

// ─── T2: PAYMENT_SUBMITTED → DISPUTED on confirmationDeadlineAt ────────

async function escalateConfirmationTimeout(tx: any, withdrawalId: string): Promise<TimeoutSweepOutcome> {
  const action = 'SYSTEM_TIMEOUT_ESCALATE_CONFIRMATION';
  const idempotencyKey = `system:confirmation-deadline:${withdrawalId}`;
  const requestHash = hashOperation(action, { withdrawalId });

  const rows = await tx.$queryRaw<{ id: string; status: string; confirmationDeadlineAt: Date | null }[]>`
    SELECT id, status, "confirmationDeadlineAt"
    FROM withdrawals
    WHERE id = ${withdrawalId}
    FOR UPDATE
  `;
  const withdrawal = rows[0];
  if (!withdrawal) return { withdrawalId, result: 'SKIPPED', reason: 'STATUS_ALREADY_CHANGED' };

  const existingOp = await tx.withdrawalOperation.findUnique({
    where: { withdrawalId_action_idempotencyKey: { withdrawalId, action, idempotencyKey } },
  });
  if (existingOp) return { withdrawalId, result: 'SKIPPED', reason: 'ALREADY_PROCESSED' };

  if (withdrawal.status !== 'PAYMENT_SUBMITTED') {
    return { withdrawalId, result: 'SKIPPED', reason: 'STATUS_ALREADY_CHANGED' };
  }
  if (!withdrawal.confirmationDeadlineAt || withdrawal.confirmationDeadlineAt > new Date()) {
    return { withdrawalId, result: 'SKIPPED', reason: 'DEADLINE_NOT_ELAPSED' };
  }

  // See the identical comment in escalatePayoutInProgressTimeout — this
  // race is expected-unreachable given the FOR UPDATE-first discipline
  // every dispute-creating path in this codebase follows, kept as defense
  // in depth.
  const activeDispute = await tx.withdrawalDispute.findFirst({
    where: { withdrawalId, status: { in: ['OPEN', 'ASSIGNED'] } },
  });
  if (activeDispute) return { withdrawalId, result: 'SKIPPED', reason: 'ACTIVE_DISPUTE_EXISTS' };

  const now = new Date();
  const dispute = await tx.withdrawalDispute.create({
    data: {
      withdrawalId,
      openedBy: SYSTEM_ACTOR,
      reason: 'OTHER',
      description:
        'Automatically escalated by the withdrawal timeout sweep: the user did not confirm receipt or open a dispute before the confirmation deadline.',
      status: 'OPEN',
      openedFromStatus: 'PAYMENT_SUBMITTED',
      escalationReason: 'CONFIRMATION_DEADLINE_ELAPSED',
      idempotencyKey,
    },
  });

  const transition = await tx.withdrawal.updateMany({
    where: { id: withdrawalId, status: 'PAYMENT_SUBMITTED' },
    data: { status: 'DISPUTED', disputedAt: now },
  });
  if (transition.count !== 1) {
    throw ApiError.internal('Withdrawal left PAYMENT_SUBMITTED during system timeout escalation');
  }

  await tx.withdrawalOperation.create({
    data: {
      withdrawalId,
      actorUserId: SYSTEM_ACTOR,
      action,
      idempotencyKey,
      requestHash,
      resultType: 'WithdrawalDispute',
      resultId: dispute.id,
    },
  });

  await tx.auditLog.create({
    data: {
      userId: SYSTEM_ACTOR,
      action: 'WITHDRAWAL_SYSTEM_TIMEOUT_ESCALATED',
      entity: 'WithdrawalDispute',
      entityId: dispute.id,
      oldData: { withdrawalId, withdrawalStatus: 'PAYMENT_SUBMITTED' },
      newData: { withdrawalId, withdrawalStatus: 'DISPUTED', escalationReason: 'CONFIRMATION_DEADLINE_ELAPSED' },
    },
  });

  return { withdrawalId, result: 'ESCALATED', disputeId: dispute.id };
}

async function sweepPaymentSubmittedBatch(tx: any, batchSize: number): Promise<TimeoutSweepBatchResult> {
  const candidateRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM withdrawals
    WHERE status = 'PAYMENT_SUBMITTED'
      AND "confirmationDeadlineAt" IS NOT NULL
      AND "confirmationDeadlineAt" <= now()
    ORDER BY "confirmationDeadlineAt" ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `;

  const outcomes: TimeoutSweepOutcome[] = [];
  for (const row of candidateRows) {
    outcomes.push(await escalateConfirmationTimeout(tx, row.id));
  }
  return summarizeOutcomes(candidateRows.length, outcomes);
}

// ─── Orchestrator ────────────────────────────────────────────────────

/**
 * Runs one full timeout-sweep pass: escalates expired PAYOUT_IN_PROGRESS
 * and PAYMENT_SUBMITTED withdrawals to DISPUTED. Safe to call repeatedly
 * and safe to call concurrently — see the file header and the advisory
 * lock note below.
 */
export async function sweepWithdrawalTimeouts(opts: { batchSize?: number } = {}): Promise<TimeoutSweepSummary> {
  const batchSize = normalizeBatchSize(opts.batchSize);
  const ranAt = new Date().toISOString();

  return prisma.$transaction(
    async (tx) => {
      // pg_try_advisory_xact_lock is TRANSACTION-scoped: it releases
      // automatically when this transaction commits or rolls back, on
      // whichever pooled connection Prisma assigned to this callback.
      //
      // A session-scoped pg_try_advisory_lock/pg_advisory_unlock pair was
      // considered and rejected: Prisma does not guarantee that two
      // separate top-level calls land on the same physical connection, so
      // the unlock call could silently no-op on a different connection
      // than the one holding the lock, leaving it stuck for the lifetime
      // of that pooled connection — a real "sweep never runs again" bug,
      // not just a missed optimization. Wrapping the whole sweep in one
      // $transaction sidesteps this entirely: Prisma pins one connection
      // for the callback's duration by design.
      //
      // This lock is a throttle, not a correctness requirement: every
      // per-row mutation below is independently protected by its own FOR
      // UPDATE lock, a deterministic WithdrawalOperation idempotency key,
      // and (per the comments in escalatePayoutInProgressTimeout /
      // escalateConfirmationTimeout) the FOR UPDATE-first discipline every
      // dispute-creating path follows. A missed lock could at most cause
      // two overlapping sweep passes to block on each other row-by-row —
      // never a double transition or a duplicate dispute.
      const lockRows = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS acquired
      `;
      if (lockRows[0]?.acquired !== true) {
        return {
          ranAt,
          lockAcquired: false,
          payoutDeadline: emptyBatchResult(),
          confirmationDeadline: emptyBatchResult(),
        };
      }

      const payoutDeadline = await sweepPayoutInProgressBatch(tx, batchSize);
      const confirmationDeadline = await sweepPaymentSubmittedBatch(tx, batchSize);
      return { ranAt, lockAcquired: true, payoutDeadline, confirmationDeadline };
    },
    // Generous ceiling for a full batch (up to MAX_BATCH_SIZE rows on each
    // of two passes); default batch sizes complete in a small fraction of
    // this in normal operation.
    { timeout: 60_000, maxWait: 10_000 }
  );
}
