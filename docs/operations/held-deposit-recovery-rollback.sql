-- Emergency schema-reversal reference for 20261117000000_held_deposit_recovery.
-- NOT a routine release rollback or an executable cutover instruction. Stop and
-- obtain a separately reviewed and approved recovery plan before running it.
-- Owner-run, by hand, never automatically. It restores the two original deposit guards exactly and removes
-- the recovery objects. safetyHold values are not touched: every held order
-- stays held, exactly as before the migration.
--
-- It REFUSES to run when:
--   * any adjudication exists (a held order was financially resolved through
--     this workflow; removing the record would erase the only explanation), or
--   * any outcome or the admission exception is still enabled, or
--   * investigation cases exist and the operator has not first exported them and
--     acknowledged the discard in this session with
--       SET held_recovery.discard_cases = 'exported-and-acknowledged';
-- A successfully applied migration must NOT be marked rolled back or edited in
-- _prisma_migrations. Prisma migrate resolve --rolled-back is not a rollback for
-- successful migrations; the pinned CLI rejects that state. Running this SQL
-- alone would leave migration history inconsistent with the physical schema.
-- Keep history intact and prefer a separately reviewed, tested and approved
-- forward recovery through the normal migration workflow. Do not create that
-- migration, run this reference SQL, or restore a database under this document's
-- authority. Preserve adjudications, case evidence and financial history.
-- Any recovery plan must first stop incompatible writers, verify a restorable
-- backup and define compatible application/grant versions and post-recovery
-- checks. If this SQL was already run, stop and escalate; do not repair migration
-- history manually or retry deployment as a substitute for a recovery plan.
BEGIN;
LOCK TABLE public.agent_orders, public.agent_reservations, public.agent_order_settlements, public.disputes,
  public.late_payment_cases, public.late_payment_reference_claims, public.held_deposit_adjudications,
  public.held_deposit_cases, public.held_deposit_recovery_policy IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.held_deposit_adjudications) THEN
    RAISE EXCEPTION 'Rollback refused: held-deposit adjudications exist and must be preserved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.held_deposit_recovery_policy WHERE "unpaidReleaseEnabled" OR "coinCreditEnabled"
      OR "externalReturnEnabled" OR "admissionExceptionMax" > 0) THEN
    RAISE EXCEPTION 'Rollback refused: disable the recovery policy first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.held_deposit_cases)
     AND coalesce(current_setting('held_recovery.discard_cases', true), '') <> 'exported-and-acknowledged' THEN
    RAISE EXCEPTION 'Rollback refused: export the investigation cases and acknowledge their discard first';
  END IF;
END $$;

-- The original guards, byte-for-byte from 20261113060000_deposit_destination_revisions.
CREATE OR REPLACE FUNCTION public.deposit_order_destination() RETURNS trigger LANGUAGE plpgsql
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
CREATE OR REPLACE FUNCTION public.deposit_financial_safety() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,pg_temp AS $$
DECLARE blocked boolean;
BEGIN
  SELECT (o."safetyHold" OR a."safetyHold" OR a.status='DISABLED') INTO blocked
  FROM public.agent_orders o JOIN public.agent_payment_accounts a ON a.id=o."paymentAccountId"
  WHERE o.id=NEW."orderId" FOR SHARE OF a,o;
  IF NOT FOUND OR blocked THEN RAISE EXCEPTION 'Deposit financial operation is on safety hold'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER held_deposit_reference_exclusive ON public.late_payment_reference_claims;
DROP TRIGGER held_deposit_late_payment_exclusive ON public.late_payment_cases;
DROP TABLE public.held_deposit_reference_claims;
DROP TABLE public.held_deposit_adjudications;
DROP TABLE public.held_deposit_case_events;
DROP TABLE public.held_deposit_cases;
DROP TABLE public.held_deposit_recovery_policy;
DROP FUNCTION public.held_deposit_authorized(text, text);
DROP FUNCTION public.held_deposit_adjudication_authorize();
DROP FUNCTION public.held_deposit_adjudication_complete();
DROP FUNCTION public.held_deposit_case_guard();
DROP FUNCTION public.held_deposit_claim_guard();
DROP FUNCTION public.held_deposit_late_payment_exclusive();
DROP FUNCTION public.held_deposit_reference_exclusive();
DROP FUNCTION public.held_deposit_immutable();
DROP FUNCTION public.held_deposit_policy_guard();
COMMIT;
