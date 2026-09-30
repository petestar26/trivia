-- Dormant future-beacon protocol. Historical seeds and payouts are unchanged.
-- Signatures are BLS-verified by the pinned official client before import/draw;
-- SQL enforces identity/time/hash/lifecycle, not BLS pairings. Owner SQL remains
-- privileged; external publication and monitoring are activation prerequisites.
BEGIN;
SET LOCAL lock_timeout='20s';
LOCK TABLE public.scheduled_game_rounds,public.house_round_randomness IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE public.house_round_randomness DROP CONSTRAINT house_round_randomness_algorithm_check;
ALTER TABLE public.house_round_randomness ADD CONSTRAINT house_round_randomness_algorithm_check
  CHECK(algorithm IN ('sha256-rejection-u32be-v1','sha256-quicknet-rejection-u32be-v2'));
CREATE TABLE public.house_round_beacon_pins (
  round_id TEXT PRIMARY KEY REFERENCES public.scheduled_game_rounds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  chain_hash TEXT NOT NULL CHECK(chain_hash='52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'),
  beacon_round BIGINT NOT NULL CHECK(beacon_round BETWEEN 1 AND 9007199254740991),
  beacon_time_ms BIGINT NOT NULL CHECK(beacon_time_ms BETWEEN 1692803367000 AND 9007199254740991),
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  signature_hex TEXT CHECK(signature_hex ~ '^[0-9a-f]{96}$'),
  randomness_hex TEXT CHECK(randomness_hex ~ '^[0-9a-f]{64}$'),
  received_at TIMESTAMPTZ,
  CHECK((signature_hex IS NULL AND randomness_hex IS NULL AND received_at IS NULL) OR
    (signature_hex IS NOT NULL AND randomness_hex IS NOT NULL AND received_at IS NOT NULL))
);
CREATE FUNCTION public.house_quicknet_target(cutoff_ms BIGINT) RETURNS BIGINT
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  SELECT CASE WHEN cutoff_ms::NUMERIC+6000<1692803367000 THEN 1::BIGINT
    ELSE pg_catalog.floor((cutoff_ms::NUMERIC+6000-1692803367000)/3000)::BIGINT+2 END
$$;
CREATE FUNCTION public.house_round_beacon_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.scheduled_game_rounds%ROWTYPE; owner_oid OID; now_ms BIGINT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'beacon proof history is immutable'; END IF;
  SELECT c.relowner INTO owner_oid FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID;
  IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=CURRENT_USER) IS DISTINCT FROM owner_oid
    THEN RAISE EXCEPTION 'financial beacon preparation is owner-only' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=NEW.round_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:'||g.stream_id,0));
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=NEW.round_id FOR UPDATE;
  now_ms:=pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT;
  IF TG_OP='INSERT' THEN
    IF g.mode<>'FINANCIAL' OR g.game_key<>'spin_win' OR g.state<>'OPEN'
      OR now_ms<g.opens_ms OR now_ms>=g.closes_ms OR NEW.signature_hex IS NOT NULL
      OR NEW.beacon_round IS DISTINCT FROM public.house_quicknet_target(g.closes_ms)
      OR NEW.beacon_time_ms::NUMERIC IS DISTINCT FROM (1692803367000::NUMERIC+(NEW.beacon_round-1)::NUMERIC*3000)
      OR EXISTS(SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=g.id)
      OR EXISTS(SELECT 1 FROM public.economic_operations o WHERE o.snapshot->'financialTicket'->>'roundId'=g.id)
      THEN RAISE EXCEPTION 'beacon target must be the pinned future event before every ticket'; END IF;
    NEW.pinned_at:=pg_catalog.clock_timestamp();
  ELSE
    IF OLD.signature_hex IS NOT NULL OR NEW.signature_hex IS NULL OR g.state<>'OPEN'
      OR now_ms<OLD.beacon_time_ms
      OR (pg_catalog.to_jsonb(NEW)-ARRAY['signature_hex','randomness_hex','received_at']) IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)-ARRAY['signature_hex','randomness_hex','received_at'])
      THEN RAISE EXCEPTION 'beacon proof is one-time and after its pinned event'; END IF;
    NEW.received_at:=pg_catalog.clock_timestamp();
  END IF;
  IF NEW.signature_hex IS NOT NULL AND NEW.randomness_hex IS DISTINCT FROM
    pg_catalog.encode(public.digest(pg_catalog.decode(NEW.signature_hex,'hex'),'sha256'::TEXT),'hex')
    THEN RAISE EXCEPTION 'beacon randomness must hash its exact signature'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER house_round_beacon_guard BEFORE INSERT OR UPDATE OR DELETE ON public.house_round_beacon_pins
  FOR EACH ROW EXECUTE FUNCTION public.house_round_beacon_guard();
CREATE TRIGGER house_round_beacon_no_truncate BEFORE TRUNCATE ON public.house_round_beacon_pins
  FOR EACH STATEMENT EXECUTE FUNCTION public.house_round_beacon_guard();

CREATE OR REPLACE FUNCTION public.house_spin_outcome(rid TEXT) RETURNS INTEGER
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE x public.house_round_randomness%ROWTYPE; g public.scheduled_game_rounds%ROWTYPE;
  digest BYTEA; word BIGINT; counter INTEGER; p public.house_round_beacon_pins%ROWTYPE; message TEXT;
BEGIN
  SELECT * INTO STRICT x FROM public.house_round_randomness WHERE round_id=rid;
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=rid;
  IF x.algorithm='sha256-quicknet-rejection-u32be-v2' THEN
    SELECT * INTO STRICT p FROM public.house_round_beacon_pins WHERE round_id=rid;
    IF p.signature_hex IS NULL OR p.randomness_hex IS NULL THEN RAISE EXCEPTION 'pinned beacon proof is pending'; END IF;
  END IF;
  FOR counter IN 0..127 LOOP
    IF x.algorithm='sha256-quicknet-rejection-u32be-v2' THEN
      message:='playqube:spin-win:quicknet-draw:v2'||E'\n'||rid||E'\n'||g.rules_id||E'\n'||x.seed_hex||E'\n'||p.chain_hash||E'\n'||p.beacon_round::TEXT||E'\n'||p.randomness_hex||E'\n'||counter::TEXT;
    ELSE
      message:='playqube:spin-win:draw:v1'||E'\n'||rid||E'\n'||g.rules_id||E'\n'||x.seed_hex||E'\n'||counter::TEXT;
    END IF;
    digest:=public.digest(pg_catalog.convert_to(message,'UTF8'),'sha256'::TEXT);
    word:=pg_catalog.get_byte(digest,0)::BIGINT*16777216+pg_catalog.get_byte(digest,1)::BIGINT*65536
      +pg_catalog.get_byte(digest,2)::BIGINT*256+pg_catalog.get_byte(digest,3);
    IF word<4294967289 THEN RETURN (word%37)::INTEGER; END IF;
  END LOOP;
  RAISE EXCEPTION 'randomness rejection limit exhausted';
END $$;

CREATE OR REPLACE FUNCTION public.house_round_randomness_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE g public.scheduled_game_rounds%ROWTYPE; owner_oid OID; now_ms BIGINT;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'randomness history is immutable'; END IF;
  SELECT c.relowner INTO owner_oid FROM pg_catalog.pg_class c WHERE c.oid=TG_RELID;
  IF (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=CURRENT_USER) IS DISTINCT FROM owner_oid
    THEN RAISE EXCEPTION 'financial randomness is owner-only' USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=NEW.round_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:'||g.stream_id,0));
  SELECT * INTO STRICT g FROM public.scheduled_game_rounds WHERE id=NEW.round_id FOR UPDATE;
  now_ms:=pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp())*1000)::BIGINT;
  IF TG_OP='INSERT' THEN
    IF g.mode<>'FINANCIAL' OR g.state<>'OPEN' OR now_ms<g.opens_ms OR now_ms>=g.closes_ms
      OR NEW.revealed_at IS NOT NULL OR NEW.cancelled_outcome IS NOT NULL OR EXISTS(SELECT 1 FROM public.economic_operations o
        WHERE o.snapshot->'financialTicket'->>'roundId'=g.id) THEN
      RAISE EXCEPTION 'financial randomness must be committed before admission'; END IF;
    IF (NEW.algorithm='sha256-quicknet-rejection-u32be-v2') IS DISTINCT FROM
      EXISTS(SELECT 1 FROM public.house_round_beacon_pins p WHERE p.round_id=g.id AND p.signature_hex IS NULL)
      THEN RAISE EXCEPTION 'randomness algorithm and future beacon pin must agree'; END IF;
    NEW.prepared_at:=pg_catalog.clock_timestamp();
    IF NEW.commitment_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(pg_catalog.convert_to(
      'playqube:spin-win:commit:v1'||E'\n'||g.id||E'\n'||g.rules_id||E'\n'||NEW.seed_hex,'UTF8'),'sha256'::TEXT),'hex')
      THEN RAISE EXCEPTION 'randomness commitment mismatch'; END IF;
  ELSE
    IF OLD.revealed_at IS NOT NULL OR NEW.revealed_at IS NULL
      OR (pg_catalog.to_jsonb(NEW)-ARRAY['revealed_at','cancelled_outcome']) IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)-ARRAY['revealed_at','cancelled_outcome'])
      THEN RAISE EXCEPTION 'randomness reveal is immutable'; END IF;
    IF NEW.algorithm='sha256-quicknet-rejection-u32be-v2' AND
      (NEW.cancelled_outcome IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.house_round_beacon_pins p
       WHERE p.round_id=g.id AND p.signature_hex IS NOT NULL AND now_ms>=p.beacon_time_ms))
      THEN RAISE EXCEPTION 'future-beacon draw must await its exact proof and cannot be cancelled'; END IF;
    IF NEW.cancelled_outcome IS NOT NULL THEN
      -- A cancellation exposes the same precommitted result, even before
      -- cutoff. The deferred proof requires a cancelled round in this tx.
      -- CANCELLED also permits auditing pre-existing dormant cancellations.
      IF g.mode<>'FINANCIAL' OR g.state NOT IN ('OPEN','CANCELLED')
        OR NEW.cancelled_outcome IS DISTINCT FROM public.house_spin_outcome(g.id)
        THEN RAISE EXCEPTION 'cancelled randomness must record the committed outcome'; END IF;
    ELSIF g.state<>'OPEN' OR now_ms<g.closes_ms THEN
      RAISE EXCEPTION 'randomness reveal is immutable and after cutoff';
    END IF;
    NEW.revealed_at:=pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.house_round_randomness_failures() RETURNS TABLE(id TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  SELECT g.id FROM public.scheduled_game_rounds g LEFT JOIN public.house_round_randomness x ON x.round_id=g.id
  WHERE g.mode='FINANCIAL' AND (
    (x.round_id IS NOT NULL AND (x.algorithm NOT IN ('sha256-rejection-u32be-v1','sha256-quicknet-rejection-u32be-v2')
      OR x.commitment_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(pg_catalog.convert_to(
       'playqube:spin-win:commit:v1'||E'\n'||g.id||E'\n'||g.rules_id||E'\n'||x.seed_hex,'UTF8'),'sha256'::TEXT),'hex')))
    OR (g.state='DRAWN' AND CASE WHEN x.round_id IS NULL OR x.revealed_at IS NULL OR x.cancelled_outcome IS NOT NULL OR (x.algorithm='sha256-quicknet-rejection-u32be-v2' AND NOT EXISTS(SELECT 1 FROM public.house_round_beacon_pins p WHERE p.round_id=g.id AND p.signature_hex IS NOT NULL)) THEN TRUE
      ELSE g.outcome IS DISTINCT FROM public.house_spin_outcome(g.id) END)
    OR (g.state='OPEN' AND (x.revealed_at IS NOT NULL OR x.cancelled_outcome IS NOT NULL))
    OR (g.state='CANCELLED' AND CASE WHEN x.round_id IS NULL THEN FALSE ELSE
      x.revealed_at IS NULL OR x.cancelled_outcome IS DISTINCT FROM public.house_spin_outcome(g.id) END)
    OR EXISTS(SELECT 1 FROM public.scheduled_stake_holds h JOIN public.economic_operations o ON o.id=h.hold_operation_id
      WHERE o.snapshot->'financialTicket'->>'roundId'=g.id AND (x.round_id IS NULL OR x.prepared_at>h.created_at))
  )
  UNION
  SELECT g.id FROM public.scheduled_game_rounds g JOIN public.house_round_randomness x ON x.round_id=g.id
    LEFT JOIN public.house_round_beacon_pins p ON p.round_id=g.id
  WHERE (x.algorithm='sha256-quicknet-rejection-u32be-v2') IS DISTINCT FROM (p.round_id IS NOT NULL)
    OR (p.round_id IS NOT NULL AND (g.state='CANCELLED' OR x.prepared_at<p.pinned_at OR
      pg_catalog.floor(EXTRACT(EPOCH FROM x.prepared_at)*1000)>=p.beacon_time_ms))
  UNION
  SELECT p.round_id FROM public.house_round_beacon_pins p
    JOIN public.scheduled_game_rounds g ON g.id=p.round_id
    LEFT JOIN public.house_round_randomness x ON x.round_id=p.round_id
  WHERE x.round_id IS NULL OR p.beacon_round IS DISTINCT FROM public.house_quicknet_target(g.closes_ms)
    OR p.beacon_time_ms::NUMERIC IS DISTINCT FROM (1692803367000::NUMERIC+(p.beacon_round-1)::NUMERIC*3000)
    OR (p.signature_hex IS NOT NULL AND (p.randomness_hex IS DISTINCT FROM pg_catalog.encode(
       public.digest(pg_catalog.decode(p.signature_hex,'hex'),'sha256'::TEXT),'hex') OR
       pg_catalog.floor(EXTRACT(EPOCH FROM p.received_at)*1000)<p.beacon_time_ms))
$$;

CREATE OR REPLACE FUNCTION public.scheduled_round_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  stream public.scheduled_game_streams%ROWTYPE;
  duration BIGINT;
  now_ms BIGINT;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'round history cannot be removed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || NEW.stream_id, 0));
  now_ms := pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000)::BIGINT;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO STRICT stream FROM public.scheduled_game_streams WHERE id = NEW.stream_id;
    duration := stream.betting_ms::BIGINT + stream.reveal_ms + stream.result_ms;
    IF NOT stream.enabled OR NEW.state <> 'OPEN' OR NEW.outcome IS NOT NULL OR NEW.drawn_at IS NOT NULL
      OR NEW.game_key IS DISTINCT FROM stream.game_key OR NEW.rules_id IS DISTINCT FROM stream.rules_id
      OR NEW.mode IS DISTINCT FROM stream.mode OR NEW.id IS DISTINCT FROM (stream.id || ':' || NEW.sequence::TEXT)
      OR NEW.opens_ms::NUMERIC IS DISTINCT FROM (stream.anchor_ms::NUMERIC + NEW.sequence::NUMERIC * duration)
      OR NEW.closes_ms <> NEW.opens_ms + stream.betting_ms
      OR NEW.reveal_ends_ms <> NEW.closes_ms + stream.reveal_ms
      OR NEW.ends_ms <> NEW.reveal_ends_ms + stream.result_ms
      OR now_ms < NEW.opens_ms OR now_ms >= NEW.closes_ms THEN
      RAISE EXCEPTION 'invalid, disabled, or closed round creation';
    END IF;
  ELSE
    IF OLD.mode='FINANCIAL' AND OLD.state='OPEN' AND NEW.state='CANCELLED' THEN
      IF EXISTS(SELECT 1 FROM public.house_round_beacon_pins p WHERE p.round_id=OLD.id)
        THEN RAISE EXCEPTION 'future-beacon rounds cannot be voided; await the pinned result'; END IF;
      IF NEW.cancel_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(NEW.cancel_reason)) NOT BETWEEN 1 AND 512
        OR NEW.outcome IS NOT NULL OR NEW.drawn_at IS NOT NULL
        OR (pg_catalog.to_jsonb(NEW)-ARRAY['state','cancel_reason']) IS DISTINCT FROM
           (pg_catalog.to_jsonb(OLD)-ARRAY['state','cancel_reason'])
        THEN RAISE EXCEPTION 'only an undrawn financial round can be cancelled'; END IF;
      -- Keep the missing-seed branch in PL/pgSQL: a SQL planner may evaluate
      -- the stable outcome function before filtering an empty seed subquery.
      IF EXISTS(SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=OLD.id) THEN
        IF NOT EXISTS(SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=OLD.id
          AND x.revealed_at IS NOT NULL AND x.cancelled_outcome=public.house_spin_outcome(OLD.id))
          THEN RAISE EXCEPTION 'only an undrawn financial round can be cancelled'; END IF;
      END IF;
      RETURN NEW;
    END IF;
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['state','outcome','drawn_at','cancel_reason']) IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['state','outcome','drawn_at','cancel_reason'])
      OR OLD.state <> 'OPEN' OR NEW.state <> 'DRAWN' OR NEW.outcome IS NULL
      OR NEW.outcome NOT BETWEEN 0 AND 36 OR now_ms < OLD.closes_ms THEN
      RAISE EXCEPTION 'invalid round transition or immutable result';
    END IF;
    IF OLD.mode='FINANCIAL' AND NOT EXISTS(SELECT 1 FROM public.house_round_randomness x
      WHERE x.round_id=OLD.id AND x.revealed_at IS NOT NULL AND x.cancelled_outcome IS NULL AND NEW.outcome=public.house_spin_outcome(OLD.id))
      THEN RAISE EXCEPTION 'financial draw must reveal its precommitted seed'; END IF;
    -- The caller cannot backdate the result. Pause stops new rounds, not
    -- completion of an already-open round, including recovery after downtime.
    NEW.drawn_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER house_beacon_randomness_proof AFTER INSERT OR UPDATE ON public.house_round_beacon_pins
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.house_round_randomness_constraint();
-- Keep the established setup logic intact and narrow the new metadata table
-- after it runs. Both entry points remain owner-run SECURITY INVOKER functions.
ALTER FUNCTION public.ledger_apply_runtime_grants(TEXT) RENAME TO ledger_apply_runtime_grants_seed_only;
CREATE FUNCTION public.ledger_apply_runtime_grants(runtime_role TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE cols TEXT;
BEGIN
  PERFORM public.ledger_apply_runtime_grants_seed_only(runtime_role);
  EXECUTE pg_catalog.format('REVOKE INSERT,UPDATE,DELETE ON public.house_round_beacon_pins FROM %I',runtime_role);
  SELECT pg_catalog.string_agg(pg_catalog.quote_ident(a.attname),',' ORDER BY a.attnum) INTO cols
    FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.house_round_beacon_pins'::regclass AND a.attnum>0 AND NOT a.attisdropped;
  EXECUTE pg_catalog.format('REVOKE INSERT (%s),UPDATE (%s) ON public.house_round_beacon_pins FROM %I',cols,cols,runtime_role);
END $$;
REVOKE ALL ON FUNCTION public.ledger_apply_runtime_grants(TEXT),public.ledger_apply_runtime_grants_seed_only(TEXT),
  public.house_round_beacon_guard() FROM PUBLIC;
REVOKE ALL ON public.house_round_beacon_pins FROM PUBLIC;
GRANT SELECT ON public.house_round_beacon_pins TO PUBLIC;
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.house_round_randomness_failures()) THEN
    RAISE EXCEPTION 'existing committed rounds fail forward entropy proof';
  END IF;
END $$;
COMMIT;
