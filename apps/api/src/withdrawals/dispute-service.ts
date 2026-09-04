import { createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import type { WithdrawalDispute, WithdrawalSettlement } from '@socialplay/database';
import { ApiError } from '../middleware';
import { applyBalanceChanges } from '../economy/wallet-service';
import { consumeReservedLiquidity, releaseReservedLiquidity } from './liquidity-service';

type RequestContext = { ip?: string; userAgent?: string };

export type WithdrawalDisputeReasonValue =
  | 'FIAT_NOT_RECEIVED'
  | 'WRONG_FIAT_AMOUNT'
  | 'AGENT_UNRESPONSIVE'
  | 'OTHER';

export type WithdrawalEscalationReason =
  | 'AGENT_NOT_ACTIVE'
  | 'PAYMENT_DEADLINE_ELAPSED'
  | 'FRAUD_SUSPECTED';

export type WithdrawalResolutionOutcome = 'COMPLETED' | 'CANCELLED';

export interface OpenUserWithdrawalDisputeArgs {
  reason: WithdrawalDisputeReasonValue;
  description: string;
  idempotencyKey: string;
}

export interface EscalateWithdrawalArgs {
  escalationReason: WithdrawalEscalationReason;
  description: string;
  idempotencyKey: string;
}

export interface AdminVerifiedPaymentArgs {
  referenceNumber: string;
  paymentOccurredAt: Date | string;
  note?: string;
}

export interface ResolveWithdrawalDisputeArgs {
  outcome: WithdrawalResolutionOutcome;
  resolutionNote: string;
  idempotencyKey: string;
  adminVerifiedPayment?: AdminVerifiedPaymentArgs;
}

type LockedWithdrawal = {
  id: string;
  withdrawalNumber: string;
  userId: string;
  agentId: string | null;
  status: string;
  fiatAmount: bigint;
  fiatCurrency: string;
  coinAmount: number;
  paymentSubmissionDeadlineAt: Date | null;
  paymentSubmittedAt: Date | null;
  createdAt: Date;
};

type LockedAgent = { id: string; userId: string; status: string };

type LockedReservation = {
  id: string;
  withdrawalId: string;
  agentId: string;
  fiatCurrency: string;
  amount: bigint;
  status: string;
};

type LockedHold = {
  id: string;
  withdrawalId: string;
  coinAmount: number;
  status: string;
  debitWalletTransactionId: string;
};

const DISPUTE_REASONS: WithdrawalDisputeReasonValue[] = [
  'FIAT_NOT_RECEIVED',
  'WRONG_FIAT_AMOUNT',
  'AGENT_UNRESPONSIVE',
  'OTHER',
];

const ESCALATION_REASONS: WithdrawalEscalationReason[] = [
  'AGENT_NOT_ACTIVE',
  'PAYMENT_DEADLINE_ELAPSED',
  'FRAUD_SUSPECTED',
];

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiError.badRequest(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw ApiError.badRequest(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw ApiError.badRequest(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maxLength) {
    throw ApiError.badRequest(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    value.length > 128 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw ApiError.badRequest('idempotencyKey must be between 8 and 128 characters');
  }
  return value;
}

function hashOperation(action: string, payload: Record<string, unknown>): string {
  // Every caller constructs payload with a fixed key order and normalized
  // values. JSON preserves field boundaries, unlike the legacy colon-joined
  // W-1D1 hashes (where embedded colons can create ambiguous preimages).
  return createHash('sha256').update(JSON.stringify({ action, ...payload })).digest('hex');
}

function idempotencyConflict(): never {
  throw ApiError.conflict('Idempotency key reused with different request data', {
    code: 'IDEMPOTENCY_CONFLICT',
  });
}

async function lockWithdrawal(tx: any, withdrawalId: string): Promise<LockedWithdrawal> {
  const rows = await tx.$queryRaw<LockedWithdrawal[]>`
    SELECT id, "withdrawalNumber", "userId", "agentId", status,
           "fiatAmount", "fiatCurrency", "coinAmount",
           "paymentSubmissionDeadlineAt", "paymentSubmittedAt", "createdAt"
    FROM withdrawals
    WHERE id = ${withdrawalId}
    FOR UPDATE
  `;
  const withdrawal = rows[0];
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  return withdrawal;
}

async function lockAssignedAgent(tx: any, agentId: string | null): Promise<LockedAgent | null> {
  if (!agentId) return null;
  const rows = await tx.$queryRaw<LockedAgent[]>`
    SELECT id, "userId", status
    FROM agents
    WHERE id = ${agentId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

async function lockDispute(tx: any, disputeId: string): Promise<WithdrawalDispute> {
  const rows = await tx.$queryRaw<WithdrawalDispute[]>`
    SELECT *
    FROM withdrawal_disputes
    WHERE id = ${disputeId}
    FOR UPDATE
  `;
  const dispute = rows[0];
  if (!dispute) throw ApiError.notFound('Withdrawal dispute not found');
  return dispute;
}

async function lockReservation(tx: any, withdrawalId: string): Promise<LockedReservation> {
  const rows = await tx.$queryRaw<LockedReservation[]>`
    SELECT id, "withdrawalId", "agentId", "fiatCurrency", amount, status
    FROM withdrawal_liquidity_reservations
    WHERE "withdrawalId" = ${withdrawalId}
    FOR UPDATE
  `;
  const reservation = rows[0];
  if (!reservation) throw ApiError.internal('Withdrawal liquidity reservation not found');
  return reservation;
}

async function lockHold(tx: any, withdrawalId: string): Promise<LockedHold> {
  const rows = await tx.$queryRaw<LockedHold[]>`
    SELECT id, "withdrawalId", "coinAmount", status, "debitWalletTransactionId"
    FROM withdrawal_holds
    WHERE "withdrawalId" = ${withdrawalId}
    FOR UPDATE
  `;
  const hold = rows[0];
  if (!hold) throw ApiError.internal('Withdrawal hold not found');
  return hold;
}

async function lockWallet(tx: any, userId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
    FROM wallets
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
  if (!rows[0]) throw ApiError.internal('Wallet not found for withdrawal refund');
}

async function assertActivePlatformAdmin(db: any, userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true },
  });
  if (!user) throw ApiError.unauthorized('Authentication required');
  if (user.status !== 'ACTIVE') throw ApiError.forbidden('Admin account is not active');
  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Admin privileges required');
  }
}

async function lockActivePlatformAdmin(tx: any, userId: string): Promise<void> {
  // A route-level JWT check and an unlocked pre-flight DB read are not enough
  // for a money-moving admin operation: role/status could be revoked while
  // the transaction is running. Share-lock the actor's User row immediately after
  // Withdrawal, before Agent/Dispute and all monetary rows.
  const rows = await tx.$queryRaw<{ role: string; status: string }[]>`
    SELECT role, status
    FROM users
    WHERE id = ${userId}
    FOR SHARE
  `;
  const user = rows[0];
  if (!user) throw ApiError.unauthorized('Authentication required');
  if (user.status !== 'ACTIVE') throw ApiError.forbidden('Admin account is not active');
  if (user.role !== 'ADMIN' && user.role !== 'SUPER_ADMIN') {
    throw ApiError.forbidden('Admin privileges required');
  }
}

function assertAdminIsIndependent(adminId: string, withdrawal: LockedWithdrawal, agent: LockedAgent | null): void {
  if (withdrawal.userId === adminId) {
    throw ApiError.forbidden('You cannot administer your own withdrawal');
  }
  if (agent?.userId === adminId) {
    throw ApiError.forbidden('You cannot administer a withdrawal assigned to your own agent account');
  }
}

async function findOperation(
  tx: any,
  withdrawalId: string,
  action: string,
  idempotencyKey: string,
  actorUserId: string,
  requestHash: string,
  resultType: string,
  expectedResultId?: string
) {
  const operation = await tx.withdrawalOperation.findUnique({
    where: {
      withdrawalId_action_idempotencyKey: { withdrawalId, action, idempotencyKey },
    },
  });
  if (!operation) return null;
  if (
    operation.actorUserId !== actorUserId ||
    operation.requestHash !== requestHash ||
    operation.resultType !== resultType ||
    (expectedResultId !== undefined && operation.resultId !== expectedResultId)
  ) {
    idempotencyConflict();
  }
  return operation;
}

async function replayDispute(tx: any, operation: { resultId: string }, withdrawalId: string) {
  const dispute = await tx.withdrawalDispute.findUnique({ where: { id: operation.resultId } });
  if (!dispute || dispute.withdrawalId !== withdrawalId) {
    throw ApiError.internal('Withdrawal operation points to an invalid dispute');
  }
  const withdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
  return { dispute, withdrawal, idempotent: true };
}

async function replaySettlement(
  tx: any,
  operation: { resultId: string },
  withdrawalId: string,
  expected?: {
    outcome?: 'COMPLETED' | 'CANCELLED';
    resolvedVia?: 'USER_CONFIRMED' | 'ADMIN_DISPUTE_RESOLUTION';
    resolvedByUserId?: string;
    disputeId?: string | null;
  }
) {
  const settlement = await tx.withdrawalSettlement.findUnique({ where: { id: operation.resultId } });
  if (
    !settlement ||
    settlement.withdrawalId !== withdrawalId ||
    (expected?.outcome !== undefined && settlement.outcome !== expected.outcome) ||
    (expected?.resolvedVia !== undefined && settlement.resolvedVia !== expected.resolvedVia) ||
    (expected?.resolvedByUserId !== undefined && settlement.resolvedByUserId !== expected.resolvedByUserId) ||
    (expected && Object.prototype.hasOwnProperty.call(expected, 'disputeId') &&
      settlement.disputeId !== expected.disputeId)
  ) {
    throw ApiError.internal('Withdrawal operation points to an invalid settlement');
  }
  const withdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
  return { settlement, withdrawal, idempotent: true };
}

function validateReservation(withdrawal: LockedWithdrawal, reservation: LockedReservation): void {
  if (!withdrawal.agentId || reservation.agentId !== withdrawal.agentId) {
    throw ApiError.internal('Withdrawal reservation agent does not match the assigned agent');
  }
  if (reservation.fiatCurrency !== withdrawal.fiatCurrency || reservation.amount !== withdrawal.fiatAmount) {
    throw ApiError.internal('Withdrawal reservation amount or currency does not match the withdrawal');
  }
  if (reservation.status !== 'ACTIVE') {
    throw ApiError.internal(`Withdrawal liquidity reservation is not ACTIVE: ${reservation.status}`);
  }
}

async function validateHold(tx: any, withdrawal: LockedWithdrawal, hold: LockedHold): Promise<void> {
  if (hold.coinAmount !== withdrawal.coinAmount) {
    throw ApiError.internal('Withdrawal hold amount does not match the withdrawal');
  }
  if (hold.status !== 'ACTIVE') {
    throw ApiError.internal(`Withdrawal hold is not ACTIVE: ${hold.status}`);
  }
  const debit = await tx.walletTransaction.findUnique({
    where: { id: hold.debitWalletTransactionId },
    select: {
      id: true,
      userId: true,
      type: true,
      ledgerType: true,
      currency: true,
      amount: true,
      referenceType: true,
      referenceId: true,
      status: true,
    },
  });
  if (
    !debit ||
    debit.userId !== withdrawal.userId ||
    debit.type !== 'COIN_DEBIT' ||
    debit.ledgerType !== 'DEBIT' ||
    debit.currency !== 'COINS' ||
    debit.amount !== hold.coinAmount ||
    debit.referenceType !== 'WITHDRAWAL' ||
    debit.referenceId !== withdrawal.id ||
    debit.status !== 'SUCCEEDED'
  ) {
    throw ApiError.internal('Withdrawal hold points to an invalid wallet debit');
  }
}

async function assertNoSettlement(tx: any, withdrawalId: string): Promise<void> {
  const existing = await tx.withdrawalSettlement.findUnique({ where: { withdrawalId } });
  if (existing) throw ApiError.internal('Withdrawal already has a settlement without a matching operation');
}

async function settleCompleted(
  tx: any,
  withdrawal: LockedWithdrawal,
  resolvedByUserId: string,
  resolvedVia: 'USER_CONFIRMED' | 'ADMIN_DISPUTE_RESOLUTION',
  idempotencyKey: string,
  now: Date,
  disputeId?: string,
  paymentSubmittedAt?: Date
): Promise<WithdrawalSettlement> {
  await assertNoSettlement(tx, withdrawal.id);

  // Required money lock order: Withdrawal (already held) -> Agent (admin
  // paths only, already held) -> Dispute (admin path, already held) ->
  // Reservation -> AgentFiatLiquidity (inside helper) -> Hold. COMPLETED
  // performs no wallet write and therefore takes no wallet lock.
  const reservation = await lockReservation(tx, withdrawal.id);
  validateReservation(withdrawal, reservation);
  await consumeReservedLiquidity(tx, reservation);

  const hold = await lockHold(tx, withdrawal.id);
  await validateHold(tx, withdrawal, hold);
  const holdClaim = await tx.withdrawalHold.updateMany({
    where: { id: hold.id, status: 'ACTIVE' },
    data: { status: 'CONSUMED', consumedAt: now },
  });
  if (holdClaim.count !== 1) throw ApiError.internal('Withdrawal hold could not be consumed');

  const settlement = await tx.withdrawalSettlement.create({
    data: {
      withdrawalId: withdrawal.id,
      reservationId: reservation.id,
      coinAmount: hold.coinAmount,
      fiatAmount: reservation.amount,
      walletTransactionId: hold.debitWalletTransactionId,
      resolvedVia,
      outcome: 'COMPLETED',
      disputeId,
      resolvedByUserId,
      idempotencyKey,
    },
  });

  const transition = await tx.withdrawal.updateMany({
    where: { id: withdrawal.id, status: disputeId ? 'DISPUTED' : 'PAYMENT_SUBMITTED' },
    data: {
      status: 'COMPLETED',
      completedAt: now,
      ...(paymentSubmittedAt ? { paymentSubmittedAt } : {}),
    },
  });
  if (transition.count !== 1) throw ApiError.internal('Withdrawal left its locked state during completion');
  return settlement;
}

async function settleCancelled(
  tx: any,
  withdrawal: LockedWithdrawal,
  resolvedByUserId: string,
  idempotencyKey: string,
  now: Date,
  disputeId: string
): Promise<WithdrawalSettlement> {
  await assertNoSettlement(tx, withdrawal.id);

  const reservation = await lockReservation(tx, withdrawal.id);
  validateReservation(withdrawal, reservation);
  await releaseReservedLiquidity(tx, reservation);

  const hold = await lockHold(tx, withdrawal.id);
  await validateHold(tx, withdrawal, hold);
  await lockWallet(tx, withdrawal.userId);
  const credit = await applyBalanceChanges(tx, withdrawal.userId, [
    {
      currency: 'COINS',
      amount: hold.coinAmount,
      ledgerType: 'CREDIT',
      transactionType: 'COIN_CREDIT',
      referenceType: 'WITHDRAWAL',
      referenceId: withdrawal.id,
      description: `Withdrawal ${withdrawal.withdrawalNumber} cancelled by dispute resolution — coin refund`,
    },
  ]);
  const refundWalletTransactionId = credit.transactions[0]?.id;
  if (!refundWalletTransactionId) throw ApiError.internal('Withdrawal refund did not create a wallet transaction');

  const holdClaim = await tx.withdrawalHold.updateMany({
    where: { id: hold.id, status: 'ACTIVE' },
    data: {
      status: 'REFUNDED',
      refundWalletTransactionId,
      releasedAt: now,
    },
  });
  if (holdClaim.count !== 1) throw ApiError.internal('Withdrawal hold could not be refunded');

  const settlement = await tx.withdrawalSettlement.create({
    data: {
      withdrawalId: withdrawal.id,
      reservationId: reservation.id,
      coinAmount: hold.coinAmount,
      fiatAmount: reservation.amount,
      walletTransactionId: hold.debitWalletTransactionId,
      resolvedVia: 'ADMIN_DISPUTE_RESOLUTION',
      outcome: 'CANCELLED',
      disputeId,
      refundWalletTransactionId,
      resolvedByUserId,
      idempotencyKey,
    },
  });

  const transition = await tx.withdrawal.updateMany({
    where: { id: withdrawal.id, status: 'DISPUTED' },
    data: { status: 'CANCELLED', cancelledAt: now },
  });
  if (transition.count !== 1) throw ApiError.internal('Withdrawal left DISPUTED during cancellation');
  return settlement;
}

export async function confirmWithdrawalReceipt(
  actorUserId: string,
  withdrawalId: string,
  opts: { idempotencyKey: string },
  context?: RequestContext
) {
  const idempotencyKey = normalizeIdempotencyKey(opts?.idempotencyKey);
  const requestHash = hashOperation('CONFIRM_RECEIPT', {});

  return prisma.$transaction(async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    if (withdrawal.userId !== actorUserId) {
      throw ApiError.forbidden('This withdrawal does not belong to you');
    }

    const existingOp = await findOperation(
      tx,
      withdrawalId,
      'CONFIRM_RECEIPT',
      idempotencyKey,
      actorUserId,
      requestHash,
      'WithdrawalSettlement'
    );
    if (existingOp) {
      return replaySettlement(tx, existingOp, withdrawalId, {
        outcome: 'COMPLETED',
        resolvedVia: 'USER_CONFIRMED',
        resolvedByUserId: actorUserId,
        disputeId: null,
      });
    }
    if (withdrawal.status !== 'PAYMENT_SUBMITTED') {
      throw ApiError.conflict(`Cannot confirm receipt from status: ${withdrawal.status}`);
    }
    if (!withdrawal.paymentSubmittedAt) {
      throw ApiError.internal('PAYMENT_SUBMITTED withdrawal has no paymentSubmittedAt');
    }
    const submission = await tx.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId } });
    if (!submission || submission.agentId !== withdrawal.agentId) {
      throw ApiError.internal('PAYMENT_SUBMITTED withdrawal has no valid payment submission');
    }

    const now = new Date();
    const settlement = await settleCompleted(
      tx,
      withdrawal,
      actorUserId,
      'USER_CONFIRMED',
      idempotencyKey,
      now
    );
    await tx.withdrawalOperation.create({
      data: {
        withdrawalId,
        actorUserId,
        action: 'CONFIRM_RECEIPT',
        idempotencyKey,
        requestHash,
        resultType: 'WithdrawalSettlement',
        resultId: settlement.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'WITHDRAWAL_RECEIPT_CONFIRMED',
        entity: 'Withdrawal',
        entityId: withdrawalId,
        oldData: { status: 'PAYMENT_SUBMITTED' },
        newData: { status: 'COMPLETED', settlementId: settlement.id },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });
    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { settlement, withdrawal: fresh, idempotent: false };
  });
}

export async function openUserWithdrawalDispute(
  actorUserId: string,
  withdrawalId: string,
  rawArgs: OpenUserWithdrawalDisputeArgs,
  context?: RequestContext
) {
  if (!DISPUTE_REASONS.includes(rawArgs?.reason)) throw ApiError.badRequest('Invalid dispute reason');
  const description = normalizeRequiredText(rawArgs?.description, 'description', 4000);
  const idempotencyKey = normalizeIdempotencyKey(rawArgs?.idempotencyKey);
  const requestHash = hashOperation('DISPUTE_OPEN_USER', { reason: rawArgs.reason, description });

  return prisma.$transaction(async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    if (withdrawal.userId !== actorUserId) {
      throw ApiError.forbidden('This withdrawal does not belong to you');
    }
    const existingOp = await findOperation(
      tx,
      withdrawalId,
      'DISPUTE_OPEN_USER',
      idempotencyKey,
      actorUserId,
      requestHash,
      'WithdrawalDispute'
    );
    if (existingOp) {
      const replay = await replayDispute(tx, existingOp, withdrawalId);
      if (
        replay.dispute.openedBy !== actorUserId ||
        replay.dispute.reason !== rawArgs.reason ||
        replay.dispute.description !== description ||
        replay.dispute.openedFromStatus !== 'PAYMENT_SUBMITTED'
      ) {
        throw ApiError.internal('Withdrawal operation points to an invalid user dispute');
      }
      return replay;
    }
    if (withdrawal.status !== 'PAYMENT_SUBMITTED') {
      throw ApiError.conflict(`Cannot open a dispute from status: ${withdrawal.status}`);
    }
    const submission = await tx.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId } });
    if (!withdrawal.paymentSubmittedAt || !submission || submission.agentId !== withdrawal.agentId) {
      throw ApiError.internal('PAYMENT_SUBMITTED withdrawal has no valid payment submission');
    }
    const active = await tx.withdrawalDispute.findFirst({
      where: { withdrawalId, status: { in: ['OPEN', 'ASSIGNED'] } },
    });
    if (active) throw ApiError.conflict('An active dispute already exists for this withdrawal');

    const now = new Date();
    const dispute = await tx.withdrawalDispute.create({
      data: {
        withdrawalId,
        openedBy: actorUserId,
        reason: rawArgs.reason,
        description,
        status: 'OPEN',
        openedFromStatus: 'PAYMENT_SUBMITTED',
        idempotencyKey,
      },
    });
    const transition = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PAYMENT_SUBMITTED' },
      data: { status: 'DISPUTED', disputedAt: now },
    });
    if (transition.count !== 1) throw ApiError.internal('Withdrawal left PAYMENT_SUBMITTED while opening dispute');
    await tx.withdrawalOperation.create({
      data: {
        withdrawalId,
        actorUserId,
        action: 'DISPUTE_OPEN_USER',
        idempotencyKey,
        requestHash,
        resultType: 'WithdrawalDispute',
        resultId: dispute.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'WITHDRAWAL_DISPUTE_OPENED',
        entity: 'WithdrawalDispute',
        entityId: dispute.id,
        oldData: { withdrawalStatus: 'PAYMENT_SUBMITTED' },
        newData: { withdrawalId, withdrawalStatus: 'DISPUTED', reason: rawArgs.reason },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });
    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { dispute, withdrawal: fresh, idempotent: false };
  });
}

export async function escalateWithdrawalToDispute(
  adminId: string,
  withdrawalId: string,
  rawArgs: EscalateWithdrawalArgs,
  context?: RequestContext
) {
  if (!ESCALATION_REASONS.includes(rawArgs?.escalationReason)) {
    throw ApiError.badRequest('Invalid escalation reason');
  }
  const description = normalizeRequiredText(rawArgs?.description, 'description', 4000);
  const idempotencyKey = normalizeIdempotencyKey(rawArgs?.idempotencyKey);
  const requestHash = hashOperation('DISPUTE_ESCALATE_ADMIN', {
    escalationReason: rawArgs.escalationReason,
    description,
  });

  // Fail closed before revealing whether the target withdrawal exists, then
  // repeat against a fresh DB read inside the state-changing transaction.
  await assertActivePlatformAdmin(prisma, adminId);
  return prisma.$transaction(async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    await lockActivePlatformAdmin(tx, adminId);
    const agent = await lockAssignedAgent(tx, withdrawal.agentId);
    assertAdminIsIndependent(adminId, withdrawal, agent);

    const existingOp = await findOperation(
      tx,
      withdrawalId,
      'DISPUTE_ESCALATE_ADMIN',
      idempotencyKey,
      adminId,
      requestHash,
      'WithdrawalDispute'
    );
    if (existingOp) {
      const replay = await replayDispute(tx, existingOp, withdrawalId);
      if (
        replay.dispute.openedBy !== adminId ||
        replay.dispute.description !== description ||
        replay.dispute.openedFromStatus !== 'PAYOUT_IN_PROGRESS' ||
        replay.dispute.escalationReason !== rawArgs.escalationReason
      ) {
        throw ApiError.internal('Withdrawal operation points to an invalid admin escalation');
      }
      return replay;
    }
    if (withdrawal.status !== 'PAYOUT_IN_PROGRESS') {
      throw ApiError.conflict(`Cannot escalate withdrawal from status: ${withdrawal.status}`);
    }

    const now = new Date();
    if (rawArgs.escalationReason === 'AGENT_NOT_ACTIVE' && agent?.status === 'ACTIVE') {
      throw ApiError.conflict('Assigned agent is still active', { code: 'ESCALATION_NOT_ALLOWED' });
    }
    if (
      rawArgs.escalationReason === 'PAYMENT_DEADLINE_ELAPSED' &&
      (!withdrawal.paymentSubmissionDeadlineAt || withdrawal.paymentSubmissionDeadlineAt > now)
    ) {
      throw ApiError.conflict('Payment-submission deadline has not elapsed', {
        code: 'ESCALATION_NOT_ALLOWED',
      });
    }
    if (rawArgs.escalationReason === 'FRAUD_SUSPECTED' && agent?.status !== 'UNDER_REVIEW') {
      throw ApiError.conflict('Fraud escalation requires the assigned agent to be under review', {
        code: 'ESCALATION_NOT_ALLOWED',
      });
    }

    const active = await tx.withdrawalDispute.findFirst({
      where: { withdrawalId, status: { in: ['OPEN', 'ASSIGNED'] } },
    });
    if (active) throw ApiError.conflict('An active dispute already exists for this withdrawal');
    const dispute = await tx.withdrawalDispute.create({
      data: {
        withdrawalId,
        openedBy: adminId,
        reason: rawArgs.escalationReason === 'FRAUD_SUSPECTED' ? 'OTHER' : 'AGENT_UNRESPONSIVE',
        description,
        status: 'OPEN',
        openedFromStatus: 'PAYOUT_IN_PROGRESS',
        escalationReason: rawArgs.escalationReason,
        idempotencyKey,
      },
    });
    const transition = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: 'PAYOUT_IN_PROGRESS' },
      data: { status: 'DISPUTED', disputedAt: now },
    });
    if (transition.count !== 1) throw ApiError.internal('Withdrawal left PAYOUT_IN_PROGRESS during escalation');
    await tx.withdrawalOperation.create({
      data: {
        withdrawalId,
        actorUserId: adminId,
        action: 'DISPUTE_ESCALATE_ADMIN',
        idempotencyKey,
        requestHash,
        resultType: 'WithdrawalDispute',
        resultId: dispute.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'WITHDRAWAL_ADMIN_ESCALATED',
        entity: 'WithdrawalDispute',
        entityId: dispute.id,
        oldData: { withdrawalStatus: 'PAYOUT_IN_PROGRESS' },
        newData: {
          withdrawalId,
          withdrawalStatus: 'DISPUTED',
          escalationReason: rawArgs.escalationReason,
          assignedAgentStatus: agent?.status ?? 'MISSING',
        },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });
    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { dispute, withdrawal: fresh, idempotent: false };
  });
}

async function loadDisputeTargetForAdmin(adminId: string, disputeId: string) {
  await assertActivePlatformAdmin(prisma, adminId);
  const dispute = await prisma.withdrawalDispute.findUnique({
    where: { id: disputeId },
    select: { withdrawalId: true },
  });
  if (!dispute) throw ApiError.notFound('Withdrawal dispute not found');
  return dispute.withdrawalId;
}

export async function listWithdrawalDisputesForAdmin(
  adminId: string,
  opts: { status?: 'OPEN' | 'ASSIGNED' | 'RESOLVED'; cursor?: string; limit?: number } = {}
) {
  await assertActivePlatformAdmin(prisma, adminId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let after: { openedAt: Date; id: string } | undefined;
  if (opts.cursor) {
    const cursor = await prisma.withdrawalDispute.findUnique({
      where: { id: opts.cursor },
      select: { id: true, openedAt: true },
    });
    if (!cursor) throw ApiError.badRequest('Invalid dispute cursor');
    after = cursor;
  }

  const rows = await prisma.withdrawalDispute.findMany({
    where: {
      status: opts.status ?? { in: ['OPEN', 'ASSIGNED'] },
      ...(after
        ? {
            OR: [
              { openedAt: { gt: after.openedAt } },
              { openedAt: after.openedAt, id: { gt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function getWithdrawalDisputeForAdmin(adminId: string, disputeId: string) {
  await assertActivePlatformAdmin(prisma, adminId);
  const dispute = await prisma.withdrawalDispute.findUnique({ where: { id: disputeId } });
  if (!dispute) throw ApiError.notFound('Withdrawal dispute not found');
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: dispute.withdrawalId } });
  if (!withdrawal) throw ApiError.internal('Withdrawal missing for dispute');
  return { dispute, withdrawal };
}

export async function listWithdrawalEscalationCandidates(
  adminId: string,
  opts: { cursor?: string; limit?: number } = {}
) {
  await assertActivePlatformAdmin(prisma, adminId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let after: { createdAt: Date; id: string } | undefined;
  if (opts.cursor) {
    const cursor = await prisma.withdrawal.findUnique({
      where: { id: opts.cursor },
      select: { id: true, createdAt: true },
    });
    if (!cursor) throw ApiError.badRequest('Invalid withdrawal cursor');
    after = cursor;
  }

  const rows = await prisma.withdrawal.findMany({
    where: {
      status: 'PAYOUT_IN_PROGRESS',
      OR: [
        { paymentSubmissionDeadlineAt: { lte: new Date() } },
        { agentId: null },
        { agent: { is: { status: { not: 'ACTIVE' } } } },
      ],
      ...(after
        ? {
            AND: [{
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function claimWithdrawalDispute(
  adminId: string,
  disputeId: string,
  opts: { idempotencyKey: string },
  context?: RequestContext
) {
  const idempotencyKey = normalizeIdempotencyKey(opts?.idempotencyKey);
  const requestHash = hashOperation('DISPUTE_CLAIM_ADMIN', { disputeId });
  const withdrawalId = await loadDisputeTargetForAdmin(adminId, disputeId);

  return prisma.$transaction(async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    await lockActivePlatformAdmin(tx, adminId);
    const agent = await lockAssignedAgent(tx, withdrawal.agentId);
    assertAdminIsIndependent(adminId, withdrawal, agent);
    const dispute = await lockDispute(tx, disputeId);
    if (dispute.withdrawalId !== withdrawalId) {
      throw ApiError.internal('Withdrawal dispute changed aggregate identity');
    }
    if (dispute.openedBy === adminId) {
      throw ApiError.forbidden('The admin who opened a dispute cannot claim it');
    }

    const existingOp = await findOperation(
      tx,
      withdrawalId,
      'DISPUTE_CLAIM_ADMIN',
      idempotencyKey,
      adminId,
      requestHash,
      'WithdrawalDispute',
      disputeId
    );
    if (existingOp) return replayDispute(tx, existingOp, withdrawalId);
    if (withdrawal.status !== 'DISPUTED') {
      throw ApiError.conflict(`Cannot claim a dispute for withdrawal status: ${withdrawal.status}`);
    }
    if (dispute.status !== 'OPEN') {
      throw ApiError.conflict(`Withdrawal dispute cannot be claimed from status: ${dispute.status}`);
    }

    const now = new Date();
    const claim = await tx.withdrawalDispute.updateMany({
      where: { id: disputeId, status: 'OPEN' },
      data: { status: 'ASSIGNED', assignedAdminId: adminId, assignedAt: now },
    });
    if (claim.count !== 1) throw ApiError.internal('Withdrawal dispute left OPEN while locked');
    await tx.withdrawalOperation.create({
      data: {
        withdrawalId,
        actorUserId: adminId,
        action: 'DISPUTE_CLAIM_ADMIN',
        idempotencyKey,
        requestHash,
        resultType: 'WithdrawalDispute',
        resultId: disputeId,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'WITHDRAWAL_DISPUTE_CLAIMED',
        entity: 'WithdrawalDispute',
        entityId: disputeId,
        oldData: { status: 'OPEN' },
        newData: { status: 'ASSIGNED', assignedAdminId: adminId },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });
    const fresh = await tx.withdrawalDispute.findUnique({ where: { id: disputeId } });
    const freshWithdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { dispute: fresh, withdrawal: freshWithdrawal, idempotent: false };
  });
}

function normalizeAdminPayment(raw: AdminVerifiedPaymentArgs | undefined, now: Date, createdAt: Date) {
  if (!raw) return undefined;
  const referenceNumber = normalizeRequiredText(raw.referenceNumber, 'adminVerifiedPayment.referenceNumber', 256);
  const note = normalizeOptionalText(raw.note, 'adminVerifiedPayment.note', 1024);
  const paymentOccurredAt = raw.paymentOccurredAt instanceof Date
    ? raw.paymentOccurredAt
    : new Date(raw.paymentOccurredAt);
  if (Number.isNaN(paymentOccurredAt.getTime())) {
    throw ApiError.badRequest('adminVerifiedPayment.paymentOccurredAt must be a valid timestamp');
  }
  if (paymentOccurredAt < createdAt) {
    throw ApiError.badRequest('Verified payment cannot predate the withdrawal');
  }
  if (paymentOccurredAt.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw ApiError.badRequest('Verified payment timestamp cannot be in the future');
  }
  return { referenceNumber, note, paymentOccurredAt };
}

export async function resolveWithdrawalDispute(
  adminId: string,
  disputeId: string,
  rawArgs: ResolveWithdrawalDisputeArgs,
  context?: RequestContext
) {
  if (rawArgs?.outcome !== 'COMPLETED' && rawArgs?.outcome !== 'CANCELLED') {
    throw ApiError.badRequest('outcome must be COMPLETED or CANCELLED');
  }
  const resolutionNote = normalizeRequiredText(rawArgs?.resolutionNote, 'resolutionNote', 4000);
  const idempotencyKey = normalizeIdempotencyKey(rawArgs?.idempotencyKey);
  const withdrawalId = await loadDisputeTargetForAdmin(adminId, disputeId);

  return prisma.$transaction(async (tx) => {
    const withdrawal = await lockWithdrawal(tx, withdrawalId);
    await lockActivePlatformAdmin(tx, adminId);
    const agent = await lockAssignedAgent(tx, withdrawal.agentId);
    assertAdminIsIndependent(adminId, withdrawal, agent);
    const dispute = await lockDispute(tx, disputeId);
    if (dispute.withdrawalId !== withdrawalId) {
      throw ApiError.internal('Withdrawal dispute changed aggregate identity');
    }
    if (dispute.openedBy === adminId) {
      throw ApiError.forbidden('The admin who opened a dispute cannot resolve it');
    }
    if (dispute.assignedAdminId !== adminId) {
      throw ApiError.forbidden('Only the admin who claimed this dispute may resolve it');
    }

    const now = new Date();
    const adminVerifiedPayment = normalizeAdminPayment(rawArgs.adminVerifiedPayment, now, withdrawal.createdAt);
    const requestHash = hashOperation('DISPUTE_RESOLVE_ADMIN', {
      disputeId,
      outcome: rawArgs.outcome,
      resolutionNote,
      adminVerifiedPayment: adminVerifiedPayment
        ? {
            referenceNumber: adminVerifiedPayment.referenceNumber,
            paymentOccurredAt: adminVerifiedPayment.paymentOccurredAt.toISOString(),
            note: adminVerifiedPayment.note,
          }
        : null,
    });
    const existingOp = await findOperation(
      tx,
      withdrawalId,
      'DISPUTE_RESOLVE_ADMIN',
      idempotencyKey,
      adminId,
      requestHash,
      'WithdrawalSettlement'
    );
    if (existingOp) {
      const replay = await replaySettlement(tx, existingOp, withdrawalId, {
        outcome: rawArgs.outcome,
        resolvedVia: 'ADMIN_DISPUTE_RESOLUTION',
        resolvedByUserId: adminId,
        disputeId,
      });
      const freshDispute = await tx.withdrawalDispute.findUnique({ where: { id: disputeId } });
      const expectedResolution = rawArgs.outcome === 'COMPLETED' ? 'RELEASE_COINS' : 'CANCEL_WITHDRAWAL';
      if (
        !freshDispute ||
        freshDispute.status !== 'RESOLVED' ||
        freshDispute.resolution !== expectedResolution ||
        freshDispute.resolvedBy !== adminId
      ) {
        throw ApiError.internal('Withdrawal operation points to an invalid resolved dispute');
      }
      return { ...replay, dispute: freshDispute };
    }
    if (rawArgs.outcome === 'CANCELLED' && adminVerifiedPayment) {
      throw ApiError.badRequest('adminVerifiedPayment is only valid for a COMPLETED resolution');
    }
    if (rawArgs.outcome === 'COMPLETED' && dispute.openedFromStatus === 'PAYOUT_IN_PROGRESS' && !adminVerifiedPayment) {
      throw ApiError.badRequest('adminVerifiedPayment is required to complete an escalated in-progress payout');
    }
    if (rawArgs.outcome === 'COMPLETED' && dispute.openedFromStatus === 'PAYMENT_SUBMITTED' && adminVerifiedPayment) {
      throw ApiError.badRequest('adminVerifiedPayment must not replace an existing agent payment submission');
    }
    if (withdrawal.status !== 'DISPUTED') {
      throw ApiError.conflict(`Cannot resolve a dispute for withdrawal status: ${withdrawal.status}`);
    }
    if (dispute.status !== 'ASSIGNED') {
      throw ApiError.conflict(`Withdrawal dispute cannot be resolved from status: ${dispute.status}`);
    }
    if (dispute.openedFromStatus !== 'PAYMENT_SUBMITTED' && dispute.openedFromStatus !== 'PAYOUT_IN_PROGRESS') {
      throw ApiError.internal('Withdrawal dispute has an invalid or missing origin status');
    }

    let paymentSubmittedAt: Date | undefined;
    if (rawArgs.outcome === 'COMPLETED') {
      if (dispute.openedFromStatus === 'PAYMENT_SUBMITTED') {
        const submission = await tx.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId } });
        if (!withdrawal.paymentSubmittedAt || !submission || submission.agentId !== withdrawal.agentId) {
          throw ApiError.internal('Disputed withdrawal has no valid agent payment submission');
        }
      } else {
        if (!agent) throw ApiError.internal('Assigned agent missing during admin-verified completion');
        const existingSubmission = await tx.withdrawalPaymentSubmission.findUnique({ where: { withdrawalId } });
        if (existingSubmission) {
          throw ApiError.internal('In-progress withdrawal unexpectedly already has a payment submission');
        }
        paymentSubmittedAt = now;
        await tx.withdrawalPaymentSubmission.create({
          data: {
            withdrawalId,
            agentId: agent.id,
            submittedByUserId: adminId,
            submittedAt: now,
            source: 'ADMIN_VERIFIED',
            paymentOccurredAt: adminVerifiedPayment!.paymentOccurredAt,
            referenceNumber: adminVerifiedPayment!.referenceNumber,
            note: adminVerifiedPayment!.note,
            idempotencyKey,
            requestHash,
          },
        });
      }
    }

    const settlement = rawArgs.outcome === 'COMPLETED'
      ? await settleCompleted(
          tx,
          withdrawal,
          adminId,
          'ADMIN_DISPUTE_RESOLUTION',
          idempotencyKey,
          now,
          disputeId,
          paymentSubmittedAt
        )
      : await settleCancelled(tx, withdrawal, adminId, idempotencyKey, now, disputeId);

    const resolution = rawArgs.outcome === 'COMPLETED' ? 'RELEASE_COINS' : 'CANCEL_WITHDRAWAL';
    const disputeClaim = await tx.withdrawalDispute.updateMany({
      where: { id: disputeId, status: 'ASSIGNED', assignedAdminId: adminId },
      data: {
        status: 'RESOLVED',
        resolution,
        resolutionNote,
        resolvedBy: adminId,
        resolvedAt: now,
      },
    });
    if (disputeClaim.count !== 1) throw ApiError.internal('Withdrawal dispute left ASSIGNED while locked');
    await tx.withdrawalOperation.create({
      data: {
        withdrawalId,
        actorUserId: adminId,
        action: 'DISPUTE_RESOLVE_ADMIN',
        idempotencyKey,
        requestHash,
        resultType: 'WithdrawalSettlement',
        resultId: settlement.id,
      },
    });
    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'WITHDRAWAL_DISPUTE_RESOLVED',
        entity: 'WithdrawalDispute',
        entityId: disputeId,
        oldData: { status: 'ASSIGNED', withdrawalStatus: 'DISPUTED' },
        newData: {
          status: 'RESOLVED',
          withdrawalStatus: rawArgs.outcome,
          resolution,
          settlementId: settlement.id,
        },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });
    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    const freshDispute = await tx.withdrawalDispute.findUnique({ where: { id: disputeId } });
    return { settlement, withdrawal: fresh, dispute: freshDispute, idempotent: false };
  });
}
