import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import type { Withdrawal } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges } from '../economy/wallet-service';
import { requiresStepUp, requireStepUp } from '../security/step-up-service';
import {
  LiquidityContentionError,
  selectEligibleAgentLiquidity,
  incrementReservedLiquidity,
  writeReserveLedgerEntry,
  releaseReservedLiquidity,
} from './liquidity-service';

// W-1B Task D: withdrawal creation service.
//
// Opus's W-1A2 carry-forward requirement #1: CREATED is not used by this
// implementation. There is no justified resting state between "a quote
// was consumed" and "coins are held" — everything from quote-claim
// through liquidity-reservation happens in ONE transaction, so the
// Withdrawal row is created directly in HELD. Withdrawal.status's
// CREATED value and quoteExpiresAt/the [status, quoteExpiresAt] sweep
// index become dead code paths as a result — WithdrawalQuote.expiresAt
// is the real, now-authoritative "did this go stale before being used"
// mechanism. quoteExpiresAt is still populated (NOT NULL, no default) —
// with the consumed quote's own expiresAt, the only value that is both
// available and meaningful at this point, even though nothing reads it
// afterward.

const MAX_LIQUIDITY_RETRY_ATTEMPTS = 3;

// W-1D0: deterministic constant — no WithdrawalConfig table exists yet to
// source this from (docs/withdrawal-w1-w2-design.md §2.2 proposes one,
// unimplemented). Matches the design doc's own recommended default
// ("Agent is notified and has 15 minutes to make the payout", §1.1).
// Internal only — never client-supplied, never echoed as configurable.
const DEFAULT_PAYMENT_SUBMISSION_WINDOW_MS = 15 * 60 * 1000;

export interface CreateWithdrawalArgs {
  quoteId: string;
  payoutAccountId: string;
  idempotencyKey: string;
}

function validateArgs(args: CreateWithdrawalArgs) {
  if (!args.quoteId || typeof args.quoteId !== 'string') throw ApiError.badRequest('quoteId is required');
  if (!args.payoutAccountId || typeof args.payoutAccountId !== 'string') {
    throw ApiError.badRequest('payoutAccountId is required');
  }
  if (!args.idempotencyKey || typeof args.idempotencyKey !== 'string') {
    throw ApiError.badRequest('idempotencyKey is required');
  }
}

/**
 * The idempotency-conflict hash: canonical inputs to a withdrawal-creation
 * REQUEST are exactly quoteId + payoutAccountId (the two things the
 * caller actually chose — everything else is derived server-side from
 * the quote). Same [userId, idempotencyKey] + same hash => return the
 * existing withdrawal; same key + different hash => 409
 * IDEMPOTENCY_CONFLICT. This is Withdrawal.requestHash's actual role —
 * distinct from WithdrawalQuote.requestHash, which only hashes a quote's
 * own creation inputs for traceability (see quote-service.ts).
 */
function computeWithdrawalRequestHash(quoteId: string, payoutAccountId: string): string {
  return createHash('sha256').update(`${quoteId}:${payoutAccountId}`).digest('hex');
}

/**
 * Withdrawal.withdrawalNumber ("WD-000123") from the dedicated
 * withdrawal_number_seq Postgres sequence (migration
 * 20260903020000_w1a_withdrawal_number_sequence) — nextval() only, never
 * count()/MAX()/read-then-write, for the exact reason documented on
 * order-service.ts's nextOrderNumber: a COUNT()-based allocator collides
 * under scoped deletes independent of any concurrency, and nextval() is
 * both monotonic for the sequence's lifetime and non-transactional (a
 * rolled-back transaction never returns its consumed value), so two
 * concurrent callers can never observe the same value.
 */
async function nextWithdrawalNumber(tx: any): Promise<string> {
  const rows = await tx.$queryRaw<{ nextval: bigint | number | string }[]>`
    SELECT nextval('withdrawal_number_seq') AS nextval
  `;
  const n = Number(rows[0].nextval);
  return `WD-${String(n).padStart(6, '0')}`;
}

/**
 * Creates a Withdrawal from a previously-issued quote and one of the
 * caller's own payout accounts. Identity is always actorUserId — never
 * accepted from the request body. tokenIat is the access token's `iat`
 * claim, required only when the caller's security policy requires
 * step-up (see step-up-service.ts) — the route layer that doesn't exist
 * yet must extract it from the verified JWT, never trust a client-
 * supplied value.
 *
 * Atomically, in one transaction:
 *   1. claim the quote (ACTIVE, unexpired, owned by this user) -> CONSUMED,
 *      setting quote.consumedByWithdrawalId = the withdrawal's own
 *      (pre-generated) id in the SAME write (Opus requirement #2 — both
 *      sides of the 1:1 are set together, never in two separate steps
 *      that could disagree). If the claim fails because the quote is
 *      already CONSUMED, re-checks Withdrawal by [userId, idempotencyKey]
 *      before assuming it's an unrelated conflict — see the inline
 *      comment at that check for why.
 *   2. consume step-up, if the caller's policy requires it, inside this
 *      same transaction — a failed/rolled-back attempt never burns it.
 *   3. re-verify the payout account's ownership/active status, and that
 *      its countryId matches the quote's — the two must agree, or the
 *      wrong country's rate/liquidity pool would be used.
 *   4. select + lock an eligible AgentFiatLiquidity row, and reserve
 *      against it — BEFORE touching the wallet. schema.prisma's lock-
 *      order comment on Withdrawal is explicit: "Never Wallet first and
 *      Agent liquidity second." The reservation's ledger entry and its
 *      own WithdrawalLiquidityReservation row are deferred until after
 *      step 6 creates the parent Withdrawal — see the ordering note on
 *      incrementReservedLiquidity in liquidity-service.ts. W-1D0:
 *      candidates whose Agent.userId equals the withdrawing user are
 *      excluded — a user's own agent profile may never be selected to
 *      pay out their own withdrawal (see selectEligibleAgentLiquidity).
 *   5. debit coins from the wallet exactly once (applyBalanceChanges).
 *   6. create the Withdrawal row itself, status HELD — the parent row
 *      must exist before step 7's children, since both carry a real FK
 *      to withdrawals.id.
 *   7. create the WithdrawalHold (pointing at step 5's debit ledger row)
 *      and the WithdrawalLiquidityReservation + its RESERVE ledger entry
 *      (recording what step 4 already applied to the balance).
 *   8. write an audit log entry.
 *
 * If liquidity is unavailable, the whole transaction rolls back —
 * including the wallet debit and any step-up consumption — because
 * every one of those writes lives in this one transaction; no separate
 * manual-rollback code exists or is needed.
 */
export async function createWithdrawal(
  actorUserId: string,
  rawArgs: CreateWithdrawalArgs,
  tokenIat: number,
  context?: { ip?: string; userAgent?: string }
): Promise<{ withdrawal: unknown; idempotent: boolean }> {
  validateArgs(rawArgs);
  const args = rawArgs;
  const requestHash = computeWithdrawalRequestHash(args.quoteId, args.payoutAccountId);

  const existing = await prisma.withdrawal.findUnique({
    where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
  });
  if (existing) {
    if (existing.requestHash === requestHash) {
      return { withdrawal: existing, idempotent: true };
    }
    throw ApiError.conflict('A withdrawal already exists for this idempotency key with different request data', {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  }

  // Pre-flight reads outside the transaction — fail fast on obviously
  // bad input rather than spend a transaction attempt on it. Every
  // value actually used to build the Withdrawal row is re-read fresh
  // inside the transaction below; these are user-friendly early checks
  // only, not the source of truth.
  const quotePreview = await prisma.withdrawalQuote.findUnique({ where: { id: args.quoteId } });
  if (!quotePreview) throw ApiError.badRequest('Invalid quote');
  if (quotePreview.userId !== actorUserId) throw ApiError.forbidden('This quote does not belong to you');

  const payoutAccountPreview = await prisma.userPayoutAccount.findUnique({ where: { id: args.payoutAccountId } });
  if (!payoutAccountPreview) throw ApiError.badRequest('Invalid payout account');
  if (payoutAccountPreview.userId !== actorUserId) {
    throw ApiError.forbidden('This payout account does not belong to you');
  }
  if (payoutAccountPreview.status !== 'ACTIVE') {
    throw ApiError.badRequest('This payout account is not currently active');
  }
  if (payoutAccountPreview.countryId !== quotePreview.countryId) {
    throw ApiError.badRequest('This payout account does not belong to the quote\'s country');
  }

  const needsStepUp = await requiresStepUp(actorUserId);
  if (needsStepUp && (tokenIat === undefined || tokenIat === null)) {
    throw ApiError.forbidden('Step-up authentication required', { code: 'STEP_UP_REQUIRED' });
  }

  for (let attempt = 0; attempt < MAX_LIQUIDITY_RETRY_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const withdrawalId = randomUUID();
        const now = new Date();

        // W-1D2A Step 0: one-live-withdrawal-per-user rule. Reject before the
        // quote is claimed / wallet is debited / liquidity is reserved if the
        // user already has a live withdrawal (HELD / PAYOUT_IN_PROGRESS /
        // PAYMENT_SUBMITTED / DISPUTED). This is the deterministic
        // application-level guard; the partial unique index
        // (withdrawals_one_live_per_user_unique) remains the hard DB backstop
        // for the concurrent race. Idempotent replays never reach here — the
        // pre-flight check above returns the existing withdrawal first.
        const liveWithdrawalCount = await tx.withdrawal.count({
          where: {
            userId: actorUserId,
            status: { in: ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED'] },
          },
        });
        if (liveWithdrawalCount > 0) {
          throw ApiError.conflict('You already have an active withdrawal in progress', {
            code: 'ACTIVE_WITHDRAWAL_EXISTS',
          });
        }

        // Step 1: atomic quote claim, setting both sides of the 1:1 at
        // once (Opus requirement #2).
        const quoteClaim = await tx.withdrawalQuote.updateMany({
          where: { id: args.quoteId, userId: actorUserId, status: 'ACTIVE', expiresAt: { gt: now } },
          data: { status: 'CONSUMED', consumedAt: now, consumedByWithdrawalId: withdrawalId },
        });
        if (quoteClaim.count === 0) {
          const current = await tx.withdrawalQuote.findUnique({ where: { id: args.quoteId } });
          if (!current) throw ApiError.badRequest('Invalid quote');
          // Not reachable via createWithdrawal's own pre-flight check
          // (line ~152 already rejects a mismatched owner before the
          // retry loop starts, and quote ownership is immutable post-
          // creation) — kept as defense-in-depth so this fallback never
          // reports "expired"/"already used" for what is actually an
          // ownership violation, in case that pre-flight guard is ever
          // refactored away from this exact call path.
          if (current.userId !== actorUserId) throw ApiError.forbidden('This quote does not belong to you');
          if (current.status === 'CONSUMED') {
            // Could be a concurrent duplicate of THIS SAME request racing
            // on the same quote — a genuine second, unrelated request
            // that happens to reuse an already-used quote is a real user
            // error, but two racing copies of one request (retried
            // client, doubled network call) must resolve idempotently
            // rather than surface a confusing "quote already used".
            // Re-check by idempotency key before assuming the latter.
            const winner = await tx.withdrawal.findUnique({
              where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
            });
            if (winner) {
              if (winner.requestHash === requestHash) {
                return { withdrawal: winner, idempotent: true };
              }
              throw ApiError.conflict(
                'A withdrawal already exists for this idempotency key with different request data',
                { code: 'IDEMPOTENCY_CONFLICT' }
              );
            }
            throw ApiError.conflict('This quote has already been used');
          }
          throw ApiError.conflict('This quote has expired — request a new one');
        }
        const quote = await tx.withdrawalQuote.findUnique({ where: { id: args.quoteId } });

        // Step 2: step-up, inside this transaction, only if required.
        // A rollback of this transaction (any later failure) rolls this
        // consumption back too — requireStepUp is never called outside
        // tx, so nothing here can burn a step-up on a failed attempt.
        if (needsStepUp) {
          await requireStepUp({ userId: actorUserId, tokenIat }, 'WITHDRAWAL_CREATE', tx);
        }

        // Step 3: re-verify the payout account inside the transaction —
        // ownership, active status, and that its country matches the
        // quote's. A mismatch here would mean paying out at the wrong
        // country's rate/liquidity pool, so this must reject before any
        // liquidity lock or wallet debit is attempted.
        const payoutAccount = await tx.userPayoutAccount.findUnique({ where: { id: args.payoutAccountId } });
        if (!payoutAccount || payoutAccount.userId !== actorUserId) {
          throw ApiError.forbidden('This payout account does not belong to you');
        }
        if (payoutAccount.status !== 'ACTIVE') {
          throw ApiError.badRequest('This payout account is not currently active');
        }
        if (payoutAccount.countryId !== quote!.countryId) {
          throw ApiError.badRequest('This payout account does not belong to the quote\'s country');
        }

        // Step 4: select + lock an eligible agent fiat liquidity row and
        // reserve against it — BEFORE the wallet is touched (schema.prisma:
        // "Never Wallet first and Agent liquidity second"). The
        // WithdrawalLiquidityReservation row and its ledger entry are
        // deferred to step 7, since they carry a real FK to withdrawals.id
        // and the parent row doesn't exist yet. Throws
        // LiquidityContentionError (caught below) if none is available.
        const candidate = await selectEligibleAgentLiquidity(
          tx,
          quote!.countryId,
          quote!.fiatCurrency,
          quote!.fiatAmount,
          actorUserId
        );
        await incrementReservedLiquidity(tx, candidate, quote!.fiatAmount);

        // Step 5: debit coins exactly once — sole authoritative wallet
        // mutation path, same as every other economy flow in this repo.
        await getOrCreateWallet(actorUserId, tx);
        const balanceResult = await applyBalanceChanges(tx, actorUserId, [
          {
            currency: 'COINS',
            amount: quote!.coinAmount,
            ledgerType: 'DEBIT',
            transactionType: 'COIN_DEBIT',
            referenceType: 'WITHDRAWAL',
            referenceId: withdrawalId,
            description: `Coins withdrawn for fiat payout (quote ${quote!.id})`,
          },
        ]);

        // Step 6: the Withdrawal row itself — HELD directly (see file
        // header). withdrawalNumber via the sequence, never count/max.
        // Must exist before step 7's children — both carry a real FK to
        // withdrawals.id.
        const withdrawal = await tx.withdrawal.create({
          data: {
            id: withdrawalId,
            withdrawalNumber: await nextWithdrawalNumber(tx),
            userId: actorUserId,
            agentId: candidate.agentId,
            quoteId: args.quoteId,
            requestHash,
            idempotencyKey: args.idempotencyKey,
            countryId: quote!.countryId,
            paymentMethodDefId: payoutAccount.methodDefId,
            userPayoutAccountId: args.payoutAccountId,
            paymentSnapshot: payoutAccount.accountDetails as any,
            fiatAmount: quote!.fiatAmount,
            fiatCurrency: quote!.fiatCurrency,
            exchangeRateConfigId: quote!.exchangeRateConfigId,
            exchangeRateValue: quote!.exchangeRateValue,
            coinAmount: quote!.coinAmount,
            status: 'HELD',
            quoteExpiresAt: quote!.expiresAt,
            paymentSubmissionDeadlineAt: new Date(now.getTime() + DEFAULT_PAYMENT_SUBMISSION_WINDOW_MS),
          },
        });

        // Step 7: the hold (pointing at step 5's debit ledger row) and
        // the liquidity reservation + its RESERVE ledger entry (recording
        // what step 4 already applied to the balance) — now that the
        // parent Withdrawal row they both FK to actually exists.
        await tx.withdrawalHold.create({
          data: {
            withdrawalId,
            coinAmount: quote!.coinAmount,
            status: 'ACTIVE',
            debitWalletTransactionId: balanceResult.transactions[0].id,
          },
        });
        const reservation = await tx.withdrawalLiquidityReservation.create({
          data: {
            withdrawalId,
            agentId: candidate.agentId,
            fiatCurrency: quote!.fiatCurrency,
            amount: quote!.fiatAmount,
            status: 'ACTIVE',
          },
        });
        await writeReserveLedgerEntry(tx, candidate, quote!.fiatAmount, quote!.fiatCurrency, withdrawalId, reservation.id);

        // Step 8: audit log. Agent notification is deliberately deferred
        // to the payment-submission phase (explicitly out of scope this
        // turn) — notifying an agent about a withdrawal they have no
        // route to act on yet would be premature.
        await tx.auditLog.create({
          data: {
            userId: actorUserId,
            action: 'WITHDRAWAL_CREATED',
            entity: 'Withdrawal',
            entityId: withdrawal.id,
            newData: {
              coinAmount: quote!.coinAmount,
              fiatAmount: quote!.fiatAmount.toString(),
              fiatCurrency: quote!.fiatCurrency,
              agentId: candidate.agentId,
              status: 'HELD',
            },
            ip: context?.ip,
            userAgent: context?.userAgent,
          },
        });

        return { withdrawal, idempotent: false };
      });
    } catch (err) {
      if (err instanceof LiquidityContentionError) {
        if (attempt < MAX_LIQUIDITY_RETRY_ATTEMPTS - 1) continue;
        throw ApiError.conflict('No agent liquidity is currently available for this withdrawal — please try again shortly', {
          code: 'INSUFFICIENT_LIQUIDITY',
        });
      }

      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        // Mirrors order-service.ts's exact defensive pattern: a P2002
        // here is EITHER the [userId, idempotencyKey] unique constraint
        // (a concurrent duplicate request won the race) OR the
        // withdrawalNumber unique constraint (an unrelated numbering
        // collision) — refetch by idempotency key rather than parse
        // Prisma's non-stable error target shape.
        const winner = await prisma.withdrawal.findUnique({
          where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
        });
        if (winner) {
          if (winner.requestHash === requestHash) {
            return { withdrawal: winner, idempotent: true };
          }
          throw ApiError.conflict('A withdrawal already exists for this idempotency key with different request data', {
            code: 'IDEMPOTENCY_CONFLICT',
          });
        }
        if (attempt < MAX_LIQUIDITY_RETRY_ATTEMPTS - 1) continue;
      }
      throw err;
    }
  }
  throw ApiError.conflict('Could not create withdrawal — please retry');
}

export async function getOwnWithdrawalById(actorUserId: string, withdrawalId: string) {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (withdrawal.userId !== actorUserId) throw ApiError.forbidden('This withdrawal does not belong to you');
  return withdrawal;
}

export async function listOwnWithdrawals(actorUserId: string) {
  return prisma.withdrawal.findMany({ where: { userId: actorUserId }, orderBy: { createdAt: 'desc' } });
}

// ═══════════════════════════════════════════════════════════════════
// W-1D1: withdrawal lifecycle — agent reads, payout claim, payment
// submission, user cancel
//
// Every state-changing function follows the same idempotency pattern:
//   1. Lock the withdrawal row (SELECT ... FOR UPDATE inside $transaction).
//   2. Re-check status and authorization inside the lock.
//   3. Check WithdrawalOperation by (withdrawalId, action, idempotencyKey):
//        - hit + matching requestHash  → idempotent replay (re-read, return)
//        - hit + mismatched requestHash → 409 CONFLICT
//        - no hit → proceed with mutation + insert WithdrawalOperation
//   4. On replay: re-read canonical DB entities (never return cached data),
//      re-evaluate authorization before returning.
// ═══════════════════════════════════════════════════════════════════

// ─── Request hash helpers ──────────────────────────────────────

function hashLifecycleRequest(parts: string[]): string {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

function computeClaimPayoutHash(): string {
  return hashLifecycleRequest(['claim-payout']);
}

function computeSubmitPaymentHash(referenceNumber: string, normalizedNote: string | null): string {
  return hashLifecycleRequest(['submit-payment', referenceNumber, normalizedNote ?? '']);
}

/** Trims and collapses a blank note to null — the SAME normalized value
 * must feed both the request hash and the stored column, or a client
 * sending "x" vs " x " (or "" vs omitted) would hash differently while
 * persisting identically, or vice versa. */
function normalizeNote(note: string | undefined): string | null {
  if (!note) return null;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function computeCancelHash(): string {
  return hashLifecycleRequest(['cancel']);
}

// ─── Authorization helpers ─────────────────────────────────────
//
// W-1D1 agent reads and state-changing actions are restricted to agents
// whose profile status is ACTIVE. Any other status (PENDING_VERIFICATION,
// TEMPORARILY_SUSPENDED, DISABLED, UNDER_REVIEW) is blocked with 403 for
// every W-1D1 agent path. Recovery for a suspended/disabled assigned agent
// belongs to the W-1D2 admin escalation — no admin override exists here.
// User-initiated cancelHeldWithdrawal does NOT go through these helpers:
// it is a user action and must succeed regardless of the assigned agent's
// status.

const AGENT_ACTIVE_STATUS = 'ACTIVE';

async function requireActiveAgent(actorUserId: string) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  if (agent.status !== AGENT_ACTIVE_STATUS) {
    throw ApiError.forbidden('Your agent account is not active');
  }
  return agent;
}

async function requireAssignedAgent(actorUserId: string, withdrawalAgentId: string) {
  const agent = await requireActiveAgent(actorUserId);
  if (agent.id !== withdrawalAgentId) {
    throw ApiError.forbidden('You are not the assigned agent for this withdrawal');
  }
  return agent;
}

// W-1D2A: re-verify the assigned agent is ACTIVE **inside the caller's
// transaction**, against a fresh read, AFTER the Withdrawal row is locked.
//
// The pre-flight requireAssignedAgent() reads the agent row (and its status)
// OUTSIDE the transaction. An admin may disable/suspend the agent in the
// window between that read and the Withdrawal FOR UPDATE lock. Re-reading the
// agent here — before the idempotent-replay lookup and before any mutation —
// guarantees authorization (identity AND ACTIVE status) is re-validated under
// the lock, so a disabled/suspended agent can neither begin a NEW payout nor
// obtain a SUCCESSFUL idempotent replay of one. Authorization stays before
// idempotent replay; idempotent replay stays before the status gate.
async function assertActiveAssignedAgentInTx(tx: any, actorUserId: string, withdrawalAgentId: string) {
  const agent = await tx.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  if (agent.id !== withdrawalAgentId) {
    throw ApiError.forbidden('You are not the assigned agent for this withdrawal');
  }
  if (agent.status !== AGENT_ACTIVE_STATUS) {
    throw ApiError.forbidden('Your agent account is not active');
  }
  return agent;
}

// ─── W-1D1 Function 1: listAssignedWithdrawals ────────────────

export interface WithdrawalFilter {
  status?: string;
}

export async function listAssignedWithdrawals(
  actorUserId: string,
  filters?: WithdrawalFilter
) {
  // Only ACTIVE agents may read their assigned withdrawals (R1).
  const agent = await requireActiveAgent(actorUserId);

  const where: Record<string, unknown> = { agentId: agent.id };
  if (filters?.status) {
    where.status = filters.status;
  }

  return prisma.withdrawal.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: {
      hold: { select: { coinAmount: true, status: true } },
      user: { select: { id: true, username: true, displayName: true } },
    },
  });
}

// ─── W-1D1 Function 2: getAssignedWithdrawal ──────────────────

export async function getAssignedWithdrawal(
  actorUserId: string,
  withdrawalId: string
) {
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (!withdrawal.agentId) throw ApiError.notFound('Withdrawal has no assigned agent');
  await requireAssignedAgent(actorUserId, withdrawal.agentId);
  return withdrawal;
}
// ─── W-1D1 Function 3: claimPayout ────────────────────────────
//
// HELD → PAYOUT_IN_PROGRESS
//
// The assigned agent signals they are beginning the payout process.
// MUST NOT set paymentSubmittedAt (only submitPayment does that).
// Authorised only for the assigned agent.

export async function claimPayout(
  actorUserId: string,
  withdrawalId: string,
  opts: { idempotencyKey: string },
  context?: { ip?: string; userAgent?: string }
) {
  const { idempotencyKey } = opts;
  const requestHash = computeClaimPayoutHash();

  // Pre-flight: load withdrawal + agent outside the transaction.
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (!withdrawal.agentId) throw ApiError.notFound('Withdrawal has no assigned agent');
  const agent = await requireAssignedAgent(actorUserId, withdrawal.agentId);

  return prisma.$transaction(async (tx) => {
    // ── 1. Lock the withdrawal row ──────────────────────────────
    const rows = await tx.$queryRaw<
      Pick<Withdrawal, 'id' | 'status' | 'agentId' | 'paymentSubmissionDeadlineAt'>[]
    >`
      SELECT id, status, "agentId", "paymentSubmissionDeadlineAt"
      FROM withdrawals
      WHERE id = ${withdrawalId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (!locked) throw ApiError.notFound('Withdrawal not found');

    // ── 2. Verify authorization from the LOCKED row ────────────
    if (locked.agentId !== agent.id) {
      throw ApiError.forbidden('You are not the assigned agent for this withdrawal');
    }

    // W-1D2A: re-verify the assigned agent is ACTIVE inside this transaction
    // (fresh read) before idempotent replay or any mutation — see
    // assertActiveAssignedAgentInTx.
    await assertActiveAssignedAgentInTx(tx, actorUserId, locked.agentId);

    // ── 3. Idempotency check BEFORE status ─────────────────────
    // Same-key replay must work even after the withdrawal progressed, so
    // operation lookup precedes the starting-status gate.
    const existingOp = await tx.withdrawalOperation.findUnique({
      where: {
        withdrawalId_action_idempotencyKey: {
          withdrawalId,
          action: 'CLAIM_PAYOUT',
          idempotencyKey,
        },
      },
    });
    if (existingOp) {
      if (existingOp.requestHash !== requestHash) {
        throw ApiError.conflict('Idempotency key reused with different request data', {
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }
      // Replay: re-read canonical entity (never stale cached snapshot).
      const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      return { result: fresh, idempotent: true };
    }

    // ── 4. Only for a NEW operation, enforce starting status ───
    if (locked.status !== 'HELD') {
      throw ApiError.badRequest(`Cannot claim payout from status: ${locked.status}`);
    }

    // W-1D1 fix (Opus adversarial review B1): a HELD withdrawal always
    // has paymentSubmissionDeadlineAt set atomically at creation (W-1D0)
    // — null here is an invariant violation, not a legitimate business
    // state. Rejecting a claim once the deadline has passed only blocks
    // a FUTURE claim attempt — it never moves money, unlike a refund —
    // so this stays even though cancelHeldWithdrawal's own use of this
    // deadline was reverted (see that file's header comment): once an
    // existing PAYOUT_IN_PROGRESS withdrawal is claimed, there is no
    // user-facing escape hatch in W-1D1; the remedy for an abandoned
    // claim is a manual admin decision in a later phase, not automatic
    // or user-triggered.
    if (locked.paymentSubmissionDeadlineAt === null) {
      throw ApiError.internal(
        'paymentSubmissionDeadlineAt is null on a HELD withdrawal — invariant violation'
      );
    }
    if (new Date() >= new Date(locked.paymentSubmissionDeadlineAt)) {
      throw ApiError.conflict(
        'The payment-submission window for this withdrawal has expired — it can no longer be claimed',
        { code: 'PAYOUT_CLAIM_EXPIRED' }
      );
    }

    // ── 5. Transition: HELD → PAYOUT_IN_PROGRESS ───────────────
    await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'PAYOUT_IN_PROGRESS' },
    });

    const opId = randomUUID();
    await tx.withdrawalOperation.create({
      data: {
        id: opId,
        withdrawalId,
        actorUserId,
        action: 'CLAIM_PAYOUT',
        idempotencyKey,
        requestHash,
        resultType: 'Withdrawal',
        resultId: withdrawalId,
      },
    });

    // Audit — unwrapped: a failed write must abort this transaction like
    // any other step (see cancelHeldWithdrawal's header note on why a
    // try/catch here would be both useless and dangerous).
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'WITHDRAWAL_PAYOUT_CLAIMED',
        entity: 'Withdrawal',
        entityId: withdrawalId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        newData: { status: 'PAYOUT_IN_PROGRESS', agentId: agent.id },
      },
    });

    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { result: fresh, idempotent: false };
  });
}

// ─── W-1D1 Function 4: submitPayment ──────────────────────────
//
// PAYOUT_IN_PROGRESS → PAYMENT_SUBMITTED
//
// The assigned agent records proof of payment (referenceNumber + note).
// Creates an immutable WithdrawalPaymentSubmission row.
// Sets paymentSubmittedAt and confirmationDeadlineAt on the withdrawal.
// Authorised only for the assigned agent.

const DEFAULT_CONFIRMATION_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours

export async function submitPayment(
  actorUserId: string,
  withdrawalId: string,
  args: { referenceNumber: string; note?: string; idempotencyKey: string },
  context?: { ip?: string; userAgent?: string }
) {
  const { referenceNumber, note, idempotencyKey } = args;
  if (!referenceNumber || referenceNumber.trim().length === 0) {
    throw ApiError.badRequest('referenceNumber is required');
  }
  const normalizedNote = normalizeNote(note);
  const requestHash = computeSubmitPaymentHash(referenceNumber.trim(), normalizedNote);

  // Pre-flight: load withdrawal + agent outside the transaction.
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (!withdrawal.agentId) throw ApiError.notFound('Withdrawal has no assigned agent');
  const agent = await requireAssignedAgent(actorUserId, withdrawal.agentId);

  return prisma.$transaction(async (tx) => {
    // ── 1. Lock the withdrawal row ──────────────────────────────
    const rows = await tx.$queryRaw<Pick<Withdrawal, 'id' | 'status' | 'agentId'>[]>`
      SELECT id, status, "agentId"
      FROM withdrawals
      WHERE id = ${withdrawalId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (!locked) throw ApiError.notFound('Withdrawal not found');

    // ── 2. Verify authorization from the LOCKED row ────────────
    if (locked.agentId !== agent.id) {
      throw ApiError.forbidden('You are not the assigned agent for this withdrawal');
    }

    // W-1D2A: re-verify the assigned agent is ACTIVE inside this transaction
    // (fresh read) before idempotent replay or any mutation — see
    // assertActiveAssignedAgentInTx.
    await assertActiveAssignedAgentInTx(tx, actorUserId, locked.agentId);

    // ── 3. Idempotency check BEFORE status ─────────────────────
    const existingOp = await tx.withdrawalOperation.findUnique({
      where: {
        withdrawalId_action_idempotencyKey: {
          withdrawalId,
          action: 'SUBMIT_PAYMENT',
          idempotencyKey,
        },
      },
    });
    if (existingOp) {
      if (existingOp.requestHash !== requestHash) {
        throw ApiError.conflict('Idempotency key reused with different request data', {
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }
      // Replay: re-read the canonical payment submission (never stale).
      const existingSubmission = await tx.withdrawalPaymentSubmission.findUnique({
        where: { withdrawalId },
      });
      const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      return { result: existingSubmission, withdrawal: fresh, idempotent: true };
    }

    // ── 4. Only for a NEW operation, enforce starting status ───
    if (locked.status !== 'PAYOUT_IN_PROGRESS') {
      throw ApiError.badRequest(`Cannot submit payment from status: ${locked.status}`);
    }

    // ── 5. Create the payment submission ───────────────────────
    const now = new Date();
    const submission = await tx.withdrawalPaymentSubmission.create({
      data: {
        withdrawalId,
        agentId: agent.id,
        submittedByUserId: actorUserId,
        submittedAt: now,
        referenceNumber: referenceNumber.trim(),
        note: normalizedNote,
        idempotencyKey,
        requestHash,
      },
    });

    // ── Transition: PAYOUT_IN_PROGRESS → PAYMENT_SUBMITTED ─────
    await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: {
        status: 'PAYMENT_SUBMITTED',
        paymentSubmittedAt: now,
        confirmationDeadlineAt: new Date(now.getTime() + DEFAULT_CONFIRMATION_WINDOW_MS),
      },
    });

    const opId = randomUUID();
    await tx.withdrawalOperation.create({
      data: {
        id: opId,
        withdrawalId,
        actorUserId,
        action: 'SUBMIT_PAYMENT',
        idempotencyKey,
        requestHash,
        resultType: 'WithdrawalPaymentSubmission',
        resultId: submission.id,
      },
    });

    // Audit — unwrapped, same reasoning as claimPayout/cancelHeldWithdrawal.
    // referenceNumber is the agent's own external payout reference, not a
    // payout-account secret — safe to log. No paymentSnapshot included.
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'WITHDRAWAL_PAYMENT_SUBMITTED',
        entity: 'Withdrawal',
        entityId: withdrawalId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        newData: {
          status: 'PAYMENT_SUBMITTED',
          agentId: agent.id,
          submissionId: submission.id,
          referenceNumber: submission.referenceNumber,
        },
      },
    });

    const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { result: submission, withdrawal: fresh, idempotent: false };
  });
}

// ─── W-1D1 Function 5: cancelHeldWithdrawal ───────────────────
//
// HELD → CANCELLED. This is the ONLY legal starting state for a
// user-initiated cancel in W-1D1.
//
// The USER (not the agent) cancels a withdrawal that is still held.
// This is the most financially complex operation — it must atomically:
//   1. Refund coins from the hold (using hold.coinAmount, NOT withdrawal.coinAmount)
//   2. Mark the hold as REFUNDED with the refund transaction id
//   3. Release the fiat reservation (AgentFiatLiquidity.reservedBalance decreases)
//   4. NEVER touch AgentInventory or AgentInventoryLedger
//
// PAYOUT_IN_PROGRESS and PAYMENT_SUBMITTED are NEVER cancellable by the
// user — including once paymentSubmissionDeadlineAt has passed. An
// earlier version of this function allowed a user to cancel an expired,
// unclaimed-payment PAYOUT_IN_PROGRESS withdrawal; that was reverted
// (OpenAI review finding, a real money-safety bug, not a false
// positive): once claimPayout has fired, an external fiat transfer may
// already be in progress even though submitPayment has not recorded it
// yet, so a user-triggered refund at that point can double-pay the user
// — coins refunded here AND fiat already sent by the agent, with no way
// for this function to know which has happened. claimPayout may still
// reject a brand-new claim attempt once the deadline has passed (see
// claimPayout — that only blocks a FUTURE claim and never moves money),
// but an EXISTING PAYOUT_IN_PROGRESS withdrawal has no user-facing
// escape hatch in W-1D1. The remedy for an abandoned claim is deferred
// to a later phase as a MANUAL ADMIN decision (PAYOUT_IN_PROGRESS →
// DISPUTED, W-1D2/D3) — never an automatic or user-triggered refund. No
// EXPIRED transition and no DISPUTED transition exist in W-1D1.

export async function cancelHeldWithdrawal(
  actorUserId: string,
  withdrawalId: string,
  opts: { idempotencyKey: string },
  context?: { ip?: string; userAgent?: string }
) {
  const { idempotencyKey } = opts;
  const requestHash = computeCancelHash();

  // Pre-flight: load withdrawal outside the transaction.
  const withdrawal = await prisma.withdrawal.findUnique({ where: { id: withdrawalId } });
  if (!withdrawal) throw ApiError.notFound('Withdrawal not found');
  if (withdrawal.userId !== actorUserId) {
    throw ApiError.forbidden('This withdrawal does not belong to you');
  }

  return prisma.$transaction(async (tx) => {
    // ── 1. Lock the withdrawal row ──────────────────────────────
    const rows = await tx.$queryRaw<Pick<Withdrawal, 'id' | 'status' | 'userId'>[]>`
      SELECT id, status, "userId"
      FROM withdrawals
      WHERE id = ${withdrawalId}
      FOR UPDATE
    `;
    const locked = rows[0];
    if (!locked) throw ApiError.notFound('Withdrawal not found');

    // ── 2. Verify ownership from the LOCKED row ────────────────
    if (locked.userId !== actorUserId) {
      throw ApiError.forbidden('This withdrawal does not belong to you');
    }

    // ── 3. Idempotency check BEFORE status ─────────────────────
    const existingOp = await tx.withdrawalOperation.findUnique({
      where: {
        withdrawalId_action_idempotencyKey: {
          withdrawalId,
          action: 'CANCEL',
          idempotencyKey,
        },
      },
    });
    if (existingOp) {
      if (existingOp.requestHash !== requestHash) {
        throw ApiError.conflict('Idempotency key reused with different request data', {
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }
      // Replay: re-read canonical entity (never stale cached snapshot).
      const fresh = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      return { result: fresh, idempotent: true };
    }

    // ── 4. Only for a NEW operation, enforce starting status ───
    // HELD only — see the file header. PAYOUT_IN_PROGRESS and
    // PAYMENT_SUBMITTED always reject here, deadline or not.
    if (locked.status !== 'HELD') {
      throw ApiError.badRequest(`Cannot cancel withdrawal from status: ${locked.status}`);
    }

    // ── 5. Require exactly one ACTIVE liquidity reservation ────
    const reservation = await tx.withdrawalLiquidityReservation.findUnique({
      where: { withdrawalId },
    });
    if (!reservation) {
      throw ApiError.internal('Withdrawal liquidity reservation not found');
    }
    if (reservation.status !== 'ACTIVE') {
      throw ApiError.internal(`Liquidity reservation is not ACTIVE: ${reservation.status}`);
    }

    // ── 6. Release the fiat reservation BEFORE refunding the wallet ──
    // Money-path lock order: fiat (AgentFiatLiquidity) is released before the
    // coin wallet is refunded, matching the creation order (reserve was taken
    // before the coin hold was spent). Never touches AgentInventory.
    await releaseReservedLiquidity(tx, {
      id: reservation.id,
      agentId: reservation.agentId,
      fiatCurrency: reservation.fiatCurrency,
      amount: reservation.amount,
      withdrawalId,
    });

    // ── 7. Require ACTIVE hold ─────────────────────────────────
    const hold = await tx.withdrawalHold.findUnique({ where: { withdrawalId } });
    if (!hold) throw ApiError.internal('Withdrawal hold not found');
    if (hold.status !== 'ACTIVE') {
      throw ApiError.internal(`Hold is not ACTIVE: ${hold.status}`);
    }

    // ── 8. Refund coins to the user from hold.coinAmount ───────
    const freshWithdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!freshWithdrawal) throw ApiError.notFound('Withdrawal not found');

    await getOrCreateWallet(freshWithdrawal.userId, tx);
    const creditResult = await applyBalanceChanges(tx, freshWithdrawal.userId, [
      {
        currency: 'COINS',
        amount: hold.coinAmount,
        ledgerType: 'CREDIT',
        transactionType: 'COIN_CREDIT',
        referenceType: 'WITHDRAWAL',
        referenceId: withdrawalId,
        description: `Withdrawal cancelled — coin refund`,
      },
    ]);

    // ── 9. Mark the hold as REFUNDED (exactly one ACTIVE hold) ─
    const holdUpdate = await tx.withdrawalHold.updateMany({
      where: { id: hold.id, status: 'ACTIVE' },
      data: {
        status: 'REFUNDED',
        refundWalletTransactionId: creditResult.transactions[0].id,
        releasedAt: new Date(),
      },
    });
    if (holdUpdate.count !== 1) {
      throw ApiError.internal('Hold could not be transitioned to REFUNDED');
    }

    // ── 10. Transition: HELD → CANCELLED ───────────────────────
    await tx.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    // ── 11. Record the operation ───────────────────────────────
    await tx.withdrawalOperation.create({
      data: {
        withdrawalId,
        actorUserId,
        action: 'CANCEL',
        idempotencyKey,
        requestHash,
        resultType: 'Withdrawal',
        resultId: withdrawalId,
      },
    });

    // ── 12. Audit ──────────────────────────────────────────────
    // W-1D1 fix (Opus adversarial review R1): unwrapped, matching
    // createWithdrawal's pattern. The removed try/catch could not achieve
    // its stated goal — PostgreSQL aborts the whole transaction on a
    // failed statement, so catching it in JS does not un-abort it; the
    // very next statement would fail with 25P02 and the cancel would
    // roll back regardless. The only case where the catch "worked" was a
    // client-side Prisma validation error, which would silently commit a
    // coin refund with NO audit record at all. If this write fails, the
    // whole cancel must fail with it.
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'WITHDRAWAL_CANCELLED',
        entity: 'Withdrawal',
        entityId: withdrawalId,
        ip: context?.ip,
        userAgent: context?.userAgent,
        newData: {
          status: 'CANCELLED',
          previousStatus: locked.status,
          refundCoins: hold.coinAmount,
          walletTransactionId: creditResult.transactions[0].id,
          reservationReleased: reservation.id,
        },
      },
    });

    const final = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { result: final, idempotent: false };
  });
}
