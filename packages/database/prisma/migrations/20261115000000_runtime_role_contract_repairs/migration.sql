-- Preserve all historical migrations and the later runtime-grant wrapper chain.
BEGIN;
CREATE OR REPLACE FUNCTION public.ledger_apply_runtime_grants_pre_sports(runtime_role TEXT) RETURNS VOID LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tab TEXT; cols TEXT; holders TEXT; subjects OID[];
BEGIN
 PERFORM public.ledger_apply_runtime_grants_pre_crypto(runtime_role);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE ON public.crypto_addresses,public.crypto_deposits,public.crypto_withdrawals TO %I',runtime_role);
 EXECUTE format('GRANT SELECT,INSERT ON public.crypto_deposit_settlements TO %I',runtime_role);
 EXECUTE format('GRANT SELECT ON public.crypto_receipts TO %I',runtime_role);
 subjects:=ARRAY(SELECT x.role_id
   FROM public.ledger_role_reach((SELECT oid FROM pg_roles WHERE rolname=runtime_role)) x
   JOIN pg_roles r ON r.oid=x.role_id
   WHERE x.assumable OR (x.via_id=(SELECT oid FROM pg_roles WHERE rolname=runtime_role) AND NOT r.rolsuper));
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
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants_pre_sports(text) FROM PUBLIC;

-- Expose only the invariant timing predicate, never private seed material.
-- Keep exact timestamp precision and the scanner's existing row coverage.
-- The calling scan retains pagination and independent BLS verification.
CREATE FUNCTION public.house_beacon_timing_valid(rid TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT COALESCE((
    SELECT COALESCE(g.mode='FINANCIAL' AND g.game_key='spin_win'
          AND x.algorithm='sha256-quicknet-rejection-u32be-v2'
          AND EXTRACT(EPOCH FROM p.pinned_at)*1000>=g.opens_ms
          AND EXTRACT(EPOCH FROM p.pinned_at)*1000<g.closes_ms
          AND x.prepared_at>=p.pinned_at
          AND EXTRACT(EPOCH FROM x.prepared_at)*1000<g.closes_ms
          AND EXTRACT(EPOCH FROM p.received_at)*1000>=p.beacon_time_ms,
          FALSE)
    FROM public.house_round_beacon_pins p
    LEFT JOIN public.scheduled_game_rounds g ON g.id=p.round_id
    LEFT JOIN public.house_round_randomness x ON x.round_id=p.round_id
    WHERE p.round_id=rid
  ), FALSE)
$$;
REVOKE ALL ON FUNCTION public.house_beacon_timing_valid(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.house_beacon_timing_valid(TEXT) TO PUBLIC;
COMMIT;
