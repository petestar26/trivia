import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { getOrCreateWallet, applyBalanceChanges } from '../economy/wallet-service';
import { requiresStepUp, requireStepUp } from '../security/step-up-service';
import {
  LiquidityContentionError,
  selectEligibleAgentLiquidity,
  incrementReservedLiquidity,
  writeReserveLedgerEntry,
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
 *      incrementReservedLiquidity in liquidity-service.ts.
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
          quote!.fiatAmount
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
