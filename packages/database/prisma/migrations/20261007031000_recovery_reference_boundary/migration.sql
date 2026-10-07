-- Serialize recovery reference claims with legacy deposit evidence writes.
-- Evidence is not verification: a collision requires staff investigation.
CREATE FUNCTION public.guard_recovery_evidence_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE method_id text; order_id text; normalized text;
BEGIN
 SELECT c."orderId",o."paymentMethodDefId" INTO order_id,method_id
 FROM public.late_payment_cases c JOIN public.agent_orders o ON o.id=c."orderId" WHERE c.id=NEW."caseId";
 IF method_id IS NULL OR method_id IS DISTINCT FROM NEW."methodId" THEN
   RAISE EXCEPTION 'Recovery reference provider does not match the order';
 END IF;
 normalized=upper(btrim(NEW.reference));
 IF normalized IS DISTINCT FROM NEW.reference THEN RAISE EXCEPTION 'Recovery reference must be normalized'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recovery-reference:'||method_id||':'||normalized,0));
 IF EXISTS(SELECT 1 FROM public.payment_evidence e JOIN public.agent_orders o ON o.id=e."orderId"
   WHERE o."paymentMethodDefId"=method_id AND upper(btrim(e."referenceNumber"))=normalized
   AND (e."orderId"<>order_id OR NEW.kind='REFUND')) THEN
   RAISE EXCEPTION 'Transfer reference conflicts with existing deposit evidence' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER recovery_evidence_reference_guard BEFORE INSERT ON public.late_payment_reference_claims
FOR EACH ROW EXECUTE FUNCTION public.guard_recovery_evidence_reference();

CREATE FUNCTION public.guard_evidence_recovery_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE method_id text; normalized text;
BEGIN
 IF NEW."referenceNumber" IS NULL OR btrim(NEW."referenceNumber")='' THEN RETURN NEW; END IF;
 SELECT "paymentMethodDefId" INTO method_id FROM public.agent_orders WHERE id=NEW."orderId";
 normalized=upper(btrim(NEW."referenceNumber"));
 PERFORM pg_advisory_xact_lock(hashtextextended('recovery-reference:'||method_id||':'||normalized,0));
 IF EXISTS(SELECT 1 FROM public.late_payment_reference_claims r JOIN public.late_payment_cases c ON c.id=r."caseId"
   WHERE r."methodId"=method_id AND r.reference=normalized AND (c."orderId"<>NEW."orderId" OR r.kind='REFUND')) THEN
   RAISE EXCEPTION 'Transfer reference already used by payment recovery' USING ERRCODE='23505';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evidence_recovery_reference_guard BEFORE INSERT OR UPDATE ON public.payment_evidence
FOR EACH ROW EXECUTE FUNCTION public.guard_evidence_recovery_reference();
