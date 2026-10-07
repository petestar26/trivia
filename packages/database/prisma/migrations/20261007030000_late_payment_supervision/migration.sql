-- Forward-only extension. Final resolutions and original reports stay immutable.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint
 WHERE conrelid='public.late_payment_cases'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%status%'
 LOOP EXECUTE format('ALTER TABLE public.late_payment_cases DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE public.late_payment_cases
 ADD CONSTRAINT recovery_status CHECK(status IN ('OPEN','ASSIGNED','REFUNDED','REJECTED')),
 ADD CONSTRAINT recovery_assignment CHECK(
 (status='OPEN' AND "assignedAdminId" IS NULL AND "assignedAt" IS NULL) OR
 (status IN ('ASSIGNED','REFUNDED','REJECTED') AND "assignedAdminId" IS NOT NULL AND "assignedAt" IS NOT NULL)),
 ADD CONSTRAINT recovery_resolution CHECK(
 (status IN ('OPEN','ASSIGNED') AND "resolutionKey" IS NULL AND "resolutionNote" IS NULL AND "resolvedAt" IS NULL
 AND "verifiedPaymentReference" IS NULL AND "verifiedAmount" IS NULL AND "refundReference" IS NULL AND "refundedAt" IS NULL) OR
 (status='REJECTED' AND "resolutionKey" IS NOT NULL AND length("resolutionNote") BETWEEN 3 AND 4000 AND "resolutionNote" IS NOT NULL AND "resolvedAt" IS NOT NULL
 AND "verifiedPaymentReference" IS NULL AND "verifiedAmount" IS NULL AND "refundReference" IS NULL AND "refundedAt" IS NULL) OR
 (status='REFUNDED' AND "resolutionKey" IS NOT NULL AND "verifiedPaymentReference" IS NOT NULL AND "verifiedAmount">0 AND "verifiedAmount" IS NOT NULL
 AND "refundReference" IS NOT NULL AND "refundedAt" IS NOT NULL AND "resolutionNote" IS NOT NULL AND length("resolutionNote") BETWEEN 1 AND 4000 AND "resolvedAt" IS NOT NULL));
CREATE OR REPLACE FUNCTION public.guard_late_payment_case() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery history cannot be deleted'; END IF;
 IF TG_OP='INSERT' AND NEW.status!='OPEN' THEN RAISE EXCEPTION 'Recovery must begin open'; END IF;
 IF TG_OP='UPDATE' THEN
   IF (pg_catalog.to_jsonb(NEW)-ARRAY['status','assignedAdminId','assignedAt','resolutionKey','verifiedPaymentReference','verifiedAmount','refundReference','refundedAt','resolutionNote','resolvedAt'])
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['status','assignedAdminId','assignedAt','resolutionKey','verifiedPaymentReference','verifiedAmount','refundReference','refundedAt','resolutionNote','resolvedAt'])
   THEN RAISE EXCEPTION 'Recovery report is immutable'; END IF;
   IF NOT ((OLD.status='OPEN' AND NEW.status='ASSIGNED') OR
     (OLD.status='ASSIGNED' AND NEW.status='OPEN') OR
     (OLD.status='ASSIGNED' AND NEW.status IN ('REFUNDED','REJECTED') AND NEW."assignedAdminId"=OLD."assignedAdminId" AND NEW."assignedAt"=OLD."assignedAt"))
   THEN RAISE EXCEPTION 'Invalid recovery transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
