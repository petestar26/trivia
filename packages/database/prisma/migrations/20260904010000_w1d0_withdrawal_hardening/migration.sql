-- W-1D0: Withdrawal lifecycle hardening (ahead of W-1D1 lifecycle routes)
--
-- ADDITIVE ONLY. This migration adds one nullable column, two new tables,
-- their indexes/foreign keys, one CHECK constraint, and one partial
-- unique index. It does not drop, alter, rename, or rewrite any existing
-- table, column, index, or constraint, and modifies no existing data.
--
-- No lifecycle route in this repository writes to either new table yet
-- (submit-payment, cancel, confirm-receipt, dispute are all out of scope
-- for this slice) — see schema.prisma's comments on
-- WithdrawalPaymentSubmission / WithdrawalOperation for intended future
-- usage.

-- ── AlterTable ─────────────────────────────────────────────────

ALTER TABLE "withdrawals" ADD COLUMN "paymentSubmissionDeadlineAt" TIMESTAMP(3);

-- ── CreateTable ─────────────────────────────────────────────────

-- withdrawal_payment_submissions
CREATE TABLE "withdrawal_payment_submissions" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "note" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_payment_submissions_pkey" PRIMARY KEY ("id")
);

-- withdrawal_operations
CREATE TABLE "withdrawal_operations" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "resultType" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_operations_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ─────────────────────────────────────────────────

CREATE INDEX "withdrawals_status_paymentSubmissionDeadlineAt_idx" ON "withdrawals"("status", "paymentSubmissionDeadlineAt");

CREATE UNIQUE INDEX "withdrawal_payment_submissions_withdrawalId_key" ON "withdrawal_payment_submissions"("withdrawalId");
CREATE UNIQUE INDEX "withdrawal_payment_submissions_withdrawalId_idempotencyKey_key" ON "withdrawal_payment_submissions"("withdrawalId", "idempotencyKey");
CREATE INDEX "withdrawal_payment_submissions_agentId_createdAt_idx" ON "withdrawal_payment_submissions"("agentId", "createdAt");

CREATE UNIQUE INDEX "withdrawal_operations_withdrawalId_action_idempotencyKey_key" ON "withdrawal_operations"("withdrawalId", "action", "idempotencyKey");
CREATE INDEX "withdrawal_operations_withdrawalId_action_idx" ON "withdrawal_operations"("withdrawalId", "action");

-- ── Manual SQL: CHECK constraint ────────────────────────────────
--
-- A COMPLETED withdrawal must have recorded when payment was submitted.
-- Backstops the state machine at the database level — mirrors the
-- philosophy of the partial unique indexes below and in
-- 20260903010000_w1a_withdrawal_tables.

ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_completed_requires_payment_submitted_check"
    CHECK ("status" <> 'COMPLETED' OR "paymentSubmittedAt" IS NOT NULL);

-- ── Manual SQL: partial unique index ────────────────────────────
--
-- At most one terminal (RELEASE or CONSUME, combined) ledger entry per
-- withdrawal liquidity reservation — backstops invariant #15 in
-- docs/withdrawal-w1-w2-design.md §4 ("A reservation transitions exactly
-- once from ACTIVE to either RELEASED or CONSUMED"): a reservation must
-- never be both released AND consumed, and must never be released or
-- consumed twice.

CREATE UNIQUE INDEX "agent_fiat_liquidity_ledger_reservation_terminal_unique" ON "agent_fiat_liquidity_ledger" ("reservationId")
    WHERE "type" IN ('RELEASE', 'CONSUME') AND "reservationId" IS NOT NULL;

-- ── AddForeignKey ───────────────────────────────────────────────

ALTER TABLE "withdrawal_payment_submissions" ADD CONSTRAINT "withdrawal_payment_submissions_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_payment_submissions" ADD CONSTRAINT "withdrawal_payment_submissions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_payment_submissions" ADD CONSTRAINT "withdrawal_payment_submissions_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "withdrawal_operations" ADD CONSTRAINT "withdrawal_operations_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
