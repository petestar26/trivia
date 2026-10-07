-- Support-only recovery: no changes to orders, reservations, or wallet balances.
CREATE TABLE public.late_payment_cases (
 id TEXT PRIMARY KEY, "orderId" TEXT NOT NULL UNIQUE REFERENCES public.agent_orders(id) ON DELETE RESTRICT,
 "openedBy" TEXT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 "idempotencyKey" TEXT NOT NULL,
 "paymentReference" TEXT NOT NULL, "paidAmount" INTEGER NOT NULL CHECK ("paidAmount">0),
 "paidAt" TIMESTAMP(3) NOT NULL, description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','REFUNDED')),
 "assignedAdminId" TEXT REFERENCES public.users(id) ON DELETE RESTRICT, "assignedAt" TIMESTAMP(3),
 "resolutionKey" TEXT, "verifiedPaymentReference" TEXT, "verifiedAmount" INTEGER,
 "refundReference" TEXT, "refundedAt" TIMESTAMP(3), "resolutionNote" TEXT, "resolvedAt" TIMESTAMP(3),
 "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (length(description) BETWEEN 1 AND 4000),
 CHECK ((status='OPEN' AND "assignedAdminId" IS NULL AND "assignedAt" IS NULL)
     OR (status IN ('ASSIGNED','REFUNDED') AND "assignedAdminId" IS NOT NULL AND "assignedAt" IS NOT NULL)),
 CHECK ((status!='REFUNDED' AND "resolutionKey" IS NULL AND "verifiedPaymentReference" IS NULL
     AND "verifiedAmount" IS NULL AND "refundReference" IS NULL AND "refundedAt" IS NULL
     AND "resolutionNote" IS NULL AND "resolvedAt" IS NULL)
     OR (status='REFUNDED' AND "resolutionKey" IS NOT NULL AND "verifiedPaymentReference" IS NOT NULL
     AND "verifiedAmount" IS NOT NULL AND "verifiedAmount">0 AND "refundReference" IS NOT NULL AND "refundedAt" IS NOT NULL
     AND "resolutionNote" IS NOT NULL AND length("resolutionNote") BETWEEN 1 AND 4000 AND "resolvedAt" IS NOT NULL))
);
CREATE INDEX late_payment_cases_queue ON public.late_payment_cases(status,"openedAt");
-- Provider scope comes from the immutable order. A member's unverified claim
-- cannot reserve a verified transfer reference and block another customer's case.
CREATE TABLE public.late_payment_reference_claims (
 "methodId" TEXT NOT NULL, reference TEXT NOT NULL, "caseId" TEXT NOT NULL
 REFERENCES public.late_payment_cases(id) ON DELETE RESTRICT,
 kind TEXT NOT NULL CHECK(kind IN ('PAYMENT','REFUND')),
 PRIMARY KEY ("methodId", reference)
);
CREATE FUNCTION public.guard_late_payment_case() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recovery history cannot be deleted'; END IF;
 IF TG_OP='INSERT' AND NEW.status!='OPEN' THEN RAISE EXCEPTION 'Recovery must begin open'; END IF;
 IF TG_OP='UPDATE' THEN
   IF (pg_catalog.to_jsonb(NEW)-ARRAY['status','assignedAdminId','assignedAt','resolutionKey','verifiedPaymentReference','verifiedAmount','refundReference','refundedAt','resolutionNote','resolvedAt'])
     IS DISTINCT FROM (pg_catalog.to_jsonb(OLD)-ARRAY['status','assignedAdminId','assignedAt','resolutionKey','verifiedPaymentReference','verifiedAmount','refundReference','refundedAt','resolutionNote','resolvedAt'])
   THEN RAISE EXCEPTION 'Recovery report is immutable'; END IF;
   IF NOT ((OLD.status='OPEN' AND NEW.status='ASSIGNED') OR
     (OLD.status='ASSIGNED' AND NEW.status='REFUNDED' AND NEW."assignedAdminId"=OLD."assignedAdminId" AND NEW."assignedAt"=OLD."assignedAt"))
   THEN RAISE EXCEPTION 'Invalid recovery transition'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER late_payment_case_guard BEFORE INSERT OR UPDATE OR DELETE ON public.late_payment_cases
FOR EACH ROW EXECUTE FUNCTION public.guard_late_payment_case();

CREATE FUNCTION public.guard_late_payment_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 RAISE EXCEPTION 'Verified recovery references are immutable';
END $$;
CREATE TRIGGER late_payment_reference_guard BEFORE UPDATE OR DELETE ON public.late_payment_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.guard_late_payment_reference();
