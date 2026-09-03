import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { assertPlatformAdmin } from '../agents/agent-service';
import { assertSuperAdmin } from '../agents/inventory-service';

// W-1B1 Task C: admin fiat liquidity service.
//
// AgentFiatLiquidity tracks local fiat an agent can pay out for withdrawals
// — it is completely separate from AgentInventory (Coin stock for agent
// orders). This file never reads or writes AgentInventory or
// AgentInventoryLedger. It mirrors inventory-service.ts's funding/adjustment
// pattern exactly, scoped by (agentId, fiatCurrency) instead of agentId
// alone, and using BigInt for every fiat minor-unit value (schema:
// "Fiat minor-unit fields use BigInt ... to support currencies whose minor
// units exceed Int32 range").

const FIAT_CURRENCY_RE = /^[A-Z]{3}$/; // ISO 4217, matches Country.currencyCode's own convention

function validateFiatCurrency(fiatCurrency: string) {
  if (!FIAT_CURRENCY_RE.test(fiatCurrency)) {
    throw ApiError.badRequest('fiatCurrency must be a 3-letter ISO 4217 code (e.g. "NGN")');
  }
}

async function loadTargetAgent(agentId: string, adminId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw ApiError.notFound('Agent not found');
  if (agent.userId === adminId) {
    throw ApiError.forbidden('You cannot fund or adjust your own agent fiat liquidity');
  }
  return agent;
}

// ─── Reads ──────────────────────────────────────────────────────

/**
 * A not-yet-funded (agent, currency) pair is a legitimate, common state —
 * mirrors getAgentInventory's `exists: false` shape rather than throwing.
 */
export async function getAgentFiatLiquidity(agentId: string, fiatCurrency: string) {
  validateFiatCurrency(fiatCurrency);
  const liquidity = await prisma.agentFiatLiquidity.findUnique({
    where: { agentId_fiatCurrency: { agentId, fiatCurrency } },
  });
  if (!liquidity) {
    return {
      agentId,
      fiatCurrency,
      totalBalance: 0n,
      reservedBalance: 0n,
      available: 0n,
      version: 0,
      exists: false,
    };
  }
  return {
    agentId,
    fiatCurrency,
    totalBalance: liquidity.totalBalance,
    reservedBalance: liquidity.reservedBalance,
    available: liquidity.totalBalance - liquidity.reservedBalance,
    version: liquidity.version,
    exists: true,
  };
}

export async function listAgentFiatLiquidity(agentId: string) {
  return prisma.agentFiatLiquidity.findMany({ where: { agentId }, orderBy: { fiatCurrency: 'asc' } });
}

export async function getAgentFiatLiquidityLedger(agentId: string, fiatCurrency?: string, limit = 50) {
  return prisma.agentFiatLiquidityLedger.findMany({
    where: fiatCurrency ? { agentId, fiatCurrency } : { agentId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ─── Admin funding / adjustment ────────────────────────────────

/**
 * First-ever funding of an agent's fiat liquidity bucket for one currency.
 * Legal exactly once per (agent, fiatCurrency) pair — subsequent changes go
 * through adjustAgentFiatLiquidity. Idempotent via the ledger's
 * @@unique([agentId, fiatCurrency, idempotencyKey]).
 */
export async function fundAgentFiatLiquidity(
  adminId: string,
  agentId: string,
  fiatCurrency: string,
  amount: bigint,
  idempotencyKey: string,
  context?: { ip?: string; userAgent?: string }
) {
  validateFiatCurrency(fiatCurrency);
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw ApiError.badRequest('Funding amount must be a positive integer (fiat minor units)');
  }
  if (!idempotencyKey) {
    throw ApiError.badRequest('idempotencyKey is required');
  }
  await assertPlatformAdmin(adminId);
  const agent = await loadTargetAgent(agentId, adminId);

  const existingLedger = await prisma.agentFiatLiquidityLedger.findUnique({
    where: { agentId_fiatCurrency_idempotencyKey: { agentId: agent.id, fiatCurrency, idempotencyKey } },
  });
  if (existingLedger) {
    return prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency } },
    });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.agentFiatLiquidity.findUnique({
        where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency } },
      });
      if (existing) {
        throw ApiError.conflict(
          'Agent fiat liquidity for this currency already exists — use the adjustment operation instead'
        );
      }

      const liquidity = await tx.agentFiatLiquidity.create({
        data: { agentId: agent.id, fiatCurrency, totalBalance: amount, reservedBalance: 0n },
      });

      await tx.agentFiatLiquidityLedger.create({
        data: {
          agentId: agent.id,
          fiatCurrency,
          type: 'INITIAL_FUNDING',
          amount,
          totalBefore: 0n,
          totalAfter: amount,
          reservedBefore: 0n,
          reservedAfter: 0n,
          performedByAdminId: adminId,
          idempotencyKey,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: adminId,
          action: 'AGENT_FIAT_LIQUIDITY_FUNDED',
          entity: 'AgentFiatLiquidity',
          entityId: liquidity.id,
          newData: { agentId: agent.id, fiatCurrency, amount: amount.toString(), totalAfter: amount.toString() },
          ip: context?.ip,
          userAgent: context?.userAgent,
        },
      });

      return liquidity;
    });
  } catch (err) {
    // Two concurrent first-time-funding attempts for the same (agent,
    // currency) can both pass the existence check above before either
    // commits — the @@unique([agentId, fiatCurrency]) constraint is the
    // real backstop; this converts the resulting P2002 into the same
    // friendly conflict the sequential check already produces.
    if ((err as { code?: string }).code === 'P2002') {
      throw ApiError.conflict(
        'Agent fiat liquidity for this currency already exists — use the adjustment operation instead'
      );
    }
    throw err;
  }
}

/**
 * Signed admin adjustment (credit or debit) for an existing bucket.
 * SUPER_ADMIN-only, mirrors adjustAgentInventory's invariants exactly:
 * totalBalance may never go negative, and a deduction may never take
 * totalBalance below reservedBalance — fiat already promised to a live
 * withdrawal cannot be clawed back out from under it. Version-pinned
 * atomic update. Idempotent via the ledger's compound unique.
 */
export async function adjustAgentFiatLiquidity(
  adminId: string,
  agentId: string,
  fiatCurrency: string,
  signedAmount: bigint,
  reason: string,
  idempotencyKey: string,
  context?: { ip?: string; userAgent?: string }
) {
  validateFiatCurrency(fiatCurrency);
  if (typeof signedAmount !== 'bigint' || signedAmount === 0n) {
    throw ApiError.badRequest('Adjustment amount must be a non-zero integer (fiat minor units)');
  }
  if (!reason || reason.trim().length === 0) {
    throw ApiError.badRequest('A reason is required for a liquidity adjustment');
  }
  if (!idempotencyKey) {
    throw ApiError.badRequest('idempotencyKey is required');
  }
  await assertSuperAdmin(adminId);
  const agent = await loadTargetAgent(agentId, adminId);

  const existingLedger = await prisma.agentFiatLiquidityLedger.findUnique({
    where: { agentId_fiatCurrency_idempotencyKey: { agentId: agent.id, fiatCurrency, idempotencyKey } },
  });
  if (existingLedger) {
    return prisma.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency } },
    });
  }

  return prisma.$transaction(async (tx) => {
    const liquidity = await tx.agentFiatLiquidity.findUnique({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency } },
    });
    if (!liquidity) {
      throw ApiError.conflict('Agent has no fiat liquidity yet for this currency — use the funding operation first');
    }

    const newTotal = liquidity.totalBalance + signedAmount;
    if (newTotal < 0n) {
      throw ApiError.badRequest('Adjustment would take totalBalance negative');
    }
    if (newTotal < liquidity.reservedBalance) {
      throw ApiError.badRequest(
        'Adjustment would take totalBalance below reservedBalance — fiat already reserved for live withdrawals cannot be removed'
      );
    }

    const claim = await tx.agentFiatLiquidity.updateMany({
      where: { id: liquidity.id, version: liquidity.version },
      data: { totalBalance: newTotal, version: { increment: 1 } },
    });
    if (claim.count === 0) {
      throw ApiError.conflict('Concurrent liquidity modification — please retry');
    }

    await tx.agentFiatLiquidityLedger.create({
      data: {
        agentId: agent.id,
        fiatCurrency,
        // ADMIN_ADJUSTMENT covers both credit and debit — direction is
        // recovered from totalBefore/totalAfter, exactly like
        // AgentInventoryLedger's identical single-type adjustment
        // precedent. AGENT_CREDIT/AGENT_DEBIT are distinct ledger types
        // reserved for a non-admin-initiated flow this service does not
        // implement.
        type: 'ADMIN_ADJUSTMENT',
        amount: signedAmount < 0n ? -signedAmount : signedAmount,
        totalBefore: liquidity.totalBalance,
        totalAfter: newTotal,
        reservedBefore: liquidity.reservedBalance,
        reservedAfter: liquidity.reservedBalance,
        reason: reason.trim(),
        performedByAdminId: adminId,
        idempotencyKey,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_FIAT_LIQUIDITY_ADJUSTED',
        entity: 'AgentFiatLiquidity',
        entityId: liquidity.id,
        oldData: { totalBalance: liquidity.totalBalance.toString() },
        newData: { totalBalance: newTotal.toString(), signedAmount: signedAmount.toString(), reason: reason.trim() },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return tx.agentFiatLiquidity.findUnique({ where: { id: liquidity.id } });
  });
}

// ─── W-1B Task D support: candidate selection + reservation ───────
//
// Added for withdrawal-service.ts. Withdrawal.agentId is nullable "until
// assigned at HELD transition" (schema comment) — unlike AgentOrder,
// where the caller picks an agent directly, a withdrawal's agent is
// selected by the system from whichever agents in the withdrawal's
// country hold enough of the right currency. Everything below must be
// called from within the caller's own transaction; nothing here opens
// its own. No release/consume functions exist yet — this phase only
// creates reservations (ends at HELD); the settlement/cancellation flow
// that would release or consume one is explicitly out of scope.

/** Distinct from ApiError — see selectEligibleAgentLiquidity's doc comment. */
export class LiquidityContentionError extends Error {
  constructor() {
    super('No eligible agent fiat liquidity currently available');
    this.name = 'LiquidityContentionError';
  }
}

interface LiquidityCandidateRow {
  id: string;
  agentId: string;
  totalBalance: bigint;
  reservedBalance: bigint;
  version: number;
}

/**
 * Selects and locks ONE eligible AgentFiatLiquidity row: agent ACTIVE, in
 * the given country, with enough available balance (totalBalance -
 * reservedBalance) in fiatCurrency. FOR UPDATE OF afl SKIP LOCKED means a
 * concurrent withdrawal racing for the same pool skips any row another
 * in-flight transaction already holds, rather than blocking on it, and
 * tries the next-best eligible agent instead — standard practice for
 * high-contention resource selection, avoiding both deadlocks and long
 * waits. "OF afl" scopes the row lock to the liquidity table only — a
 * bare FOR UPDATE on this JOIN would also lock the matched "agents" row,
 * which is only being read here to filter, not something this operation
 * intends to hold a lock on.
 *
 * Throws LiquidityContentionError — not ApiError — when nothing matches.
 * This is a deliberately distinct signal: zero rows can mean either
 * "genuinely no agent has enough" or "the only eligible agent's row is
 * momentarily locked by another concurrent withdrawal," and a single
 * query cannot tell those apart. The caller (withdrawal-service.ts) is
 * expected to retry the WHOLE creation transaction a bounded number of
 * times before concluding real INSUFFICIENT_LIQUIDITY.
 *
 * W-1D0: `withdrawingUserId` excludes the withdrawing user's own agent
 * profile from candidacy (via `a."userId" != withdrawingUserId`) — an
 * agent must never be assigned to pay out their own withdrawal, even as
 * the sole liquid candidate for the country/currency. Rejected up front
 * rather than left to a later step, since nothing downstream in the
 * creation transaction would otherwise catch it.
 */
export async function selectEligibleAgentLiquidity(
  tx: any,
  countryId: string,
  fiatCurrency: string,
  amount: bigint,
  withdrawingUserId: string
): Promise<LiquidityCandidateRow> {
  const candidates = await tx.$queryRaw<LiquidityCandidateRow[]>`
    SELECT afl.id, afl."agentId", afl."totalBalance", afl."reservedBalance", afl.version
    FROM "agent_fiat_liquidities" afl
    JOIN "agents" a ON a.id = afl."agentId"
    WHERE a."countryId" = ${countryId}
      AND a.status = 'ACTIVE'
      AND a."userId" != ${withdrawingUserId}
      AND afl."fiatCurrency" = ${fiatCurrency}
      AND (afl."totalBalance" - afl."reservedBalance") >= ${amount}
    ORDER BY (afl."totalBalance" - afl."reservedBalance") DESC
    LIMIT 1
    FOR UPDATE OF afl SKIP LOCKED
  `;
  if (candidates.length === 0) {
    throw new LiquidityContentionError();
  }
  return candidates[0];
}

/**
 * Reserves `amount` against an already-selected-and-locked candidate row
 * (from selectEligibleAgentLiquidity, in the same transaction) — the
 * version-pinned balance write only, no ledger entry and no
 * WithdrawalLiquidityReservation row.
 *
 * Split from the ledger write (below) because of a real ordering
 * constraint: the lock-order comment on Withdrawal in schema.prisma
 * requires AgentFiatLiquidity to be locked/reserved BEFORE the wallet is
 * touched, but WithdrawalLiquidityReservation.withdrawalId is a real FK
 * to withdrawals.id, so that row — and the ledger entry that references
 * it — can only be created AFTER the parent Withdrawal row exists.
 * withdrawal-service.ts therefore calls this function early (before the
 * wallet debit, before Withdrawal is created) and writeReserveLedgerEntry
 * later (after Withdrawal and the reservation row both exist).
 *
 * The version-pinned updateMany should never see count === 0 given
 * FOR UPDATE already holds this row's lock for the transaction's
 * lifetime — checked anyway as defense-in-depth, converting to the same
 * LiquidityContentionError so the caller's retry logic handles it
 * uniformly.
 */
export async function incrementReservedLiquidity(
  tx: any,
  candidate: LiquidityCandidateRow,
  amount: bigint
): Promise<void> {
  const claim = await tx.agentFiatLiquidity.updateMany({
    where: { id: candidate.id, version: candidate.version },
    data: { reservedBalance: { increment: amount }, version: { increment: 1 } },
  });
  if (claim.count === 0) {
    throw new LiquidityContentionError();
  }
}

/**
 * Writes the RESERVE ledger entry for a reservation already applied by
 * incrementReservedLiquidity — call once the WithdrawalLiquidityReservation
 * row exists (see the ordering note above). `candidate`'s totalBefore/
 * reservedBefore are the pre-reservation snapshot from the original
 * selectEligibleAgentLiquidity read; totalAfter/reservedAfter are derived
 * from it exactly as incrementReservedLiquidity applied them.
 */
export async function writeReserveLedgerEntry(
  tx: any,
  candidate: LiquidityCandidateRow,
  amount: bigint,
  fiatCurrency: string,
  withdrawalId: string,
  reservationId: string
): Promise<void> {
  await tx.agentFiatLiquidityLedger.create({
    data: {
      agentId: candidate.agentId,
      fiatCurrency,
      type: 'RESERVE',
      amount,
      totalBefore: candidate.totalBalance,
      totalAfter: candidate.totalBalance,
      reservedBefore: candidate.reservedBalance,
      reservedAfter: candidate.reservedBalance + amount,
      reservationId,
      withdrawalId,
    },
  });
}
