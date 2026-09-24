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
-- ADMIN_ADJUST (credit or debit): the operation consumes exactly one
--   admin_adjustment_approvals record, EXECUTED by this operation. The record
--   holds the user, the signed amount, non-empty evidence, its creator and
--   two approvals by distinct SUPER_ADMINs, neither of them the user, both
--   active when the adjustment settles; the second approver records the
--   operation. The operation repeats the approval's evidence and amount; a
--   credit mints exactly that amount, only into UNCLASSIFIED (reviewable)
--   lots; a debit consumes exactly that amount from the user's own managed
--   lots; and one succeeded Coin wallet transaction of the same user,
--   direction and amount backs it. The approval is created PENDING, only
--   moves PENDING -> FIRST_APPROVED -> EXECUTED (or to REJECTED/CANCELLED),
--   never changes its terms, and is terminal once executed or closed.
--
-- The database cannot authenticate the people behind these records: a
-- writer with unrestricted credentials can still fabricate a consistent
-- approval naming real administrators. What it guarantees is that ordinary
-- SQL (the application role, with every trigger active) cannot create an
-- ADMIN_ADJUST or LEGACY_RESOLVE operation that is not backed, exactly, by
-- such a record.
-- legacy_balance_reviews: created OPEN; evidence and the first approval are
--   frozen while FIRST_APPROVED (only resolving or reopening may follow);
--   resolved only from a first approval; only a resolved review names a
--   resolution operation; immutable once resolved or rejected; never deleted.
--
-- Approver and actor activity is checked when the operation is written. The
-- invariant checker (I16) re-checks everything else for all history, since
-- an administrator may legitimately leave after approving.

-- No ledger write may interleave with installing these rules or with the
-- closing check below (writers are stopped for the upgrade; this makes any
-- that were missed wait instead of racing).
LOCK TABLE "economic_operations", "coin_lot_entries", "coin_provenance", "legacy_balance_reviews",
  "wallet_transactions" IN SHARE ROW EXCLUSIVE MODE;

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

-- Evidence is an object whose caseId (a string) matches the approval's, with
-- a real string rationale and at least one non-empty string reference.
-- Anything missing or of another type is FALSE, never NULL (a CHECK accepts
-- NULL), and each test runs only once the ones before it hold, so array
-- functions only ever see an array.
CREATE OR REPLACE FUNCTION "admin_adjustment_evidence_valid"(evidence JSONB, case_id TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(evidence) IS DISTINCT FROM 'object' THEN false
    WHEN jsonb_typeof(evidence -> 'caseId') IS DISTINCT FROM 'string' THEN false
    WHEN (evidence ->> 'caseId') IS DISTINCT FROM case_id THEN false
    WHEN jsonb_typeof(evidence -> 'rationale') IS DISTINCT FROM 'string' THEN false
    WHEN length(btrim(evidence ->> 'rationale')) < 10 THEN false
    WHEN jsonb_typeof(evidence -> 'supportingEvidence') IS DISTINCT FROM 'array' THEN false
    WHEN jsonb_array_length(evidence -> 'supportingEvidence') = 0 THEN false
    ELSE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(evidence -> 'supportingEvidence') AS item(value)
      WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string' OR length(btrim(item.value #>> '{}')) = 0)
  END
$$;

CREATE TABLE "admin_adjustment_approvals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "caseId" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstApproverId" TEXT,
    "firstApprovedAt" TIMESTAMP(3),
    "secondApproverId" TEXT,
    "secondApprovedAt" TIMESTAMP(3),
    "operationId" TEXT,
    "walletTransactionId" TEXT,
    "executedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    CONSTRAINT "admin_adjustment_approvals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "admin_adjustment_approvals_amount_chk"
      CHECK ("amount" <> 0 AND "amount" BETWEEN -1000000000 AND 1000000000),
    CONSTRAINT "admin_adjustment_approvals_status_chk"
      CHECK ("status" IN ('PENDING', 'FIRST_APPROVED', 'EXECUTED', 'REJECTED', 'CANCELLED')),
    CONSTRAINT "admin_adjustment_approvals_evidence_chk"
      CHECK ("admin_adjustment_evidence_valid"("evidence", "caseId")),
    CONSTRAINT "admin_adjustment_approvals_independent_chk"
      CHECK ("firstApproverId" IS DISTINCT FROM "userId" AND "secondApproverId" IS DISTINCT FROM "userId"
             AND ("firstApproverId" IS NULL OR "secondApproverId" IS NULL OR "firstApproverId" <> "secondApproverId"))
);
CREATE UNIQUE INDEX "admin_adjustment_approvals_caseId_key" ON "admin_adjustment_approvals" ("caseId");
CREATE UNIQUE INDEX "admin_adjustment_approvals_operationId_key" ON "admin_adjustment_approvals" ("operationId");
CREATE UNIQUE INDEX "admin_adjustment_approvals_walletTransactionId_key" ON "admin_adjustment_approvals" ("walletTransactionId");
CREATE INDEX "admin_adjustment_approvals_userId_status_idx" ON "admin_adjustment_approvals" ("userId", "status");
ALTER TABLE "admin_adjustment_approvals" ADD CONSTRAINT "admin_adjustment_approvals_user_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_adjustment_approvals" ADD CONSTRAINT "admin_adjustment_approvals_operation_fkey"
  FOREIGN KEY ("operationId") REFERENCES "economic_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_adjustment_approvals" ADD CONSTRAINT "admin_adjustment_approvals_walletTransaction_fkey"
  FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The approval's lifecycle. Its terms never change; each transition sets
-- exactly its own fields; executed, rejected and cancelled are terminal.
CREATE OR REPLACE FUNCTION "admin_adjustment_approval_lifecycle_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'admin_adjustment_approvals is append-only; approval % cannot be deleted', OLD."id";
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" IS DISTINCT FROM 'PENDING'
       OR NEW."firstApproverId" IS NOT NULL OR NEW."firstApprovedAt" IS NOT NULL
       OR NEW."secondApproverId" IS NOT NULL OR NEW."secondApprovedAt" IS NOT NULL
       OR NEW."operationId" IS NOT NULL OR NEW."walletTransactionId" IS NOT NULL OR NEW."executedAt" IS NOT NULL
       OR NEW."closedBy" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."closeReason" IS NOT NULL THEN
      RAISE EXCEPTION 'admin adjustment approval % must be created PENDING, without approvals', NEW."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount" OR NEW."caseId" IS DISTINCT FROM OLD."caseId"
     OR NEW."evidence" IS DISTINCT FROM OLD."evidence" OR NEW."createdBy" IS DISTINCT FROM OLD."createdBy"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'admin adjustment approval % terms (user, amount, case, evidence, creator) are immutable', OLD."id";
  END IF;
  IF OLD."status" IN ('EXECUTED', 'REJECTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'admin adjustment approval % is %; it can no longer change', OLD."id", OLD."status";
  END IF;
  IF OLD."status" = 'PENDING' AND NEW."status" = 'FIRST_APPROVED' THEN
    IF NEW."firstApproverId" IS NULL OR NEW."firstApprovedAt" IS NULL
       OR NEW."secondApproverId" IS NOT NULL OR NEW."secondApprovedAt" IS NOT NULL
       OR NEW."operationId" IS NOT NULL OR NEW."walletTransactionId" IS NOT NULL OR NEW."executedAt" IS NOT NULL
       OR NEW."closedBy" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."closeReason" IS NOT NULL THEN
      RAISE EXCEPTION 'admin adjustment approval % first approval records exactly its approver and time', OLD."id";
    END IF;
  ELSIF OLD."status" = 'FIRST_APPROVED' AND NEW."status" = 'EXECUTED' THEN
    IF NEW."firstApproverId" IS DISTINCT FROM OLD."firstApproverId" OR NEW."firstApprovedAt" IS DISTINCT FROM OLD."firstApprovedAt"
       OR NEW."secondApproverId" IS NULL OR NEW."secondApprovedAt" IS NULL
       OR NEW."operationId" IS NULL OR NEW."walletTransactionId" IS NULL OR NEW."executedAt" IS NULL
       OR NEW."closedBy" IS NOT NULL OR NEW."closedAt" IS NOT NULL OR NEW."closeReason" IS NOT NULL THEN
      RAISE EXCEPTION 'admin adjustment approval % can only be executed from a first approval, by its second approver and operation', OLD."id";
    END IF;
  ELSIF OLD."status" IN ('PENDING', 'FIRST_APPROVED') AND NEW."status" IN ('REJECTED', 'CANCELLED') THEN
    IF NEW."firstApproverId" IS DISTINCT FROM OLD."firstApproverId" OR NEW."firstApprovedAt" IS DISTINCT FROM OLD."firstApprovedAt"
       OR NEW."secondApproverId" IS NOT NULL OR NEW."secondApprovedAt" IS NOT NULL
       OR NEW."operationId" IS NOT NULL OR NEW."walletTransactionId" IS NOT NULL OR NEW."executedAt" IS NOT NULL
       OR NEW."closedBy" IS NULL OR NEW."closedAt" IS NULL OR length(btrim(COALESCE(NEW."closeReason", ''))) = 0 THEN
      RAISE EXCEPTION 'admin adjustment approval % closes with exactly who closed it, when and why', OLD."id";
    END IF;
  ELSE
    RAISE EXCEPTION 'admin adjustment approval % cannot move from % to %', OLD."id", OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "admin_adjustment_approval_lifecycle_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "admin_adjustment_approvals"
FOR EACH ROW EXECUTE FUNCTION "admin_adjustment_approval_lifecycle_guard"();

CREATE OR REPLACE FUNCTION "admin_adjustment_violation"(operation_id TEXT, check_approvers_active BOOLEAN)
RETURNS TEXT AS $$
DECLARE
  op RECORD;
  approval RECORD;
  entries RECORD;
BEGIN
  SELECT o."id", o."type"::text AS kind, o."userId", o."snapshot", o."createdBy", o."walletTransactionIds"
    INTO op FROM "economic_operations" o WHERE o."id" = operation_id;
  IF NOT FOUND OR op.kind <> 'ADMIN_ADJUST' THEN
    RETURN NULL;
  END IF;
  SELECT a.* INTO approval FROM "admin_adjustment_approvals" a WHERE a."operationId" = op."id";
  IF NOT FOUND THEN
    RETURN format('admin adjustment %s is not the execution of any adjustment approval', op."id");
  END IF;
  IF approval."status" IS DISTINCT FROM 'EXECUTED' THEN
    RETURN format('admin adjustment %s names approval %s, which is %s, not EXECUTED', op."id", approval."id", approval."status");
  END IF;
  IF approval."userId" IS DISTINCT FROM op."userId" THEN
    RETURN format('admin adjustment %s of user %s names approval %s of user %s', op."id", op."userId", approval."id", approval."userId");
  END IF;
  IF approval."firstApproverId" IS NULL OR approval."secondApproverId" IS NULL
     OR approval."firstApproverId" = approval."secondApproverId"
     OR approval."firstApproverId" = approval."userId" OR approval."secondApproverId" = approval."userId" THEN
    RETURN format('admin adjustment %s lacks two distinct independent approvals', op."id");
  END IF;
  IF op."createdBy" IS DISTINCT FROM approval."secondApproverId" THEN
    RETURN format('admin adjustment %s was recorded by %s, not by its executing approver', op."id", COALESCE(op."createdBy", 'NULL'));
  END IF;
  IF check_approvers_active AND (
       SELECT count(*) FROM "users" u
       WHERE u."id" IN (approval."firstApproverId", approval."secondApproverId")
         AND u."role"::text = 'SUPER_ADMIN' AND u."status"::text = 'ACTIVE') <> 2 THEN
    RETURN format('admin adjustment %s needs two currently active SUPER_ADMIN approvers', op."id");
  END IF;
  IF op."snapshot" IS NULL
     OR (op."snapshot" ->> 'approvalId') IS DISTINCT FROM approval."id"
     OR (op."snapshot" -> 'evidence') IS DISTINCT FROM approval."evidence"
     OR (op."snapshot" -> 'amount') IS DISTINCT FROM to_jsonb(approval."amount") THEN
    RETURN format('admin adjustment %s does not repeat the terms of approval %s', op."id", approval."id");
  END IF;

  SELECT COALESCE(sum(e."availableDelta"), 0) AS moved,
         count(*) AS n,
         count(*) FILTER (WHERE approval."amount" > 0 AND e."entryType" = 'MINT' AND e."availableDelta" > 0
                            AND e."reservedDelta" = 0 AND p."lotClass"::text = 'UNCLASSIFIED'
                            AND p."userId" = op."userId") AS valid_credits,
         count(*) FILTER (WHERE approval."amount" < 0 AND e."entryType" = 'CONSUME' AND e."availableDelta" < 0
                            AND e."reservedDelta" = 0 AND p."lotClass" IS NOT NULL
                            AND p."userId" = op."userId") AS valid_debits
    INTO entries
  FROM "coin_lot_entries" e
  JOIN "coin_provenance" p ON p."id" = e."lotId"
  WHERE e."operationId" = op."id";
  IF entries.n = 0 OR entries.moved <> approval."amount"
     OR (approval."amount" > 0 AND entries.valid_credits <> entries.n)
     OR (approval."amount" < 0 AND entries.valid_debits <> entries.n) THEN
    RETURN format('admin adjustment %s must %s exactly the approved %s Coins %s the user''s own %s lots',
                  op."id", CASE WHEN approval."amount" > 0 THEN 'mint' ELSE 'consume' END, abs(approval."amount"),
                  CASE WHEN approval."amount" > 0 THEN 'into' ELSE 'from' END,
                  CASE WHEN approval."amount" > 0 THEN 'UNCLASSIFIED' ELSE 'managed' END);
  END IF;

  IF cardinality(op."walletTransactionIds") IS DISTINCT FROM 1
     OR op."walletTransactionIds"[1] IS DISTINCT FROM approval."walletTransactionId"
     OR NOT EXISTS (
       SELECT 1 FROM "wallet_transactions" w
       WHERE w."id" = approval."walletTransactionId" AND w."userId" = op."userId"
         AND w."currency"::text = 'COINS'
         AND w."ledgerType"::text = CASE WHEN approval."amount" > 0 THEN 'CREDIT' ELSE 'DEBIT' END
         AND w."status"::text = 'SUCCEEDED' AND w."amount" = abs(approval."amount")) THEN
    RETURN format('admin adjustment %s is not backed by the approval''s one succeeded Coin wallet transaction', op."id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "operation_authorization_guard"()
RETURNS trigger AS $$
DECLARE
  message TEXT;
  operation TEXT;
BEGIN
  IF TG_TABLE_NAME = 'economic_operations' THEN
    operation := NEW."id";
  ELSE
    operation := NEW."operationId";
  END IF;
  IF TG_TABLE_NAME = 'admin_adjustment_approvals' AND NOT EXISTS (
       SELECT 1 FROM "economic_operations" o WHERE o."id" = operation AND o."type"::text = 'ADMIN_ADJUST') THEN
    RAISE EXCEPTION 'admin adjustment approval % was executed by %, which is not an ADMIN_ADJUST operation', NEW."id", operation;
  END IF;
  message := COALESCE("legacy_resolution_violation"(operation, true),
                      "admin_adjustment_violation"(operation, true));
  IF message IS NOT NULL THEN
    RAISE EXCEPTION '%', message;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- Checked at commit, whichever row of the operation is written: its entries,
-- the operation itself (so an operation without entries cannot pass), or
-- the approval it executes.
CREATE CONSTRAINT TRIGGER "operation_authorization_guard"
AFTER INSERT ON "coin_lot_entries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "operation_authorization_guard"();
CREATE CONSTRAINT TRIGGER "authorized_operation_guard"
AFTER INSERT ON "economic_operations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."type"::text IN ('ADMIN_ADJUST', 'LEGACY_RESOLVE'))
EXECUTE FUNCTION "operation_authorization_guard"();
CREATE CONSTRAINT TRIGGER "adjustment_execution_guard"
AFTER UPDATE ON "admin_adjustment_approvals"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."status" = 'EXECUTED')
EXECUTE FUNCTION "operation_authorization_guard"();

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

-- Nothing already recorded escapes the rules just installed: every existing
-- LEGACY_RESOLVE and ADMIN_ADJUST must satisfy them, in history mode. The
-- query between the markers is, verbatim, UNAUTHORIZED_OPERATIONS_QUERY
-- (apps/api/src/economy/ledger-integrity-definitions.ts), which invariant
-- I16 and the UPGRADED preflight also evaluate. A supported upgrade has no
-- such operation yet; any found stops the upgrade before it commits.
DO $authorization$
DECLARE
  found_count INTEGER;
  found_sample TEXT;
BEGIN
  SELECT count(*)::int, left(string_agg(u."kind" || ' ' || u."id" || ': ' || u."detail", '; ' ORDER BY u."id"), 2000)
    INTO found_count, found_sample
  FROM (
-- ledger-authorization-check:begin
SELECT v."id", v."userId", v."kind", v."detail"
FROM (
  SELECT o."id", o."userId", o."type"::text AS "kind",
         COALESCE("legacy_resolution_violation"(o."id", false),
                  "admin_adjustment_violation"(o."id", false)) AS "detail"
  FROM "economic_operations" o
  WHERE o."type"::text IN ('LEGACY_RESOLVE', 'ADMIN_ADJUST')
) v
WHERE v."detail" IS NOT NULL
-- ledger-authorization-check:end
  ) u;
  IF found_count > 0 THEN
    RAISE EXCEPTION 'LEDGER AUTHORIZATION CHECK STOPPED THE UPGRADE: % recorded operation(s) are not backed by the records that authorize them: %',
      found_count, found_sample
      USING HINT = 'Restore the pre-upgrade backup and escalate; see docs/deployment/ledger-upgrade-gate.md. Never mark this migration as applied.';
  END IF;
END
$authorization$;
