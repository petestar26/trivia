-- M4: preserve every legacy allocation as an opening-journal CONSUME,
-- and seal the obsolete allocator. This runs while the M3 gates are false.
-- The M7 application replay will classify the remaining value; these opening
-- rows are an immutable record of what the old model believed, not proof of
-- withdrawability. Every old lot starts UNCLASSIFIED until replay verifies it.
CREATE OR REPLACE FUNCTION "coin_allocations_frozen"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'coin_allocations is frozen; write coin_lot_entries instead';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "coin_allocations_frozen"
BEFORE INSERT OR UPDATE OR DELETE ON "coin_allocations"
FOR EACH ROW EXECUTE FUNCTION "coin_allocations_frozen"();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coin_provenance" p
    JOIN LATERAL (
      SELECT COALESCE(SUM(a."allocatedAmount"), 0) AS consumed
      FROM "coin_allocations" a WHERE a."provenanceId" = p."id"
    ) x ON true
    WHERE x.consumed > p."amount"
  ) THEN
    RAISE EXCEPTION 'legacy allocation sum exceeds source amount; resolve before opening journal migration';
  END IF;
END;
$$;

INSERT INTO "coin_ledger_accounts" ("userId")
SELECT DISTINCT "userId" FROM "wallets"
ON CONFLICT ("userId") DO NOTHING;

-- One opening operation per historical lot. Scope is the lot's immutable id.
INSERT INTO "economic_operations" (
  "type", "userId", "scopeType", "scopeId", "countryPolicyId",
  "countryPolicyVersion", "walletTransactionIds", "createdBy", "createdAt"
)
SELECT 'LEGACY_OPENING', p."userId", 'LEGACY_LOT', p."id",
       CASE WHEN p."countryPolicyId" IS NOT NULL AND p."countryPolicyVersion" IS NOT NULL THEN p."countryPolicyId" ELSE NULL END,
       CASE WHEN p."countryPolicyId" IS NOT NULL AND p."countryPolicyVersion" IS NOT NULL THEN p."countryPolicyVersion" ELSE NULL END,
       CASE WHEN p."walletTransactionId" IS NULL THEN ARRAY[]::TEXT[]
            ELSE ARRAY[p."walletTransactionId"]::TEXT[] END,
       'SYSTEM', p."createdAt"
FROM "coin_provenance" p
ON CONFLICT ("type", "scopeType", "scopeId") DO NOTHING;

WITH consumed AS (
  SELECT p."id", COALESCE(SUM(a."allocatedAmount"), 0)::INTEGER AS "amount"
  FROM "coin_provenance" p
  LEFT JOIN "coin_allocations" a ON a."provenanceId" = p."id"
  GROUP BY p."id"
)
UPDATE "coin_provenance" p
SET "lotClass" = 'UNCLASSIFIED',
    "state" = CASE WHEN p."amount" = c."amount" THEN 'EXHAUSTED'::"lot_state" ELSE 'OPEN'::"lot_state" END,
    "availableAmount" = p."amount" - c."amount",
    "reservedAmount" = 0,
    "requirementAmount" = p."requiredPlaythrough",
    "progressAmount" = p."completedPlaythrough",
    "mintedAt" = p."createdAt",
    "availableAt" = p."createdAt",
    "rootLotId" = p."id",
    "sourceOperationId" = op."id"
FROM consumed c
JOIN "economic_operations" op
  ON op."type" = 'LEGACY_OPENING' AND op."scopeType" = 'LEGACY_LOT' AND op."scopeId" = c."id"
WHERE p."id" = c."id";

-- Populate opening MINT entries before old CONSUMEs; the cache trigger is
-- installed only in M6, so M4 sets caches above from the same arithmetic.
INSERT INTO "coin_lot_entries" (
  "operationId", "lotId", "userId", "entryType", "availableDelta",
  "progressDelta", "obligationDelta", "sequence", "createdAt"
)
SELECT op."id", p."id", p."userId", 'MINT', p."amount",
       p."completedPlaythrough",
       p."requiredPlaythrough" - p."completedPlaythrough", 0, p."createdAt"
FROM "coin_provenance" p
JOIN "economic_operations" op
  ON op."type" = 'LEGACY_OPENING' AND op."scopeType" = 'LEGACY_LOT' AND op."scopeId" = p."id"
ON CONFLICT ("operationId", "sequence") DO NOTHING;

-- One synthetic operation per old allocation gives its debit an immutable
-- operation identity even when gameSessionId was NULL (withdrawal/gift).
INSERT INTO "economic_operations" (
  "type", "userId", "scopeType", "scopeId", "createdBy", "createdAt"
)
SELECT 'LEGACY_OPENING', a."userId", 'LEGACY_ALLOCATION', a."id", 'SYSTEM', a."createdAt"
FROM "coin_allocations" a
ON CONFLICT ("type", "scopeType", "scopeId") DO NOTHING;
INSERT INTO "coin_lot_entries" (
  "operationId", "lotId", "userId", "entryType", "availableDelta",
  "obligationShare", "sequence", "createdAt"
)
SELECT op."id", a."provenanceId", a."userId", 'CONSUME', -a."allocatedAmount",
       NULL, 0, a."createdAt"
FROM "coin_allocations" a
JOIN "economic_operations" op
  ON op."type" = 'LEGACY_OPENING' AND op."scopeType" = 'LEGACY_ALLOCATION' AND op."scopeId" = a."id"
ON CONFLICT ("operationId", "sequence") DO NOTHING;

-- An ACTIVE hold is value already removed from the visible wallet. Give it
-- its own review-required reserved lot and a linked opening RESERVE, so
-- cancellation can restore the original amount without calling it
-- withdrawable, and completion can FINALIZE the same immutable reservation.
-- Terminal historical holds remain untouched.
INSERT INTO "economic_operations" (
  "type", "userId", "scopeType", "scopeId", "walletTransactionIds",
  "snapshot", "createdBy", "createdAt"
)
SELECT 'LEGACY_OPENING', w."userId", 'WITHDRAWAL', h."withdrawalId",
       ARRAY[h."debitWalletTransactionId"]::TEXT[],
       jsonb_build_object('legacyActiveHold', true, 'withdrawalId', h."withdrawalId"),
       'SYSTEM', h."createdAt"
FROM "withdrawal_holds" h
JOIN "withdrawals" w ON w."id" = h."withdrawalId"
WHERE h."status" = 'ACTIVE' AND h."holdOperationId" IS NULL
ON CONFLICT ("type", "scopeType", "scopeId") DO NOTHING;

INSERT INTO "coin_provenance" (
  "id", "userId", "amount", "provenanceType", "restrictionStatus",
  "originalSource", "requiredPlaythrough", "completedPlaythrough",
  "createdAt", "updatedAt", "lotClass", "state", "availableAmount",
  "reservedAmount", "requirementAmount", "progressAmount", "mintedAt",
  "availableAt", "sourceOperationId"
)
SELECT 'legacy-hold:' || h."id", w."userId", h."coinAmount", 'WITHDRAWAL',
       'RESTRICTED', 'WITHDRAWAL', 0, 0, h."createdAt", h."createdAt",
       'UNCLASSIFIED', 'OPEN', 0, h."coinAmount", 0, 0, h."createdAt",
       h."createdAt", op."id"
FROM "withdrawal_holds" h
JOIN "withdrawals" w ON w."id" = h."withdrawalId"
JOIN "economic_operations" op ON op."type" = 'LEGACY_OPENING'
  AND op."scopeType" = 'WITHDRAWAL' AND op."scopeId" = h."withdrawalId"
WHERE h."status" = 'ACTIVE' AND h."holdOperationId" IS NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "legacy_balance_reviews" (
  "id", "userId", "lotId", "amount", "evidence", "status", "createdAt"
)
SELECT 'legacy-hold-review:' || h."id", w."userId", 'legacy-hold:' || h."id",
       h."coinAmount",
       jsonb_build_object('source', 'pre-ledger active withdrawal hold',
                          'withdrawalId', h."withdrawalId", 'holdId', h."id"),
       'OPEN', h."createdAt"
FROM "withdrawal_holds" h
JOIN "withdrawals" w ON w."id" = h."withdrawalId"
WHERE h."status" = 'ACTIVE' AND h."holdOperationId" IS NULL
ON CONFLICT ("id") DO NOTHING;

UPDATE "coin_provenance" p
SET "reviewId" = r."id", "rootLotId" = p."id"
FROM "withdrawal_holds" h
JOIN "legacy_balance_reviews" r ON r."id" = 'legacy-hold-review:' || h."id"
WHERE p."id" = 'legacy-hold:' || h."id" AND h."status" = 'ACTIVE'
  AND h."holdOperationId" IS NULL;

INSERT INTO "coin_lot_entries" (
  "operationId", "lotId", "userId", "entryType", "availableDelta",
  "reservedDelta", "sequence", "createdAt"
)
SELECT op."id", p."id", p."userId", 'MINT', h."coinAmount", 0, 0, h."createdAt"
FROM "withdrawal_holds" h
JOIN "economic_operations" op ON op."type" = 'LEGACY_OPENING'
  AND op."scopeType" = 'WITHDRAWAL' AND op."scopeId" = h."withdrawalId"
JOIN "coin_provenance" p ON p."id" = 'legacy-hold:' || h."id"
WHERE h."status" = 'ACTIVE' AND h."holdOperationId" IS NULL
ON CONFLICT ("operationId", "sequence") DO NOTHING;
INSERT INTO "coin_lot_entries" (
  "operationId", "lotId", "userId", "entryType", "availableDelta",
  "reservedDelta", "sequence", "createdAt"
)
SELECT op."id", p."id", p."userId", 'RESERVE', -h."coinAmount",
       h."coinAmount", 1, h."createdAt"
FROM "withdrawal_holds" h
JOIN "economic_operations" op ON op."type" = 'LEGACY_OPENING'
  AND op."scopeType" = 'WITHDRAWAL' AND op."scopeId" = h."withdrawalId"
JOIN "coin_provenance" p ON p."id" = 'legacy-hold:' || h."id"
WHERE h."status" = 'ACTIVE' AND h."holdOperationId" IS NULL
ON CONFLICT ("operationId", "sequence") DO NOTHING;

UPDATE "withdrawal_holds" h
SET "holdOperationId" = op."id"
FROM "economic_operations" op
WHERE h."status" = 'ACTIVE' AND h."holdOperationId" IS NULL
  AND op."type" = 'LEGACY_OPENING' AND op."scopeType" = 'WITHDRAWAL'
  AND op."scopeId" = h."withdrawalId";
