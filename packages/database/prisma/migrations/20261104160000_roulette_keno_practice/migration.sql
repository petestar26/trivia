-- Original Roulette Keno. Isolated, non-redeemable practice ETB only.
CREATE TABLE rk_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 1000 CHECK (balance BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE rk_rounds (
  id text PRIMARY KEY,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  outcome jsonb,
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01',
  CHECK (closes_at=opens_at+interval '60 seconds' AND ends_at=opens_at+interval '90 seconds')
);
CREATE INDEX rk_round_due ON rk_rounds(retry_at,closes_at) WHERE outcome IS NULL;
CREATE INDEX rk_round_recent ON rk_rounds(opens_at DESC);
CREATE TABLE rk_tickets (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES rk_rounds(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES rk_accounts(user_id) ON DELETE RESTRICT,
  slot integer NOT NULL CHECK(slot BETWEEN 1 AND 10),
  market text NOT NULL CHECK(market IN ('NUMBERS','COLOR','PARITY','RANGE','ROW','COLUMN')),
  picks jsonb NOT NULL,
  amount integer NOT NULL CHECK(amount BETWEEN 5 AND 500 AND amount%5=0),
  stake integer NOT NULL CHECK(stake BETWEEN 5 AND 500),
  payout integer CHECK(payout>=0),
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01',
  UNIQUE(round_id,user_id,slot),
  CHECK (jsonb_typeof(picks)='array' AND stake=amount*jsonb_array_length(picks))
);
CREATE INDEX rk_ticket_user ON rk_tickets(user_id,round_id);
CREATE INDEX rk_ticket_due ON rk_tickets(retry_at,round_id,id) WHERE payout IS NULL;
CREATE FUNCTION rk_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE draw jsonb; opened timestamptz; cutoff timestamptz; hits integer; first_ball integer; choice integer; mult integer; lim integer;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Roulette Keno history is immutable'; END IF;
  IF TG_TABLE_NAME='rk_accounts' THEN
    IF TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Practice identity is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='rk_rounds' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.outcome IS NOT NULL THEN RAISE EXCEPTION 'New rounds must await the draw'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.opens_at,NEW.closes_at,NEW.ends_at) IS DISTINCT FROM (OLD.id,OLD.opens_at,OLD.closes_at,OLD.ends_at)
       OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR clock_timestamp()<OLD.closes_at THEN RAISE EXCEPTION 'Draw is immutable and cannot begin early'; END IF;
    IF jsonb_typeof(NEW.outcome)<>'array' OR jsonb_array_length(NEW.outcome)<>18 THEN RAISE EXCEPTION 'Invalid draw'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outcome) v WHERE v::text !~ '^([1-9]|[1-6][0-9]|7[0-2])$')
       OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(NEW.outcome) v)<>18 THEN RAISE EXCEPTION 'Invalid draw'; END IF;
  ELSE
    SELECT outcome,opens_at,closes_at INTO draw,opened,cutoff FROM public.rk_rounds WHERE id=NEW.round_id;
    IF TG_OP='INSERT' THEN
      IF draw IS NOT NULL OR clock_timestamp()<opened OR clock_timestamp()>=cutoff OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Ticket entry is closed'; END IF;
      IF jsonb_typeof(NEW.picks)<>'array' OR jsonb_array_length(NEW.picks) NOT BETWEEN 1 AND 10 THEN RAISE EXCEPTION 'Invalid picks'; END IF;
      lim:=CASE NEW.market WHEN 'NUMBERS' THEN 72 WHEN 'ROW' THEN 6 WHEN 'COLUMN' THEN 4 ELSE 2 END;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.picks) v WHERE v::text !~ '^([1-9]|[1-6][0-9]|7[0-2])$') THEN RAISE EXCEPTION 'Invalid picks'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.picks) v WHERE v::integer>lim)
         OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(NEW.picks) v)<>jsonb_array_length(NEW.picks)
         OR (NEW.market<>'NUMBERS' AND jsonb_array_length(NEW.picks)<>1) THEN RAISE EXCEPTION 'Invalid picks'; END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW)-'payout'-'retry_at') IS DISTINCT FROM (to_jsonb(OLD)-'payout'-'retry_at')
       OR OLD.payout IS NOT NULL OR NEW.payout IS NULL OR draw IS NULL OR clock_timestamp()<cutoff+interval '18 seconds' THEN RAISE EXCEPTION 'Ticket is immutable or draw is incomplete'; END IF;
    first_ball:=(draw->>0)::integer;
    choice:=(NEW.picks->>0)::integer;
    mult:=CASE NEW.market WHEN 'NUMBERS' THEN 36 WHEN 'ROW' THEN 54 WHEN 'COLUMN' THEN 36 ELSE 18 END;
    IF NEW.market='NUMBERS' THEN
      SELECT count(*) INTO hits FROM jsonb_array_elements(NEW.picks) p JOIN jsonb_array_elements(draw) d ON p.value=d.value;
    ELSE
      hits:=(CASE NEW.market
        WHEN 'COLOR' THEN (((first_ball-1)%36+1)=ANY(ARRAY[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]))=(choice=1)
        WHEN 'PARITY' THEN (first_ball%2=1)=(choice=1)
        WHEN 'RANGE' THEN (first_ball<=36)=(choice=1)
        WHEN 'ROW' THEN (first_ball-1)/12+1=choice
        WHEN 'COLUMN' THEN (first_ball-1)/18+1=choice END)::integer;
    END IF;
    IF NEW.payout<>hits*NEW.amount*mult/10 THEN RAISE EXCEPTION 'Return must match the official draw'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rk_account_guard BEFORE INSERT OR UPDATE OR DELETE ON rk_accounts FOR EACH ROW EXECUTE FUNCTION rk_guard();
CREATE TRIGGER rk_round_guard BEFORE INSERT OR UPDATE OR DELETE ON rk_rounds FOR EACH ROW EXECUTE FUNCTION rk_guard();
CREATE TRIGGER rk_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON rk_tickets FOR EACH ROW EXECUTE FUNCTION rk_guard();
CREATE TRIGGER rk_account_truncate BEFORE TRUNCATE ON rk_accounts FOR EACH STATEMENT EXECUTE FUNCTION rk_guard();
CREATE TRIGGER rk_round_truncate BEFORE TRUNCATE ON rk_rounds FOR EACH STATEMENT EXECUTE FUNCTION rk_guard();
CREATE TRIGGER rk_ticket_truncate BEFORE TRUNCATE ON rk_tickets FOR EACH STATEMENT EXECUTE FUNCTION rk_guard();
CREATE FUNCTION rk_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
  SELECT balance INTO actual FROM public.rk_accounts WHERE user_id=NEW.user_id;
  SELECT 1000+COALESCE(sum(COALESCE(payout,0)-stake),0) INTO expected FROM public.rk_tickets WHERE user_id=NEW.user_id;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Practice balance must match receipts'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rk_balance_account AFTER INSERT OR UPDATE ON rk_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rk_balance_check();
CREATE CONSTRAINT TRIGGER rk_balance_ticket AFTER INSERT OR UPDATE ON rk_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION rk_balance_check();
REVOKE ALL ON rk_accounts,rk_rounds,rk_tickets FROM PUBLIC;
REVOKE ALL ON FUNCTION rk_guard(),rk_balance_check() FROM PUBLIC;

-- Extend only Salem's already-provisioned, marked practice worker, if present.
-- No role creation, credentials, membership, financial tables or default grants.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salem_practice_worker_20261104') THEN
    IF NOT EXISTS(SELECT 1 FROM pg_roles r WHERE rolname='salem_practice_worker_20261104'
      AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
      AND shobj_description(r.oid,'pg_authid')='salem-practice-activation-20261104') THEN
      RAISE EXCEPTION 'Unexpected practice worker identity';
    END IF;
    GRANT SELECT,INSERT,UPDATE ON rk_accounts,rk_rounds,rk_tickets TO salem_practice_worker_20261104;
  END IF;
END $$;

INSERT INTO game_definitions(id,key,name,description,type,mode,family,"catalogStatus","isActive","minBet","maxBet","wagerCurrency","rewardCurrency",configuration,"updatedAt")
VALUES('salem-roulette-keno-v1','roulette_keno','Roulette Keno','18 balls. 72 numbers. Number picks and first-ball markets with separate practice bets.',
 'TURBO_KENO','WAGER','SCHEDULED_DRAW','COMING_SOON',false,5,500,'COINS','COINS','{"practiceOnly":true,"rulesId":"roulette-keno-90-v1"}',now())
ON CONFLICT(key) DO NOTHING;
