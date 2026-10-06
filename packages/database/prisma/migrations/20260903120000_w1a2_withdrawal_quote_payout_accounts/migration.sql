-- W-1A2: Withdrawal quote persistence + user payout destination
--
-- Corrects two gaps discovered in W-1A before any withdrawal-creation
-- service code was written (the "withdrawals" table has zero rows in
-- every real environment right now, since no code has ever inserted
-- into it — see the NOT NULL "quoteId" note below):
--
--   1. No WithdrawalQuote table existed, so a quote could not be
--      persisted, claimed, and consumed independently of payout-account
--      selection, as the withdrawal-creation flow requires.
--
--   2. Withdrawal.paymentAccountId had no backing table at all, and its
--      own comment ("agent's payout account") was semantically wrong — a
--      withdrawal pays the USER, so the destination must be the user's
--      own account. UserPayoutAccount is a new, distinct table; it does
--      NOT reuse AgentPaymentAccount, which is a different entity (agent
--      receiving accounts for coin purchases) with a different lifecycle.
--
-- ADDITIVE ONLY, with one exception that is safe by construction: adding
-- "quoteId" NOT NULL to the already-deployed "withdrawals" table. This is
-- safe ONLY because "withdrawals" is provably empty in every environment
-- this migration could run against — W-1B service code (the only thing
-- that could ever insert a row) has been explicitly paused pending this
-- fix, and no route/service code inserting into "withdrawals" has ever
-- existed. If that assumption stops holding before this migration is
-- deployed, this ADD COLUMN step must be split into a nullable-then-
-- backfill-then-NOT-NULL sequence instead.
--
-- No other existing table, column, index, or constraint is touched.
-- "withdrawals"."paymentAccountId" (the physical column) is NOT renamed —
-- the Prisma field renamed to userPayoutAccountId keeps
-- @map("paymentAccountId"), so there is no ALTER/RENAME for it here.
--
-- Both new enum types below are freshly CREATEd (not ALTER TYPE ... ADD
-- VALUE on a pre-existing type), so — unlike the W-1A
-- TransactionReferenceType addition — they may legally be used in the
-- same transaction/file that creates them. No migration split is needed.

-- ── CreateEnum ─────────────────────────────────────────────────

CREATE TYPE "WithdrawalQuoteStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'EXPIRED');

CREATE TYPE "UserPayoutAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- ── CreateTable ─────────────────────────────────────────────────

-- withdrawal_quotes
CREATE TABLE "withdrawal_quotes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "fiatAmount" BIGINT NOT NULL,
    "exchangeRateConfigId" TEXT NOT NULL,
    "exchangeRateValue" DECIMAL(18,6) NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "WithdrawalQuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedByWithdrawalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_quotes_pkey" PRIMARY KEY ("id")
);

-- user_payout_accounts
CREATE TABLE "user_payout_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "methodDefId" TEXT NOT NULL,
    "accountDetails" JSONB NOT NULL,
    "displayLabel" TEXT,
    "status" "UserPayoutAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_payout_accounts_pkey" PRIMARY KEY ("id")
);

-- ── AlterTable ─────────────────────────────────────────────────
--
-- Safe as a plain NOT NULL add: "withdrawals" has zero rows in every
-- real environment (see header note). Postgres validates the NOT NULL
-- constraint against existing rows at ADD COLUMN time; against an empty
-- table this succeeds immediately with no rewrite/backfill needed.

ALTER TABLE "withdrawals" ADD COLUMN "quoteId" TEXT NOT NULL;

-- ── CreateIndex ─────────────────────────────────────────────────

-- withdrawal_quotes: consumedByWithdrawalId's uniqueness (below) already
-- provides an index for point lookups on that column, so no separate
-- plain index is added for it.
CREATE UNIQUE INDEX "withdrawal_quotes_consumedByWithdrawalId_key" ON "withdrawal_quotes"("consumedByWithdrawalId");
CREATE INDEX "withdrawal_quotes_userId_createdAt_idx" ON "withdrawal_quotes"("userId", "createdAt");
CREATE INDEX "withdrawal_quotes_status_expiresAt_idx" ON "withdrawal_quotes"("status", "expiresAt");

-- user_payout_accounts
CREATE INDEX "user_payout_accounts_userId_status_idx" ON "user_payout_accounts"("userId", "status");

-- withdrawals: quoteId is the exactly-once structural backstop for quote
-- consumption (mirrors WithdrawalHold.withdrawalId / AgentOrderSettlement.orderId).
CREATE UNIQUE INDEX "withdrawals_quoteId_key" ON "withdrawals"("quoteId");

-- ── AddForeignKey ───────────────────────────────────────────────

ALTER TABLE "withdrawal_quotes" ADD CONSTRAINT "withdrawal_quotes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_quotes" ADD CONSTRAINT "withdrawal_quotes_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_payout_accounts" ADD CONSTRAINT "user_payout_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_payout_accounts" ADD CONSTRAINT "user_payout_accounts_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_payout_accounts" ADD CONSTRAINT "user_payout_accounts_methodDefId_fkey" FOREIGN KEY ("methodDefId") REFERENCES "payment_method_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "withdrawal_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "user_payout_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
