-- Ledger upgrade, final integrity gate, then the database guards that keep
-- the same definitions true for every later write.
--
-- 1. "ledger_integrity_anomalies"() is the single definition of a ledger
--    anomaly for the upgraded schema. The runtime invariant checker (I15)
--    calls this same function; the read-only preflight carries a copy that a
--    test compares with it. The blocks between the ledger-integrity markers
--    are copies of apps/api/src/economy/ledger-integrity-definitions.ts.
-- 2. The gate stops the upgrade on any anomaly. Everything in this migration
--    runs in one transaction, so a stop leaves no function, trigger or index
--    behind. It first locks every table the scan or the guards read against
--    writers, so no write can land between the scan and the guards. Follow
--    docs/deployment/ledger-upgrade-gate.md.
-- 3. Only after the gate passes, guards are installed for the anomaly kinds
--    the earlier ledger guards did not reject on write: half-initialized
--    lots, ledger rows without a wallet, and UNCLASSIFIED value of a
--    classified user that no open review covers.
CREATE OR REPLACE FUNCTION "ledger_integrity_anomalies"()
RETURNS TABLE ("category" text, "subjectType" text, "subjectId" text, "userId" text, "detail" text)
LANGUAGE sql STABLE
AS $ledger$
WITH
-- ledger-integrity:source-current:begin
ledger_accounts AS (
  SELECT a."userId" AS user_id, (a."classifiedAt" IS NOT NULL) AS classified
  FROM "coin_ledger_accounts" a
),
ledger_wallets AS (
  SELECT w."userId" AS user_id, w."coinsBalance"::bigint AS coins_balance
  FROM "wallets" w
),
ledger_lots AS (
  SELECT p."id" AS id, p."userId" AS user_id, p."lotClass"::text AS lot_class, p."state"::text AS state,
         p."availableAmount"::bigint AS available, p."reservedAmount"::bigint AS reserved,
         p."requirementAmount"::bigint AS requirement, p."progressAmount"::bigint AS progress,
         p."sourceOperationId" AS source_operation_id, p."reviewId" AS review_id
  FROM "coin_provenance" p
),
ledger_entries AS (
  SELECT e."lotId" AS lot_id, e."availableDelta"::bigint AS available_delta,
         e."reservedDelta"::bigint AS reserved_delta, e."progressDelta"::bigint AS progress_delta,
         e."obligationDelta"::bigint AS obligation_delta
  FROM "coin_lot_entries" e
),
ledger_operations AS (
  SELECT o."id" AS id, o."userId" AS user_id
  FROM "economic_operations" o
),
ledger_reviews AS (
  SELECT r."id" AS id, r."userId" AS user_id, r."status"::text AS status
  FROM "legacy_balance_reviews" r
)
-- ledger-integrity:source-current:end
, anomalies AS (
-- ledger-integrity:predicates:begin
SELECT 'LOT_STATE_NULL'::text AS category, 'lot'::text AS subject_type, l.id AS subject_id, l.user_id AS user_id,
       format('managed %s lot %s has no state', l.lot_class, l.id) AS detail
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL AND l.state IS NULL
UNION ALL
SELECT 'LOT_CACHE_NULL', 'lot', l.id, l.user_id,
       format('managed lot %s has a NULL cache (available %s, reserved %s, requirement %s, progress %s)',
              l.id, COALESCE(l.available::text, 'NULL'), COALESCE(l.reserved::text, 'NULL'),
              COALESCE(l.requirement::text, 'NULL'), COALESCE(l.progress::text, 'NULL'))
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL
  AND (l.available IS NULL OR l.reserved IS NULL OR l.requirement IS NULL OR l.progress IS NULL)
UNION ALL
SELECT 'LOT_PARTIALLY_LEGACY', 'lot', l.id, l.user_id,
       format('lot %s has no lot class but some ledger fields set; a pre-journal lot keeps all of them NULL', l.id)
FROM ledger_lots l
WHERE l.lot_class IS NULL
  AND (l.state IS NOT NULL OR l.available IS NOT NULL OR l.reserved IS NOT NULL
       OR l.requirement IS NOT NULL OR l.progress IS NOT NULL OR l.source_operation_id IS NOT NULL)
UNION ALL
SELECT 'LEGACY_LOT_OF_CLASSIFIED_OWNER', 'lot', l.id, l.user_id,
       format('pre-journal lot %s belongs to user %s, whose ledger account is already classified', l.id, l.user_id)
FROM ledger_lots l
WHERE l.lot_class IS NULL
  AND EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.user_id = l.user_id AND a.classified)
UNION ALL
SELECT 'WALLET_MISSING', 'user', o.user_id, o.user_id,
       format('user %s has %s but no wallet row', COALESCE(o.user_id, 'NULL'),
              string_agg(DISTINCT o.owns, ' and ' ORDER BY o.owns))
FROM (
  SELECT a.user_id, 'a ledger account'::text AS owns FROM ledger_accounts a
  UNION ALL
  SELECT l.user_id, 'coin lots'::text FROM ledger_lots l
) o
WHERE NOT EXISTS (SELECT 1 FROM ledger_wallets w WHERE w.user_id = o.user_id)
GROUP BY o.user_id
UNION ALL
SELECT 'WALLET_LOT_MISMATCH', 'user', a.user_id, a.user_id,
       format('classified wallet of user %s holds %s Coins but its lots hold %s',
              a.user_id, w.coins_balance, COALESCE(t.total, 0))
FROM ledger_accounts a
LEFT JOIN ledger_wallets w ON w.user_id = a.user_id
LEFT JOIN (
  SELECT l.user_id, SUM(l.available) AS total FROM ledger_lots l GROUP BY l.user_id
) t ON t.user_id = a.user_id
WHERE a.classified
  AND w.user_id IS NOT NULL
  AND w.coins_balance IS DISTINCT FROM COALESCE(t.total, 0)
UNION ALL
SELECT 'CACHE_JOURNAL_MISMATCH', 'lot', l.id, l.user_id,
       format('managed lot %s caches (available %s, reserved %s, requirement %s, progress %s) differ from its journal (%s, %s, %s, %s)',
              l.id, COALESCE(l.available::text, 'NULL'), COALESCE(l.reserved::text, 'NULL'),
              COALESCE(l.requirement::text, 'NULL'), COALESCE(l.progress::text, 'NULL'),
              COALESCE(j.available, 0), COALESCE(j.reserved, 0), COALESCE(j.requirement, 0), COALESCE(j.progress, 0))
FROM ledger_lots l
LEFT JOIN (
  SELECT e.lot_id,
         SUM(e.available_delta) AS available,
         SUM(e.reserved_delta) AS reserved,
         SUM(e.progress_delta) AS progress,
         SUM(COALESCE(e.progress_delta, 0) + COALESCE(e.obligation_delta, 0)) AS requirement
  FROM ledger_entries e
  GROUP BY e.lot_id
) j ON j.lot_id = l.id
WHERE l.lot_class IS NOT NULL
  AND (l.available IS DISTINCT FROM COALESCE(j.available, 0)
       OR l.reserved IS DISTINCT FROM COALESCE(j.reserved, 0)
       OR l.requirement IS DISTINCT FROM COALESCE(j.requirement, 0)
       OR l.progress IS DISTINCT FROM COALESCE(j.progress, 0))
UNION ALL
SELECT 'SOURCE_OPERATION_MISSING', 'lot', l.id, l.user_id,
       format('managed lot %s has no source operation', l.id)
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL AND l.source_operation_id IS NULL
UNION ALL
SELECT 'SOURCE_OPERATION_INVALID', 'lot', l.id, l.user_id,
       format('managed lot %s names source operation %s, which does not exist', l.id, l.source_operation_id)
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL AND l.source_operation_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ledger_operations o WHERE o.id = l.source_operation_id)
UNION ALL
SELECT 'SOURCE_OPERATION_CROSS_USER', 'lot', l.id, l.user_id,
       format('managed lot %s of user %s names source operation %s of user %s',
              l.id, COALESCE(l.user_id, 'NULL'), o.id, COALESCE(o.user_id, 'NULL'))
FROM ledger_lots l
JOIN ledger_operations o ON o.id = l.source_operation_id -- a missing operation is SOURCE_OPERATION_INVALID above
WHERE l.lot_class IS NOT NULL AND o.user_id IS DISTINCT FROM l.user_id
UNION ALL
SELECT 'UNCLASSIFIED_VALUE_UNREVIEWED', 'lot', l.id, l.user_id,
       format('UNCLASSIFIED lot %s of classified user %s holds %s Coins without an open review (review: %s)',
              l.id, l.user_id, COALESCE(l.available, 0) + COALESCE(l.reserved, 0),
              COALESCE(l.review_id || ' is ' || COALESCE(r.status, 'missing') || ' for user ' || COALESCE(r.user_id, 'NULL'), 'none'))
FROM ledger_lots l
LEFT JOIN ledger_reviews r ON r.id = l.review_id
WHERE l.lot_class = 'UNCLASSIFIED'
  AND COALESCE(l.available, 0) + COALESCE(l.reserved, 0) > 0
  AND EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.user_id = l.user_id AND a.classified)
  AND (r.id IS NULL OR r.user_id IS DISTINCT FROM l.user_id
       OR r.status IS NULL OR r.status NOT IN ('OPEN', 'FIRST_APPROVED'))
-- ledger-integrity:predicates:end
)
SELECT a.category, a.subject_type, a.subject_id, a.user_id, a.detail
FROM anomalies a
ORDER BY a.category, a.subject_id NULLS FIRST
$ledger$;

-- The scan and the guard installation must see one stable state. An
-- uncommitted write that the scan cannot see would otherwise commit after it
-- and slip under guards installed a moment later. These locks conflict with
-- every writer (and allow plain reads) on each table the scan or the guards
-- read, and are held until this migration's transaction ends: a writer that
-- is mid-transaction makes the gate wait, and the gate then evaluates its
-- committed result.
LOCK TABLE "wallets", "wallet_transactions", "coin_ledger_accounts", "coin_provenance",
  "coin_lot_entries", "economic_operations", "legacy_balance_reviews", "withdrawal_holds",
  "withdrawals" IN SHARE ROW EXCLUSIVE MODE;

DO $gate$
DECLARE
  gate_total integer;
  gate_summary text;
BEGIN
  SELECT COALESCE(sum(c.n), 0)::integer,
         string_agg(format('%s x%s [%s]', c.category, c.n, c.sample), '; ' ORDER BY c.category)
    INTO gate_total, gate_summary
  FROM (
    SELECT a."category" AS category, count(*) AS n,
           array_to_string((array_agg(COALESCE(a."subjectId", 'NULL') ORDER BY a."subjectId"))[1:10], ', ') AS sample
    FROM "ledger_integrity_anomalies"() a
    GROUP BY a."category"
  ) c;

  IF gate_total > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('LEDGER INTEGRITY GATE STOPPED THE UPGRADE: %s anomalous ledger record(s): %s', gate_total, gate_summary),
      DETAIL = 'This migration changed nothing: no function, trigger or index from it exists. Earlier migrations of this release are already applied.',
      HINT = 'Run the read-only preflight (pnpm --filter api preflight:ledger-upgrade) to list every record, then follow docs/deployment/ledger-upgrade-gate.md: escalate each record for a separately reviewed, case-specific correction. Never mark this migration as applied.';
  END IF;
END
$gate$;

-- A lot is either fully pre-journal (every ledger field NULL, awaiting the M7
-- replay) or fully initialized. Nothing in between is ever valid.
CREATE OR REPLACE FUNCTION "coin_lot_initialization_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."lotClass" IS NOT NULL AND (
       NEW."state" IS NULL OR NEW."availableAmount" IS NULL OR NEW."reservedAmount" IS NULL
       OR NEW."requirementAmount" IS NULL OR NEW."progressAmount" IS NULL) THEN
    RAISE EXCEPTION 'managed coin lot % is not fully initialized: its state and every cache must be set', NEW."id";
  END IF;
  IF NEW."lotClass" IS NULL AND (
       NEW."state" IS NOT NULL OR NEW."availableAmount" IS NOT NULL OR NEW."reservedAmount" IS NOT NULL
       OR NEW."requirementAmount" IS NOT NULL OR NEW."progressAmount" IS NOT NULL
       OR NEW."sourceOperationId" IS NOT NULL) THEN
    RAISE EXCEPTION 'coin lot % is partially initialized: a pre-journal lot keeps every ledger field NULL until replay', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "coin_lot_initialization_guard"
BEFORE INSERT OR UPDATE ON "coin_provenance"
FOR EACH ROW EXECUTE FUNCTION "coin_lot_initialization_guard"();

-- Every owner of a coin lot or a ledger account has a wallet row. Deferred,
-- and re-reading the current row, so writers may order their inserts freely
-- within one transaction.
CREATE OR REPLACE FUNCTION "coin_lot_owner_wallet_guard"()
RETURNS trigger AS $$
DECLARE
  owner TEXT;
BEGIN
  SELECT p."userId" INTO owner FROM "coin_provenance" p WHERE p."id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM "wallets" w WHERE w."userId" = owner) THEN
    RAISE EXCEPTION 'coin_provenance lot % belongs to user % who has no wallet', NEW."id", owner;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "coin_lot_owner_wallet_guard"
AFTER INSERT OR UPDATE ON "coin_provenance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "coin_lot_owner_wallet_guard"();

CREATE OR REPLACE FUNCTION "coin_account_owner_wallet_guard"()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "coin_ledger_accounts" a WHERE a."userId" = NEW."userId") THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "wallets" w WHERE w."userId" = NEW."userId") THEN
    RAISE EXCEPTION 'coin_ledger_accounts row % belongs to user % who has no wallet', NEW."userId", NEW."userId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "coin_account_owner_wallet_guard"
AFTER INSERT OR UPDATE ON "coin_ledger_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "coin_account_owner_wallet_guard"();

CREATE OR REPLACE FUNCTION "wallet_ledger_owner_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."userId" IS NOT DISTINCT FROM OLD."userId" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "coin_ledger_accounts" a WHERE a."userId" = OLD."userId")
     OR EXISTS (SELECT 1 FROM "coin_provenance" p WHERE p."userId" = OLD."userId") THEN
    RAISE EXCEPTION 'wallet of user % cannot be removed while it owns ledger rows', OLD."userId";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "wallet_ledger_owner_guard"
BEFORE DELETE OR UPDATE OF "userId" ON "wallets"
FOR EACH ROW EXECUTE FUNCTION "wallet_ledger_owner_guard"();

-- UNCLASSIFIED value (available or reserved) of a classified user must be
-- covered by an OPEN or FIRST_APPROVED review of that same user. The older
-- row guard only checked a NULL reviewId and available value at lot-write
-- time; this also covers reserved value, reviews that were resolved or moved
-- to another user, and an account classified around unreviewed value.
CREATE OR REPLACE FUNCTION "unclassified_lot_review_violation"(lot_id TEXT)
RETURNS TEXT AS $$
DECLARE
  message TEXT;
BEGIN
  SELECT format('UNCLASSIFIED lot %s of classified user %s holds %s Coins without an open review',
                p."id", p."userId", COALESCE(p."availableAmount", 0) + COALESCE(p."reservedAmount", 0))
    INTO message
  FROM "coin_provenance" p
  LEFT JOIN "legacy_balance_reviews" r ON r."id" = p."reviewId"
  WHERE p."id" = lot_id
    AND p."lotClass" = 'UNCLASSIFIED'
    AND COALESCE(p."availableAmount", 0) + COALESCE(p."reservedAmount", 0) > 0
    AND EXISTS (SELECT 1 FROM "coin_ledger_accounts" a
                WHERE a."userId" = p."userId" AND a."classifiedAt" IS NOT NULL)
    AND (r."id" IS NULL OR r."userId" IS DISTINCT FROM p."userId"
         OR r."status" IS NULL OR r."status" NOT IN ('OPEN', 'FIRST_APPROVED'));
  RETURN message;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "coin_lot_review_coverage_guard"()
RETURNS trigger AS $$
DECLARE
  message TEXT;
BEGIN
  message := "unclassified_lot_review_violation"(NEW."id");
  IF message IS NOT NULL THEN
    RAISE EXCEPTION '%', message;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "coin_lot_review_coverage_guard"
AFTER INSERT OR UPDATE ON "coin_provenance"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."lotClass" = 'UNCLASSIFIED') EXECUTE FUNCTION "coin_lot_review_coverage_guard"();

CREATE OR REPLACE FUNCTION "account_review_coverage_guard"()
RETURNS trigger AS $$
DECLARE
  lot RECORD;
  message TEXT;
BEGIN
  FOR lot IN
    SELECT p."id" FROM "coin_provenance" p
    WHERE p."userId" = NEW."userId" AND p."lotClass" = 'UNCLASSIFIED'
    ORDER BY p."id"
  LOOP
    message := "unclassified_lot_review_violation"(lot."id");
    IF message IS NOT NULL THEN
      RAISE EXCEPTION '%', message;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "account_review_coverage_guard"
AFTER INSERT OR UPDATE ON "coin_ledger_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."classifiedAt" IS NOT NULL) EXECUTE FUNCTION "account_review_coverage_guard"();

CREATE OR REPLACE FUNCTION "review_coverage_guard"()
RETURNS trigger AS $$
DECLARE
  lot RECORD;
  message TEXT;
BEGIN
  FOR lot IN
    SELECT p."id" FROM "coin_provenance" p WHERE p."reviewId" = NEW."id" ORDER BY p."id"
  LOOP
    message := "unclassified_lot_review_violation"(lot."id");
    IF message IS NOT NULL THEN
      RAISE EXCEPTION '%', message;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "review_coverage_guard"
AFTER UPDATE ON "legacy_balance_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "review_coverage_guard"();

CREATE INDEX "coin_provenance_review_idx" ON "coin_provenance" ("reviewId");
