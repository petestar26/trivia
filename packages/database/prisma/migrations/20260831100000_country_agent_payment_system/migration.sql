-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('BANK_TRANSFER', 'MOBILE_PAYMENT');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'TEMPORARILY_SUSPENDED', 'DISABLED', 'UNDER_REVIEW');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentAccountStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "InventoryLedgerType" AS ENUM ('INITIAL_ALLOCATION', 'RESERVE', 'RELEASE_UNUSED', 'CONSUME_ON_SETTLEMENT', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AgentOrderStatus" AS ENUM ('CREATED', 'PAYMENT_SUBMITTED', 'AGENT_TIMEOUT', 'DISPUTE', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED', 'CONSUMED');

-- CreateEnum
CREATE TYPE "SettlementOrigin" AS ENUM ('AGENT_RELEASE', 'ADMIN_DISPUTE_RESOLUTION');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('PAYMENT_NOT_RECEIVED', 'WRONG_AMOUNT', 'AGENT_UNRESPONSIVE', 'OTHER');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'ASSIGNED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisputeResolution" AS ENUM ('RELEASE', 'CANCEL');

-- CreateEnum
CREATE TYPE "MessageSenderRole" AS ENUM ('ADMIN', 'AGENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'AGENT_ORDER_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_PAYMENT_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_COINS_RELEASED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_ORDER_TIMEOUT';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_DISPUTE_OPENED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_DISPUTE_RESOLVED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_APPLICATION_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_APPLICATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_APPLICATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_SUSPENDED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_PAYMENT_ACCOUNT_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_PAYMENT_ACCOUNT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'AGENT_ADMIN_MESSAGE';

-- AlterEnum
ALTER TYPE "TransactionReferenceType" ADD VALUE 'AGENT_ORDER';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referredByAgentId" TEXT;

-- CreateTable
CREATE TABLE "countries" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "agentPaymentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_method_definitions" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "name" TEXT NOT NULL,
    "fieldSchema" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_method_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rate_configs" (
    "id" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "coinsPerUnit" DECIMAL(18,6) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "setBy" TEXT NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exchange_rate_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "displayName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "minOrderAmount" INTEGER,
    "maxOrderAmount" INTEGER,
    "suspendedAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_applications" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "submittedData" JSONB NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "agent_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_payment_accounts" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "methodDefId" TEXT NOT NULL,
    "status" "PaymentAccountStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "accountDetails" JSONB NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_inventories" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "totalBalance" INTEGER NOT NULL DEFAULT 0,
    "reservedBalance" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_inventories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_inventory_ledger" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "InventoryLedgerType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "totalBefore" INTEGER NOT NULL,
    "totalAfter" INTEGER NOT NULL,
    "reservedBefore" INTEGER NOT NULL,
    "reservedAfter" INTEGER NOT NULL,
    "reservationId" TEXT,
    "orderId" TEXT,
    "reason" TEXT,
    "performedByAdminId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_inventory_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_orders" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "countryId" TEXT NOT NULL,
    "paymentMethodDefId" TEXT NOT NULL,
    "paymentAccountId" TEXT NOT NULL,
    "paymentSnapshot" JSONB NOT NULL,
    "fiatAmount" INTEGER NOT NULL,
    "fiatCurrency" TEXT NOT NULL,
    "exchangeRateConfigId" TEXT NOT NULL,
    "exchangeRateValue" DECIMAL(18,6) NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "status" "AgentOrderStatus" NOT NULL DEFAULT 'CREATED',
    "idempotencyKey" TEXT NOT NULL,
    "paymentInstructionsShownAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentSubmittedAt" TIMESTAMP(3),
    "releaseDeadlineAt" TIMESTAMP(3),
    "agentTimeoutAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_reservations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "agent_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_order_settlements" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "coinAmount" INTEGER NOT NULL,
    "walletTransactionId" TEXT NOT NULL,
    "resolvedVia" "SettlementOrigin" NOT NULL,
    "releasedBy" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_order_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_evidence" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "paymentTimestamp" TIMESTAMP(3),
    "note" TEXT,
    "fileBucket" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "openedBy" TEXT NOT NULL,
    "reason" "DisputeReason" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "assignedAdminId" TEXT,
    "resolution" "DisputeResolution",
    "resolutionNote" TEXT,
    "resolvedBy" TEXT,
    "idempotencyKey" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_conversations" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" "MessageSenderRole" NOT NULL,
    "body" TEXT NOT NULL,
    "relatedOrderId" TEXT,
    "relatedDisputeId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "countries_code_key" ON "countries"("code");

-- CreateIndex
CREATE INDEX "countries_isActive_idx" ON "countries"("isActive");

-- CreateIndex
CREATE INDEX "payment_method_definitions_countryId_isActive_idx" ON "payment_method_definitions"("countryId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "payment_method_definitions_countryId_type_name_key" ON "payment_method_definitions"("countryId", "type", "name");

-- CreateIndex
CREATE INDEX "exchange_rate_configs_countryId_fiatCurrency_isActive_effec_idx" ON "exchange_rate_configs"("countryId", "fiatCurrency", "isActive", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "agents_userId_key" ON "agents"("userId");

-- CreateIndex
CREATE INDEX "agents_countryId_status_idx" ON "agents"("countryId", "status");

-- CreateIndex
CREATE INDEX "agent_applications_agentId_submittedAt_idx" ON "agent_applications"("agentId", "submittedAt");

-- CreateIndex
CREATE INDEX "agent_payment_accounts_agentId_status_idx" ON "agent_payment_accounts"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_inventories_agentId_key" ON "agent_inventories"("agentId");

-- CreateIndex
CREATE INDEX "agent_inventory_ledger_agentId_createdAt_idx" ON "agent_inventory_ledger"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_inventory_ledger_orderId_idx" ON "agent_inventory_ledger"("orderId");

-- CreateIndex
CREATE INDEX "agent_inventory_ledger_reservationId_idx" ON "agent_inventory_ledger"("reservationId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_inventory_ledger_agentId_idempotencyKey_key" ON "agent_inventory_ledger"("agentId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "agent_orders_orderNumber_key" ON "agent_orders"("orderNumber");

-- CreateIndex
CREATE INDEX "agent_orders_agentId_status_idx" ON "agent_orders"("agentId", "status");

-- CreateIndex
CREATE INDEX "agent_orders_userId_status_idx" ON "agent_orders"("userId", "status");

-- CreateIndex
CREATE INDEX "agent_orders_status_releaseDeadlineAt_idx" ON "agent_orders"("status", "releaseDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "agent_orders_userId_idempotencyKey_key" ON "agent_orders"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "agent_reservations_orderId_key" ON "agent_reservations"("orderId");

-- CreateIndex
CREATE INDEX "agent_reservations_agentId_status_idx" ON "agent_reservations"("agentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "agent_order_settlements_orderId_key" ON "agent_order_settlements"("orderId");

-- CreateIndex
CREATE INDEX "payment_evidence_orderId_idx" ON "payment_evidence"("orderId");

-- CreateIndex
CREATE INDEX "disputes_orderId_status_idx" ON "disputes"("orderId", "status");

-- CreateIndex
CREATE INDEX "disputes_status_openedAt_idx" ON "disputes"("status", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_orderId_idempotencyKey_key" ON "disputes"("orderId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "agent_conversations_agentId_key" ON "agent_conversations"("agentId");

-- CreateIndex
CREATE INDEX "agent_messages_conversationId_createdAt_idx" ON "agent_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referredByAgentId_fkey" FOREIGN KEY ("referredByAgentId") REFERENCES "agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_definitions" ADD CONSTRAINT "payment_method_definitions_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rate_configs" ADD CONSTRAINT "exchange_rate_configs_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_applications" ADD CONSTRAINT "agent_applications_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_payment_accounts" ADD CONSTRAINT "agent_payment_accounts_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_payment_accounts" ADD CONSTRAINT "agent_payment_accounts_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_payment_accounts" ADD CONSTRAINT "agent_payment_accounts_methodDefId_fkey" FOREIGN KEY ("methodDefId") REFERENCES "payment_method_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inventories" ADD CONSTRAINT "agent_inventories_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_inventory_ledger" ADD CONSTRAINT "agent_inventory_ledger_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_orders" ADD CONSTRAINT "agent_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_orders" ADD CONSTRAINT "agent_orders_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reservations" ADD CONSTRAINT "agent_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "agent_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_reservations" ADD CONSTRAINT "agent_reservations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_order_settlements" ADD CONSTRAINT "agent_order_settlements_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "agent_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_evidence" ADD CONSTRAINT "payment_evidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "agent_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "agent_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Manual addition — Phase C correction B.
--
-- Invariant: an order may not have more than one ACTIVE dispute, where
-- active means status IN ('OPEN', 'ASSIGNED'). Prisma's schema DSL has no
-- syntax for a conditional/partial unique constraint (a WHERE clause scoping
-- which rows the uniqueness applies to), so this could not be expressed in
-- schema.prisma and was not emitted by `prisma migrate diff`. It is added
-- here as hand-written PostgreSQL DDL, reviewed alongside the generated
-- statements above rather than silently omitted.
--
-- RESOLVED disputes are explicitly NOT covered by this index, so an order's
-- dispute history can contain any number of resolved rows — only a second
-- concurrently-active one is rejected, matching Phase B §21/§40's requirement
-- that historical disputes remain queryable while at most one stays open.
CREATE UNIQUE INDEX "disputes_active_order_unique" ON "disputes" ("orderId")
WHERE "status" IN ('OPEN', 'ASSIGNED');

