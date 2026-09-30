-- Durable result generation only. No money, tickets, or Coin activation.
BEGIN;
SET LOCAL lock_timeout = '20s';

CREATE TABLE public.scheduled_game_streams (
  id TEXT PRIMARY KEY,
  game_key TEXT NOT NULL CHECK (game_key = 'spin_win'),
  rules_id TEXT NOT NULL CHECK (rules_id = 'single-zero-rtp90-v2'),
  mode TEXT NOT NULL DEFAULT 'PRACTICE' CHECK (mode = 'PRACTICE'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  anchor_ms BIGINT NOT NULL CHECK (anchor_ms BETWEEN 0 AND 8000000000000000),
  betting_ms INTEGER NOT NULL CHECK (betting_ms BETWEEN 1 AND 3600000),
  reveal_ms INTEGER NOT NULL CHECK (reveal_ms BETWEEN 1 AND 3600000),
  result_ms INTEGER NOT NULL CHECK (result_ms BETWEEN 1 AND 3600000),
  CHECK (id ~ '^[A-Za-z0-9_-]{1,64}$')
);

CREATE TABLE public.scheduled_game_rounds (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL REFERENCES public.scheduled_game_streams(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  game_key TEXT NOT NULL,
  rules_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode = 'PRACTICE'),
  opens_ms BIGINT NOT NULL,
  closes_ms BIGINT NOT NULL,
  reveal_ends_ms BIGINT NOT NULL,
  ends_ms BIGINT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'DRAWN')),
  outcome SMALLINT CHECK (outcome BETWEEN 0 AND 36),
  drawn_at TIMESTAMPTZ,
  UNIQUE (stream_id, sequence),
  CHECK (0 <= opens_ms AND opens_ms < closes_ms AND closes_ms < reveal_ends_ms AND reveal_ends_ms < ends_ms
    AND ends_ms <= 9007199254740991),
  CHECK ((state = 'OPEN' AND outcome IS NULL AND drawn_at IS NULL)
    OR (state = 'DRAWN' AND outcome IS NOT NULL AND drawn_at IS NOT NULL))
);
CREATE INDEX scheduled_game_rounds_pending ON public.scheduled_game_rounds(stream_id, closes_ms) WHERE state = 'OPEN';

CREATE FUNCTION public.scheduled_stream_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'scheduled stream history cannot be removed';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || NEW.id, 0));
  IF TG_OP = 'UPDATE' AND (pg_catalog.to_jsonb(NEW) - 'enabled') IS DISTINCT FROM
                            (pg_catalog.to_jsonb(OLD) - 'enabled') THEN
    RAISE EXCEPTION 'schedule terms are immutable; create a new stream version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_stream_guard BEFORE INSERT OR UPDATE OR DELETE ON public.scheduled_game_streams
FOR EACH ROW EXECUTE FUNCTION public.scheduled_stream_guard();
CREATE TRIGGER scheduled_stream_no_truncate BEFORE TRUNCATE ON public.scheduled_game_streams
FOR EACH STATEMENT EXECUTE FUNCTION public.scheduled_stream_guard();

CREATE FUNCTION public.scheduled_round_guard() RETURNS trigger
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
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['state','outcome','drawn_at']) IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['state','outcome','drawn_at'])
      OR OLD.state <> 'OPEN' OR NEW.state <> 'DRAWN' OR NEW.outcome IS NULL
      OR NEW.outcome NOT BETWEEN 0 AND 36 OR now_ms < OLD.closes_ms THEN
      RAISE EXCEPTION 'invalid round transition or immutable result';
    END IF;
    -- The caller cannot backdate the result. Pause stops new rounds, not
    -- completion of an already-open round, including recovery after downtime.
    NEW.drawn_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_round_guard BEFORE INSERT OR UPDATE OR DELETE ON public.scheduled_game_rounds
FOR EACH ROW EXECUTE FUNCTION public.scheduled_round_guard();
CREATE TRIGGER scheduled_round_no_truncate BEFORE TRUNCATE ON public.scheduled_game_rounds
FOR EACH STATEMENT EXECUTE FUNCTION public.scheduled_round_guard();

REVOKE ALL ON FUNCTION public.scheduled_stream_guard(), public.scheduled_round_guard() FROM PUBLIC;
REVOKE ALL ON public.scheduled_game_streams, public.scheduled_game_rounds FROM PUBLIC;

INSERT INTO public.scheduled_game_streams
  (id, game_key, rules_id, anchor_ms, betting_ms, reveal_ms, result_ms)
VALUES ('spin-win-practice-v1', 'spin_win', 'single-zero-rtp90-v2', 0, 45000, 10000, 5000);
COMMIT;
