-- W-1A: Withdrawal Schema (Phase W-1/W-2)
--
-- ADDITIVE ONLY. This migration creates new enums, tables, indexes, and
-- constraints. It does not drop, alter, rename, or rewrite any existing
-- table, column, index, or constraint.
--
-- No existing financial table (wallets, wallet_transactions,
-- agent_inventories, agent_orders, agent_reservations,
-- agent_order_settlements, disputes, security tables) is modified.
-- No existing data is modified.
--
-- The WITHDRAWAL value added to TransactionReferenceType lives in its own
-- migration (20260903000000_w1a_withdrawal_enum) so that the partial
-- unique indexes below may legally reference it in their WHERE predicates.

-- ── CreateEnum ─────────────────────────────────────────────────

CREATE TYPE "WithdrawalStatus" AS ENUM (
    'CREATED', 'HELD', 'PAYMENT_SUBMITTED', 'DISPUTED',
    'COMPLETED', 'CANCELLED', 'EXPIRED'
);

CREATE TYPE "WithdrawalHoldStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'REFUNDED');

CREATE TYPE "WithdrawalSettlementOrigin" AS ENUM (
    'USER_CONFIRMED', 'ADMIN_DISPUTE_RESOLUTION', 'DIRECT'
);

CREATE TYPE "FiatLiquidityType" AS ENUM (
    'INITIAL_FUNDING', 'RESERVE', 'RELEASE', 'CONSUME',
    'ADMIN_ADJUSTMENT', 'AGENT_CREDIT', 'AGENT_DEBIT'
);

CREATE TYPE "WithdrawalDisputeStatus" AS ENUM ('OPEN', 'ASSIGNED', 'RESOLVED');

CREATE TYPE "WithdrawalDisputeReason" AS ENUM (
    'FIAT_NOT_RECEIVED', 'WRONG_FIAT_AMOUNT', 'AGENT_UNRESPONSIVE', 'OTHER'
);

CREATE TYPE "WithdrawalDisputeResolution" AS ENUM ('RELEASE_COINS', 'CANCEL_WITHDRAWAL');

-- ── CreateTable ─────────────────────────────────────────────────
--
-- Lock ordering documented for every withdrawal transaction:
--
--   Withdrawal
--   → WithdrawalLiquidityReservation
--   → AgentFiatLiquidity (AGENT RESOURCE)
--   → WithdrawalHold → Wallet (USER WALLET)
--
-- Never Wallet first and Agent liquidity second.

-- withdrawals
CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "withdrawalNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT,
    "requestHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "paymentMethodDefId" TEXT NOT NULL,
    "paymentAccountId" TEXT NOT NULL,
    "paymentSnapshot" JSONB NOT NULL,
    "fiatAmount" BIGINT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "exchangeRateConfigId" TEXT NOT NULL,
    "exchangeRateValue" DECIMAL(18,6) NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'CREATED',
    "quoteExpiresAt" TIMESTAMP(3) NOT NULL,
    "confirmationDeadlineAt" TIMESTAMP(3),
    "paymentSubmittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- withdrawal_holds
CREATE TABLE "withdrawal_holds" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "status" "WithdrawalHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "debitWalletTransactionId" TEXT NOT NULL,
    "refundWalletTransactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "withdrawal_holds_pkey" PRIMARY KEY ("id")
);

-- withdrawal_settlements
CREATE TABLE "withdrawal_settlements" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "fiatAmount" BIGINT NOT NULL,
    "walletTransactionId" TEXT NOT NULL,
    "resolvedVia" "WithdrawalSettlementOrigin" NOT NULL,
    "completedByUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_settlements_pkey" PRIMARY KEY ("id")
);

-- withdrawal_evidence
CREATE TABLE "withdrawal_evidence" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "paymentTimestamp" TIMESTAMP(3),
    "note" TEXT,
    "fileBucket" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_evidence_pkey" PRIMARY KEY ("id")
);

-- withdrawal_disputes
CREATE TABLE "withdrawal_disputes" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "openedBy" TEXT NOT NULL,
    "reason" "WithdrawalDisputeReason" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "WithdrawalDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAdminId" TEXT,
    "resolution" "WithdrawalDisputeResolution",
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "idempotencyKey" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "withdrawal_disputes_pkey" PRIMARY KEY ("id")
);

-- agent_fiat_liquidities
CREATE TABLE "agent_fiat_liquidities" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "totalBalance" BIGINT NOT NULL DEFAULT 0,
    "reservedBalance" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_fiat_liquidities_pkey" PRIMARY KEY ("id")
);

-- agent_fiat_liquidity_ledger
CREATE TABLE "agent_fiat_liquidity_ledger" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "type" "FiatLiquidityType" NOT NULL,
    "amount" BIGINT NOT NULL,
    "totalBefore" BIGINT NOT NULL,
    "totalAfter" BIGINT NOT NULL,
    "reservedBefore" BIGINT NOT NULL,
    "reservedAfter" BIGINT NOT NULL,
    "reservationId" TEXT,
    "withdrawalId" TEXT,
    "reason" TEXT,
    "performedByAdminId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_fiat_liquidity_ledger_pkey" PRIMARY KEY ("id")
);

-- withdrawal_liquidity_reservations
CREATE TABLE "withdrawal_liquidity_reservations" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "withdrawal_liquidity_reservations_pkey" PRIMARY KEY ("id")
);

-- ── CreateIndex ─────────────────────────────────────────────────
--
-- Unique constraints

-- Note: no unique index on (userId, requestHash). requestHash is stored for
-- W-1B's replay comparison (same idempotencyKey + same hash => idempotent
-- return; same key + different hash => 409) but must not itself be unique,
-- or a user could never repeat a same-shaped withdrawal (e.g. the same
-- amount to the same saved payout account) again.
CREATE UNIQUE INDEX "withdrawals_withdrawalNumber_key" ON "withdrawals"("withdrawalNumber");
CREATE UNIQUE INDEX "withdrawals_userId_idempotencyKey_key" ON "withdrawals"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "withdrawal_holds_withdrawalId_key" ON "withdrawal_holds"("withdrawalId");
CREATE UNIQUE INDEX "withdrawal_holds_debitWalletTransactionId_key" ON "withdrawal_holds"("debitWalletTransactionId");
CREATE UNIQUE INDEX "withdrawal_holds_refundWalletTransactionId_key" ON "withdrawal_holds"("refundWalletTransactionId");
CREATE UNIQUE INDEX "withdrawal_settlements_withdrawalId_key" ON "withdrawal_settlements"("withdrawalId");
CREATE UNIQUE INDEX "withdrawal_settlements_withdrawalId_idempotencyKey_key" ON "withdrawal_settlements"("withdrawalId", "idempotencyKey");
CREATE UNIQUE INDEX "agent_fiat_liquidities_agentId_fiatCurrency_key" ON "agent_fiat_liquidities"("agentId", "fiatCurrency");
CREATE UNIQUE INDEX "agent_fiat_liquidity_ledger_agentId_fiatCurrency_idempotencyKey_key" ON "agent_fiat_liquidity_ledger"("agentId", "fiatCurrency", "idempotencyKey");
CREATE UNIQUE INDEX "withdrawal_liquidity_reservations_withdrawalId_key" ON "withdrawal_liquidity_reservations"("withdrawalId");

-- Regular indexes

CREATE INDEX "withdrawals_agentId_status_idx" ON "withdrawals"("agentId", "status");
CREATE INDEX "withdrawals_userId_status_idx" ON "withdrawals"("userId", "status");
CREATE INDEX "withdrawals_status_confirmationDeadlineAt_idx" ON "withdrawals"("status", "confirmationDeadlineAt");
CREATE INDEX "withdrawals_status_quoteExpiresAt_idx" ON "withdrawals"("status", "quoteExpiresAt");
CREATE INDEX "withdrawal_evidence_withdrawalId_idx" ON "withdrawal_evidence"("withdrawalId");
CREATE INDEX "withdrawal_disputes_withdrawalId_status_idx" ON "withdrawal_disputes"("withdrawalId", "status");
CREATE INDEX "withdrawal_disputes_status_openedAt_idx" ON "withdrawal_disputes"("status", "openedAt");
CREATE INDEX "agent_fiat_liquidity_ledger_agentId_createdAt_idx" ON "agent_fiat_liquidity_ledger"("agentId", "createdAt");
CREATE INDEX "agent_fiat_liquidity_ledger_withdrawalId_idx" ON "agent_fiat_liquidity_ledger"("withdrawalId");
CREATE INDEX "agent_fiat_liquidity_ledger_reservationId_idx" ON "agent_fiat_liquidity_ledger"("reservationId");
CREATE INDEX "withdrawal_liquidity_reservations_agentId_status_idx" ON "withdrawal_liquidity_reservations"("agentId", "status");

-- ── Manual SQL: partial unique indexes ─────────────────────────
--
-- These cannot be expressed in Prisma's @@unique (which lacks WHERE
-- clauses). They are hand-written DDL, following the precedent of
-- disputes_active_order_unique in migration
-- 20260831100000_country_agent_payment_system.
--
-- These indexes are in a SEPARATE migration file from the ALTER TYPE
-- ADD VALUE 'WITHDRAWAL' (20260903000000_w1a_withdrawal_enum) because
-- PostgreSQL forbids using a newly-added enum value in the same
-- transaction as its ADD VALUE.

-- At most one active dispute per withdrawal.
-- Resolved disputes are explicitly NOT covered by this index.
CREATE UNIQUE INDEX "withdrawal_disputes_active_unique" ON "withdrawal_disputes" ("withdrawalId")
    WHERE "status" IN ('OPEN', 'ASSIGNED');

-- At most one successful withdrawal DEBIT per withdrawal.
-- WalletTransaction has no @@unique on referenceId; this partial index
-- is the DB-level guard preventing double-debit for the same withdrawal.
CREATE UNIQUE INDEX "wallet_transactions_withdrawal_debit_unique" ON "wallet_transactions" ("referenceId")
    WHERE "referenceType" = 'WITHDRAWAL' AND "ledgerType" = 'DEBIT' AND "status" = 'SUCCEEDED' AND "referenceId" IS NOT NULL;

-- At most one successful withdrawal CREDIT (refund) per withdrawal.
CREATE UNIQUE INDEX "wallet_transactions_withdrawal_credit_unique" ON "wallet_transactions" ("referenceId")
    WHERE "referenceType" = 'WITHDRAWAL' AND "ledgerType" = 'CREDIT' AND "status" = 'SUCCEEDED' AND "referenceId" IS NOT NULL;

-- ── AddForeignKey ───────────────────────────────────────────────

ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "withdrawal_holds" ADD CONSTRAINT "withdrawal_holds_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "withdrawal_settlements" ADD CONSTRAINT "withdrawal_settlements_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_evidence" ADD CONSTRAINT "withdrawal_evidence_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "withdrawal_disputes" ADD CONSTRAINT "withdrawal_disputes_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_fiat_liquidities" ADD CONSTRAINT "agent_fiat_liquidities_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_fiat_liquidity_ledger" ADD CONSTRAINT "agent_fiat_liquidity_ledger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_liquidity_reservations" ADD CONSTRAINT "withdrawal_liquidity_reservations_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "withdrawals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "withdrawal_liquidity_reservations" ADD CONSTRAINT "withdrawal_liquidity_reservations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
