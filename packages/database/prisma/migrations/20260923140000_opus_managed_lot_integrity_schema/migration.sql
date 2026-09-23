-- Populated-upgrade data-integrity validation, schema half.
--
-- Forward-only, additive: a new terminal lot state, a new operation type, a
-- new dual-admin review table for managed-lot integrity anomalies, and two
-- functions used by every later step (the ongoing invariant scan, the
-- migration-time gate, and the read-only preflight report all call the same
-- check_populated_upgrade_integrity() so their definition of "malformed"
-- never drifts).
--
-- Neither new enum value is USED (compared against, cast into) anywhere in
-- this same migration's own executable statements, so PostgreSQL's rule
-- against referencing a brand-new enum value inside the transaction that
-- added it does not apply here. The functions below only mention the new
-- values as source text; that text is not executed until a later migration
-- or a later transaction calls these functions or fires these triggers.
ALTER TYPE "lot_state" ADD VALUE IF NOT EXISTS 'INTEGRITY_REMEDIATED';
ALTER TYPE "operation_type" ADD VALUE IF NOT EXISTS 'LEGACY_INTEGRITY_REMEDIATION';

-- A managed lot (lotClass IS NOT NULL) whose own bookkeeping cannot be
-- trusted — no source operation, a source operation that does not exist or
-- belongs to someone else, or a cache that does not equal its own journal —
-- cannot be represented by legacy_balance_reviews (that table requires
-- lotClass = 'UNCLASSIFIED': see lockWalletAndLot in legacy-review-service.ts).
-- lotId is nullable: a wallet/lot aggregate mismatch with no single
-- identifiably-broken lot is reviewed against the user, not a lot.
CREATE TABLE "managed_lot_integrity_reviews" (
  "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
  "userId" TEXT NOT NULL,
  "lotId" TEXT,
  "anomalyType" TEXT NOT NULL,
  "proposedAvailableAmount" INTEGER NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'FIRST_APPROVED',
  "resolvedBy" TEXT NOT NULL,
  "secondApproverId" TEXT,
  "resolutionOperationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "managed_lot_integrity_reviews_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "managed_lot_integrity_reviews_anomalyType_check" CHECK (
    "anomalyType" IN ('MISSING_SOURCE_OPERATION', 'INVALID_SOURCE_OPERATION',
                       'CROSS_USER_SOURCE_OPERATION', 'CACHE_ENTRY_MISMATCH',
                       'WALLET_LOT_MISMATCH')
  ),
  CONSTRAINT "managed_lot_integrity_reviews_status_check" CHECK (
    "status" IN ('FIRST_APPROVED', 'RESOLVED')
  ),
  CONSTRAINT "managed_lot_integrity_reviews_amount_check" CHECK ("proposedAvailableAmount" >= 0),
  CONSTRAINT "managed_lot_integrity_reviews_user_fkey" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "managed_lot_integrity_reviews_lot_fkey" FOREIGN KEY ("lotId")
    REFERENCES "coin_provenance"("id") ON DELETE RESTRICT,
  CONSTRAINT "managed_lot_integrity_reviews_resolutionOperation_fkey" FOREIGN KEY ("resolutionOperationId")
    REFERENCES "economic_operations"("id") ON DELETE RESTRICT,
  CONSTRAINT "managed_lot_integrity_reviews_resolutionOperationId_key" UNIQUE ("resolutionOperationId")
);
CREATE UNIQUE INDEX "managed_lot_integrity_reviews_one_open_per_lot"
  ON "managed_lot_integrity_reviews" ("lotId") WHERE "status" = 'FIRST_APPROVED' AND "lotId" IS NOT NULL;
CREATE INDEX "managed_lot_integrity_reviews_user_status_idx"
  ON "managed_lot_integrity_reviews" ("userId", "status");

-- Append-only, matching every other financial-history table.
CREATE OR REPLACE FUNCTION "managed_lot_integrity_reviews_append_only"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'managed_lot_integrity_reviews is append-only';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."id" <> NEW."id" OR OLD."userId" <> NEW."userId"
       OR OLD."lotId" IS DISTINCT FROM NEW."lotId"
       OR OLD."anomalyType" <> NEW."anomalyType"
       OR OLD."proposedAvailableAmount" <> NEW."proposedAvailableAmount"
       OR OLD."resolvedBy" <> NEW."resolvedBy"
       OR OLD."createdAt" <> NEW."createdAt" THEN
      RAISE EXCEPTION 'managed_lot_integrity_reviews origin fields are immutable';
    END IF;
    IF OLD."status" = 'RESOLVED' THEN
      RAISE EXCEPTION 'resolved managed lot integrity review cannot be altered';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "managed_lot_integrity_reviews_append_only"
BEFORE UPDATE OR DELETE ON "managed_lot_integrity_reviews"
FOR EACH ROW EXECUTE FUNCTION "managed_lot_integrity_reviews_append_only"();

-- The single, shared definition of "malformed pre-existing ledger data".
-- Excludes lots already closed through this same remediation path (their
-- historical anomaly is documented and permanently frozen, not fixed in
-- place) so a remediated row does not reappear as a live violation forever.
CREATE OR REPLACE FUNCTION "check_populated_upgrade_integrity"()
RETURNS TABLE("category" text, "id" text, "detail" text) AS $$
BEGIN
  RETURN QUERY
  SELECT 'MISSING_SOURCE_OPERATION'::text, p."id",
    format('managed lot %s has no source operation', p."id")
  FROM "coin_provenance" p
  WHERE p."lotClass" IS NOT NULL AND p."state" <> 'INTEGRITY_REMEDIATED'
    AND p."sourceOperationId" IS NULL

  UNION ALL
  SELECT 'INVALID_SOURCE_OPERATION'::text, p."id",
    format('managed lot %s source operation %s does not exist', p."id", p."sourceOperationId")
  FROM "coin_provenance" p
  WHERE p."lotClass" IS NOT NULL AND p."state" <> 'INTEGRITY_REMEDIATED'
    AND p."sourceOperationId" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "economic_operations" o WHERE o."id" = p."sourceOperationId")

  UNION ALL
  SELECT 'CROSS_USER_SOURCE_OPERATION'::text, p."id",
    format('managed lot %s source operation %s belongs to user %s, not %s',
           p."id", p."sourceOperationId", o."userId", p."userId")
  FROM "coin_provenance" p
  JOIN "economic_operations" o ON o."id" = p."sourceOperationId"
  WHERE p."lotClass" IS NOT NULL AND p."state" <> 'INTEGRITY_REMEDIATED'
    AND o."userId" <> p."userId"

  UNION ALL
  SELECT 'CACHE_ENTRY_MISMATCH'::text, p."id",
    format('managed lot %s cache does not equal the sum of its own journal entries', p."id")
  FROM "coin_provenance" p
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(e."availableDelta"),0)::bigint AS available,
           COALESCE(SUM(e."reservedDelta"),0)::bigint AS reserved,
           COALESCE(SUM(e."progressDelta"),0)::bigint AS progress,
           COALESCE(SUM(e."progressDelta"+e."obligationDelta"),0)::bigint AS requirement
    FROM "coin_lot_entries" e WHERE e."lotId" = p."id"
  ) j ON true
  WHERE p."lotClass" IS NOT NULL AND p."state" <> 'INTEGRITY_REMEDIATED'
    AND (p."availableAmount" IS DISTINCT FROM j.available
      OR p."reservedAmount" IS DISTINCT FROM j.reserved
      OR p."progressAmount" IS DISTINCT FROM j.progress
      OR p."requirementAmount" IS DISTINCT FROM j.requirement)

  UNION ALL
  SELECT 'WALLET_LOT_MISMATCH'::text, a."userId",
    format('classified wallet %s balance does not equal its summed available lots', a."userId")
  FROM "coin_ledger_accounts" a
  JOIN "wallets" w ON w."userId" = a."userId"
  WHERE a."classifiedAt" IS NOT NULL
    AND w."coinsBalance" <> COALESCE((
      SELECT SUM(p."availableAmount") FROM "coin_provenance" p
      WHERE p."userId" = a."userId" AND p."state" <> 'INTEGRITY_REMEDIATED'
    ), 0);
END;
$$ LANGUAGE plpgsql STABLE;

-- Bounded, human-readable stop: never silently repairs, deletes, legitimizes
-- or makes value withdrawable — it only ever reports and raises. Callable
-- standalone (a read-only preflight before deploying) or from a migration
-- (turns the same report into a hard stop) or again after remediation (must
-- return with no exception).
CREATE OR REPLACE FUNCTION "run_populated_upgrade_gate"()
RETURNS void AS $$
DECLARE
  report jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'category', grouped."category",
    'count', grouped."count",
    'sample', grouped."sample"
  ))
  INTO report
  FROM (
    SELECT v."category",
      COUNT(*)::int AS "count",
      (array_agg(v."id" ORDER BY v."id"))[1:10] AS "sample"
    FROM "check_populated_upgrade_integrity"() v
    GROUP BY v."category"
  ) grouped;

  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'Populated upgrade validation failed — malformed pre-existing ledger data found: %', report;
  END IF;
END;
$$ LANGUAGE plpgsql;
