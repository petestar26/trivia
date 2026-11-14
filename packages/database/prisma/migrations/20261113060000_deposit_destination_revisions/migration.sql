-- Local candidate only. No grants, activation, provider verification or fund movement.
BEGIN;
ALTER TABLE public.agent_payment_accounts ADD COLUMN "approvedRevision" integer NOT NULL DEFAULT 0,
  ADD COLUMN "safetyHold" boolean NOT NULL DEFAULT false;
ALTER TABLE public.agent_orders ADD COLUMN "paymentAccountRevision" integer,
  ADD COLUMN "safetyHold" boolean NOT NULL DEFAULT false;
CREATE TABLE public.agent_payment_account_revisions (
  "accountId" text NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  "agentId" text NOT NULL, "countryId" text NOT NULL, "methodDefId" text NOT NULL,
  "accountDetails" jsonb NOT NULL, "reviewedBy" text, "reviewedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("accountId", revision)
);
-- Only currently approved destinations have verifiable approval provenance.
INSERT INTO public.agent_payment_account_revisions
  ("accountId",revision,"agentId","countryId","methodDefId","accountDetails","reviewedBy","reviewedAt")
SELECT id,1,"agentId","countryId","methodDefId","accountDetails","reviewedBy","reviewedAt"
FROM public.agent_payment_accounts WHERE status='APPROVED';
UPDATE public.agent_payment_accounts SET "approvedRevision"=1 WHERE status='APPROVED';
-- Do not rewrite any historical order, including settled purchase witnesses.
-- Legacy orders retain their authoritative snapshot and no claimed revision.
UPDATE public.agent_payment_accounts SET "safetyHold"=true WHERE status='DISABLED';
UPDATE public.agent_orders o SET "safetyHold"=true
WHERE o.status IN ('CREATED','PAYMENT_SUBMITTED','DISPUTE') AND (
  NOT EXISTS (SELECT 1 FROM public.agent_payment_accounts a WHERE a.id=o."paymentAccountId") OR EXISTS
  (SELECT 1 FROM public.agent_payment_accounts a WHERE a.id=o."paymentAccountId" AND a."safetyHold"));

CREATE FUNCTION public.deposit_revision_immutable() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Approved receiving revisions are immutable'; END $$;
CREATE TRIGGER deposit_revision_immutable BEFORE UPDATE OR DELETE ON public.agent_payment_account_revisions
FOR EACH ROW EXECUTE FUNCTION public.deposit_revision_immutable();
CREATE TRIGGER deposit_revision_no_truncate BEFORE TRUNCATE ON public.agent_payment_account_revisions
FOR EACH STATEMENT EXECUTE FUNCTION public.deposit_revision_immutable();

-- Retain identities even before their first approval: deleting and recreating
-- a pending row could otherwise reuse an old timestamp token (ABA).
CREATE TRIGGER deposit_account_no_delete BEFORE DELETE ON public.agent_payment_accounts
FOR EACH ROW EXECUTE FUNCTION public.deposit_revision_immutable();
CREATE TRIGGER deposit_account_no_truncate BEFORE TRUNCATE ON public.agent_payment_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.deposit_revision_immutable();

CREATE FUNCTION public.deposit_account_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE changed boolean := false; disable_requested boolean := NEW.status='DISABLED';
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW."agentId" IS DISTINCT FROM OLD."agentId" THEN
      RAISE EXCEPTION 'Receiving account identity is immutable';
    END IF;
    IF OLD."safetyHold" AND NOT NEW."safetyHold" THEN
      RAISE EXCEPTION 'Safety hold release requires a separately approved policy';
    END IF;
    changed := ROW(NEW."countryId",NEW."methodDefId",NEW."accountDetails") IS DISTINCT FROM
               ROW(OLD."countryId",OLD."methodDefId",OLD."accountDetails");
    NEW."approvedRevision" := OLD."approvedRevision";
    -- Timestamp(3) is exactly representable by JavaScript Date. Every write,
    -- including disable and direct SQL, advances by at least one millisecond.
    NEW."updatedAt" := greatest(NEW."updatedAt", OLD."updatedAt" + interval '1 millisecond',
                                pg_catalog.date_trunc('milliseconds',pg_catalog.clock_timestamp()));
    IF changed THEN
      NEW.status := 'PENDING_APPROVAL'; NEW."reviewedBy" := NULL; NEW."reviewedAt" := NULL;
    END IF;
  ELSE NEW."approvedRevision" := 0;
  END IF;
  IF disable_requested THEN NEW."safetyHold" := true; END IF;
  IF NEW.status='APPROVED' AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    IF NEW."safetyHold" THEN RAISE EXCEPTION 'Unsafe account cannot be approved'; END IF;
    NEW."approvedRevision" := NEW."approvedRevision" + 1;

  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_account_revision BEFORE INSERT OR UPDATE ON public.agent_payment_accounts
FOR EACH ROW EXECUTE FUNCTION public.deposit_account_revision();

-- Record only the actual committed-to-be approved account row. Direct inserts
-- cannot invent a future revision: exact current approval must match and that
-- primary key is populated atomically by the account AFTER trigger.
CREATE FUNCTION public.deposit_revision_insert() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.agent_payment_accounts a WHERE a.id=NEW."accountId"
    AND a.status='APPROVED' AND NOT a."safetyHold"
    AND ROW(a."approvedRevision",a."agentId",a."countryId",a."methodDefId",a."accountDetails",a."reviewedBy",a."reviewedAt")
      IS NOT DISTINCT FROM ROW(NEW.revision,NEW."agentId",NEW."countryId",NEW."methodDefId",NEW."accountDetails",NEW."reviewedBy",NEW."reviewedAt") FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Revision must match the current approved destination'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_revision_insert BEFORE INSERT ON public.agent_payment_account_revisions
FOR EACH ROW EXECUTE FUNCTION public.deposit_revision_insert();
CREATE FUNCTION public.deposit_record_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW.status='APPROVED' AND (TG_OP='INSERT' OR NEW."approvedRevision"<>OLD."approvedRevision") THEN
    INSERT INTO public.agent_payment_account_revisions
      ("accountId",revision,"agentId","countryId","methodDefId","accountDetails","reviewedBy","reviewedAt")
    VALUES (NEW.id,NEW."approvedRevision",NEW."agentId",NEW."countryId",NEW."methodDefId",
            NEW."accountDetails",NEW."reviewedBy",NEW."reviewedAt");
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_record_revision AFTER INSERT OR UPDATE ON public.agent_payment_accounts
FOR EACH ROW EXECUTE FUNCTION public.deposit_record_revision();

CREATE FUNCTION public.deposit_account_safety() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF NEW."safetyHold" THEN
    UPDATE public.agent_orders SET "safetyHold"=true
    WHERE "paymentAccountId"=NEW.id AND status IN ('CREATED','PAYMENT_SUBMITTED','DISPUTE') AND NOT "safetyHold";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_account_safety AFTER UPDATE ON public.agent_payment_accounts
FOR EACH ROW WHEN (NEW."safetyHold" IS DISTINCT FROM OLD."safetyHold")
EXECUTE FUNCTION public.deposit_account_safety();

CREATE FUNCTION public.deposit_order_destination() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE a public.agent_payment_accounts;
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
      RAISE EXCEPTION 'Order is on safety hold; financial resolution is gated';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_order_destination BEFORE INSERT OR UPDATE ON public.agent_orders
FOR EACH ROW EXECUTE FUNCTION public.deposit_order_destination();
-- Recovery writes do not update the order, so the order-status trigger alone
-- cannot protect them. Investigation/assignment stays available; resolution is
-- refused while either the immutable order or its account is held/missing.
CREATE FUNCTION public.deposit_recovery_safety() RETURNS trigger LANGUAGE plpgsql
SET search_path=public,pg_temp AS $$
DECLARE blocked boolean;
BEGIN
  IF NEW.status IN ('REFUNDED','REJECTED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT (o."safetyHold" OR a."safetyHold" OR a.status='DISABLED') INTO blocked
    FROM public.agent_orders o JOIN public.agent_payment_accounts a ON a.id=o."paymentAccountId"
    WHERE o.id=NEW."orderId" FOR SHARE OF a,o;
    IF NOT FOUND OR blocked THEN RAISE EXCEPTION 'Recovery resolution is on safety hold'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_recovery_safety BEFORE UPDATE ON public.late_payment_cases
FOR EACH ROW EXECUTE FUNCTION public.deposit_recovery_safety();
-- Defense in depth for paths that might touch reservation/settlement/dispute
-- rows without changing order status. No hold is cleared by these checks.
CREATE FUNCTION public.deposit_financial_safety() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE blocked boolean;
BEGIN
  SELECT (o."safetyHold" OR a."safetyHold" OR a.status='DISABLED') INTO blocked
  FROM public.agent_orders o JOIN public.agent_payment_accounts a ON a.id=o."paymentAccountId"
  WHERE o.id=NEW."orderId" FOR SHARE OF a,o;
  IF NOT FOUND OR blocked THEN RAISE EXCEPTION 'Deposit financial operation is on safety hold'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deposit_reservation_safety BEFORE UPDATE ON public.agent_reservations
FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
EXECUTE FUNCTION public.deposit_financial_safety();
CREATE TRIGGER deposit_settlement_safety BEFORE INSERT ON public.agent_order_settlements
FOR EACH ROW EXECUTE FUNCTION public.deposit_financial_safety();
CREATE TRIGGER deposit_dispute_safety BEFORE UPDATE ON public.disputes
FOR EACH ROW WHEN (NEW.status='RESOLVED' AND NEW.status IS DISTINCT FROM OLD.status)
EXECUTE FUNCTION public.deposit_financial_safety();
COMMIT;
