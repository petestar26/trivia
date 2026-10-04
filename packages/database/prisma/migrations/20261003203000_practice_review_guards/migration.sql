-- Forward-only strengthening: retain every historical practice ticket/result.
CREATE INDEX system_keno_ticket_user ON system_keno_practice_tickets(user_id);
CREATE INDEX system_dice_ticket_user ON system_dice_practice_tickets(user_id);
CREATE INDEX system_keno_ticket_pending ON system_keno_practice_tickets(retry_at,round_id,id) WHERE payout IS NULL;
CREATE INDEX system_dice_ticket_pending ON system_dice_practice_tickets(retry_at,round_id,id) WHERE payout IS NULL;

CREATE OR REPLACE FUNCTION system_keno_practice_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE draw jsonb; opened timestamptz; cutoff timestamptz; hits integer;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Practice history is immutable'; END IF;
  IF TG_TABLE_NAME='system_keno_practice_rounds' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.outcome IS NOT NULL THEN RAISE EXCEPTION 'New Keno rounds must await their draw'; END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
    IF (NEW.id,NEW.opens_at,NEW.closes_at,NEW.ends_at) IS DISTINCT FROM (OLD.id,OLD.opens_at,OLD.closes_at,OLD.ends_at)
      OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR clock_timestamp()<OLD.closes_at THEN
      RAISE EXCEPTION 'Keno result is immutable and cannot draw before cutoff';
    END IF;
    IF jsonb_typeof(NEW.outcome)<>'array' OR jsonb_array_length(NEW.outcome)<>20 THEN RAISE EXCEPTION 'Invalid Keno draw'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outcome) value WHERE value::text !~ '^([1-9]|[1-7][0-9]|80)$')
      OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.outcome) value)<>20 THEN RAISE EXCEPTION 'Invalid Keno draw'; END IF;
  ELSE
    SELECT outcome,opens_at,closes_at INTO draw,opened,cutoff FROM public.system_keno_practice_rounds WHERE id=NEW.round_id;
    IF TG_OP='INSERT' THEN
      IF draw IS NOT NULL OR clock_timestamp()<opened OR clock_timestamp()>=cutoff OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Keno admission is closed'; END IF;
      IF jsonb_typeof(NEW.picks)<>'array' OR jsonb_array_length(NEW.picks) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid Keno picks'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.picks) value WHERE value::text !~ '^([1-9]|[1-7][0-9]|80)$')
        OR (SELECT count(DISTINCT value) FROM jsonb_array_elements(NEW.picks) value)<>jsonb_array_length(NEW.picks) THEN RAISE EXCEPTION 'Invalid Keno picks'; END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
    IF (NEW.id,NEW.round_id,NEW.user_id,NEW.picks,NEW.stake_per_number,NEW.stake) IS DISTINCT FROM (OLD.id,OLD.round_id,OLD.user_id,OLD.picks,OLD.stake_per_number,OLD.stake)
      OR OLD.payout IS NOT NULL OR NEW.payout IS NULL OR draw IS NULL THEN RAISE EXCEPTION 'Practice ticket is immutable'; END IF;
    SELECT count(*) INTO hits FROM jsonb_array_elements(NEW.picks) p JOIN jsonb_array_elements(draw) d ON p.value=d.value;
    IF NEW.payout<>hits*(NEW.stake_per_number/5)*18 THEN RAISE EXCEPTION 'Keno payout must match the immutable draw'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER system_keno_round_guard ON system_keno_practice_rounds;
DROP TRIGGER system_keno_ticket_guard ON system_keno_practice_tickets;
CREATE TRIGGER system_keno_round_guard BEFORE INSERT OR UPDATE OR DELETE ON system_keno_practice_rounds FOR EACH ROW EXECUTE FUNCTION system_keno_practice_guard();
CREATE TRIGGER system_keno_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON system_keno_practice_tickets FOR EACH ROW EXECUTE FUNCTION system_keno_practice_guard();
REVOKE ALL ON FUNCTION system_keno_practice_guard() FROM PUBLIC;
