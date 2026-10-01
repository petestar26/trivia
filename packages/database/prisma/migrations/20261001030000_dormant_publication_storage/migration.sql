-- Dormant, public RFC 3161 archive. No authority approval, network submission,
-- ticket admission, financial gate or existing-row update occurs here.
BEGIN;
SET LOCAL lock_timeout='20s';

CREATE TABLE public.house_publication_requests (
  round_id TEXT PRIMARY KEY REFERENCES public.scheduled_game_rounds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  authority_id TEXT NOT NULL CHECK (authority_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  root_certificate_sha256 TEXT NOT NULL CHECK (root_certificate_sha256 ~ '^[0-9a-f]{64}$'),
  signer_certificate_sha256 TEXT NOT NULL CHECK (signer_certificate_sha256 ~ '^[0-9a-f]{64}$'),
  policy_oid TEXT NOT NULL CHECK (policy_oid ~ '^[0-9]+(\.[0-9]+)+$'),
  max_accuracy_ms INTEGER NOT NULL CHECK (max_accuracy_ms BETWEEN 1 AND 5000),
  commitment JSONB NOT NULL,
  commitment_hash TEXT NOT NULL CHECK (commitment_hash ~ '^[0-9a-f]{64}$'),
  query_der BYTEA NOT NULL CHECK (pg_catalog.octet_length(query_der) BETWEEN 1 AND 4096),
  query_sha256 TEXT NOT NULL CHECK (query_sha256 = pg_catalog.encode(public.digest(query_der,'sha256'::TEXT),'hex')),
  nonce_hex TEXT NOT NULL CHECK (nonce_hex ~ '^[1-9a-f][0-9a-f]{0,39}$'),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.house_publication_receipts (
  round_id TEXT PRIMARY KEY REFERENCES public.house_publication_requests(round_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  response_der BYTEA NOT NULL CHECK (pg_catalog.octet_length(response_der) BETWEEN 1 AND 65536),
  response_sha256 TEXT NOT NULL CHECK (response_sha256 = pg_catalog.encode(public.digest(response_der,'sha256'::TEXT),'hex')),
  serial_hex TEXT NOT NULL CHECK (serial_hex ~ '^[1-9a-f][0-9a-f]{0,39}$'),
  observed_from_ms BIGINT NOT NULL CHECK (observed_from_ms BETWEEN 0 AND 9007199254740991),
  observed_through_ms BIGINT NOT NULL CHECK (observed_through_ms BETWEEN observed_from_ms AND 9007199254740991),
  recorded_at TIMESTAMPTZ(6) NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION public.house_publication_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE sid TEXT; proof JSONB; terms JSONB; receipt_hash TEXT; req public.house_publication_requests%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE='check_violation',MESSAGE='publication archive is append-only';
  END IF;
  IF CURRENT_USER <> pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID)) THEN
    RAISE EXCEPTION USING ERRCODE='insufficient_privilege',MESSAGE='publication archive writes are owner-only';
  END IF;
  SELECT g.stream_id INTO sid FROM public.scheduled_game_rounds g WHERE g.id=NEW.round_id;
  IF sid IS NULL THEN RAISE EXCEPTION 'publication round is unavailable'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:'||sid,0));
  PERFORM 1 FROM public.scheduled_game_rounds g WHERE g.id=NEW.round_id FOR UPDATE;
  proof := public.house_public_spin_proof(NEW.round_id);
  IF proof IS NULL THEN RAISE EXCEPTION 'publication commitment is unavailable'; END IF;
  terms := proof->'commitment';
  receipt_hash := pg_catalog.encode(public.digest(pg_catalog.convert_to(pg_catalog.concat_ws(E'\n',
    'playqube:spin-win:public-commitment:v1',terms->>'roundId',terms->>'rulesId',terms->>'protocol',
    terms->>'chainHash',terms->>'opensAtMs',terms->>'closesAtMs',terms->>'pinnedAtMs',terms->>'preparedAtMs',
    terms->>'seedCommitment',terms->>'beaconRound',terms->>'beaconTimeMs'),'UTF8'),'sha256'::TEXT),'hex');
  IF TG_TABLE_NAME='house_publication_requests' THEN
    IF proof->>'stage' <> 'PENDING' OR NEW.commitment IS DISTINCT FROM terms OR NEW.commitment_hash <> receipt_hash
       OR pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT >= (terms->>'closesAtMs')::BIGINT THEN
      RAISE EXCEPTION USING ERRCODE='check_violation',MESSAGE='publication request does not match the open commitment';
    END IF;
  ELSE
    SELECT r.* INTO req FROM public.house_publication_requests r WHERE r.round_id=NEW.round_id;
    IF req.round_id IS NULL OR req.commitment IS DISTINCT FROM terms OR req.commitment_hash <> receipt_hash
       OR NEW.observed_from_ms < (terms->>'preparedAtMs')::BIGINT
       OR NEW.observed_through_ms >= (terms->>'closesAtMs')::BIGINT
       OR NEW.observed_through_ms-NEW.observed_from_ms > req.max_accuracy_ms*2+1 THEN
      RAISE EXCEPTION USING ERRCODE='check_violation',MESSAGE='publication receipt does not match its request';
    END IF;
    -- PostgreSQL validates linkage/bounds, not CMS/TSA signatures. Owner-run
    -- code must verify exact raw DER against approved source trust before INSERT.
    -- Every public read/use repeats that cryptographic verification.
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER house_publication_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_publication_requests
  FOR EACH ROW EXECUTE FUNCTION public.house_publication_guard();
CREATE TRIGGER house_publication_request_no_truncate BEFORE TRUNCATE ON public.house_publication_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_publication_guard();
CREATE TRIGGER house_publication_receipt_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_publication_receipts
  FOR EACH ROW EXECUTE FUNCTION public.house_publication_guard();
CREATE TRIGGER house_publication_receipt_no_truncate BEFORE TRUNCATE ON public.house_publication_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_publication_guard();

-- Preserve prior setup behavior, then restrict new public archive tables.
-- The wrapper and archived entry point are invoker/owner-run, never DEFINER.
ALTER FUNCTION public.ledger_apply_runtime_grants(TEXT) RENAME TO ledger_apply_runtime_grants_pre_publication;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role TEXT) RETURNS VOID
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
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(TEXT),public.ledger_apply_runtime_grants_pre_publication(TEXT),
  public.house_publication_guard() FROM PUBLIC;
REVOKE ALL ON public.house_publication_requests,public.house_publication_receipts FROM PUBLIC;
-- Entire archive is public evidence; no credential or unrevealed seed is stored.
GRANT SELECT ON public.house_publication_requests,public.house_publication_receipts TO PUBLIC;
COMMIT;
