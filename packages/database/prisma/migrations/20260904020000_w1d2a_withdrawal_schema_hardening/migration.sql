-- W-1D2A: withdrawal schema hardening (ahead of W-1D2 admin resolution)
--
-- ADDITIVE ONLY for existing rows/tables. This migration:
--   1. Creates two new enums (PaymentSubmissionSource, WithdrawalSettlementOutcome).
--   2. Adds provenance to withdrawal_payment_submissions (source, paymentOccurredAt).
--   3. Adds dispute-origin fields to withdrawal_disputes (openedFromStatus, escalationReason).
--   4. Adds settlement outcome to withdrawal_settlements (outcome, disputeId,
--      refundWalletTransactionId) with a backfill for pre-existing rows.
--      The physical "completedByUserId" column is NOT renamed — the Prisma
--      field rename to resolvedByUserId is schema-only via @map.
--   5. Adds a one-live-withdrawal-per-user partial unique index, preceded by a
--      preflight duplicate check that FAILS (never auto-deletes/resolves) if
--      duplicates exist.
--   6. Adds safe CHECK constraints.
--
-- It does not drop, alter, rename, or rewrite any existing table or column,
-- and modifies no existing data except the explicit outcome backfill below.

-- ── CreateEnum ─────────────────────────────────────────────────

CREATE TYPE "PaymentSubmissionSource" AS ENUM ('AGENT_SUBMITTED', 'ADMIN_VERIFIED');

CREATE TYPE "WithdrawalSettlementOutcome" AS ENUM ('COMPLETED', 'CANCELLED');

-- ── AlterTable: withdrawal_payment_submissions ──────────────────
--
-- W-1D2A provenance. source carries WHERE a payment-submission record came
-- from; default AGENT_SUBMITTED (matching schema.prisma's @default and the
-- existing W-1D1 submitPayment path, which never sets it). paymentOccurredAt
-- records when the external fiat payment actually occurred (or was
-- admin-verified to have) so a COMPLETED withdrawal can satisfy the
-- "payment submitted" invariant independently of the agent-supplied reference.

ALTER TABLE "withdrawal_payment_submissions" ADD COLUMN "source" "PaymentSubmissionSource" NOT NULL DEFAULT 'AGENT_SUBMITTED';
ALTER TABLE "withdrawal_payment_submissions" ADD COLUMN "paymentOccurredAt" TIMESTAMP(3);

-- ── AlterTable: withdrawal_disputes ─────────────────────────────
--
-- W-1D2A dispute-origin fields. openedFromStatus records the Withdrawal
-- status the dispute was opened FROM (nullable). escalationReason is an
-- optional admin escalation note carried on the dispute.

ALTER TABLE "withdrawal_disputes" ADD COLUMN "openedFromStatus" "WithdrawalStatus";
ALTER TABLE "withdrawal_disputes" ADD COLUMN "escalationReason" TEXT;

-- ── AlterTable: withdrawal_settlements ──────────────────────────
--
-- W-1D2A settlement outcome. outcome distinguishes a completed payout from
-- an admin cancellation/refund. disputeId (nullable, unique — one settlement
-- per dispute) links a settlement to the dispute it resolved.
--   refundWalletTransactionId (nullable, unique) records the refund Wallet
--   COIN_CREDIT for a CANCELLED settlement. walletTransactionId is unchanged
--   and always stays the ORIGINAL hold debit.
--
-- Backfill: pre-existing settlements only ever recorded successful
-- completion, so every existing row is set to COMPLETED, then NOT NULL is
-- applied WITHOUT a persisted DB default (schema.prisma declares `outcome`
-- with no @default, so every future settlement write must supply it).

ALTER TABLE "withdrawal_settlements" ADD COLUMN "outcome" "WithdrawalSettlementOutcome";
UPDATE "withdrawal_settlements" SET "outcome" = 'COMPLETED' WHERE "outcome" IS NULL;
ALTER TABLE "withdrawal_settlements" ALTER COLUMN "outcome" SET NOT NULL;
ALTER TABLE "withdrawal_settlements" ADD COLUMN "disputeId" TEXT;
ALTER TABLE "withdrawal_settlements" ADD COLUMN "refundWalletTransactionId" TEXT;

-- ── CreateIndex: unique columns on withdrawal_settlements ───────

CREATE UNIQUE INDEX "withdrawal_settlements_disputeId_key" ON "withdrawal_settlements"("disputeId");
CREATE UNIQUE INDEX "withdrawal_settlements_refundWalletTransactionId_key" ON "withdrawal_settlements"("refundWalletTransactionId");

-- ── Manual SQL: preflight duplicate check ───────────────────────
--
-- Before creating the one-live-withdrawal-per-user partial unique index,
-- verify no user currently holds more than one withdrawal in a "live" state
-- (HELD / PAYOUT_IN_PROGRESS / PAYMENT_SUBMITTED / DISPUTED). If duplicates
-- exist the migration must FAIL with a clear message — never auto-delete or
-- auto-resolve rows. This mirrors the migration philosophy of the existing
-- partial unique indexes in 20260903010000_w1a_withdrawal_tables.

DO $$
DECLARE
    dup_users integer;
BEGIN
    SELECT count(*) INTO dup_users
    FROM (
        SELECT "userId"
        FROM "withdrawals"
        WHERE "status" IN ('HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED')
        GROUP BY "userId"
        HAVING count(*) > 1
    ) d;

    IF dup_users > 0 THEN
        RAISE EXCEPTION
            'Cannot create one-live-withdrawal-per-user index: % user(s) currently have more than one live withdrawal (HELD / PAYOUT_IN_PROGRESS / PAYMENT_SUBMITTED / DISPUTED). Resolve duplicates manually before applying this migration.',
            dup_users;
    END IF;
END $$;

-- ── Manual SQL: partial unique index ────────────────────────────
--
-- At most one live withdrawal per user. Statuses considered "live":
-- HELD, PAYOUT_IN_PROGRESS, PAYMENT_SUBMITTED, DISPUTED. Terminal states
-- (COMPLETED, CANCELLED, EXPIRED, CREATED) are excluded. This is the hard
-- DB backstop for the application-level ACTIVE_WITHDRAWAL_EXISTS check in
-- createWithdrawal.

CREATE UNIQUE INDEX "withdrawals_one_live_per_user_unique" ON "withdrawals"("userId")
    WHERE "status" IN ('HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED');

-- ── Manual SQL: CHECK constraints ───────────────────────────────
--
-- Positive amounts (fiat/coin) are always strictly positive in this domain;
-- liquidity balances are never negative and reserved never exceeds total
-- (available = total - reserved is kept >= 0 on every committed state); a
-- CANCELLED settlement must reference its refund; a RESOLVED dispute must be
-- complete.

-- withdrawals: positive amounts
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_positive_amounts_check"
    CHECK ("coinAmount" > 0 AND "fiatAmount" > 0);

-- withdrawal_holds: positive coin hold
ALTER TABLE "withdrawal_holds" ADD CONSTRAINT "withdrawal_holds_positive_coin_amount_check"
    CHECK ("coinAmount" > 0);

-- withdrawal_liquidity_reservations: positive reservation amount
ALTER TABLE "withdrawal_liquidity_reservations" ADD CONSTRAINT "withdrawal_liquidity_reservations_positive_amount_check"
    CHECK ("amount" > 0);

-- agent_fiat_liquidities: nonnegative + available (total - reserved) >= 0
ALTER TABLE "agent_fiat_liquidities" ADD CONSTRAINT "agent_fiat_liquidities_nonnegative_balance_check"
    CHECK ("totalBalance" >= 0 AND "reservedBalance" >= 0 AND "reservedBalance" <= "totalBalance");

-- withdrawal_settlements: a CANCELLED settlement must record its refund
ALTER TABLE "withdrawal_settlements" ADD CONSTRAINT "withdrawal_settlements_cancelled_requires_refund_check"
    CHECK (("outcome" <> 'CANCELLED') OR ("refundWalletTransactionId" IS NOT NULL));

-- withdrawal_disputes: a RESOLVED dispute must carry resolution + resolvedBy + resolvedAt
ALTER TABLE "withdrawal_disputes" ADD CONSTRAINT "withdrawal_disputes_resolved_complete_check"
    CHECK (("status" <> 'RESOLVED') OR ("resolution" IS NOT NULL AND "resolvedBy" IS NOT NULL AND "resolvedAt" IS NOT NULL));
