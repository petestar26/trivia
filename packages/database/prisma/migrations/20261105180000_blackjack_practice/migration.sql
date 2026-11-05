-- Isolated six-seat Blackjack prediction practice; no financial wallet access.
CREATE TABLE bj_accounts(user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,balance_cents bigint NOT NULL DEFAULT 100000 CHECK(balance_cents BETWEEN 0 AND 9007199254740991));
CREATE TABLE bj_rounds(id text PRIMARY KEY,opens_at timestamptz NOT NULL UNIQUE,stage integer NOT NULL CHECK(stage BETWEEN 0 AND 3),hands jsonb NOT NULL,quotes jsonb NOT NULL,retry_at timestamptz NOT NULL DEFAULT '1970-01-01');
CREATE INDEX bj_round_recent ON bj_rounds(opens_at DESC);
CREATE INDEX bj_round_due ON bj_rounds(retry_at,opens_at) WHERE stage<3;
CREATE TABLE bj_tickets(id text PRIMARY KEY,round_id text NOT NULL REFERENCES bj_rounds(id) ON DELETE RESTRICT,user_id text NOT NULL REFERENCES bj_accounts(user_id) ON DELETE RESTRICT,slot integer NOT NULL CHECK(slot BETWEEN 1 AND 10),stage integer NOT NULL CHECK(stage BETWEEN 0 AND 2),seat integer NOT NULL CHECK(seat BETWEEN 0 AND 6),market text NOT NULL CHECK(market IN ('WIN','DRAW','LOSE','P17','P18','P19','P20','P21','BLACKJACK','BUST')),amount integer NOT NULL CHECK(amount BETWEEN 5 AND 500 AND amount%5=0),odds integer NOT NULL CHECK(odds BETWEEN 101 AND 20000),payout_cents integer CHECK(payout_cents>=0),retry_at timestamptz NOT NULL DEFAULT '1970-01-01',UNIQUE(round_id,user_id,slot),CHECK(seat>0 OR market NOT IN ('WIN','DRAW','LOSE')));
CREATE INDEX bj_ticket_user ON bj_tickets(user_id,round_id);
CREATE INDEX bj_ticket_due ON bj_tickets(retry_at,round_id,id) WHERE payout_cents IS NULL;
CREATE FUNCTION bj_total(cards jsonb) RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE c integer; score integer:=0; aces integer:=0;
BEGIN
 FOR c IN SELECT v::integer FROM jsonb_array_elements_text(cards) v LOOP
  IF c%13=0 THEN score:=score+11; aces:=aces+1; ELSE score:=score+least(c%13+1,10); END IF;
 END LOOP;
 WHILE score>21 AND aces>0 LOOP score:=score-10; aces:=aces-1; END LOOP;
 RETURN score;
END $$;
CREATE FUNCTION bj_category(cards jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT CASE WHEN public.bj_total(cards)>21 THEN 'BUST' WHEN public.bj_total(cards)=21 AND jsonb_array_length(cards)=2 THEN 'BLACKJACK' ELSE 'P'||public.bj_total(cards)::text END
$$;
CREATE FUNCTION bj_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.bj_rounds; h jsonb; old_h jsonb; prefix jsonb; i integer; j integer; expected integer; p integer; d integer; pc text; dc text; result text; q record;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Blackjack history is immutable'; END IF;
 IF TG_TABLE_NAME='bj_accounts' THEN
  IF TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Practice identity is immutable'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-'retry_at') IS NOT DISTINCT FROM (to_jsonb(OLD)-'retry_at') AND NEW.retry_at>=OLD.retry_at THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='bj_rounds' THEN
  IF jsonb_typeof(NEW.hands)<>'array' OR jsonb_array_length(NEW.hands)<>7 OR jsonb_typeof(NEW.quotes)<>'object' THEN RAISE EXCEPTION 'Invalid table'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.hands) h_row WHERE jsonb_typeof(h_row)<>'array' OR jsonb_array_length(h_row)<1 OR jsonb_array_length(h_row)>12) THEN RAISE EXCEPTION 'Invalid hands'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.hands) h_row CROSS JOIN LATERAL jsonb_array_elements(h_row) c WHERE c::text !~ '^(0|[1-9][0-9]{0,2})$' OR c::text::integer>311)
   OR (SELECT count(*)<>count(DISTINCT c) FROM jsonb_array_elements(NEW.hands) h_row CROSS JOIN LATERAL jsonb_array_elements(h_row) c) THEN RAISE EXCEPTION 'Invalid shoe'; END IF;
  IF clock_timestamp()<NEW.opens_at+NEW.stage*interval '40 seconds' THEN RAISE EXCEPTION 'Cards cannot be dealt early'; END IF;
  IF TG_OP='INSERT' THEN
   IF NEW.stage<>0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.hands) h_row WHERE jsonb_array_length(h_row)<>1) THEN RAISE EXCEPTION 'Start with one visible card per hand'; END IF;
  ELSE
   IF (NEW.id,NEW.opens_at) IS DISTINCT FROM (OLD.id,OLD.opens_at) OR NEW.stage<>OLD.stage+1 THEN RAISE EXCEPTION 'Round progression is immutable'; END IF;
   FOR i IN 0..6 LOOP
    h:=NEW.hands->i; old_h:=OLD.hands->i;
    IF jsonb_array_length(h)<jsonb_array_length(old_h) THEN RAISE EXCEPTION 'Cards cannot be removed'; END IF;
    FOR j IN 0..jsonb_array_length(old_h)-1 LOOP
     IF h->j IS DISTINCT FROM old_h->j THEN RAISE EXCEPTION 'Cards cannot change'; END IF;
    END LOOP;
    expected:=jsonb_array_length(old_h)+CASE WHEN NEW.stage=1 OR public.bj_total(old_h)<17 THEN 1 ELSE 0 END;
    IF NEW.stage<3 AND jsonb_array_length(h)<>expected THEN RAISE EXCEPTION 'Invalid dealing stage'; END IF;
    IF NEW.stage=3 THEN
     IF public.bj_total(h)<17 THEN RAISE EXCEPTION 'Showdown hand incomplete'; END IF;
     prefix:=old_h;
     IF jsonb_array_length(h)>jsonb_array_length(old_h) THEN
      FOR j IN jsonb_array_length(old_h)..jsonb_array_length(h)-1 LOOP
       IF public.bj_total(prefix)>=17 THEN RAISE EXCEPTION 'All hands stand on 17'; END IF;
       prefix:=prefix||jsonb_build_array(h->j);
      END LOOP;
     END IF;
    END IF;
   END LOOP;
  END IF;
  IF NEW.stage=3 AND NEW.quotes<>'{}'::jsonb THEN RAISE EXCEPTION 'Showdown markets must be closed'; END IF;
  FOR q IN SELECT * FROM jsonb_each(NEW.quotes) LOOP
   IF q.key !~ '^[0-6]:(WIN|DRAW|LOSE|P17|P18|P19|P20|P21|BLACKJACK|BUST)$' OR q.key IN ('0:WIN','0:DRAW','0:LOSE') OR q.value::text !~ '^[0-9]+$' OR q.value::text::integer NOT BETWEEN 101 AND 20000 THEN RAISE EXCEPTION 'Invalid quote'; END IF;
  END LOOP;
 ELSE
  SELECT * INTO r FROM public.bj_rounds WHERE id=NEW.round_id;
  IF TG_OP='INSERT' THEN
   IF NEW.payout_cents IS NOT NULL OR r.stage<>NEW.stage OR r.stage=3 OR clock_timestamp()<r.opens_at+NEW.stage*interval '40 seconds' OR clock_timestamp()>=r.opens_at+(NEW.stage+1)*interval '40 seconds' THEN RAISE EXCEPTION 'Betting stage closed'; END IF;
   IF (r.quotes->>(NEW.seat::text||':'||NEW.market))::integer IS DISTINCT FROM NEW.odds THEN RAISE EXCEPTION 'Quote has changed or market is closed'; END IF;
   RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-'payout_cents'-'retry_at') IS DISTINCT FROM (to_jsonb(OLD)-'payout_cents'-'retry_at') OR OLD.payout_cents IS NOT NULL OR NEW.payout_cents IS NULL OR r.stage<>3 OR clock_timestamp()<r.opens_at+interval '120 seconds' THEN RAISE EXCEPTION 'Ticket immutable or showdown incomplete'; END IF;
  p:=public.bj_total(r.hands->NEW.seat); d:=public.bj_total(r.hands->0); pc:=public.bj_category(r.hands->NEW.seat); dc:=public.bj_category(r.hands->0);
  result:=CASE WHEN p>21 THEN 'LOSE' WHEN d>21 THEN 'WIN' WHEN pc='BLACKJACK' AND dc<>'BLACKJACK' THEN 'WIN' WHEN dc='BLACKJACK' AND pc<>'BLACKJACK' THEN 'LOSE' WHEN p=d THEN 'DRAW' WHEN p>d THEN 'WIN' ELSE 'LOSE' END;
  expected:=CASE WHEN NEW.market=CASE WHEN NEW.market IN ('WIN','DRAW','LOSE') THEN result ELSE pc END THEN NEW.amount*NEW.odds ELSE 0 END;
  IF NEW.payout_cents<>expected THEN RAISE EXCEPTION 'Return must match official cards and locked price'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION bj_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
 SELECT balance_cents INTO actual FROM public.bj_accounts WHERE user_id=NEW.user_id;
 SELECT 100000+COALESCE(sum(COALESCE(payout_cents,0)-amount*100),0) INTO expected FROM public.bj_tickets WHERE user_id=NEW.user_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Practice balance must match receipts'; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER bj_account_guard BEFORE INSERT OR UPDATE OR DELETE ON bj_accounts FOR EACH ROW EXECUTE FUNCTION bj_guard();
CREATE TRIGGER bj_round_guard BEFORE INSERT OR UPDATE OR DELETE ON bj_rounds FOR EACH ROW EXECUTE FUNCTION bj_guard();
CREATE TRIGGER bj_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON bj_tickets FOR EACH ROW EXECUTE FUNCTION bj_guard();
CREATE TRIGGER bj_account_truncate BEFORE TRUNCATE ON bj_accounts FOR EACH STATEMENT EXECUTE FUNCTION bj_guard();
CREATE TRIGGER bj_round_truncate BEFORE TRUNCATE ON bj_rounds FOR EACH STATEMENT EXECUTE FUNCTION bj_guard();
CREATE TRIGGER bj_ticket_truncate BEFORE TRUNCATE ON bj_tickets FOR EACH STATEMENT EXECUTE FUNCTION bj_guard();
CREATE CONSTRAINT TRIGGER bj_balance_account AFTER INSERT OR UPDATE ON bj_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bj_balance_check();
CREATE CONSTRAINT TRIGGER bj_balance_ticket AFTER INSERT OR UPDATE ON bj_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bj_balance_check();
REVOKE ALL ON bj_accounts,bj_rounds,bj_tickets FROM PUBLIC;
REVOKE ALL ON FUNCTION bj_total(jsonb),bj_category(jsonb),bj_guard(),bj_balance_check() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='salem_practice_worker_20261104') THEN
  IF NOT EXISTS(SELECT 1 FROM pg_roles r WHERE rolname='salem_practice_worker_20261104' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolbypassrls AND NOT rolreplication AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AND shobj_description(r.oid,'pg_authid')='salem-practice-activation-20261104') THEN RAISE EXCEPTION 'Unexpected practice worker identity'; END IF;
  GRANT SELECT,INSERT,UPDATE ON bj_accounts,bj_rounds,bj_tickets TO salem_practice_worker_20261104;
  GRANT EXECUTE ON FUNCTION bj_total(jsonb),bj_category(jsonb) TO salem_practice_worker_20261104;
 END IF;
END $$;
INSERT INTO game_definitions(id,key,name,description,type,mode,family,"catalogStatus","isActive","minBet","maxBet","wagerCurrency","rewardCurrency",configuration,"updatedAt")
VALUES('salem-blackjack-v1','blackjack','Blackjack','Six seats. One dealer. Follow the cards and predict each hand with independent practice bets.','TURBO_KENO','WAGER','SCHEDULED_DRAW','COMING_SOON',false,5,500,'COINS','COINS','{"practiceOnly":true,"rulesId":"blackjack-six-seat-160-v1"}',now()) ON CONFLICT(key) DO NOTHING;
