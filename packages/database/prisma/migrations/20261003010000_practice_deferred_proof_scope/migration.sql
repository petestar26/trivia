-- Practice writes cannot alter the financial proof relations. Their restricted
-- writer must not need to invoke a callable financial proof function.
-- Every financial round/randomness/beacon write retains the existing check.
-- No role/privilege, gate, stream, catalog, balance, ticket or proof data changes.
BEGIN;
SET LOCAL lock_timeout = '20s';
CREATE OR REPLACE FUNCTION public.house_round_randomness_constraint() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE failure TEXT;
BEGIN
  IF TG_TABLE_NAME = 'scheduled_game_rounds' THEN
    IF NEW.mode = 'PRACTICE' THEN RETURN NULL; END IF;
  END IF;
  SELECT f.id INTO failure FROM public.house_round_randomness_failures() f LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'financial randomness proof mismatch: %', failure; END IF;
  RETURN NULL;
END $$;
COMMIT;
