-- Audit every committed cancellation; retain a unique semantic rules version.
-- This forward correction changes no gate, catalog or customer balance.
BEGIN;
SET LOCAL lock_timeout='20s';
LOCK TABLE public.game_rules, public.scheduled_game_rounds, public.house_round_randomness
  IN SHARE ROW EXCLUSIVE MODE;
-- A semantic rules ID must resolve to one immutable published row per game.
-- Refuse duplicates transactionally rather than guess a historical version.
CREATE UNIQUE INDEX game_rules_semantic_id_unique
  ON public.game_rules ("gameId", (rules->>'rulesId'))
  WHERE rules->>'rulesId' IS NOT NULL;
ALTER TABLE public.house_round_randomness ADD COLUMN cancelled_outcome INTEGER
  CHECK(cancelled_outcome BETWEEN 0 AND 36);

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
    NEW.prepared_at:=pg_catalog.clock_timestamp();
    IF NEW.commitment_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(pg_catalog.convert_to(
      'playqube:spin-win:commit:v1'||E'\n'||g.id||E'\n'||g.rules_id||E'\n'||NEW.seed_hex,'UTF8'),'sha256'::TEXT),'hex')
      THEN RAISE EXCEPTION 'randomness commitment mismatch'; END IF;
  ELSE
    IF OLD.revealed_at IS NOT NULL OR NEW.revealed_at IS NULL
      OR (pg_catalog.to_jsonb(NEW)-ARRAY['revealed_at','cancelled_outcome']) IS DISTINCT FROM
         (pg_catalog.to_jsonb(OLD)-ARRAY['revealed_at','cancelled_outcome'])
      THEN RAISE EXCEPTION 'randomness reveal is immutable'; END IF;
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
    (x.round_id IS NOT NULL AND (x.algorithm<>'sha256-rejection-u32be-v1'
      OR x.commitment_sha256 IS DISTINCT FROM pg_catalog.encode(public.digest(pg_catalog.convert_to(
       'playqube:spin-win:commit:v1'||E'\n'||g.id||E'\n'||g.rules_id||E'\n'||x.seed_hex,'UTF8'),'sha256'::TEXT),'hex')))
    OR (g.state='DRAWN' AND CASE WHEN x.round_id IS NULL OR x.revealed_at IS NULL OR x.cancelled_outcome IS NOT NULL THEN TRUE
      ELSE g.outcome IS DISTINCT FROM public.house_spin_outcome(g.id) END)
    OR (g.state='OPEN' AND (x.revealed_at IS NOT NULL OR x.cancelled_outcome IS NOT NULL))
    OR (g.state='CANCELLED' AND x.round_id IS NOT NULL AND
      (x.revealed_at IS NULL OR x.cancelled_outcome IS DISTINCT FROM public.house_spin_outcome(g.id)))
    OR EXISTS(SELECT 1 FROM public.scheduled_stake_holds h JOIN public.economic_operations o ON o.id=h.hold_operation_id
      WHERE o.snapshot->'financialTicket'->>'roundId'=g.id AND (x.round_id IS NULL OR x.prepared_at>h.created_at))
  )
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
      IF NEW.cancel_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(NEW.cancel_reason)) NOT BETWEEN 1 AND 512
        OR NEW.outcome IS NOT NULL OR NEW.drawn_at IS NOT NULL
        OR (pg_catalog.to_jsonb(NEW)-ARRAY['state','cancel_reason']) IS DISTINCT FROM
           (pg_catalog.to_jsonb(OLD)-ARRAY['state','cancel_reason'])
        OR (EXISTS(SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=OLD.id)
          AND NOT EXISTS(SELECT 1 FROM public.house_round_randomness x WHERE x.round_id=OLD.id
            AND x.revealed_at IS NOT NULL AND x.cancelled_outcome=public.house_spin_outcome(OLD.id)))
        THEN RAISE EXCEPTION 'only an undrawn financial round can be cancelled'; END IF;
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

-- Earlier dormant cancellations already froze their seed and round terms.
-- Audit them now without inventing a historical disclosure time or changing
-- any wager/payout. revealed_at records this disclosure's database time.
UPDATE public.house_round_randomness x
SET revealed_at=pg_catalog.clock_timestamp(),cancelled_outcome=public.house_spin_outcome(x.round_id)
FROM public.scheduled_game_rounds g
WHERE g.id=x.round_id AND g.state='CANCELLED' AND x.revealed_at IS NULL;
SET CONSTRAINTS ALL IMMEDIATE;
COMMIT;
