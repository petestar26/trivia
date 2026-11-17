-- Held-deposit recovery. Local candidate only: no grants, no activation.
-- safetyHold is NEVER cleared. A held order may reach a terminal state only
-- through one order-specific adjudication row, authorised by the database and
-- usable only inside the transaction that inserted it. Every outcome and the
-- admission exception ship DISABLED; only the table owner can enable them.
BEGIN;

-- ── Policy: a single owner-controlled row; everything off by default ────────
CREATE TABLE public.held_deposit_recovery_policy (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  "unpaidReleaseEnabled" boolean NOT NULL DEFAULT false,
  "coinCreditEnabled" boolean NOT NULL DEFAULT false,
  "externalReturnEnabled" boolean NOT NULL DEFAULT false,
  "admissionExceptionMax" integer NOT NULL DEFAULT 0 CHECK ("admissionExceptionMax" BETWEEN 0 AND 3),
  "approvedBy" text, "approvalReference" text,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (NOT ("unpaidReleaseEnabled" OR "coinCreditEnabled" OR "externalReturnEnabled" OR "admissionExceptionMax" > 0)
    OR (length(btrim(coalesce("approvedBy",''))) > 0 AND length(btrim(coalesce("approvalReference",''))) > 0))
);
INSERT INTO public.held_deposit_recovery_policy DEFAULT VALUES;
CREATE FUNCTION public.held_deposit_policy_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'Held-deposit recovery policy is a single permanent row'; END IF;
  IF current_user <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
      WHERE c.oid='public.held_deposit_recovery_policy'::regclass) THEN
    RAISE EXCEPTION 'Held-deposit recovery policy requires the database owner';
  END IF;
  NEW."updatedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
CREATE TRIGGER held_deposit_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.held_deposit_recovery_policy
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_policy_guard();
CREATE TRIGGER held_deposit_policy_no_truncate BEFORE TRUNCATE ON public.held_deposit_recovery_policy
FOR EACH STATEMENT EXECUTE FUNCTION public.held_deposit_policy_guard();

-- ── Cases: one per held order; versioned for stale-decision detection ───────
CREATE TABLE public.held_deposit_cases (
  "orderId" text PRIMARY KEY REFERENCES public.agent_orders(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','RESOLVED')),
  classification text NOT NULL DEFAULT 'UNREVIEWED' CHECK (classification IN
    ('UNREVIEWED','PAYMENT_CLAIMED_UNKNOWN','VERIFIED_UNPAID','VERIFIED_PAYMENT_RECEIVED','VERIFIED_EXTERNAL_RETURN')),
  "memberDeclaration" text CHECK ("memberDeclaration" IN ('NOT_PAID','PAID')),
  "memberDeclaredAt" timestamp(3),
  "assignedAdminId" text REFERENCES public.users(id) ON DELETE RESTRICT,
  "assignedAt" timestamp(3),
  version integer NOT NULL DEFAULT 1,
  "openedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" timestamp(3),
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((status='ASSIGNED') = ("assignedAdminId" IS NOT NULL AND status<>'RESOLVED') OR status='RESOLVED'),
  CHECK ((status='RESOLVED') = (classification LIKE 'VERIFIED_%')),
  CHECK (("memberDeclaration" IS NULL) = ("memberDeclaredAt" IS NULL))
);
CREATE INDEX held_deposit_cases_queue ON public.held_deposit_cases (status, "openedAt");

-- ── Immutable case trail (sensitive: reasons and evidence summaries) ────────
CREATE TABLE public.held_deposit_case_events (
  id text PRIMARY KEY,
  "orderId" text NOT NULL REFERENCES public.held_deposit_cases("orderId") ON DELETE RESTRICT,
  "actorId" text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('OPENED','CLAIMED','RELEASED','CLASSIFIED','MEMBER_DECLARED','ADJUDICATED')),
  "caseVersion" integer NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX held_deposit_case_events_order ON public.held_deposit_case_events ("orderId", "createdAt");

-- ── Adjudications: at most one outcome per order, ever ──────────────────────
CREATE TABLE public.held_deposit_adjudications (
  "orderId" text PRIMARY KEY REFERENCES public.held_deposit_cases("orderId") ON DELETE RESTRICT,
  id text NOT NULL UNIQUE,
  outcome text NOT NULL CHECK (outcome IN ('VERIFIED_UNPAID','VERIFIED_PAYMENT_RECEIVED','VERIFIED_EXTERNAL_RETURN')),
  "adminId" text NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  "idempotencyKey" text NOT NULL CHECK (length("idempotencyKey") BETWEEN 8 AND 128),
  "requestHash" text NOT NULL CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  "stepUpId" text NOT NULL UNIQUE,
  "caseVersion" integer NOT NULL,
  "orderStatusBefore" text NOT NULL CHECK ("orderStatusBefore" IN ('CREATED','PAYMENT_SUBMITTED','DISPUTE')),
  "reservationId" text NOT NULL,
  "coinAmount" integer NOT NULL CHECK ("coinAmount" > 0),
  "fiatAmount" integer NOT NULL CHECK ("fiatAmount" > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 4000),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence) BETWEEN 1 AND 20),
  "verifiedPaymentReference" text, "verifiedAmount" integer, "verifiedPaidAt" timestamp(3),
  "returnReference" text, "returnedAmount" integer, "returnedAt" timestamp(3),
  "authorizedTxid" bigint NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("adminId", "idempotencyKey"),
  CHECK (CASE outcome
    WHEN 'VERIFIED_UNPAID' THEN "verifiedPaymentReference" IS NULL AND "verifiedAmount" IS NULL AND "verifiedPaidAt" IS NULL
      AND "returnReference" IS NULL AND "returnedAmount" IS NULL AND "returnedAt" IS NULL AND "orderStatusBefore"='CREATED'
    WHEN 'VERIFIED_PAYMENT_RECEIVED' THEN "verifiedPaymentReference" IS NOT NULL AND "verifiedAmount" = "fiatAmount"
      AND "verifiedPaidAt" IS NOT NULL AND "returnReference" IS NULL AND "returnedAmount" IS NULL AND "returnedAt" IS NULL
    ELSE "verifiedPaymentReference" IS NOT NULL AND "verifiedAmount" > 0 AND "verifiedPaidAt" IS NOT NULL
      AND "returnReference" IS NOT NULL AND "returnReference" <> "verifiedPaymentReference"
      AND "returnedAmount" = "verifiedAmount" AND "returnedAt" IS NOT NULL AND "returnedAt" >= "verifiedPaidAt" END)
);

-- One transfer reference may back one recovery record across BOTH recovery
-- workflows (held adjudications and late-payment cases), per payment method.
CREATE TABLE public.held_deposit_reference_claims (
  "methodId" text NOT NULL, reference text NOT NULL CHECK (reference = upper(btrim(reference)) AND length(reference) BETWEEN 3 AND 128),
  "orderId" text NOT NULL REFERENCES public.held_deposit_adjudications("orderId") ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('PAYMENT','RETURN')),
  PRIMARY KEY ("methodId", reference), UNIQUE ("orderId", kind)
);
CREATE FUNCTION public.held_deposit_reference_exclusive() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  -- Same advisory key as the late-payment service, so both workflows serialise.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'recovery-reference:' || NEW."methodId" || ':' || NEW.reference, 0));
  IF TG_TABLE_NAME = 'held_deposit_reference_claims' THEN
    IF EXISTS (SELECT 1 FROM public.late_payment_reference_claims l
        WHERE l."methodId"=NEW."methodId" AND l.reference=NEW.reference) THEN
      RAISE EXCEPTION 'Transfer reference is already recorded in a recovery case';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.held_deposit_reference_claims h
      WHERE h."methodId"=NEW."methodId" AND h.reference=NEW.reference) THEN
    RAISE EXCEPTION 'Transfer reference is already recorded in a held-deposit adjudication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER held_deposit_reference_exclusive BEFORE INSERT ON public.held_deposit_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_reference_exclusive();
CREATE TRIGGER held_deposit_reference_exclusive BEFORE INSERT ON public.late_payment_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_reference_exclusive();

-- ── Append-only protection ──────────────────────────────────────────────────
CREATE FUNCTION public.held_deposit_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Held-deposit recovery records are immutable'; END $$;
CREATE TRIGGER held_deposit_event_immutable BEFORE UPDATE OR DELETE ON public.held_deposit_case_events
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_event_no_truncate BEFORE TRUNCATE ON public.held_deposit_case_events
FOR EACH STATEMENT EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_adjudication_immutable BEFORE UPDATE OR DELETE ON public.held_deposit_adjudications
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_adjudication_no_truncate BEFORE TRUNCATE ON public.held_deposit_adjudications
FOR EACH STATEMENT EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_claim_immutable BEFORE UPDATE OR DELETE ON public.held_deposit_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_claim_no_truncate BEFORE TRUNCATE ON public.held_deposit_reference_claims
FOR EACH STATEMENT EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_case_no_delete BEFORE DELETE ON public.held_deposit_cases
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_immutable();
CREATE TRIGGER held_deposit_case_no_truncate BEFORE TRUNCATE ON public.held_deposit_cases
FOR EACH STATEMENT EXECUTE FUNCTION public.held_deposit_immutable();

-- Is this exact effect authorised for this order by an adjudication inserted in
-- THIS transaction? A committed adjudication can never authorise anything again.
CREATE FUNCTION public.held_deposit_authorized(p_order text, p_effect text) RETURNS boolean LANGUAGE sql VOLATILE
SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.held_deposit_adjudications j
    WHERE j."orderId" = p_order AND j."authorizedTxid" = pg_catalog.txid_current()
      AND CASE p_effect
        WHEN 'ORDER_COMPLETED' THEN j.outcome = 'VERIFIED_PAYMENT_RECEIVED'
        WHEN 'RESERVATION_CONSUMED' THEN j.outcome = 'VERIFIED_PAYMENT_RECEIVED'
        WHEN 'SETTLEMENT' THEN j.outcome = 'VERIFIED_PAYMENT_RECEIVED'
        WHEN 'ORDER_CANCELLED' THEN j.outcome IN ('VERIFIED_UNPAID','VERIFIED_EXTERNAL_RETURN')
        WHEN 'RESERVATION_RELEASED' THEN j.outcome IN ('VERIFIED_UNPAID','VERIFIED_EXTERNAL_RETURN')
        WHEN 'DISPUTE_CLOSED' THEN true
        WHEN 'CASE_RESOLVED' THEN true
        ELSE false END)
$$;

CREATE FUNCTION public.held_deposit_case_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
DECLARE held boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o."safetyHold" INTO held FROM public.agent_orders o WHERE o.id = NEW."orderId" FOR SHARE;
    IF held IS NOT TRUE THEN RAISE EXCEPTION 'A recovery case requires an order on safety hold'; END IF;
    IF NEW.status <> 'OPEN' OR NEW.classification <> 'UNREVIEWED' OR NEW."assignedAdminId" IS NOT NULL
       OR NEW."memberDeclaration" IS NOT NULL THEN
      RAISE EXCEPTION 'A recovery case must open unassigned and unreviewed';
    END IF;
    NEW.version := 1; NEW."resolvedAt" := NULL;
    RETURN NEW;
  END IF;
  IF OLD.status = 'RESOLVED' THEN RAISE EXCEPTION 'A resolved recovery case is final'; END IF;
  IF NEW."orderId" IS DISTINCT FROM OLD."orderId" OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'Recovery case identity is immutable';
  END IF;
  -- A member may strengthen "not paid" into "paid"; never the reverse.
  IF OLD."memberDeclaration" IS NOT NULL AND NEW."memberDeclaration" IS DISTINCT FROM OLD."memberDeclaration"
     AND NOT (OLD."memberDeclaration" = 'NOT_PAID' AND NEW."memberDeclaration" = 'PAID') THEN
    RAISE EXCEPTION 'A payment declaration cannot be withdrawn';
  END IF;
  IF NEW.status = 'RESOLVED' THEN
    IF NOT public.held_deposit_authorized(NEW."orderId", 'CASE_RESOLVED')
       OR NOT EXISTS (SELECT 1 FROM public.held_deposit_adjudications j
            WHERE j."orderId" = NEW."orderId" AND j.outcome = NEW.classification) THEN
      RAISE EXCEPTION 'A recovery case is resolved only by its adjudication';
    END IF;
    NEW."resolvedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  END IF;
  NEW.version := OLD.version + 1;
  NEW."updatedAt" := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
  RETURN NEW;
END $$;
CREATE TRIGGER held_deposit_case_guard BEFORE INSERT OR UPDATE ON public.held_deposit_cases
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_case_guard();

-- ── Database-enforced authorisation of one adjudication ─────────────────────
-- Lock order: users, receiving account, order, case (account before order).
CREATE FUNCTION public.held_deposit_adjudication_authorize() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
DECLARE o public.agent_orders; c public.held_deposit_cases; p public.held_deposit_recovery_policy;
  admin_role text; admin_status text; agent_user text; reservation_status text; reservation_amount integer;
  now_utc timestamp := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'); enabled boolean := false;
BEGIN
  SELECT * INTO p FROM public.held_deposit_recovery_policy;
  IF FOUND THEN
    IF NEW.outcome = 'VERIFIED_UNPAID' THEN enabled := p."unpaidReleaseEnabled";
    ELSIF NEW.outcome = 'VERIFIED_PAYMENT_RECEIVED' THEN enabled := p."coinCreditEnabled";
    ELSIF NEW.outcome = 'VERIFIED_EXTERNAL_RETURN' THEN enabled := p."externalReturnEnabled"; END IF;
  END IF;
  IF enabled IS NOT TRUE THEN
    RAISE EXCEPTION 'This held-deposit outcome is not enabled by approved policy';
  END IF;
  SELECT u.role::text, u.status::text INTO admin_role, admin_status
    FROM public.users u WHERE u.id = NEW."adminId" FOR SHARE;
  IF admin_role IS DISTINCT FROM 'SUPER_ADMIN' OR admin_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'An active main administrator is required';
  END IF;
  PERFORM 1 FROM public.agent_payment_accounts a
    WHERE a.id = (SELECT x."paymentAccountId" FROM public.agent_orders x WHERE x.id = NEW."orderId") FOR SHARE;
  SELECT * INTO o FROM public.agent_orders WHERE id = NEW."orderId" FOR UPDATE;
  IF NOT FOUND OR NOT o."safetyHold" THEN RAISE EXCEPTION 'Adjudication requires an order on safety hold'; END IF;
  SELECT g."userId" INTO agent_user FROM public.agents g WHERE g.id = o."agentId";
  IF NEW."adminId" = o."userId" OR NEW."adminId" IS NOT DISTINCT FROM agent_user THEN
    RAISE EXCEPTION 'A party to the order cannot adjudicate it';
  END IF;
  IF o.status::text NOT IN ('CREATED','PAYMENT_SUBMITTED','DISPUTE') OR o.status::text <> NEW."orderStatusBefore" THEN
    RAISE EXCEPTION 'Order state changed; review the case again';
  END IF;
  IF NEW."coinAmount" <> o."coinAmount" OR NEW."fiatAmount" <> o."fiatAmount" THEN
    RAISE EXCEPTION 'Adjudication must carry the order''s immutable amounts';
  END IF;
  SELECT * INTO c FROM public.held_deposit_cases WHERE "orderId" = NEW."orderId" FOR UPDATE;
  IF NOT FOUND OR c.status <> 'ASSIGNED' OR c."assignedAdminId" IS DISTINCT FROM NEW."adminId" THEN
    RAISE EXCEPTION 'Only the assigned main administrator may adjudicate this case';
  END IF;
  IF c.version <> NEW."caseVersion" THEN RAISE EXCEPTION 'Case changed; review the case again'; END IF;
  SELECT r.status::text, r.amount INTO reservation_status, reservation_amount
    FROM public.agent_reservations r WHERE r.id = NEW."reservationId" AND r."orderId" = NEW."orderId" FOR UPDATE;
  IF reservation_status IS DISTINCT FROM 'ACTIVE' OR reservation_amount IS DISTINCT FROM o."coinAmount" THEN
    RAISE EXCEPTION 'The order''s reservation is not active';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_order_settlements s WHERE s."orderId" = NEW."orderId") THEN
    RAISE EXCEPTION 'Order is already settled';
  END IF;
  -- Fresh, single-use, case-specific confirmation by this administrator.
  IF NOT EXISTS (SELECT 1 FROM public.step_up_verifications s
      WHERE s.id = NEW."stepUpId" AND s."userId" = NEW."adminId"
        AND s.purpose = 'HELD_DEPOSIT_ADJUDICATION:' || NEW."orderId"
        AND s."consumedAt" IS NOT NULL AND s."consumedAt" <= s."expiresAt"
        AND s."consumedAt" > now_utc - interval '5 minutes') THEN
    RAISE EXCEPTION 'A fresh case-specific confirmation is required';
  END IF;
  IF NEW.outcome = 'VERIFIED_UNPAID' THEN
    -- Never inferred from silence: the member must have positively declared it,
    -- and nothing on record may suggest that money moved.
    IF c."memberDeclaration" IS DISTINCT FROM 'NOT_PAID' OR o."paymentSubmittedAt" IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.payment_evidence e WHERE e."orderId" = o.id)
       OR EXISTS (SELECT 1 FROM public.disputes d WHERE d."orderId" = o.id)
       OR EXISTS (SELECT 1 FROM public.late_payment_cases l WHERE l."orderId" = o.id) THEN
      RAISE EXCEPTION 'Non-payment is not verified for this order';
    END IF;
  ELSIF NEW."verifiedPaidAt" > now_utc OR NEW."verifiedPaidAt" < o."createdAt"
     OR (NEW."returnedAt" IS NOT NULL AND NEW."returnedAt" > now_utc) THEN
    RAISE EXCEPTION 'Verified transfer times must follow the order and cannot be in the future';
  END IF;
  NEW."authorizedTxid" := pg_catalog.txid_current();
  NEW."createdAt" := now_utc;
  RETURN NEW;
END $$;
CREATE TRIGGER held_deposit_adjudication_authorize BEFORE INSERT ON public.held_deposit_adjudications
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_adjudication_authorize();

-- At commit an adjudication and its complete effect exist together or not at all.
CREATE FUNCTION public.held_deposit_adjudication_complete() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
DECLARE o public.agent_orders; credited boolean := NEW.outcome = 'VERIFIED_PAYMENT_RECEIVED';
  order_final text := 'CANCELLED'; reservation_final text := 'RELEASED';
BEGIN
  IF credited THEN order_final := 'COMPLETED'; reservation_final := 'CONSUMED'; END IF;
  SELECT * INTO o FROM public.agent_orders WHERE id = NEW."orderId";
  IF NOT o."safetyHold" OR o.status::text <> order_final THEN
    RAISE EXCEPTION 'Adjudication committed without its order outcome';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_reservations r WHERE r.id = NEW."reservationId" AND r."orderId" = o.id
      AND r.status::text = reservation_final) THEN
    RAISE EXCEPTION 'Adjudication committed without its reservation outcome';
  END IF;
  IF credited <> EXISTS (SELECT 1 FROM public.agent_order_settlements s WHERE s."orderId" = o.id
      AND s."reservationId" = NEW."reservationId" AND s."coinAmount" = NEW."coinAmount" AND s."releasedBy" = NEW."adminId") THEN
    RAISE EXCEPTION 'Adjudication and settlement witness disagree';
  END IF;
  IF NOT credited AND EXISTS (SELECT 1 FROM public.agent_order_settlements s WHERE s."orderId" = o.id) THEN
    RAISE EXCEPTION 'A non-credit adjudication cannot coexist with a settlement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.held_deposit_cases c WHERE c."orderId" = o.id
      AND c.status = 'RESOLVED' AND c.classification = NEW.outcome) THEN
    RAISE EXCEPTION 'Adjudication committed without resolving its case';
  END IF;
  IF (NEW."verifiedPaymentReference" IS NOT NULL) <> EXISTS (SELECT 1 FROM public.held_deposit_reference_claims k
      WHERE k."orderId" = o.id AND k.kind = 'PAYMENT' AND k."methodId" = o."paymentMethodDefId"
        AND k.reference = NEW."verifiedPaymentReference")
     OR (NEW."returnReference" IS NOT NULL) <> EXISTS (SELECT 1 FROM public.held_deposit_reference_claims k
      WHERE k."orderId" = o.id AND k.kind = 'RETURN' AND k."methodId" = o."paymentMethodDefId"
        AND k.reference = NEW."returnReference") THEN
    RAISE EXCEPTION 'Adjudication committed without its unique transfer references';
  END IF;
  IF EXISTS (SELECT 1 FROM public.disputes d WHERE d."orderId" = o.id AND d.status::text <> 'RESOLVED') THEN
    RAISE EXCEPTION 'Adjudication committed with an open dispute';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.held_deposit_case_events e WHERE e."orderId" = o.id AND e.kind = 'ADJUDICATED'
      AND e."actorId" = NEW."adminId") THEN
    RAISE EXCEPTION 'Adjudication committed without its audit event';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER held_deposit_adjudication_complete AFTER INSERT ON public.held_deposit_adjudications
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.held_deposit_adjudication_complete();
-- Claims may only be written with their adjudication, never afterwards.
CREATE FUNCTION public.held_deposit_claim_guard() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.held_deposit_adjudications j WHERE j."orderId" = NEW."orderId"
      AND j."authorizedTxid" = pg_catalog.txid_current()
      AND ((NEW.kind = 'PAYMENT' AND NEW.reference = j."verifiedPaymentReference")
        OR (NEW.kind = 'RETURN' AND NEW.reference = j."returnReference"))) THEN
    RAISE EXCEPTION 'A transfer reference is claimed only by its adjudication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER held_deposit_claim_guard BEFORE INSERT ON public.held_deposit_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_claim_guard();
-- An adjudicated order has its final answer; no parallel late-payment record.
CREATE FUNCTION public.held_deposit_late_payment_exclusive() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.held_deposit_adjudications j WHERE j."orderId" = NEW."orderId") THEN
    RAISE EXCEPTION 'This deposit already has a held-deposit adjudication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER held_deposit_late_payment_exclusive BEFORE INSERT ON public.late_payment_cases
FOR EACH ROW EXECUTE FUNCTION public.held_deposit_late_payment_exclusive();

-- ── Existing guards, unchanged except for the single authorised exception ───
CREATE OR REPLACE FUNCTION public.deposit_order_destination() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.agent_payment_accounts; effect text := 'NONE';
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO a FROM public.agent_payment_accounts WHERE id=NEW."paymentAccountId" FOR SHARE;
    IF FOUND THEN
      IF a.status <> 'APPROVED' OR a."safetyHold" OR
         ROW(a."agentId",a."countryId",a."methodDefId",a."accountDetails") IS DISTINCT FROM
         ROW(NEW."agentId",NEW."countryId",NEW."paymentMethodDefId",NEW."paymentSnapshot") THEN
        RAISE EXCEPTION 'Receiving destination is not approved for new orders';
      END IF;
      NEW."paymentAccountRevision" := a."approvedRevision";
    ELSE
      RAISE EXCEPTION 'Receiving account is missing';
    END IF;
  ELSE
    IF ROW(NEW."paymentAccountId",NEW."paymentAccountRevision",NEW."paymentSnapshot",NEW."countryId",NEW."paymentMethodDefId",NEW."agentId")
       IS DISTINCT FROM ROW(OLD."paymentAccountId",OLD."paymentAccountRevision",OLD."paymentSnapshot",OLD."countryId",OLD."paymentMethodDefId",OLD."agentId") THEN
      RAISE EXCEPTION 'Order receiving destination is immutable';
    END IF;
    IF OLD."safetyHold" AND NOT NEW."safetyHold" THEN
      RAISE EXCEPTION 'Safety hold release requires a separately approved policy';
    END IF;
    IF (OLD."safetyHold" OR NEW."safetyHold") AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'DISPUTE' THEN
      IF NEW.status::text = 'COMPLETED' THEN effect := 'ORDER_COMPLETED';
      ELSIF NEW.status::text = 'CANCELLED' THEN effect := 'ORDER_CANCELLED'; END IF;
      IF NOT (OLD."safetyHold" AND NEW."safetyHold" AND public.held_deposit_authorized(NEW.id, effect)) THEN
        RAISE EXCEPTION 'Order is on safety hold; financial resolution is gated';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.deposit_financial_safety() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE blocked boolean; missing boolean; effect text := 'NONE';
BEGIN
  SELECT (o."safetyHold" OR a."safetyHold" OR a.status='DISABLED') INTO blocked
  FROM public.agent_orders o JOIN public.agent_payment_accounts a ON a.id=o."paymentAccountId"
  WHERE o.id=NEW."orderId" FOR SHARE OF a,o;
  missing := NOT FOUND;
  IF missing OR blocked THEN
    IF TG_TABLE_NAME = 'agent_reservations' THEN
      IF NEW.status::text = 'CONSUMED' THEN effect := 'RESERVATION_CONSUMED';
      ELSIF NEW.status::text = 'RELEASED' THEN effect := 'RESERVATION_RELEASED'; END IF;
    ELSIF TG_TABLE_NAME = 'agent_order_settlements' THEN effect := 'SETTLEMENT';
    ELSIF TG_TABLE_NAME = 'disputes' THEN effect := 'DISPUTE_CLOSED';
    END IF;
    IF NOT public.held_deposit_authorized(NEW."orderId", effect) THEN
      RAISE EXCEPTION 'Deposit financial operation is on safety hold';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
