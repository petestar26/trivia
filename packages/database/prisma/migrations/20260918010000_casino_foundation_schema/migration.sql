-- Migration B: Casino Foundation - Nullable Schema
-- Adds all columns, tables, indexes. NO CHECK/FK/trigger constraints
-- that would fail on existing data. Constraints are added in Migration D
-- after backfilling in Migration C.

-- Enable pgcrypto for digest() used in rules hashing
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. game_definitions: new nullable columns for catalog + currency + rules pointer
ALTER TABLE "game_definitions" ADD COLUMN "mode" "game_mode";
ALTER TABLE "game_definitions" ADD COLUMN "family" "game_family";
ALTER TABLE "game_definitions" ADD COLUMN "catalogStatus" "game_catalog_status";
ALTER TABLE "game_definitions" ADD COLUMN "wagerCurrency" "CurrencyType";
ALTER TABLE "game_definitions" ADD COLUMN "rewardCurrency" "CurrencyType";
ALTER TABLE "game_definitions" ADD COLUMN "currentRulesVersion" INTEGER;

-- 2. game_rules: immutable versioned rule snapshots
CREATE TABLE "game_rules" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "gameId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" "game_mode" NOT NULL,
    "family" "game_family" NOT NULL,
    "wagerCurrency" "CurrencyType",
    "rewardCurrency" "CurrencyType" NOT NULL,
    "rules" JSONB NOT NULL,
    "resultSchemaVersion" INTEGER NOT NULL,
    "rulesHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "game_rules_gameId_version_key" ON "game_rules" ("gameId", "version");
CREATE INDEX "game_rules_gameId_idx" ON "game_rules" ("gameId");

-- 3. game_sessions: rule snapshots + settlement currencies + context + snapshots
ALTER TABLE "game_sessions" ADD COLUMN "mode" "game_mode";
ALTER TABLE "game_sessions" ADD COLUMN "family" "game_family";
ALTER TABLE "game_sessions" ADD COLUMN "wagerCurrency" "CurrencyType";
ALTER TABLE "game_sessions" ADD COLUMN "rewardCurrency" "CurrencyType";
ALTER TABLE "game_sessions" ADD COLUMN "rulesVersion" INTEGER;
ALTER TABLE "game_sessions" ADD COLUMN "resultSchemaVersion" INTEGER;
ALTER TABLE "game_sessions" ADD COLUMN "settlementDebitCurrency" "CurrencyType";
ALTER TABLE "game_sessions" ADD COLUMN "settlementCreditCurrency" "CurrencyType";
ALTER TABLE "game_sessions" ADD COLUMN "requestSnapshot" JSONB;
ALTER TABLE "game_sessions" ADD COLUMN "responseSnapshot" JSONB;
ALTER TABLE "game_sessions" ADD COLUMN "fingerprint" TEXT;
ALTER TABLE "game_sessions" ADD COLUMN "selections" JSONB;
ALTER TABLE "game_sessions" ADD COLUMN "playContext" "play_context";

CREATE INDEX "game_sessions_gameId_rulesVersion_idx" ON "game_sessions" ("gameId", "rulesVersion");
CREATE INDEX "game_sessions_userId_fingerprint_idx" ON "game_sessions" ("userId", "fingerprint");

-- 4. Country casino policies (versioned, fail-closed)
CREATE TABLE "country_casino_policies" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "countryCode" VARCHAR(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "country_casino_status" NOT NULL DEFAULT 'DISABLED',
    "enabledAt" TIMESTAMPTZ,
    "disabledAt" TIMESTAMPTZ,
    "minWithdrawal" INTEGER NOT NULL DEFAULT 0,
    "maxWithdrawal" INTEGER NOT NULL DEFAULT 0,
    "dailyWithdrawalLimit" INTEGER NOT NULL DEFAULT 0,
    "monthlyWithdrawalLimit" INTEGER NOT NULL DEFAULT 0,
    "playthroughMultiplier" DECIMAL(6,2) NOT NULL DEFAULT 1.0,
    "qualifyingGames" JSONB NOT NULL DEFAULT '[]',
    "maxQualifyingStake" INTEGER NOT NULL DEFAULT 0,
    "holdingPeriodHours" INTEGER NOT NULL DEFAULT 0,
    "giftDailyLimit" INTEGER NOT NULL DEFAULT 0,
    "kycTierRequired" INTEGER NOT NULL DEFAULT 0,
    "supportedPaymentMethods" JSONB NOT NULL DEFAULT '[]',
    "withdrawalFeePercent" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "manualReviewThreshold" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "country_casino_policies_countryCode_version_key" ON "country_casino_policies" ("countryCode", "version");
CREATE INDEX "country_casino_policies_countryCode_idx" ON "country_casino_policies" ("countryCode");
CREATE INDEX "country_casino_policies_status_idx" ON "country_casino_policies" ("status");

-- 5. Coin provenance ledger entries
CREATE TABLE "coin_provenance" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "walletTransactionId" TEXT,
    "amount" INTEGER NOT NULL,
    "provenanceType" "coin_provenance_type" NOT NULL,
    "restrictionStatus" "coin_restriction_status" NOT NULL DEFAULT 'RESTRICTED',
    "originalSource" "coin_provenance_type",
    "originalGrantReferenceType" TEXT,
    "originalGrantReferenceId" TEXT,
    "countryPolicyId" TEXT,
    "countryPolicyVersion" INTEGER,
    "requiredPlaythrough" INTEGER NOT NULL DEFAULT 0,
    "completedPlaythrough" INTEGER NOT NULL DEFAULT 0,
    "giftChainOriginId" TEXT,
    "giftChainParentId" TEXT,
    "expiresAt" TIMESTAMPTZ,
    "unlockedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);
CREATE INDEX "coin_provenance_userId_idx" ON "coin_provenance" ("userId");
CREATE INDEX "coin_provenance_userId_restrictionStatus_idx" ON "coin_provenance" ("userId", "restrictionStatus");
CREATE INDEX "coin_provenance_walletTransactionId_idx" ON "coin_provenance" ("walletTransactionId");

-- 6. Coin spending allocation (deterministic per-wager)
CREATE TABLE "coin_allocations" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "userId" TEXT NOT NULL,
    "gameSessionId" TEXT,
    "provenanceId" TEXT NOT NULL,
    "allocatedAmount" INTEGER NOT NULL,
    "provenanceType" "coin_provenance_type" NOT NULL,
    "wasRestricted" BOOLEAN NOT NULL DEFAULT false,
    "allocationOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("id")
);
CREATE INDEX "coin_allocations_userId_idx" ON "coin_allocations" ("userId");
CREATE INDEX "coin_allocations_gameSessionId_idx" ON "coin_allocations" ("gameSessionId");
CREATE INDEX "coin_allocations_provenanceId_idx" ON "coin_allocations" ("provenanceId");
