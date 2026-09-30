-- Non-financial practice selections. Never debit or credit a wallet.
BEGIN;
SET LOCAL lock_timeout = '20s';
CREATE TABLE public.scheduled_practice_tickets (
  round_id TEXT NOT NULL REFERENCES public.scheduled_game_rounds(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  bets JSONB NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (round_id, user_id)
);
CREATE INDEX scheduled_practice_tickets_user ON public.scheduled_practice_tickets(user_id, accepted_at DESC);
CREATE FUNCTION public.scheduled_practice_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.scheduled_game_rounds%ROWTYPE;
  stream_enabled BOOLEAN;
  now_ms BIGINT;
  item JSONB;
  market TEXT;
  seen TEXT[] := ARRAY[]::TEXT[];
  amount NUMERIC;
  stake NUMERIC := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'practice tickets are immutable';
  END IF;
  SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id = NEW.round_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || target.stream_id, 0));
  -- Re-read after the same lock used by admission, pause and draw workers.
  SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id = NEW.round_id;
  SELECT enabled INTO STRICT stream_enabled FROM public.scheduled_game_streams WHERE id = target.stream_id;
  now_ms := pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()) * 1000)::BIGINT;
  IF NOT stream_enabled OR target.mode <> 'PRACTICE' OR target.state <> 'OPEN'
    OR target.rules_id <> 'single-zero-rtp90-v2' OR now_ms < target.opens_ms OR now_ms >= target.closes_ms THEN
    RAISE EXCEPTION 'practice round is closed' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.users WHERE id = NEW.user_id AND status::TEXT = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active player required' USING ERRCODE = '23514'; END IF;
  IF pg_catalog.jsonb_typeof(NEW.bets) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid practice ticket' USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.jsonb_array_length(NEW.bets) NOT BETWEEN 1 AND 52 THEN
    RAISE EXCEPTION 'invalid practice ticket' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT value FROM pg_catalog.jsonb_array_elements(NEW.bets) LOOP
    IF pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR pg_catalog.jsonb_typeof(item->'marketId') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(item->'amount') IS DISTINCT FROM 'number'
      OR (item - ARRAY['marketId','amount']) <> '{}'::JSONB THEN
      RAISE EXCEPTION 'invalid practice line' USING ERRCODE = '23514';
    END IF;
    market := item->>'marketId';
    IF NOT (market ~ '^number:([0-9]|[12][0-9]|3[0-6])$' OR market ~ '^sector:[0-5]$'
      OR market ~ '^dozen:[0-2]$' OR market = ANY(ARRAY['red','black','odd','even','low','high']))
      OR market = ANY(seen) THEN
      RAISE EXCEPTION 'invalid practice market' USING ERRCODE = '23514';
    END IF;
    amount := (item->>'amount')::NUMERIC;
    IF amount < 40 OR amount > 480 OR pg_catalog.mod(amount,40) <> 0 THEN
      RAISE EXCEPTION 'invalid practice amount' USING ERRCODE = '23514';
    END IF;
    seen := pg_catalog.array_append(seen, market);
    stake := stake + amount;
  END LOOP;
  IF stake > 480 THEN RAISE EXCEPTION 'practice stake exceeds limit' USING ERRCODE = '23514'; END IF;
  NEW.accepted_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_practice_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON public.scheduled_practice_tickets
FOR EACH ROW EXECUTE FUNCTION public.scheduled_practice_ticket_guard();
CREATE TRIGGER scheduled_practice_ticket_no_truncate BEFORE TRUNCATE ON public.scheduled_practice_tickets
FOR EACH STATEMENT EXECUTE FUNCTION public.scheduled_practice_ticket_guard();
REVOKE ALL ON FUNCTION public.scheduled_practice_ticket_guard() FROM PUBLIC;
REVOKE ALL ON public.scheduled_practice_tickets FROM PUBLIC;
COMMIT;
