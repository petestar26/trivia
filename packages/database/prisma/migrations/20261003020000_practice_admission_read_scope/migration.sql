-- Practice admission uses the existing per-stream lock and current reads.
-- The API keeps SELECT-only access to rounds/schedules. Trigger execution
-- stays SECURITY INVOKER, with its existing owner, fixed search path and ACL.
-- Stale transaction snapshots fail closed; no financial guard or data changes.
BEGIN;
SET LOCAL lock_timeout = '20s';
CREATE OR REPLACE FUNCTION public.scheduled_practice_ticket_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target public.scheduled_game_rounds%ROWTYPE;
  stream_enabled BOOLEAN;
  now_ms BIGINT;
  admitted_at TIMESTAMPTZ;
  item JSONB;
  market TEXT;
  seen TEXT[] := ARRAY[]::TEXT[];
  amount NUMERIC;
  stake NUMERIC := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'practice tickets are immutable';
  END IF;
  -- READ COMMITTED gives every trigger SELECT a current view after the stream lock.
  -- Stronger snapshots are refused instead of granting the API round/schedule writes.
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'could not serialize practice admission: read committed isolation required'
      USING ERRCODE = '40001';
  END IF;
  SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id = NEW.round_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('scheduled-round:' || target.stream_id, 0));
  -- Re-read after the same lock used by admission, pause and draw workers.
  SELECT * INTO STRICT target FROM public.scheduled_game_rounds WHERE id = NEW.round_id;
  SELECT enabled INTO STRICT stream_enabled FROM public.scheduled_game_streams WHERE id = target.stream_id;
  PERFORM 1 FROM public.users WHERE id = NEW.user_id AND status::TEXT = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'active player required' USING ERRCODE = '23514'; END IF;
  -- The acceptance timestamp and cutoff use the same clock sample, after
  -- every potentially blocking lock. Admission, pause and draw all hold the
  -- same stream lock; user status stays protected by its existing row lock.
  admitted_at := pg_catalog.clock_timestamp();
  now_ms := pg_catalog.floor(EXTRACT(EPOCH FROM admitted_at) * 1000)::BIGINT;
  IF NOT stream_enabled OR target.mode <> 'PRACTICE' OR target.state <> 'OPEN'
    OR target.rules_id <> 'single-zero-rtp90-v2' OR now_ms < target.opens_ms OR now_ms >= target.closes_ms THEN
    RAISE EXCEPTION 'practice round is closed' USING ERRCODE = '23514';
  END IF;
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
  NEW.accepted_at := admitted_at;
  RETURN NEW;
END $$;
COMMIT;
