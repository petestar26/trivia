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
-- With every writer stopped these locks are free. If a writer is still
-- running, the gate waits at most lock_timeout and then fails, changing
-- nothing, instead of hanging the deploy; a deadlock with such a writer ends
-- the same way for whichever side PostgreSQL aborts. See
-- docs/deployment/ledger-upgrade-gate.md ("If a migration fails").
SET LOCAL lock_timeout = '20s';
LOCK TABLE "economic_operations", "coin_lot_entries", "coin_provenance", "legacy_balance_reviews",
  "wallet_transactions" IN SHARE ROW EXCLUSIVE MODE;

-- ===========================================================================
-- Signed approval assertions: the trust boundary for human approvals.
--
-- An approval row naming two SUPER_ADMINs proves nothing if the application's
-- database role can write that row. So every approval decision - the request,
-- each approval, a close, a reopen - is also an ASSERTION signed by the API
-- (HMAC-SHA256) once it has authenticated the acting SUPER_ADMIN. The API
-- holds the signing key; the database holds the same key in
-- ledger_approval_keys, which the runtime role can neither read nor write
-- (see ledger_apply_runtime_grants). The runtime role writes approvals only
-- through the SECURITY DEFINER procedures below, which refuse any assertion
-- whose signature does not verify, and the settlement guards re-verify every
-- stored assertion. A caller that can only run SQL as the runtime role cannot
-- produce a valid signature, so it cannot approve anything. The table owner
-- and superusers remain outside this boundary: they can read the key.
--
-- Each assertion binds: subject (approval or review) and its ID, action,
-- actor, affected user, signed amount, case ID, a SHA-256 digest of the exact
-- evidence, and a single-use nonce.
-- ===========================================================================
CREATE TABLE "ledger_approval_keys" (
    "keyId" TEXT NOT NULL,
    "secret" BYTEA NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "ledger_approval_keys_pkey" PRIMARY KEY ("keyId"),
    CONSTRAINT "ledger_approval_keys_secret_chk" CHECK (octet_length("secret") >= 32)
);
REVOKE ALL ON "ledger_approval_keys" FROM PUBLIC;

CREATE TABLE "ledger_approval_assertions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" NUMERIC NOT NULL,
    "caseId" TEXT NOT NULL,
    "evidenceDigest" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ledger_approval_assertions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_approval_assertions_subject_chk" CHECK ("subjectType" IN ('ADMIN_ADJUSTMENT', 'LEGACY_REVIEW')),
    CONSTRAINT "ledger_approval_assertions_action_chk"
      CHECK ("action" IN ('REQUEST', 'FIRST_APPROVAL', 'SECOND_APPROVAL', 'REJECT', 'CANCEL', 'REOPEN')),
    CONSTRAINT "ledger_approval_assertions_nonce_chk" CHECK (length("nonce") BETWEEN 32 AND 128)
);
CREATE UNIQUE INDEX "ledger_approval_assertions_nonce_key" ON "ledger_approval_assertions" ("nonce");
CREATE INDEX "ledger_approval_assertions_subject_idx"
  ON "ledger_approval_assertions" ("subjectType", "subjectId", "action");
ALTER TABLE "ledger_approval_assertions" ADD CONSTRAINT "ledger_approval_assertions_key_fkey"
  FOREIGN KEY ("keyId") REFERENCES "ledger_approval_keys"("keyId") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION "ledger_approval_assertions_append_only"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_approval_assertions is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ledger_approval_assertions_append_only"
BEFORE UPDATE OR DELETE ON "ledger_approval_assertions"
FOR EACH ROW EXECUTE FUNCTION "ledger_approval_assertions_append_only"();

-- The approval functions below, and what they call and fire, run as the
-- owner (SECURITY DEFINER), and the owner runs the key and grants functions
-- itself. Each of them runs with the fixed search path pg_catalog, pg_temp
-- and names every table and every non-catalog function by schema, with the
-- exact argument types: no object another role creates in a schema can be
-- picked in their place (functions and operators are never looked up in
-- pg_temp). They name schema public, and pgcrypto in it; stop if either is
-- elsewhere. ledger_apply_runtime_grants also keeps the runtime role from
-- creating anything in those schemas.
DO $approval_schema$
BEGIN
  IF current_schema() IS DISTINCT FROM 'public' OR NOT EXISTS (
       SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgcrypto' AND n.nspname = 'public') THEN
    RAISE EXCEPTION 'the ledger approval functions expect the ledger tables and pgcrypto in schema public (current schema %)',
      current_schema();
  END IF;
END
$approval_schema$;

-- The digest of evidence is taken over its canonical jsonb text, so the API
-- and the database agree on it whatever the key order or formatting.
CREATE OR REPLACE FUNCTION "ledger_evidence_digest"(evidence JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT pg_catalog.encode(public.digest(COALESCE(evidence, 'null'::jsonb)::text, 'sha256'::text), 'hex'::text)
$$;

-- The exact text the API signs. The API asks for it rather than rebuilding
-- it, so both sides always sign and verify the same bytes.
CREATE OR REPLACE FUNCTION "ledger_approval_payload"(subject_type TEXT, subject_id TEXT, action TEXT, actor_id TEXT,
  user_id TEXT, amount NUMERIC, case_id TEXT, evidence_digest TEXT, nonce TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT 'playqube-ledger-approval/v1 ' || jsonb_build_array(subject_type, subject_id, action, actor_id, user_id,
           trim_scale(amount)::text, case_id, evidence_digest, nonce)::text
$$;

-- Verifies a signature with the named key (for a new assertion, only an
-- unretired key). SECURITY DEFINER: it reads the key the caller cannot. It
-- answers only true or false.
CREATE OR REPLACE FUNCTION "ledger_approval_signature_valid"(key_id TEXT, payload TEXT, signature TEXT,
  for_new_assertion BOOLEAN)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT COALESCE(bool_or(pg_catalog.encode(public.hmac(pg_catalog.convert_to(payload, 'UTF8'::name), k."secret", 'sha256'::text),
    'hex'::text) = pg_catalog.lower(signature)), false)
  FROM public."ledger_approval_keys" k
  WHERE k."keyId" = key_id AND (NOT for_new_assertion OR k."retiredAt" IS NULL)
$$;

CREATE OR REPLACE FUNCTION "ledger_assertion_valid"(a public."ledger_approval_assertions")
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT public."ledger_approval_signature_valid"(a."keyId",
    public."ledger_approval_payload"(a."subjectType", a."subjectId", a."action", a."actorId", a."userId", a."amount",
                                     a."caseId", a."evidenceDigest", a."nonce"),
    a."signature", false)
$$;

-- Installs (idempotently) a signing key; owner only.
CREATE OR REPLACE FUNCTION "ledger_install_approval_key"(key_id TEXT, secret BYTEA)
RETURNS void AS $$
BEGIN
  IF key_id IS NULL OR key_id !~ '^[A-Za-z0-9._-]{1,64}$' THEN
    RAISE EXCEPTION 'approval key id must be 1-64 characters of [A-Za-z0-9._-]';
  END IF;
  INSERT INTO public."ledger_approval_keys" ("keyId", "secret") VALUES (key_id, secret)
  ON CONFLICT ("keyId") DO UPDATE SET "keyId" = EXCLUDED."keyId"
    WHERE "ledger_approval_keys"."secret" = EXCLUDED."secret";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval key % is already installed with a different secret', key_id;
  END IF;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
CREATE OR REPLACE FUNCTION "ledger_retire_approval_key"(key_id TEXT)
RETURNS void AS $$
BEGIN
  UPDATE public."ledger_approval_keys" SET "retiredAt" = COALESCE("retiredAt", CURRENT_TIMESTAMP) WHERE "keyId" = key_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'approval key % is not installed', key_id; END IF;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE EXECUTE ON FUNCTION "ledger_install_approval_key"(TEXT, BYTEA) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION "ledger_retire_approval_key"(TEXT) FROM PUBLIC;

-- Records one verified assertion; used only by the procedures below.
CREATE OR REPLACE FUNCTION "ledger_record_assertion"(subject_type TEXT, subject_id TEXT, action TEXT, actor_id TEXT,
  user_id TEXT, assertion_amount NUMERIC, case_id TEXT, evidence JSONB, key_id TEXT, nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  digest_hex TEXT := public."ledger_evidence_digest"(evidence);
BEGIN
  IF key_id IS NULL OR nonce IS NULL OR signature IS NULL OR length(nonce) NOT BETWEEN 32 AND 128 THEN
    RAISE EXCEPTION 'ledger approval assertion for % % % needs a key, a 32-128 character nonce and a signature',
      subject_type, subject_id, action;
  END IF;
  IF NOT public."ledger_approval_signature_valid"(key_id,
       public."ledger_approval_payload"(subject_type, subject_id, action, actor_id, user_id, assertion_amount, case_id, digest_hex, nonce),
       signature, true) THEN
    RAISE EXCEPTION 'ledger approval assertion for % % % by % is not signed by an active approval key',
      subject_type, subject_id, action, actor_id;
  END IF;
  INSERT INTO public."ledger_approval_assertions" ("subjectType", "subjectId", "action", "actorId", "userId", "amount",
    "caseId", "evidenceDigest", "nonce", "keyId", "signature")
  VALUES (subject_type, subject_id, action, actor_id, user_id, assertion_amount, case_id, digest_hex, nonce, key_id, pg_catalog.lower(signature));
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE EXECUTE ON FUNCTION "ledger_record_assertion"(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "ledger_is_active_super_admin"(user_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public."users" u
                 WHERE u."id" = user_id AND u."role"::text = 'SUPER_ADMIN' AND u."status"::text = 'ACTIVE')
$$;

-- Who is a SUPER_ADMIN is itself part of the trust boundary: only the table
-- owner (migrations, operators) may create a user with any role but USER or
-- change anyone's role or status. The runtime role creates plain users only.
CREATE OR REPLACE FUNCTION "users_privilege_guard"()
RETURNS trigger AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT c."relowner" FROM pg_class c WHERE c."oid" = TG_RELID), 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW."role"::text <> 'USER' THEN
    RAISE EXCEPTION 'only the database owner creates a user with role %', NEW."role";
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."role" IS DISTINCT FROM OLD."role" OR NEW."status" IS DISTINCT FROM OLD."status") THEN
    RAISE EXCEPTION 'only the database owner changes a user''s role or status';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "users_privilege_guard"
BEFORE INSERT OR UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION "users_privilege_guard"();

-- A whole, nonzero number of Coins within +-1,000,000,000. Checked on the
-- NUMERIC the caller passed, before anything could round it.
CREATE OR REPLACE FUNCTION "ledger_require_whole_coin_amount"(requested NUMERIC)
RETURNS INTEGER AS $$
BEGIN
  IF requested IS NULL OR requested = 'NaN'::numeric OR abs(requested) > 1000000000 OR requested <> trunc(requested)
     OR requested = 0 THEN
    RAISE EXCEPTION 'admin adjustment amount % must be a nonzero whole number of Coins within +-1000000000', requested;
  END IF;
  RETURN requested::integer;
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp;

-- ---- Coin adjustment procedures (the only way the runtime role writes an
-- ---- admin_adjustment_approvals row) ----
CREATE OR REPLACE FUNCTION "ledger_adjustment_request"(approval_id TEXT, user_id TEXT, requested_amount NUMERIC,
  case_id TEXT, evidence JSONB, actor_id TEXT, key_id TEXT, nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  whole INTEGER := public."ledger_require_whole_coin_amount"(requested_amount);
BEGIN
  IF actor_id IS NULL OR actor_id = user_id THEN
    RAISE EXCEPTION 'an administrator cannot request an adjustment of their own Coins';
  END IF;
  IF NOT public."ledger_is_active_super_admin"(actor_id) THEN
    RAISE EXCEPTION 'admin adjustment % must be requested by an active SUPER_ADMIN', approval_id;
  END IF;
  PERFORM public."ledger_record_assertion"('ADMIN_ADJUSTMENT'::text, approval_id, 'REQUEST'::text, actor_id, user_id,
                                           whole::numeric, case_id,
                                    evidence, key_id, nonce, signature);
  INSERT INTO public."admin_adjustment_approvals" ("id", "userId", "amount", "caseId", "evidence", "createdBy")
  VALUES (approval_id, user_id, whole, case_id, evidence, actor_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_adjustment_first_approval"(approval_id TEXT, actor_id TEXT, key_id TEXT,
  nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT * INTO a FROM public."admin_adjustment_approvals" WHERE "id" = approval_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin adjustment approval % does not exist', approval_id; END IF;
  IF a."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'admin adjustment approval % is %, not awaiting a first approval', approval_id, a."status";
  END IF;
  IF actor_id IS NULL OR actor_id = a."userId" OR NOT public."ledger_is_active_super_admin"(actor_id) THEN
    RAISE EXCEPTION 'admin adjustment approval % needs an active SUPER_ADMIN other than the user', approval_id;
  END IF;
  PERFORM public."ledger_record_assertion"('ADMIN_ADJUSTMENT'::text, a."id", 'FIRST_APPROVAL'::text, actor_id, a."userId",
                                           a."amount"::numeric,
                                    a."caseId", a."evidence", key_id, nonce, signature);
  UPDATE public."admin_adjustment_approvals"
  SET "status" = 'FIRST_APPROVED', "firstApproverId" = actor_id, "firstApprovedAt" = CURRENT_TIMESTAMP
  WHERE "id" = a."id";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_adjustment_execute"(approval_id TEXT, actor_id TEXT, operation_id TEXT,
  wallet_transaction_id TEXT, key_id TEXT, nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT * INTO a FROM public."admin_adjustment_approvals" WHERE "id" = approval_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin adjustment approval % does not exist', approval_id; END IF;
  IF a."status" <> 'FIRST_APPROVED' THEN
    RAISE EXCEPTION 'admin adjustment approval % is %, not awaiting its second approval', approval_id, a."status";
  END IF;
  IF actor_id IS NULL OR actor_id = a."userId" OR actor_id = a."firstApproverId"
     OR NOT public."ledger_is_active_super_admin"(actor_id) OR NOT public."ledger_is_active_super_admin"(a."firstApproverId") THEN
    RAISE EXCEPTION 'admin adjustment approval % needs a second, distinct active SUPER_ADMIN and an active first approver', approval_id;
  END IF;
  PERFORM public."ledger_record_assertion"('ADMIN_ADJUSTMENT'::text, a."id", 'SECOND_APPROVAL'::text, actor_id, a."userId",
                                           a."amount"::numeric,
                                    a."caseId", a."evidence", key_id, nonce, signature);
  UPDATE public."admin_adjustment_approvals"
  SET "status" = 'EXECUTED', "secondApproverId" = actor_id, "secondApprovedAt" = CURRENT_TIMESTAMP,
      "operationId" = operation_id, "walletTransactionId" = wallet_transaction_id, "executedAt" = CURRENT_TIMESTAMP
  WHERE "id" = a."id";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_adjustment_close"(approval_id TEXT, actor_id TEXT, outcome TEXT, reason TEXT,
  key_id TEXT, nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  a RECORD;
BEGIN
  SELECT * INTO a FROM public."admin_adjustment_approvals" WHERE "id" = approval_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin adjustment approval % does not exist', approval_id; END IF;
  IF outcome NOT IN ('REJECTED', 'CANCELLED') OR a."status" NOT IN ('PENDING', 'FIRST_APPROVED') THEN
    RAISE EXCEPTION 'admin adjustment approval % is % and cannot be %', approval_id, a."status", outcome;
  END IF;
  IF actor_id IS NULL OR NOT public."ledger_is_active_super_admin"(actor_id)
     OR (outcome = 'CANCELLED' AND actor_id IS DISTINCT FROM a."createdBy") THEN
    RAISE EXCEPTION 'admin adjustment approval % can be rejected by an active SUPER_ADMIN and cancelled only by its requester', approval_id;
  END IF;
  PERFORM public."ledger_record_assertion"('ADMIN_ADJUSTMENT'::text, a."id",
    (CASE outcome WHEN 'REJECTED' THEN 'REJECT' ELSE 'CANCEL' END)::text,
    actor_id, a."userId", a."amount"::numeric, a."caseId", jsonb_build_object('evidence', a."evidence", 'closeReason', reason),
    key_id, nonce, signature);
  UPDATE public."admin_adjustment_approvals"
  SET "status" = outcome, "closedBy" = actor_id, "closedAt" = CURRENT_TIMESTAMP, "closeReason" = reason
  WHERE "id" = a."id";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- ---- Legacy review procedures (the only way the runtime role changes a
-- ---- legacy_balance_reviews row) ----
CREATE OR REPLACE FUNCTION "ledger_review_first_approval"(review_id TEXT, actor_id TEXT, proposal JSONB, key_id TEXT,
  nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  r RECORD;
  proposed NUMERIC;
BEGIN
  SELECT * INTO r FROM public."legacy_balance_reviews" WHERE "id" = review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy review % does not exist', review_id; END IF;
  IF r."status" <> 'OPEN' THEN RAISE EXCEPTION 'legacy review % is %, not OPEN', review_id, r."status"; END IF;
  IF actor_id IS NULL OR actor_id = r."userId" OR NOT public."ledger_is_active_super_admin"(actor_id) THEN
    RAISE EXCEPTION 'legacy review % needs an active SUPER_ADMIN other than its owner', review_id;
  END IF;
  IF jsonb_typeof(proposal) IS DISTINCT FROM 'object' OR jsonb_typeof(proposal -> 'amount') IS DISTINCT FROM 'number'
     OR (proposal ->> 'decision') IS NULL OR (proposal ->> 'decision') NOT IN ('WITHDRAWABLE', 'RESTRICTED') THEN
    RAISE EXCEPTION 'legacy review % needs a proposal with a numeric amount and a WITHDRAWABLE or RESTRICTED decision', review_id;
  END IF;
  proposed := (proposal ->> 'amount')::numeric;
  IF proposed <= 0 OR proposed <> trunc(proposed) OR proposed > 2000000000 THEN
    RAISE EXCEPTION 'legacy review % proposal amount % must be a positive whole number of Coins', review_id, proposed;
  END IF;
  PERFORM public."ledger_record_assertion"('LEGACY_REVIEW'::text, r."id", 'FIRST_APPROVAL'::text, actor_id, r."userId",
                                           proposed, r."id",
                                    proposal, key_id, nonce, signature);
  UPDATE public."legacy_balance_reviews"
  SET "status" = 'FIRST_APPROVED', "resolvedBy" = actor_id,
      "evidence" = COALESCE(r."evidence", '{}'::jsonb) || jsonb_build_object('proposal', proposal,
        'firstApprovedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  WHERE "id" = r."id";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_review_reopen"(review_id TEXT, actor_id TEXT, reason TEXT,
  observed_available_amount INTEGER, key_id TEXT, nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  r RECORD;
  proposed NUMERIC;
BEGIN
  SELECT * INTO r FROM public."legacy_balance_reviews" WHERE "id" = review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy review % does not exist', review_id; END IF;
  IF r."status" <> 'FIRST_APPROVED' THEN RAISE EXCEPTION 'legacy review % is %, not FIRST_APPROVED', review_id, r."status"; END IF;
  IF actor_id IS NULL OR actor_id = r."userId" OR NOT public."ledger_is_active_super_admin"(actor_id) THEN
    RAISE EXCEPTION 'legacy review % can be reopened only by an active SUPER_ADMIN other than its owner', review_id;
  END IF;
  proposed := COALESCE((r."evidence" -> 'proposal' ->> 'amount')::numeric, 0);
  PERFORM public."ledger_record_assertion"('LEGACY_REVIEW'::text, r."id", 'REOPEN'::text, actor_id, r."userId", proposed, r."id",
    jsonb_build_object('reason', reason, 'observedAvailableAmount', observed_available_amount), key_id, nonce, signature);
  UPDATE public."legacy_balance_reviews"
  SET "status" = 'OPEN', "resolvedBy" = NULL,
      "evidence" = COALESCE(r."evidence", '{}'::jsonb) || jsonb_build_object(
        'proposal', NULL, 'firstApprovedAt', NULL,
        'invalidatedApprovals', COALESCE(r."evidence" -> 'invalidatedApprovals', '[]'::jsonb) || jsonb_build_array(
          jsonb_strip_nulls(jsonb_build_object(
            'firstApproverId', r."resolvedBy", 'proposal', COALESCE(r."evidence" -> 'proposal', 'null'::jsonb),
            'invalidatedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'reason', reason, 'observedAvailableAmount', observed_available_amount))))
  WHERE "id" = r."id";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "ledger_review_resolve"(review_id TEXT, actor_id TEXT, operation_id TEXT, key_id TEXT,
  nonce TEXT, signature TEXT)
RETURNS void AS $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM public."legacy_balance_reviews" WHERE "id" = review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy review % does not exist', review_id; END IF;
  IF r."status" <> 'FIRST_APPROVED' THEN RAISE EXCEPTION 'legacy review % is %, not FIRST_APPROVED', review_id, r."status"; END IF;
  IF actor_id IS NULL OR actor_id = r."userId" OR actor_id = r."resolvedBy"
     OR NOT public."ledger_is_active_super_admin"(actor_id) OR NOT public."ledger_is_active_super_admin"(r."resolvedBy") THEN
    RAISE EXCEPTION 'legacy review % needs a second, distinct active SUPER_ADMIN and an active first approver', review_id;
  END IF;
  PERFORM public."ledger_record_assertion"('LEGACY_REVIEW'::text, r."id", 'SECOND_APPROVAL'::text, actor_id, r."userId",
    (r."evidence" -> 'proposal' ->> 'amount')::numeric, r."id", r."evidence" -> 'proposal', key_id, nonce, signature);
  UPDATE public."legacy_balance_reviews"
  SET "status" = 'RESOLVED', "secondApproverId" = actor_id, "resolutionOperationId" = operation_id,
      "resolvedAt" = CURRENT_TIMESTAMP
  WHERE "id" = r."id";
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

-- The invariant check of a gate release locks the economy in SHARE mode.
-- The runtime role holds no UPDATE or DELETE on append-only history, which
-- LOCK ... SHARE requires, so the lock is taken here, as the owner, for the
-- caller's transaction.
CREATE OR REPLACE FUNCTION "ledger_lock_economy_for_invariant_check"()
RETURNS void AS $$
BEGIN
  LOCK TABLE public."wallets", public."wallet_transactions", public."coin_provenance", public."coin_lot_entries",
    public."economic_operations", public."coin_ledger_accounts", public."legacy_balance_reviews",
    public."withdrawal_holds", public."country_jurisdictions", public."country_casino_policies",
    public."game_sessions" IN SHARE MODE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;


-- The documented runtime role of the API and the worker: data access only,
-- separate from the owner that runs migrations. Run as the owner after every
-- deploy (idempotent):  SELECT "ledger_apply_runtime_grants"('<runtime role>');
-- It gives ordinary data access to every table, then takes back what the
-- runtime never needs: rewriting or deleting financial history, deleting
-- financial state, writing approvals or their assertions directly, changing
-- legacy reviews other than through the signed procedures, writing immutable
-- rules, the signing key, migration history, and any user's role or status.
CREATE OR REPLACE FUNCTION "ledger_apply_runtime_grants"(runtime_role TEXT)
RETURNS void AS $$
DECLARE
  -- Named, not current_schema(): with the fixed search path that is pg_catalog.
  schema_name TEXT := 'public';
  t TEXT;
  updatable_user_columns TEXT;
  trusted TEXT;
  holders TEXT;
  planted TEXT;
BEGIN
  IF runtime_role IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role) THEN
    RAISE EXCEPTION 'runtime role % does not exist', runtime_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = runtime_role AND (r.rolsuper OR r.rolbypassrls)) THEN
    RAISE EXCEPTION 'runtime role % must be neither a superuser nor exempt from row security', runtime_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_roles r ON r.oid = c.relowner
             WHERE n.nspname = schema_name AND r.rolname = runtime_role)
     OR pg_has_role(runtime_role, (SELECT c.relowner FROM pg_class c WHERE c.oid = to_regclass(format('%I.%I', schema_name, 'economic_operations'))), 'MEMBER') THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
      MESSAGE = format('runtime role %s must neither own nor be a member of the owner of the schema''s tables', runtime_role);
  END IF;
  -- The approval functions run as the owner and resolve names in pg_catalog,
  -- this schema and pgcrypto's; other functions that run as the owner resolve
  -- names in this schema. A role that could create objects in any of them
  -- could plant a function or operator there that runs with the owner's
  -- privileges, so the runtime role may create nothing in them: not directly,
  -- not through PUBLIC, not as or through any role it belongs to (inherited
  -- or by SET ROLE, the schema's owner included), and it may own nothing in
  -- them that it could have planted before. What the owner can revoke is
  -- revoked; anything else stops here (SQLSTATE 42501), changing nothing.
  FOR trusted IN
    SELECT DISTINCT s FROM unnest(ARRAY['pg_catalog', schema_name,
      (SELECT n.nspname::text FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
       WHERE e.extname = 'pgcrypto')]) AS s
    WHERE s IS NOT NULL
  LOOP
    IF trusted <> 'pg_catalog' THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', trusted);
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', trusted, runtime_role);
    END IF;
    SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g.rolname::text END, ', ')
      INTO holders
    FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
    WHERE n.nspname = trusted AND a.privilege_type = 'CREATE'
      AND (a.grantee = 0 OR pg_has_role(runtime_role, a.grantee, 'MEMBER'));
    -- The owner's CREATE is implicit (not in the ACL) and has_schema_privilege
    -- ignores a membership usable only by SET ROLE: check the owner directly.
    IF holders IS NULL AND pg_has_role(runtime_role, (SELECT n.nspowner FROM pg_namespace n WHERE n.nspname = trusted), 'MEMBER') THEN
      SELECT r.rolname::text INTO holders FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = trusted;
    END IF;
    IF holders IS NOT NULL OR has_schema_privilege(runtime_role, trusted, 'CREATE') THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s can still create objects in schema %s, through %s: functions that run as the owner resolve names there. Revoke that CREATE privilege (or that membership) as its grantor, then run this again',
          runtime_role, trusted, COALESCE(holders, runtime_role));
    END IF;
    SELECT string_agg(DISTINCT o.kind || ' ' || o.name, ', ') INTO planted
    FROM (
      SELECT 'function' AS kind, p.oid::regprocedure::text AS name, p.proowner AS owner, p.pronamespace AS ns FROM pg_proc p
      UNION ALL SELECT 'operator', o.oid::regoperator::text, o.oprowner, o.oprnamespace FROM pg_operator o
      UNION ALL SELECT 'type', t.oid::regtype::text, t.typowner, t.typnamespace FROM pg_type t
      UNION ALL SELECT 'relation', c.oid::regclass::text, c.relowner, c.relnamespace FROM pg_class c
      UNION ALL SELECT 'collation', co.collname::text, co.collowner, co.collnamespace FROM pg_collation co
      UNION ALL SELECT 'conversion', cv.conname::text, cv.conowner, cv.connamespace FROM pg_conversion cv
      UNION ALL SELECT 'operator class', oc.opcname::text, oc.opcowner, oc.opcnamespace FROM pg_opclass oc
      UNION ALL SELECT 'operator family', fam.opfname::text, fam.opfowner, fam.opfnamespace FROM pg_opfamily fam
      UNION ALL SELECT 'text search configuration', tc.cfgname::text, tc.cfgowner, tc.cfgnamespace FROM pg_ts_config tc
      UNION ALL SELECT 'text search dictionary', td.dictname::text, td.dictowner, td.dictnamespace FROM pg_ts_dict td
    ) o JOIN pg_namespace n ON n.oid = o.ns
    WHERE n.nspname = trusted AND pg_has_role(runtime_role, o.owner, 'MEMBER');
    IF planted IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = format('runtime role %s owns objects in schema %s: %s. Functions that run as the owner could pick them up; check what they are, drop them (or reassign them to the owner), then run this again',
          runtime_role, trusted, planted);
    END IF;
  END LOOP;

  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', schema_name, runtime_role);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', schema_name, runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, runtime_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, runtime_role);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, runtime_role);

  -- Append-only financial history and committed records: insert and read.
  FOREACH t IN ARRAY ARRAY['economic_operations', 'coin_lot_entries', 'wallet_transactions',
                           'agent_order_settlements', 'game_sessions'] LOOP
    IF to_regclass(format('%I.%I', schema_name, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
    END IF;
  END LOOP;
  -- Financial state is never deleted.
  FOREACH t IN ARRAY ARRAY['wallets', 'coin_provenance', 'coin_ledger_accounts'] LOOP
    IF to_regclass(format('%I.%I', schema_name, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
    END IF;
  END LOOP;
  -- Approvals and their signed assertions: only through the procedures.
  FOREACH t IN ARRAY ARRAY['admin_adjustment_approvals', 'ledger_approval_assertions'] LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, t, runtime_role);
  END LOOP;
  -- Legacy reviews: the ledger opens them; they change only through the
  -- signed procedures.
  EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'legacy_balance_reviews', runtime_role);
  -- Immutable rules versions.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'game_rules', runtime_role);
  -- The signing key, and the migration history (which the preflight reads).
  EXECUTE format('REVOKE ALL ON %I.%I FROM %I', schema_name, 'ledger_approval_keys', runtime_role);
  IF to_regclass(format('%I.%I', schema_name, '_prisma_migrations')) IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON %I.%I FROM %I', schema_name, '_prisma_migrations', runtime_role);
  END IF;
  -- Users: inserted (users_privilege_guard admits only plain USER accounts
  -- from anyone but the owner), updated in every column but the id, the
  -- role and the status, never deleted.
  SELECT string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
    INTO updatable_user_columns
  FROM information_schema.columns c
  WHERE c.table_schema = schema_name AND c.table_name = 'users' AND c.column_name NOT IN ('id', 'role', 'status');
  EXECUTE format('REVOKE UPDATE, DELETE ON %I.%I FROM %I', schema_name, 'users', runtime_role);
  EXECUTE format('GRANT UPDATE (%s) ON %I.%I TO %I', updatable_user_columns, schema_name, 'users', runtime_role);
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
REVOKE EXECUTE ON FUNCTION "ledger_apply_runtime_grants"(TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION "legacy_resolution_violation"(operation_id TEXT, check_approvers_active BOOLEAN)
RETURNS TEXT AS $$
DECLARE
  op RECORD;
  review RECORD;
  lot RECORD;
  proposal JSONB;
  approved NUMERIC;
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
  IF approved <> trunc(approved) THEN
    RETURN format('legacy review %s approved a fractional amount', review."id");
  END IF;
  -- Both approvals are signed assertions of the API for exactly these terms
  -- (see ledger_approval_assertions): the runtime role cannot forge them.
  IF NOT EXISTS (
       SELECT 1 FROM "ledger_approval_assertions" a
       WHERE a."subjectType" = 'LEGACY_REVIEW' AND a."subjectId" = review."id" AND a."action" = 'FIRST_APPROVAL'
         AND a."actorId" = review."resolvedBy" AND a."userId" = review."userId" AND a."amount" = approved
         AND a."caseId" = review."id" AND a."evidenceDigest" = "ledger_evidence_digest"(proposal)
         AND "ledger_assertion_valid"(a))
     OR NOT EXISTS (
       SELECT 1 FROM "ledger_approval_assertions" a
       WHERE a."subjectType" = 'LEGACY_REVIEW' AND a."subjectId" = review."id" AND a."action" = 'SECOND_APPROVAL'
         AND a."actorId" = review."secondApproverId" AND a."userId" = review."userId" AND a."amount" = approved
         AND a."caseId" = review."id" AND a."evidenceDigest" = "ledger_evidence_digest"(proposal)
         AND "ledger_assertion_valid"(a)) THEN
    RETURN format('legacy resolution %s is not backed by signed first and second approvals of review %s', op."id", review."id");
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
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
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
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
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
  -- The request and both approvals are signed assertions of the API for
  -- exactly these terms (see ledger_approval_assertions).
  IF (SELECT count(DISTINCT a."action") FROM "ledger_approval_assertions" a
      WHERE a."subjectType" = 'ADMIN_ADJUSTMENT' AND a."subjectId" = approval."id"
        AND a."userId" = approval."userId" AND a."amount" = approval."amount" AND a."caseId" = approval."caseId"
        AND a."evidenceDigest" = "ledger_evidence_digest"(approval."evidence")
        AND ((a."action" = 'REQUEST' AND a."actorId" = approval."createdBy")
          OR (a."action" = 'FIRST_APPROVAL' AND a."actorId" = approval."firstApproverId")
          OR (a."action" = 'SECOND_APPROVAL' AND a."actorId" = approval."secondApproverId"))
        AND "ledger_assertion_valid"(a)) <> 3 THEN
    RETURN format('admin adjustment %s is not backed by a signed request, first approval and second approval', op."id");
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

  -- The backing wallet transaction is this adjustment's own: a succeeded
  -- Coin credit or debit of the user, of exactly the amount, recorded for
  -- this case (reference ADMIN / the case ID), and named by no other
  -- operation, purchase settlement or lot. An existing purchase credit, a
  -- reward or a transaction of another case can never back it.
  IF cardinality(op."walletTransactionIds") IS DISTINCT FROM 1
     OR op."walletTransactionIds"[1] IS DISTINCT FROM approval."walletTransactionId"
     OR NOT EXISTS (
       SELECT 1 FROM "wallet_transactions" w
       WHERE w."id" = approval."walletTransactionId" AND w."userId" = op."userId"
         AND w."currency"::text = 'COINS'
         AND w."type"::text = CASE WHEN approval."amount" > 0 THEN 'COIN_CREDIT' ELSE 'COIN_DEBIT' END
         AND w."ledgerType"::text = CASE WHEN approval."amount" > 0 THEN 'CREDIT' ELSE 'DEBIT' END
         AND w."referenceType"::text = 'ADMIN' AND w."referenceId" = approval."caseId"
         AND w."status"::text = 'SUCCEEDED' AND w."amount" = abs(approval."amount"))
     OR EXISTS (
       SELECT 1 FROM "economic_operations" other
       WHERE other."id" <> op."id" AND approval."walletTransactionId" = ANY (other."walletTransactionIds"))
     OR EXISTS (
       SELECT 1 FROM "agent_order_settlements" s WHERE s."walletTransactionId" = approval."walletTransactionId")
     OR EXISTS (
       SELECT 1 FROM "coin_provenance" l
       WHERE l."walletTransactionId" = approval."walletTransactionId"
         AND l."sourceOperationId" IS DISTINCT FROM op."id") THEN
    RETURN format('admin adjustment %s is not backed by the approval''s own Coin adjustment wallet transaction', op."id");
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
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;
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
