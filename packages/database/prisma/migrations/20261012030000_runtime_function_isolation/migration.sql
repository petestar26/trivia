-- Forward-only repair: preserve every previously applied migration digest.
-- Signed financial entrypoints are API capabilities, not PUBLIC draw-worker capabilities.
-- Canonical runtime setup grants them explicitly; no login or gate is created/enabled.
BEGIN;
REVOKE EXECUTE ON FUNCTION public.ledger_lock_economy_for_invariant_check() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_approval_signature_valid(text,text,text,boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_adjustment_request(text,text,numeric,text,jsonb,text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_adjustment_first_approval(text,text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_adjustment_execute(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_adjustment_close(text,text,text,text,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_review_first_approval(text,text,jsonb,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_review_reopen(text,text,text,integer,text,text,text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.ledger_review_resolve(text,text,text,text,text,text) FROM PUBLIC;

-- Use the canonical role subjects, excluding uninherited superuser attributes.
CREATE OR REPLACE FUNCTION public.ledger_apply_runtime_grants(runtime_role TEXT) RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tab TEXT; cols TEXT; holders TEXT; subjects OID[]; signature TEXT;
BEGIN
 PERFORM public.ledger_apply_runtime_grants_pre_crypto(runtime_role);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.crypto_addresses,public.crypto_deposits,public.crypto_withdrawals TO %I',runtime_role);
 EXECUTE format('GRANT SELECT,INSERT ON public.crypto_deposit_settlements TO %I',runtime_role);
 EXECUTE format('GRANT SELECT ON public.crypto_receipts TO %I',runtime_role);
 subjects:=ARRAY(SELECT x.role_id FROM public.ledger_role_reach((SELECT oid FROM pg_roles WHERE rolname=runtime_role)) x JOIN pg_roles r ON r.oid=x.role_id WHERE x.assumable OR (x.via_id=(SELECT oid FROM pg_roles WHERE rolname=runtime_role) AND NOT r.rolsuper));
 FOREACH tab IN ARRAY ARRAY['crypto_receipts','crypto_deposit_settlements','crypto_addresses','crypto_deposits','crypto_withdrawals'] LOOP
  EXECUTE format('REVOKE DELETE,TRUNCATE,TRIGGER ON public.%I FROM %I',tab,runtime_role);
  IF tab='crypto_deposit_settlements' THEN
   EXECUTE format('REVOKE UPDATE ON public.%I FROM %I',tab,runtime_role);
   SELECT string_agg(quote_ident(attname),',') INTO cols FROM pg_attribute WHERE attrelid=to_regclass('public.'||tab) AND attnum>0 AND NOT attisdropped;
   EXECUTE format('REVOKE UPDATE (%s) ON public.%I FROM %I',cols,tab,runtime_role);
  END IF;
  IF tab='crypto_receipts' THEN
   EXECUTE format('REVOKE INSERT,UPDATE ON public.%I FROM %I',tab,runtime_role);
   SELECT string_agg(quote_ident(attname),',') INTO cols FROM pg_attribute WHERE attrelid=to_regclass('public.'||tab) AND attnum>0 AND NOT attisdropped;
   EXECUTE format('REVOKE INSERT (%s),UPDATE (%s) ON public.%I FROM %I',cols,cols,tab,runtime_role);
   SELECT string_agg(rolname,',') INTO holders FROM pg_roles WHERE oid=ANY(subjects) AND (has_table_privilege(oid,'public.crypto_receipts','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(oid,'public.crypto_receipts','INSERT,UPDATE'));
   IF holders IS NOT NULL THEN RAISE EXCEPTION 'API runtime can forge crypto receipt through %',holders; END IF;
  END IF;
 END LOOP;
 FOREACH signature IN ARRAY ARRAY['public.ledger_lock_economy_for_invariant_check()','public.ledger_approval_signature_valid(text,text,text,boolean)','public.ledger_adjustment_request(text,text,numeric,text,jsonb,text,text,text,text)','public.ledger_adjustment_first_approval(text,text,text,text,text)','public.ledger_adjustment_execute(text,text,text,text,text,text,text)','public.ledger_adjustment_close(text,text,text,text,text,text,text)','public.ledger_review_first_approval(text,text,jsonb,text,text,text)','public.ledger_review_reopen(text,text,text,integer,text,text,text)','public.ledger_review_resolve(text,text,text,text,text,text)'] LOOP
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',signature,runtime_role);
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(text) FROM PUBLIC;
COMMIT;
