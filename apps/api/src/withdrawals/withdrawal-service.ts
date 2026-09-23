import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import type { Withdrawal } from '@socialplay/database';
import { ApiError } from '../middleware/error-handler.js';
import { lockUserEconomicScope, reserveWithdrawalCoins, releaseWithdrawalCoins } from '../economy/coin-ledger-service.js';
import { requireActiveWithdrawalPolicy } from '../economy/jurisdiction-service.js';
import { getOrCreateWallet } from '../economy/wallet-service.js';
import { requireStepUp } from '../security/step-up-service.js';
import { lockWithdrawalParticipants } from './lock-order.js';
import {
  LiquidityContentionError,
  selectEligibleAgentLiquidity,
  incrementReservedLiquidity,
  writeReserveLedgerEntry,
  releaseReservedLiquidity,
} from './liquidity-service.js';

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

/** Count open and finalized holds in UTC calendar windows. Cancelled holds no
 * longer count because their Coins have been returned to the original lots. */
async function assertWithdrawalPolicyLimits(
  tx: any,
  userId: string,
  coinAmount: number,
  policy: {
    minWithdrawal: number;
    maxWithdrawal: number;
    dailyWithdrawalLimit: number;
    monthlyWithdrawalLimit: number;
  },
  now: Date
): Promise<void> {
  if (coinAmount < policy.minWithdrawal || coinAmount > policy.maxWithdrawal) {
    throw ApiError.badRequest('Withdrawal amount is outside the active country policy limits');
  }
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const states = ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED', 'COMPLETED'] as const;
  const [day, month] = await Promise.all([
    tx.withdrawal.aggregate({
      where: { userId, status: { in: [...states] }, createdAt: { gte: dayStart } },
      _sum: { coinAmount: true },
    }),
    tx.withdrawal.aggregate({
      where: { userId, status: { in: [...states] }, createdAt: { gte: monthStart } },
      _sum: { coinAmount: true },
    }),
  ]);
  if ((day._sum.coinAmount ?? 0) + coinAmount > policy.dailyWithdrawalLimit) {
    throw ApiError.badRequest('Daily withdrawal limit exceeded');
  }
  if ((month._sum.coinAmount ?? 0) + coinAmount > policy.monthlyWithdrawalLimit) {
    throw ApiError.badRequest('Monthly withdrawal limit exceeded');
  }
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
 *   5. reserve withdrawable Coins in their source lots and debit the wallet
 *      exactly once through reserveWithdrawalCoins.
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

  for (let attempt = 0; attempt < MAX_LIQUIDITY_RETRY_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockUserEconomicScope(tx, `withdrawal_create:${actorUserId}`);

        // The per-user advisory lock makes this replay lookup conclusive.
        // Both identical and different-key creates serialize here, before
        // checking the one-live rule or attempting liquidity selection.
        // Follow-up fix: repeat the idempotency lookup INSIDE the
        // transaction, before the one-live-withdrawal check below. The
        // pre-flight lookup above runs OUTSIDE any transaction, so it is a
        // fast path only — a concurrent request carrying the SAME [userId,
        // idempotencyKey] can miss it (both copies read null before either
        // has written anything), then this copy enters the transaction
        // AFTER the winning copy has already committed a live withdrawal.
        // Without this re-check, the loser would fall straight into the
        // one-live-withdrawal count below, see the winner's own row, and
        // incorrectly throw ACTIVE_WITHDRAWAL_EXISTS instead of replaying
        // idempotently — the request never even reaches quote claim, so
        // the existing quote-claim-race fallback (below) cannot catch it.
        const existingInTx = await tx.withdrawal.findUnique({
          where: { userId_idempotencyKey: { userId: actorUserId, idempotencyKey: args.idempotencyKey } },
        });
        if (existingInTx) {
          if (existingInTx.requestHash === requestHash) {
            return { withdrawal: existingInTx, idempotent: true };
          }
          throw ApiError.conflict('A withdrawal already exists for this idempotency key with different request data', {
            code: 'IDEMPOTENCY_CONFLICT',
          });
        }

        const userRows = await tx.$queryRaw<{ status: string }[]>`
          SELECT status::text AS status FROM users WHERE id = ${actorUserId} FOR SHARE
        `;
        if (userRows[0]?.status !== 'ACTIVE') {
          throw ApiError.forbidden('Your account cannot create withdrawals in its current state');
        }

        const quotePreview = await tx.withdrawalQuote.findUnique({ where: { id: args.quoteId } });
        if (!quotePreview) throw ApiError.badRequest('Invalid quote');
        if (quotePreview.userId !== actorUserId) {
          throw ApiError.forbidden('This quote does not belong to you');
        }

        // Lock the selected, verified payout destination before claiming the
        // quote or the fiat liquidity. The policy must match this account.
        const payoutRows = await tx.$queryRaw<Array<{
          id: string; userId: string; countryId: string; methodDefId: string;
          accountDetails: unknown; status: string;
        }>>`
          SELECT id, "userId", "countryId", "methodDefId", "accountDetails", status::text AS status
          FROM user_payout_accounts WHERE id = ${args.payoutAccountId} FOR SHARE
        `;
        const payoutAccount = payoutRows[0];
        if (!payoutAccount || payoutAccount.userId !== actorUserId) {
          throw ApiError.forbidden('This payout account does not belong to you');
        }
        if (payoutAccount.status !== 'ACTIVE') {
          throw ApiError.badRequest('This payout account is not currently active');
        }
        if (payoutAccount.countryId !== quotePreview.countryId) {
          throw ApiError.badRequest('This payout account does not belong to the quote\'s country');
        }
        // The selected payout method is part of the verified destination at
        // L2. Hold its definition against deactivation until commit.
        const methodRows = await tx.$queryRaw<Array<{
          id: string; type: string; countryId: string; isActive: boolean;
        }>>`
          SELECT id, type::text AS type, "countryId", "isActive"
          FROM payment_method_definitions WHERE id = ${payoutAccount.methodDefId} FOR SHARE
        `;
        const method = methodRows[0];
        if (!method || !method.isActive || method.countryId !== payoutAccount.countryId) {
          throw ApiError.forbidden('Selected payout method is unavailable in this country');
        }

        // A quote can outlive a country-level payment disable. Serialize the
        // final hold with that flag change before pinning the country policy.
        const countries = await tx.$queryRaw<Array<{
          id: string; isActive: boolean; agentPaymentEnabled: boolean;
        }>>`
          SELECT id, "isActive", "agentPaymentEnabled"
          FROM countries WHERE id = ${payoutAccount.countryId} FOR SHARE
        `;
        if (!countries[0]?.isActive || !countries[0]?.agentPaymentEnabled) {
          throw ApiError.forbidden('Withdrawals are not available for this country');
        }

        const policy = await requireActiveWithdrawalPolicy(tx, actorUserId, payoutAccount.countryId);
        if (policy.countryId !== quotePreview.countryId) {
          throw ApiError.forbidden('The selected payout country does not match your verified jurisdiction');
        }
        const supportedMethods = policy.supportedPaymentMethods;
        if (!Array.isArray(supportedMethods) ||
            !supportedMethods.every((item: unknown) => typeof item === 'string') ||
            !supportedMethods.includes(method.type)) {
          throw ApiError.forbidden('Selected payout method is not supported by the active country policy');
        }
        const configuredFee = Number(policy.withdrawalFeePercent);
        if (!Number.isFinite(configuredFee) || configuredFee !== 0) {
          throw ApiError.forbidden('Withdrawal fee policy requires an approved quote flow');
        }
        if (policy.manualReviewThreshold > 0 &&
            quotePreview.coinAmount >= policy.manualReviewThreshold) {
          throw ApiError.forbidden('This withdrawal requires a manual-review flow');
        }

        const securityPolicy = await tx.userSecurityPolicy.findUnique({
          where: { userId: actorUserId },
          select: { requiresStepUpForSensitiveOps: true },
        });
        const needsStepUp = securityPolicy?.requiresStepUpForSensitiveOps ?? false;
        if (needsStepUp && (tokenIat === undefined || tokenIat === null)) {
          throw ApiError.forbidden('Step-up authentication required', { code: 'STEP_UP_REQUIRED' });
        }

        const withdrawalId = randomUUID();
        const now = new Date();

        // W-1D2A Step 0: one-live-withdrawal-per-user rule. Reject before the
        // quote is claimed / wallet is debited / liquidity is reserved if the
        // user already has a live withdrawal (HELD / PAYOUT_IN_PROGRESS /
        // PAYMENT_SUBMITTED / DISPUTED). This is the deterministic
        // application-level guard; the partial unique index
        // (withdrawals_one_live_per_user_unique) remains the hard DB backstop
        // for the concurrent race. Idempotent replays never reach here — the
        // pre-flight check above AND the in-transaction re-check just above
        // both return the existing withdrawal first.
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

        // L5: lock the wallet before policy-window aggregation and lot
        // allocation. This also serializes limits against a concurrent
        // cancellation which releases its hold under the same wallet lock.
        await getOrCreateWallet(actorUserId, tx);
        await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${actorUserId} FOR UPDATE`;
        await assertWithdrawalPolicyLimits(tx, actorUserId, quote!.coinAmount, policy, now);
        const coinHold = await reserveWithdrawalCoins(tx, actorUserId, quote!.coinAmount, {
          withdrawalId,
          policyId: policy.id,
          policyVersion: policy.version,
          holdingPeriodHours: policy.holdingPeriodHours,
          now,
        });

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
            debitWalletTransactionId: coinHold.walletTransactionId,
            holdOperationId: coinHold.holdOperationId,
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
      }, { timeout: 30_000 });
    } catch (err) {
      if (err instanceof LiquidityContentionError) {
        if (attempt < MAX_LIQUIDITY_RETRY_ATTEMPTS - 1) continue;
        throw ApiError.conflict('No agent liquidity is currently available for this withdrawal — please try again shortly', {
          code: 'INSUFFICIENT_LIQUIDITY',
        });
      }

      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        // A P2002 here can come from any of THREE unique constraints:
        // [userId, idempotencyKey], the withdrawals_one_live_per_user_unique
        // partial index (W-1D2A), or the withdrawalNumber sequence
        // collision. Rather than parse Prisma's non-stable error target
        // shape, disambiguate by re-reading in priority order — each
        // check only converts the error when it can positively explain
        // it; if neither explains it, the error is rethrown unchanged
        // below rather than masked as the wrong case (requirement: do not
        // mask an unrelated P2002).
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

        // Not an idempotency-key collision — check whether it's the
        // one-live-per-user partial unique index instead: a genuinely
        // DIFFERENT concurrent request for the same user that raced past
        // the in-transaction liveWithdrawalCount check above (both read 0
        // before either committed).
        const liveNow = await prisma.withdrawal.count({
          where: {
            userId: actorUserId,
            status: { in: ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED'] },
          },
        });
        if (liveNow > 0) {
          throw ApiError.conflict('You already have an active withdrawal in progress', {
            code: 'ACTIVE_WITHDRAWAL_EXISTS',
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
  // Lock the Agent row after the caller has locked Withdrawal. A plain
  // findUnique is not enough under READ COMMITTED: it can observe ACTIVE
  // while a concurrent admin status change is still uncommitted, then allow
  // claim/submit to commit after the disable. FOR SHARE serializes against
  // role/status UPDATEs while remaining compatible with the KEY SHARE lock a
  // concurrent withdrawal creation takes for its Agent foreign key. This
  // avoids a cycle with that creation's already-locked fiat-liquidity row.
  const rows = await tx.$queryRaw<
    { id: string; userId: string; status: string }[]
  >`
    SELECT id, "userId", status
    FROM agents
    WHERE "userId" = ${actorUserId}
    FOR SHARE
  `;
  const agent = rows[0];
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
    await lockUserEconomicScope(tx, `withdrawal:${withdrawalId}`);
    await lockWithdrawalParticipants(tx, withdrawalId, actorUserId);
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
    await lockUserEconomicScope(tx, `withdrawal:${withdrawalId}`);
    await lockWithdrawalParticipants(tx, withdrawalId, actorUserId);
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
    await lockUserEconomicScope(tx, `withdrawal:${withdrawalId}`);
    await lockWithdrawalParticipants(tx, withdrawalId, actorUserId);
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
    const reservationRows = await tx.$queryRaw<Array<{
      id: string; withdrawalId: string; agentId: string;
      fiatCurrency: string; amount: bigint; status: string;
    }>>`
      SELECT id, "withdrawalId", "agentId", "fiatCurrency", amount, status::text AS status
      FROM withdrawal_liquidity_reservations
      WHERE "withdrawalId" = ${withdrawalId}
      FOR UPDATE
    `;
    const reservation = reservationRows[0];
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
    const holdRows = await tx.$queryRaw<Array<{
      id: string; coinAmount: number; status: string; holdOperationId: string | null;
    }>>`
      SELECT id, "coinAmount", status::text AS status, "holdOperationId"
      FROM withdrawal_holds WHERE "withdrawalId" = ${withdrawalId} FOR UPDATE
    `;
    const hold = holdRows[0];
    if (!hold) throw ApiError.internal('Withdrawal hold not found');
    if (hold.status !== 'ACTIVE') {
      throw ApiError.internal(`Hold is not ACTIVE: ${hold.status}`);
    }
    if (!hold.holdOperationId) {
      throw ApiError.internal('Active withdrawal hold lacks a Coin reservation operation');
    }

    // ── 8. Refund coins to the user from hold.coinAmount ───────
    const freshWithdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!freshWithdrawal) throw ApiError.notFound('Withdrawal not found');

    await getOrCreateWallet(freshWithdrawal.userId, tx);
    await tx.$queryRaw`SELECT id FROM wallets WHERE "userId" = ${freshWithdrawal.userId} FOR UPDATE`;
    const coinRelease = await releaseWithdrawalCoins(tx, freshWithdrawal.userId, withdrawalId, {
      holdOperationId: hold.holdOperationId,
      amount: hold.coinAmount,
    });

    // ── 9. Mark the hold as REFUNDED (exactly one ACTIVE hold) ─
    const holdUpdate = await tx.withdrawalHold.updateMany({
      where: { id: hold.id, status: 'ACTIVE' },
      data: {
        status: 'REFUNDED',
        refundWalletTransactionId: coinRelease.walletTransactionId,
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
          walletTransactionId: coinRelease.walletTransactionId,
          reservationReleased: reservation.id,
        },
      },
    });

    const final = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    return { result: final, idempotent: false };
  });
}
