-- Preserve canonical runtime hardening and add the narrowly scoped onboarding capability.
CREATE OR REPLACE FUNCTION public.ledger_apply_runtime_grants(runtime_role TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE tab TEXT; cols TEXT; holders TEXT; subjects OID[];
BEGIN
  PERFORM public.ledger_apply_runtime_grants_pre_publication(runtime_role);
  subjects := ARRAY(SELECT x.role_id FROM public.ledger_role_reach((SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=runtime_role)) x
    JOIN pg_catalog.pg_roles r ON r.oid=x.role_id WHERE x.assumable OR NOT r.rolsuper);
  FOREACH tab IN ARRAY ARRAY['house_publication_requests','house_publication_receipts'] LOOP
    EXECUTE pg_catalog.format('REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON public.%I FROM %I',tab,runtime_role);
    SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname),',' ORDER BY a.attnum) INTO cols
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=pg_catalog.to_regclass('public.'||tab) AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE pg_catalog.format('REVOKE INSERT (%s),UPDATE (%s) ON public.%I FROM %I',cols,cols,tab,runtime_role);
    SELECT pg_catalog.string_agg(DISTINCT r.rolname,', ' ORDER BY r.rolname) INTO holders
      FROM pg_catalog.pg_roles r WHERE r.oid=ANY(subjects) AND (
        pg_catalog.has_table_privilege(r.oid,'public.'||tab,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR
        pg_catalog.has_any_column_privilege(r.oid,'public.'||tab,'INSERT,UPDATE'));
    IF holders IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='insufficient_privilege',MESSAGE=pg_catalog.format('publication archive %s is writable through %s',tab,holders);
    END IF;
  END LOOP;
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION public.activate_provisioned_agent(text,text,text) TO %I', runtime_role);
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(text) FROM PUBLIC;
