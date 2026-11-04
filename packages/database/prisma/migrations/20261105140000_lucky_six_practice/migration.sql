-- Original Lucky Six. Isolated, non-redeemable practice ETB only.
CREATE TABLE ls_accounts (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance bigint NOT NULL DEFAULT 1000 CHECK (balance BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE ls_rounds (
  id text PRIMARY KEY,
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  outcome jsonb,
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01',
  CHECK (closes_at=opens_at+interval '210 seconds' AND ends_at=opens_at+interval '300 seconds')
);
CREATE INDEX ls_round_due ON ls_rounds(retry_at,closes_at) WHERE outcome IS NULL;
CREATE INDEX ls_round_recent ON ls_rounds(opens_at DESC);
CREATE TABLE ls_tickets (
  id text PRIMARY KEY,
  round_id text NOT NULL REFERENCES ls_rounds(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES ls_accounts(user_id) ON DELETE RESTRICT,
  slot integer NOT NULL CHECK(slot BETWEEN 1 AND 10),
  market text NOT NULL CHECK(market IN ('SIX','ALL_COLORS','PRE_NUMBER','FIRST_COLOR','LAST_COLOR','MOST_COLOR','FIRST_PARITY','FIRST_RANGE','PRE_PARITY','PRE_SUM','DRAW_PARITY')),
  picks jsonb NOT NULL,
  amount integer NOT NULL CHECK(amount BETWEEN 5 AND 500 AND amount%5=0),
  stake integer NOT NULL CHECK(stake BETWEEN 5 AND 500),
  payout integer CHECK(payout>=0),
  retry_at timestamptz NOT NULL DEFAULT '1970-01-01',
  UNIQUE(round_id,user_id,slot),
  CHECK (jsonb_typeof(picks)='array' AND stake=amount*(CASE WHEN market='ALL_COLORS' THEN 8 ELSE 1 END))
);
CREATE INDEX ls_ticket_user ON ls_tickets(user_id,round_id);
CREATE INDEX ls_ticket_due ON ls_tickets(retry_at,round_id,id) WHERE payout IS NULL;
CREATE FUNCTION ls_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE draw jsonb; opened timestamptz; cutoff timestamptz; hits integer; first_ball integer; choice integer; lim integer;
  nums integer[]; color_counts integer[]; leader_count integer; ties integer; pos integer; i integer; expected integer:=0; won boolean;
  multipliers integer[]:=ARRAY[150000,75000,40000,25000,16000,8000,5000,3200,2400,1600,1200,960,640,480,400,320,240,200,160,120,100,80,60,50,40,32,28,24,20,18];
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Lucky Six history is immutable'; END IF;
  IF TG_TABLE_NAME='ls_accounts' THEN
    IF TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Practice identity is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='ls_rounds' THEN
    IF TG_OP='INSERT' THEN
      IF NEW.outcome IS NOT NULL THEN RAISE EXCEPTION 'New rounds must await the draw'; END IF;
      RETURN NEW;
    END IF;
    IF (NEW.id,NEW.opens_at,NEW.closes_at,NEW.ends_at) IS DISTINCT FROM (OLD.id,OLD.opens_at,OLD.closes_at,OLD.ends_at)
       OR OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR clock_timestamp()<OLD.closes_at THEN RAISE EXCEPTION 'Draw is immutable and cannot begin early'; END IF;
    IF jsonb_typeof(NEW.outcome)<>'array' OR jsonb_array_length(NEW.outcome)<>35 THEN RAISE EXCEPTION 'Invalid draw'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.outcome) v WHERE v::text !~ '^([1-9]|[1-3][0-9]|4[0-8])$')
       OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(NEW.outcome) v)<>35 THEN RAISE EXCEPTION 'Invalid draw'; END IF;
  ELSE
    SELECT outcome,opens_at,closes_at INTO draw,opened,cutoff FROM public.ls_rounds WHERE id=NEW.round_id;
    IF TG_OP='INSERT' THEN
      IF draw IS NOT NULL OR clock_timestamp()<opened OR clock_timestamp()>=cutoff OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Ticket entry is closed'; END IF;
      IF jsonb_typeof(NEW.picks)<>'array' OR jsonb_array_length(NEW.picks)<>(CASE WHEN NEW.market='SIX' THEN 6 ELSE 1 END) THEN RAISE EXCEPTION 'Invalid picks'; END IF;
      lim:=CASE WHEN NEW.market IN ('SIX','PRE_NUMBER') THEN 48 WHEN NEW.market IN ('FIRST_COLOR','LAST_COLOR','MOST_COLOR') THEN 8 WHEN NEW.market='ALL_COLORS' THEN 1 ELSE 2 END;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.picks) v WHERE v::text !~ '^([1-9]|[1-3][0-9]|4[0-8])$') THEN RAISE EXCEPTION 'Invalid picks'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.picks) v WHERE v::integer>lim)
         OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(NEW.picks) v)<>jsonb_array_length(NEW.picks)
         OR (NEW.market<>'SIX' AND jsonb_array_length(NEW.picks)<>1) THEN RAISE EXCEPTION 'Invalid picks'; END IF;
      RETURN NEW;
    END IF;
    IF (to_jsonb(NEW)-'payout'-'retry_at') IS DISTINCT FROM (to_jsonb(OLD)-'payout'-'retry_at')
       OR OLD.payout IS NOT NULL OR NEW.payout IS NULL OR draw IS NULL OR clock_timestamp()<cutoff+interval '70 seconds' THEN RAISE EXCEPTION 'Ticket is immutable or draw is incomplete'; END IF;
    SELECT array_agg(v::integer ORDER BY ord) INTO nums FROM jsonb_array_elements_text(draw) WITH ORDINALITY AS x(v,ord);
    first_ball:=nums[1]; choice:=(NEW.picks->>0)::integer;
    IF NEW.market='SIX' THEN
      SELECT count(array_position(nums,v::integer)),max(array_position(nums,v::integer)) INTO hits,pos FROM jsonb_array_elements_text(NEW.picks) v;
      IF hits=6 THEN expected:=NEW.amount*multipliers[pos-5]/10; END IF;
    ELSIF NEW.market='ALL_COLORS' THEN
      FOR i IN 0..7 LOOP
        SELECT count(array_position(nums,i+1+n*8)),max(array_position(nums,i+1+n*8)) INTO hits,pos FROM generate_series(0,5) n;
        IF hits=6 THEN expected:=expected+NEW.amount*multipliers[pos-5]/10; END IF;
      END LOOP;
    ELSIF NEW.market='MOST_COLOR' THEN
      color_counts:=ARRAY[]::integer[];
      FOR i IN 0..7 LOOP
        SELECT count(*) INTO hits FROM unnest(nums) n WHERE (n-1)%8=i;
        color_counts:=array_append(color_counts,hits);
      END LOOP;
      SELECT max(n) INTO leader_count FROM unnest(color_counts) n;
      SELECT count(*) INTO ties FROM unnest(color_counts) n WHERE n=leader_count;
      expected:=CASE WHEN ties>1 THEN NEW.amount WHEN color_counts[choice]=leader_count THEN NEW.amount*72/10 ELSE 0 END;
    ELSE
      won:=CASE NEW.market
        WHEN 'PRE_NUMBER' THEN choice=ANY(nums[1:5])
        WHEN 'FIRST_COLOR' THEN (first_ball-1)%8+1=choice
        WHEN 'LAST_COLOR' THEN (nums[35]-1)%8+1=choice
        WHEN 'FIRST_PARITY' THEN (first_ball%2=1)=(choice=1)
        WHEN 'FIRST_RANGE' THEN (first_ball<=24)=(choice=1)
        WHEN 'PRE_PARITY' THEN ((SELECT count(*) FROM unnest(nums[1:5]) n WHERE n%2=1)>=3)=(choice=1)
        WHEN 'PRE_SUM' THEN ((SELECT sum(n) FROM unnest(nums[1:5]) n)<122.5)=(choice=1)
        WHEN 'DRAW_PARITY' THEN ((SELECT count(*) FROM unnest(nums) n WHERE n%2=1)>=18)=(choice=1) END;
      IF won THEN expected:=NEW.amount*(CASE WHEN NEW.market='PRE_NUMBER' THEN 86 WHEN NEW.market IN ('FIRST_COLOR','LAST_COLOR') THEN 72 ELSE 18 END)/10; END IF;
    END IF;
    IF NEW.payout<>expected THEN RAISE EXCEPTION 'Return must match the official draw'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ls_account_guard BEFORE INSERT OR UPDATE OR DELETE ON ls_accounts FOR EACH ROW EXECUTE FUNCTION ls_guard();
CREATE TRIGGER ls_round_guard BEFORE INSERT OR UPDATE OR DELETE ON ls_rounds FOR EACH ROW EXECUTE FUNCTION ls_guard();
CREATE TRIGGER ls_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON ls_tickets FOR EACH ROW EXECUTE FUNCTION ls_guard();
CREATE TRIGGER ls_account_truncate BEFORE TRUNCATE ON ls_accounts FOR EACH STATEMENT EXECUTE FUNCTION ls_guard();
CREATE TRIGGER ls_round_truncate BEFORE TRUNCATE ON ls_rounds FOR EACH STATEMENT EXECUTE FUNCTION ls_guard();
CREATE TRIGGER ls_ticket_truncate BEFORE TRUNCATE ON ls_tickets FOR EACH STATEMENT EXECUTE FUNCTION ls_guard();
CREATE FUNCTION ls_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
  SELECT balance INTO actual FROM public.ls_accounts WHERE user_id=NEW.user_id;
  SELECT 1000+COALESCE(sum(COALESCE(payout,0)-stake),0) INTO expected FROM public.ls_tickets WHERE user_id=NEW.user_id;
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Practice balance must match receipts'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ls_balance_account AFTER INSERT OR UPDATE ON ls_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ls_balance_check();
CREATE CONSTRAINT TRIGGER ls_balance_ticket AFTER INSERT OR UPDATE ON ls_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ls_balance_check();
REVOKE ALL ON ls_accounts,ls_rounds,ls_tickets FROM PUBLIC;
REVOKE ALL ON FUNCTION ls_guard(),ls_balance_check() FROM PUBLIC;

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
    GRANT SELECT,INSERT,UPDATE ON ls_accounts,ls_rounds,ls_tickets TO salem_practice_worker_20261104;
  END IF;
END $$;

INSERT INTO game_definitions(id,key,name,description,type,mode,family,"catalogStatus","isActive","minBet","maxBet","wagerCurrency","rewardCurrency",configuration,"updatedAt")
VALUES('salem-lucky-six-v1','lucky_six','Lucky Six','Choose six from 48. Follow 35 colored balls, with independent practice bets and five-minute rounds.',
 'TURBO_KENO','WAGER','SCHEDULED_DRAW','COMING_SOON',false,5,500,'COINS','COINS','{"practiceOnly":true,"rulesId":"lucky-six-300-v1"}',now())
ON CONFLICT(key) DO NOTHING;
