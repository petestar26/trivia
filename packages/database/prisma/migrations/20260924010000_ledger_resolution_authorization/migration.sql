-- Closes the forged mint path: before this migration, ordinary SQL could mint
-- UNCLASSIFIED value with an ADMIN_ADJUST operation naming no real actor or
-- wallet credit, then move it into a WITHDRAWABLE lot with a LEGACY_RESOLVE
-- operation whose snapshot merely carried the right keys. The database now
-- binds both operation types to the records that authorize them:
--
-- LEGACY_RESOLVE: the operation is the exact resolution of one RESOLVED
--   legacy review of the same user; that review has two distinct approvers,
--   neither of them its owner, both currently active SUPER_ADMINs when the
--   resolution is written; the second approver records the operation; its
--   snapshot repeats the review's frozen evidence, approvers, amount and
--   decision exactly; and its entries are one RECLASS_OUT of that amount from
--   the review's own UNCLASSIFIED lot and one RECLASS_IN of that amount into
--   a child lot of the approved class. Nothing else.
-- ADMIN_ADJUST credits: recorded by an independent, currently active
--   SUPER_ADMIN, with evidence, only into UNCLASSIFIED (reviewable) lots, and
--   backed by exactly one succeeded Coin credit of the same user and amount.
-- legacy_balance_reviews: created OPEN; evidence and the first approval are
--   frozen while FIRST_APPROVED (only resolving or reopening may follow);
--   resolved only from a first approval; only a resolved review names a
--   resolution operation; immutable once resolved or rejected; never deleted.
--
-- Approver and actor activity is checked when the operation is written. The
-- invariant checker (I16) re-checks everything else for all history, since
-- an administrator may legitimately leave after approving.

CREATE OR REPLACE FUNCTION "legacy_resolution_violation"(operation_id TEXT, check_approvers_active BOOLEAN)
RETURNS TEXT AS $$
DECLARE
  op RECORD;
  review RECORD;
  lot RECORD;
  proposal JSONB;
  approved BIGINT;
  entries RECORD;
BEGIN
  SELECT o."id", o."type"::text AS kind, o."userId", o."scopeType", o."scopeId", o."snapshot", o."createdBy"
    INTO op FROM "economic_operations" o WHERE o."id" = operation_id;
  IF NOT FOUND OR op.kind <> 'LEGACY_RESOLVE' THEN
    RETURN NULL;
  END IF;

  SELECT r."id", r."userId", r."lotId", r."status", r."evidence", r."resolvedBy", r."secondApproverId"
    INTO review FROM "legacy_balance_reviews" r WHERE r."resolutionOperationId" = op."id";
  IF NOT FOUND THEN
    RETURN format('legacy resolution %s is not the resolution of any legacy review', op."id");
  END IF;
  IF op."scopeType" IS DISTINCT FROM 'REVIEW' OR op."scopeId" IS DISTINCT FROM review."id" THEN
    RETURN format('legacy resolution %s is scoped to %s %s, not to its review %s',
                  op."id", op."scopeType", op."scopeId", review."id");
  END IF;
  IF review."status" IS DISTINCT FROM 'RESOLVED' THEN
    RETURN format('legacy resolution %s names review %s, which is %s, not RESOLVED', op."id", review."id", review."status");
  END IF;
  IF review."userId" IS DISTINCT FROM op."userId" THEN
    RETURN format('legacy resolution %s of user %s names review %s of user %s', op."id", op."userId", review."id", review."userId");
  END IF;

  IF review."resolvedBy" IS NULL OR review."secondApproverId" IS NULL
     OR review."resolvedBy" = review."secondApproverId"
     OR review."resolvedBy" = review."userId" OR review."secondApproverId" = review."userId" THEN
    RETURN format('legacy resolution %s lacks two distinct independent approvers', op."id");
  END IF;
  IF op."createdBy" IS DISTINCT FROM review."secondApproverId" THEN
    RETURN format('legacy resolution %s was recorded by %s, not by its second approver', op."id", COALESCE(op."createdBy", 'NULL'));
  END IF;
  IF check_approvers_active AND (
       SELECT count(*) FROM "users" u
       WHERE u."id" IN (review."resolvedBy", review."secondApproverId")
         AND u."role"::text = 'SUPER_ADMIN' AND u."status"::text = 'ACTIVE') <> 2 THEN
    RETURN format('legacy resolution %s needs two currently active SUPER_ADMIN approvers', op."id");
  END IF;

  proposal := review."evidence" -> 'proposal';
  IF proposal IS NULL OR jsonb_typeof(proposal) IS DISTINCT FROM 'object'
     OR jsonb_typeof(proposal -> 'amount') IS DISTINCT FROM 'number'
     OR (proposal ->> 'decision') IS NULL OR (proposal ->> 'decision') NOT IN ('WITHDRAWABLE', 'RESTRICTED') THEN
    RETURN format('legacy review %s has no approved proposal', review."id");
  END IF;
  approved := (proposal ->> 'amount')::numeric;
  IF approved IS NULL OR approved <= 0 THEN
    RETURN format('legacy review %s approved a non-positive amount', review."id");
  END IF;
  IF op."snapshot" IS NULL
     OR (op."snapshot" -> 'evidence') IS DISTINCT FROM review."evidence"
     OR (op."snapshot" ->> 'firstApproverId') IS DISTINCT FROM review."resolvedBy"
     OR (op."snapshot" ->> 'secondApproverId') IS DISTINCT FROM review."secondApproverId"
     OR (op."snapshot" -> 'amount') IS DISTINCT FROM (proposal -> 'amount')
     OR (op."snapshot" ->> 'decision') IS DISTINCT FROM (proposal ->> 'decision') THEN
    RETURN format('legacy resolution %s does not repeat the approved evidence of review %s', op."id", review."id");
  END IF;

  SELECT p."userId", p."lotClass"::text AS lot_class, p."reviewId"
    INTO lot FROM "coin_provenance" p WHERE p."id" = review."lotId";
  IF NOT FOUND OR lot."userId" IS DISTINCT FROM review."userId"
     OR lot.lot_class IS DISTINCT FROM 'UNCLASSIFIED' OR lot."reviewId" IS DISTINCT FROM review."id" THEN
    RETURN format('legacy review %s does not own an UNCLASSIFIED lot linked back to it', review."id");
  END IF;

  SELECT count(*) FILTER (WHERE e."entryType" = 'RECLASS_OUT') AS outs,
         count(*) FILTER (WHERE e."entryType" = 'RECLASS_OUT' AND e."lotId" = review."lotId"
                            AND e."availableDelta" = -approved AND e."reservedDelta" = 0
                            AND e."progressDelta" = 0 AND e."obligationDelta" = 0) AS exact_outs,
         count(*) FILTER (WHERE e."entryType" = 'RECLASS_IN') AS ins,
         count(*) FILTER (WHERE e."entryType" = 'RECLASS_IN' AND e."availableDelta" = approved
                            AND e."reservedDelta" = 0 AND p."parentLotId" = review."lotId"
                            AND p."userId" = review."userId"
                            AND p."lotClass"::text = (proposal ->> 'decision')) AS exact_ins,
         count(*) FILTER (WHERE e."entryType" NOT IN ('RECLASS_OUT', 'RECLASS_IN')) AS others
    INTO entries
  FROM "coin_lot_entries" e
  JOIN "coin_provenance" p ON p."id" = e."lotId"
  WHERE e."operationId" = op."id";
  IF entries.outs <> 1 OR entries.exact_outs <> 1 OR entries.ins <> 1 OR entries.exact_ins <> 1
     OR entries.others <> 0 THEN
    RETURN format('legacy resolution %s must move exactly the approved %s Coins from review lot %s into one child lot of class %s',
                  op."id", approved, review."lotId", proposal ->> 'decision');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "admin_credit_violation"(operation_id TEXT, check_actor_active BOOLEAN)
RETURNS TEXT AS $$
DECLARE
  op RECORD;
  minted BIGINT;
BEGIN
  SELECT o."id", o."type"::text AS kind, o."userId", o."snapshot", o."createdBy", o."walletTransactionIds"
    INTO op FROM "economic_operations" o WHERE o."id" = operation_id;
  IF NOT FOUND OR op.kind <> 'ADMIN_ADJUST' THEN
    RETURN NULL;
  END IF;
  SELECT sum(e."availableDelta") INTO minted
  FROM "coin_lot_entries" e WHERE e."operationId" = op."id" AND e."entryType" = 'MINT';
  IF minted IS NULL THEN
    RETURN NULL; -- a debit; debits are guarded by coin_lot_entry_validate
  END IF;
  IF op."snapshot" IS NULL OR NOT (op."snapshot" ? 'evidence') THEN
    RETURN format('admin credit %s has no evidence', op."id");
  END IF;
  IF op."createdBy" IS NULL OR op."createdBy" = op."userId" THEN
    RETURN format('admin credit %s has no independent actor', op."id");
  END IF;
  IF check_actor_active AND NOT EXISTS (
       SELECT 1 FROM "users" u
       WHERE u."id" = op."createdBy" AND u."role"::text = 'SUPER_ADMIN' AND u."status"::text = 'ACTIVE') THEN
    RETURN format('admin credit %s was not recorded by a currently active SUPER_ADMIN', op."id");
  END IF;
  IF EXISTS (
       SELECT 1 FROM "coin_lot_entries" e
       JOIN "coin_provenance" p ON p."id" = e."lotId"
       WHERE e."operationId" = op."id" AND e."entryType" = 'MINT'
         AND p."lotClass" IS DISTINCT FROM 'UNCLASSIFIED') THEN
    RETURN format('admin credit %s may only mint UNCLASSIFIED value that awaits a legacy review', op."id");
  END IF;
  IF cardinality(op."walletTransactionIds") IS DISTINCT FROM 1 OR NOT EXISTS (
       SELECT 1 FROM "wallet_transactions" w
       WHERE w."id" = op."walletTransactionIds"[1] AND w."userId" = op."userId"
         AND w."currency"::text = 'COINS' AND w."ledgerType"::text = 'CREDIT'
         AND w."status"::text = 'SUCCEEDED' AND w."amount" = minted) THEN
    RETURN format('admin credit %s is not backed by one succeeded Coin credit of %s to its user', op."id", minted);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "operation_authorization_guard"()
RETURNS trigger AS $$
DECLARE
  message TEXT;
BEGIN
  message := COALESCE("legacy_resolution_violation"(NEW."operationId", true),
                      "admin_credit_violation"(NEW."operationId", true));
  IF message IS NOT NULL THEN
    RAISE EXCEPTION '%', message;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "operation_authorization_guard"
AFTER INSERT ON "coin_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "operation_authorization_guard"();

CREATE OR REPLACE FUNCTION "legacy_review_lifecycle_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legacy_balance_reviews is append-only; review % cannot be deleted', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'OPEN' OR NEW."resolvedBy" IS NOT NULL OR NEW."secondApproverId" IS NOT NULL
       OR NEW."resolutionOperationId" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'legacy review % must be created OPEN, without approvals', NEW."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."lotId" IS DISTINCT FROM OLD."lotId" OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'legacy review % user, lot and amount are immutable', OLD."id";
  END IF;
  IF OLD."status" IN ('RESOLVED', 'REJECTED') THEN
    RAISE EXCEPTION 'legacy review % is %; it can no longer change', OLD."id", OLD."status";
  END IF;
  IF OLD."status" = 'FIRST_APPROVED' AND NEW."status" IS DISTINCT FROM 'OPEN'
     AND (NEW."evidence" IS DISTINCT FROM OLD."evidence" OR NEW."resolvedBy" IS DISTINCT FROM OLD."resolvedBy") THEN
    RAISE EXCEPTION 'legacy review % evidence and first approval are frozen until it is resolved or reopened', OLD."id";
  END IF;
  IF NEW."status" = 'RESOLVED' AND (OLD."status" IS DISTINCT FROM 'FIRST_APPROVED' OR NEW."secondApproverId" IS NULL
     OR NEW."resolutionOperationId" IS NULL OR NEW."resolvedAt" IS NULL) THEN
    RAISE EXCEPTION 'legacy review % can only be resolved from a first approval, with its second approver and resolution operation', OLD."id";
  END IF;
  IF NEW."status" = 'FIRST_APPROVED' AND (NEW."resolvedBy" IS NULL OR (NEW."evidence" -> 'proposal') IS NULL
     OR jsonb_typeof(NEW."evidence" -> 'proposal') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'legacy review % first approval needs its approver and approved proposal', OLD."id";
  END IF;
  IF NEW."status" IN ('OPEN', 'FIRST_APPROVED') AND (NEW."secondApproverId" IS NOT NULL
     OR NEW."resolutionOperationId" IS NOT NULL OR NEW."resolvedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'legacy review % records a second approval without being resolved', OLD."id";
  END IF;
  IF NEW."status" = 'OPEN' AND NEW."resolvedBy" IS NOT NULL THEN
    RAISE EXCEPTION 'legacy review % is OPEN but records a first approver', OLD."id";
  END IF;
  IF NEW."status" IS DISTINCT FROM 'RESOLVED' AND NEW."resolutionOperationId" IS NOT NULL THEN
    RAISE EXCEPTION 'legacy review % names a resolution operation without being resolved', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "legacy_review_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "legacy_balance_reviews"
FOR EACH ROW EXECUTE FUNCTION "legacy_review_lifecycle_guard"();
