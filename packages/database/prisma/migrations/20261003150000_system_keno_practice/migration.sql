-- Server-scheduled free practice. These credits never enter Coin or Game Point wallets.
CREATE TABLE system_keno_practice_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 1000 CHECK (balance >= 0)
);
CREATE TABLE system_keno_practice_rounds (
  id text PRIMARY KEY,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  outcome jsonb,
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  CHECK (closes_at=opens_at+interval '45 seconds' AND ends_at=opens_at+interval '60 seconds'),
  CHECK (outcome IS NULL OR jsonb_array_length(outcome)=20)
);
CREATE INDEX system_keno_due ON system_keno_practice_rounds(closes_at) WHERE outcome IS NULL;
CREATE TABLE system_keno_practice_tickets (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES system_keno_practice_rounds(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES system_keno_practice_accounts(user_id) ON DELETE RESTRICT,
  picks jsonb NOT NULL,
  stake_per_number integer NOT NULL CHECK (stake_per_number BETWEEN 5 AND 480 AND stake_per_number%5=0),
  stake integer NOT NULL CHECK (stake BETWEEN 5 AND 480),
  payout integer CHECK (payout>=0),
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01T00:00:00Z',
  UNIQUE(round_id,user_id),
  CHECK (jsonb_array_length(picks) BETWEEN 1 AND 10 AND stake=stake_per_number*jsonb_array_length(picks))
);
CREATE FUNCTION system_keno_practice_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Practice history is immutable'; END IF;
  IF (pg_catalog.to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='system_keno_practice_rounds' THEN
    IF (NEW.id,NEW.opens_at,NEW.closes_at,NEW.ends_at) IS DISTINCT FROM (OLD.id,OLD.opens_at,OLD.closes_at,OLD.ends_at)
      OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL THEN RAISE EXCEPTION 'Round result is immutable'; END IF;
  ELSE
    IF (NEW.id,NEW.round_id,NEW.user_id,NEW.picks,NEW.stake_per_number,NEW.stake) IS DISTINCT FROM (OLD.id,OLD.round_id,OLD.user_id,OLD.picks,OLD.stake_per_number,OLD.stake)
      OR OLD.payout IS NOT NULL OR NEW.payout IS NULL THEN RAISE EXCEPTION 'Practice ticket is immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER system_keno_round_guard BEFORE UPDATE OR DELETE ON system_keno_practice_rounds FOR EACH ROW EXECUTE FUNCTION system_keno_practice_guard();
CREATE TRIGGER system_keno_ticket_guard BEFORE UPDATE OR DELETE ON system_keno_practice_tickets FOR EACH ROW EXECUTE FUNCTION system_keno_practice_guard();
CREATE FUNCTION system_keno_practice_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE who text; actual bigint; expected bigint;
BEGIN
  who:=NEW.user_id;
  SELECT balance INTO actual FROM public.system_keno_practice_accounts WHERE user_id=who;
  SELECT 1000+COALESCE(pg_catalog.sum(COALESCE(payout,0)-stake),0) INTO expected FROM public.system_keno_practice_tickets WHERE user_id=who;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Practice balance does not match tickets'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER system_keno_account_check AFTER INSERT OR UPDATE ON system_keno_practice_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION system_keno_practice_balance_check();
CREATE CONSTRAINT TRIGGER system_keno_ticket_check AFTER INSERT OR UPDATE ON system_keno_practice_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION system_keno_practice_balance_check();
REVOKE ALL ON system_keno_practice_accounts,system_keno_practice_rounds,system_keno_practice_tickets FROM PUBLIC;