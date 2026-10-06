-- M2: additive schema. Existing wallet, wallet_transactions, coin_provenance,
-- coin_allocations, and applied migrations remain intact.
CREATE TABLE "economic_operations" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
    "type" "operation_type" NOT NULL,
    "userId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "countryPolicyId" TEXT,
    "countryPolicyVersion" INTEGER,
    "walletTransactionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reversesOperationId" TEXT,
    "snapshot" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "economic_operations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "economic_operations_scope_key" UNIQUE ("type", "scopeType", "scopeId"),
    CONSTRAINT "economic_operations_reversesOperationId_key" UNIQUE ("reversesOperationId"),
    CONSTRAINT "economic_operations_pin_pair_chk" CHECK (("countryPolicyId" IS NULL) = ("countryPolicyVersion" IS NULL)),
    CONSTRAINT "economic_operations_required_pin_chk" CHECK (
      "type" NOT IN ('WAGER', 'PAYOUT', 'BONUS_GRANT', 'WITHDRAWAL_HOLD', 'BONUS_CONVERSION')
      OR ("countryPolicyId" IS NOT NULL AND "countryPolicyVersion" IS NOT NULL)
    )
);
CREATE UNIQUE INDEX "economic_operations_user_type_key_unique"
  ON "economic_operations" ("userId", "type", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX "economic_operations_user_created_idx" ON "economic_operations" ("userId", "createdAt");
CREATE INDEX "economic_operations_policy_idx" ON "economic_operations" ("countryPolicyId", "countryPolicyVersion");
ALTER TABLE "economic_operations" ADD CONSTRAINT "economic_operations_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "economic_operations" ADD CONSTRAINT "economic_operations_policy_fkey"
  FOREIGN KEY ("countryPolicyId") REFERENCES "country_casino_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "economic_operations" ADD CONSTRAINT "economic_operations_reverses_fkey"
  FOREIGN KEY ("reversesOperationId") REFERENCES "economic_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "coin_provenance"
  ADD COLUMN "lotClass" "lot_class",
  ADD COLUMN "state" "lot_state",
  ADD COLUMN "availableAmount" INTEGER,
  ADD COLUMN "reservedAmount" INTEGER,
  ADD COLUMN "requirementAmount" INTEGER,
  ADD COLUMN "progressAmount" INTEGER,
  ADD COLUMN "mintedAt" TIMESTAMP(3),
  ADD COLUMN "availableAt" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "sourceOperationId" TEXT,
  ADD COLUMN "parentLotId" TEXT,
  ADD COLUMN "rootLotId" TEXT,
  ADD COLUMN "reviewId" TEXT;
ALTER TABLE "coin_provenance" ADD CONSTRAINT "coin_provenance_sourceOperation_fkey"
  FOREIGN KEY ("sourceOperationId") REFERENCES "economic_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_provenance" ADD CONSTRAINT "coin_provenance_parentLot_fkey"
  FOREIGN KEY ("parentLotId") REFERENCES "coin_provenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_provenance" ADD CONSTRAINT "coin_provenance_rootLot_fkey"
  FOREIGN KEY ("rootLotId") REFERENCES "coin_provenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_provenance" ADD CONSTRAINT "coin_provenance_cache_nonnegative_chk" CHECK (
  ("availableAmount" IS NULL OR "availableAmount" >= 0) AND
  ("reservedAmount" IS NULL OR "reservedAmount" >= 0) AND
  ("requirementAmount" IS NULL OR "requirementAmount" >= 0) AND
  ("progressAmount" IS NULL OR "progressAmount" >= 0) AND
  ("requirementAmount" IS NULL OR "progressAmount" IS NULL OR "progressAmount" <= "requirementAmount")
);
CREATE INDEX "coin_provenance_funding_idx" ON "coin_provenance" ("userId", "state", "lotClass", "id");
CREATE INDEX "coin_provenance_sourceOperation_idx" ON "coin_provenance" ("sourceOperationId");

CREATE TABLE "coin_lot_entries" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
    "operationId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entryType" "entry_type" NOT NULL,
    "availableDelta" INTEGER NOT NULL DEFAULT 0,
    "reservedDelta" INTEGER NOT NULL DEFAULT 0,
    "progressDelta" INTEGER NOT NULL DEFAULT 0,
    "obligationDelta" INTEGER NOT NULL DEFAULT 0,
    "obligationShare" INTEGER,
    "counterpartyLotId" TEXT,
    "reversesEntryId" TEXT,
    "sequence" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coin_lot_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "coin_lot_entries_operation_sequence_key" UNIQUE ("operationId", "sequence"),
    CONSTRAINT "coin_lot_entries_reversesEntryId_key" UNIQUE ("reversesEntryId"),
    CONSTRAINT "coin_lot_entries_sequence_chk" CHECK ("sequence" >= 0),
    CONSTRAINT "coin_lot_entries_obligationShare_chk" CHECK ("obligationShare" IS NULL OR "obligationShare" >= 0),
    CONSTRAINT "coin_lot_entries_nonzero_chk" CHECK (
      "availableDelta" <> 0 OR "reservedDelta" <> 0 OR "progressDelta" <> 0 OR "obligationDelta" <> 0
    )
);
CREATE INDEX "coin_lot_entries_lot_idx" ON "coin_lot_entries" ("lotId", "createdAt", "id");
CREATE INDEX "coin_lot_entries_user_idx" ON "coin_lot_entries" ("userId", "createdAt");
CREATE INDEX "coin_lot_entries_operation_idx" ON "coin_lot_entries" ("operationId");
ALTER TABLE "coin_lot_entries" ADD CONSTRAINT "coin_lot_entries_operation_fkey"
  FOREIGN KEY ("operationId") REFERENCES "economic_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_lot_entries" ADD CONSTRAINT "coin_lot_entries_lot_fkey"
  FOREIGN KEY ("lotId") REFERENCES "coin_provenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_lot_entries" ADD CONSTRAINT "coin_lot_entries_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_lot_entries" ADD CONSTRAINT "coin_lot_entries_counterparty_fkey"
  FOREIGN KEY ("counterpartyLotId") REFERENCES "coin_provenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_lot_entries" ADD CONSTRAINT "coin_lot_entries_reverses_fkey"
  FOREIGN KEY ("reversesEntryId") REFERENCES "coin_lot_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "country_casino_policies"
  ADD COLUMN "state" "policy_state",
  ADD COLUMN "thresholdsConfiguredAt" TIMESTAMP(3),
  ADD COLUMN "configurationAttestation" JSONB,
  ADD COLUMN "configuredBy" TEXT,
  ADD COLUMN "activatedAt" TIMESTAMP(3),
  ADD COLUMN "activatedBy" TEXT,
  ADD COLUMN "maxConversionMultiple" DECIMAL(10, 2),
  ADD COLUMN "bonusExpiryHours" INTEGER;
ALTER TABLE "country_casino_policies" ADD CONSTRAINT "country_casino_policies_conversion_cap_chk"
  CHECK ("maxConversionMultiple" IS NULL OR "maxConversionMultiple" > 0);
ALTER TABLE "country_casino_policies" ADD CONSTRAINT "country_casino_policies_bonus_expiry_chk"
  CHECK ("bonusExpiryHours" IS NULL OR "bonusExpiryHours" > 0);
CREATE UNIQUE INDEX "country_casino_policies_one_active_per_country"
  ON "country_casino_policies" ("countryCode") WHERE "state" = 'ACTIVE';

CREATE TABLE "country_jurisdictions" (
    -- One row per "countries" row; TEXT like "countries"."code", which master
    -- never limited, so every existing country gets its (fail-closed) row.
    "countryCode" TEXT NOT NULL,
    "activePolicyId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "country_jurisdictions_pkey" PRIMARY KEY ("countryCode"),
    CONSTRAINT "country_jurisdictions_activePolicyId_key" UNIQUE ("activePolicyId")
);
ALTER TABLE "country_jurisdictions" ADD CONSTRAINT "country_jurisdictions_country_fkey"
  FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "country_jurisdictions" ADD CONSTRAINT "country_jurisdictions_activePolicy_fkey"
  FOREIGN KEY ("activePolicyId") REFERENCES "country_casino_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "user_kyc_verifications" (
    "userId" TEXT NOT NULL,
    "verifiedTier" INTEGER NOT NULL DEFAULT 0,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    CONSTRAINT "user_kyc_verifications_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "user_kyc_verifications_tier_chk" CHECK ("verifiedTier" >= 0),
    CONSTRAINT "user_kyc_verifications_status_chk" CHECK ("status" IN ('PENDING', 'VERIFIED', 'REVOKED', 'EXPIRED')),
    CONSTRAINT "user_kyc_verifications_verified_chk" CHECK (
      "status" <> 'VERIFIED' OR ("verifiedAt" IS NOT NULL AND "verifiedBy" IS NOT NULL AND "verifiedTier" > 0)
    )
);
ALTER TABLE "user_kyc_verifications" ADD CONSTRAINT "user_kyc_verifications_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "coin_ledger_accounts" (
    "userId" TEXT NOT NULL,
    "classifiedAt" TIMESTAMP(3),
    "classificationRunId" TEXT,
    CONSTRAINT "coin_ledger_accounts_pkey" PRIMARY KEY ("userId")
);
ALTER TABLE "coin_ledger_accounts" ADD CONSTRAINT "coin_ledger_accounts_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "legacy_balance_reviews" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
    "userId" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}'::JSONB,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "secondApproverId" TEXT,
    "resolutionOperationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "legacy_balance_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "legacy_balance_reviews_resolutionOperationId_key" UNIQUE ("resolutionOperationId"),
    CONSTRAINT "legacy_balance_reviews_amount_chk" CHECK ("amount" > 0),
    CONSTRAINT "legacy_balance_reviews_status_chk" CHECK ("status" IN ('OPEN', 'FIRST_APPROVED', 'RESOLVED', 'REJECTED')),
    CONSTRAINT "legacy_balance_reviews_distinct_approvers_chk" CHECK (
      "resolvedBy" IS NULL OR "secondApproverId" IS NULL OR "resolvedBy" <> "secondApproverId"
    )
);
CREATE UNIQUE INDEX "legacy_balance_reviews_one_open_per_lot"
  ON "legacy_balance_reviews" ("lotId") WHERE "status" IN ('OPEN', 'FIRST_APPROVED');
CREATE INDEX "legacy_balance_reviews_user_status_idx" ON "legacy_balance_reviews" ("userId", "status");
ALTER TABLE "legacy_balance_reviews" ADD CONSTRAINT "legacy_balance_reviews_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "legacy_balance_reviews" ADD CONSTRAINT "legacy_balance_reviews_lot_fkey"
  FOREIGN KEY ("lotId") REFERENCES "coin_provenance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "legacy_balance_reviews" ADD CONSTRAINT "legacy_balance_reviews_resolutionOperation_fkey"
  FOREIGN KEY ("resolutionOperationId") REFERENCES "economic_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_provenance" ADD CONSTRAINT "coin_provenance_review_fkey"
  FOREIGN KEY ("reviewId") REFERENCES "legacy_balance_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "invariant_check_runs" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid()::text),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "violations" JSONB NOT NULL DEFAULT '[]'::JSONB,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "invariant_check_runs_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "platform_gates" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastInvariantRunId" TEXT,
    CONSTRAINT "platform_gates_pkey" PRIMARY KEY ("key")
);
ALTER TABLE "platform_gates" ADD CONSTRAINT "platform_gates_lastInvariantRun_fkey"
  FOREIGN KEY ("lastInvariantRunId") REFERENCES "invariant_check_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "withdrawal_holds" ADD COLUMN "holdOperationId" TEXT;
CREATE UNIQUE INDEX "withdrawal_holds_holdOperationId_key" ON "withdrawal_holds" ("holdOperationId");
ALTER TABLE "withdrawal_holds" ADD CONSTRAINT "withdrawal_holds_holdOperation_fkey"
  FOREIGN KEY ("holdOperationId") REFERENCES "economic_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
