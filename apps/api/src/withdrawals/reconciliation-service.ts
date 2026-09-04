import { prisma } from '@socialplay/database';

// W-1D3: read-only withdrawal reconciliation.
//
// Detection only — nothing in this file writes to the database. Every
// function below is a plain findMany. Remediation for anything this
// surfaces goes through the existing, already-reviewed admin dispute
// resolution path (dispute-service.ts's resolveWithdrawalDispute), never
// an automated fix here — auto-correcting money state is exactly the kind
// of blind mutation this module exists to catch, not perform.

const TERMINAL_STATUSES = ['COMPLETED', 'CANCELLED', 'EXPIRED'] as const;
// Mirrors withdrawals_one_live_per_user_unique's partial-index WHERE
// clause exactly (packages/database/prisma/migrations/.../w1d2a_..._schema_hardening).
const LIVE_STATUSES = ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED'] as const;

const DEFAULT_STALE_DISPUTE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
const DEFAULT_ITEM_LIMIT = 50;
const MAX_ITEM_LIMIT = 200;

export interface ReconciliationItem {
  withdrawalId: string;
  reasonCode: string;
  [key: string]: unknown;
}

export interface ReconciliationCheck {
  count: number;
  items: ReconciliationItem[];
  truncated: boolean;
}

export interface ReconciliationReport {
  ranAt: string;
  staleDisputeThresholdMs: number;
  checks: {
    activeHoldOnTerminalWithdrawal: ReconciliationCheck;
    activeReservationOnTerminalWithdrawal: ReconciliationCheck;
    completedWithoutSettlement: ReconciliationCheck;
    staleUnclaimedDispute: ReconciliationCheck;
    liveWithdrawalMissingAgent: ReconciliationCheck;
  };
  totalIssues: number;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ITEM_LIMIT;
  return Math.min(Math.max(Math.floor(value), 1), MAX_ITEM_LIMIT);
}

async function detectActiveHoldOnTerminalWithdrawal(limit: number): Promise<ReconciliationCheck> {
  // take limit+1 so we can report whether the result was truncated,
  // without a second COUNT query.
  const rows = await prisma.withdrawalHold.findMany({
    where: { status: 'ACTIVE', withdrawal: { status: { in: TERMINAL_STATUSES } } },
    select: { id: true, withdrawalId: true, withdrawal: { select: { status: true } } },
    take: limit + 1,
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    count: page.length,
    truncated,
    items: page.map((r) => ({
      withdrawalId: r.withdrawalId,
      reasonCode: 'ACTIVE_HOLD_ON_TERMINAL_WITHDRAWAL',
      holdId: r.id,
      withdrawalStatus: r.withdrawal.status,
    })),
  };
}

async function detectActiveReservationOnTerminalWithdrawal(limit: number): Promise<ReconciliationCheck> {
  const rows = await prisma.withdrawalLiquidityReservation.findMany({
    where: { status: 'ACTIVE', withdrawal: { status: { in: TERMINAL_STATUSES } } },
    select: { id: true, withdrawalId: true, withdrawal: { select: { status: true } } },
    take: limit + 1,
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    count: page.length,
    truncated,
    items: page.map((r) => ({
      withdrawalId: r.withdrawalId,
      reasonCode: 'ACTIVE_RESERVATION_ON_TERMINAL_WITHDRAWAL',
      reservationId: r.id,
      withdrawalStatus: r.withdrawal.status,
    })),
  };
}

async function detectCompletedWithoutSettlement(limit: number): Promise<ReconciliationCheck> {
  const rows = await prisma.withdrawal.findMany({
    where: { status: 'COMPLETED', settlement: null },
    select: { id: true },
    take: limit + 1,
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    count: page.length,
    truncated,
    items: page.map((r) => ({ withdrawalId: r.id, reasonCode: 'COMPLETED_WITHOUT_SETTLEMENT' })),
  };
}

async function detectStaleUnclaimedDispute(limit: number, thresholdMs: number): Promise<ReconciliationCheck> {
  const cutoff = new Date(Date.now() - thresholdMs);
  const rows = await prisma.withdrawalDispute.findMany({
    where: { status: 'OPEN', openedAt: { lte: cutoff } },
    select: { id: true, withdrawalId: true, openedAt: true },
    orderBy: { openedAt: 'asc' },
    take: limit + 1,
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    count: page.length,
    truncated,
    items: page.map((r) => ({
      withdrawalId: r.withdrawalId,
      reasonCode: 'DISPUTE_OPEN_UNCLAIMED_PAST_THRESHOLD',
      disputeId: r.id,
      openedAt: r.openedAt.toISOString(),
    })),
  };
}

async function detectLiveWithdrawalMissingAgent(limit: number): Promise<ReconciliationCheck> {
  const rows = await prisma.withdrawal.findMany({
    where: { status: { in: LIVE_STATUSES }, agentId: null },
    select: { id: true, status: true },
    take: limit + 1,
  });
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return {
    count: page.length,
    truncated,
    items: page.map((r) => ({
      withdrawalId: r.id,
      reasonCode: 'LIVE_WITHDRAWAL_MISSING_AGENT',
      withdrawalStatus: r.status,
    })),
  };
}

/**
 * Runs every W-1D3 drift detector and returns counts + ids/reason codes.
 * Read-only: issues no writes, and callers must route any remediation
 * through the existing admin dispute resolution flow.
 */
export async function runWithdrawalReconciliation(
  opts: { limit?: number; staleDisputeThresholdMs?: number } = {}
): Promise<ReconciliationReport> {
  const limit = normalizeLimit(opts.limit);
  const staleDisputeThresholdMs =
    opts.staleDisputeThresholdMs !== undefined && Number.isFinite(opts.staleDisputeThresholdMs) && opts.staleDisputeThresholdMs > 0
      ? opts.staleDisputeThresholdMs
      : DEFAULT_STALE_DISPUTE_THRESHOLD_MS;

  const [
    activeHoldOnTerminalWithdrawal,
    activeReservationOnTerminalWithdrawal,
    completedWithoutSettlement,
    staleUnclaimedDispute,
    liveWithdrawalMissingAgent,
  ] = await Promise.all([
    detectActiveHoldOnTerminalWithdrawal(limit),
    detectActiveReservationOnTerminalWithdrawal(limit),
    detectCompletedWithoutSettlement(limit),
    detectStaleUnclaimedDispute(limit, staleDisputeThresholdMs),
    detectLiveWithdrawalMissingAgent(limit),
  ]);

  const checks = {
    activeHoldOnTerminalWithdrawal,
    activeReservationOnTerminalWithdrawal,
    completedWithoutSettlement,
    staleUnclaimedDispute,
    liveWithdrawalMissingAgent,
  };
  const totalIssues = Object.values(checks).reduce((sum, check) => sum + check.count, 0);

  return { ranAt: new Date().toISOString(), staleDisputeThresholdMs, checks, totalIssues };
}
