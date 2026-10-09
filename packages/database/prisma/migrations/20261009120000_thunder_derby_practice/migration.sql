-- Separate, non-transferable practice credits. No financial ledger changes.
CREATE TABLE derby_accounts(user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT, balance bigint NOT NULL DEFAULT 1000 CHECK(balance BETWEEN 0 AND 9007199254740991));
CREATE TABLE derby_rounds(
 id text PRIMARY KEY, field integer NOT NULL CHECK(field IN(6,8)),
 opens_at timestamptz NOT NULL, starts_at timestamptz NOT NULL, finishes_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 finish_order integer[] NOT NULL, seed text NOT NULL CHECK(seed ~ '^[a-f0-9]{64}$'), commitment text NOT NULL CHECK(commitment ~ '^[a-f0-9]{64}$'),
 CHECK(ends_at=opens_at+field*interval '30 seconds' AND finishes_at=ends_at-interval '15 seconds' AND starts_at=finishes_at-interval '45 seconds')
);
CREATE TABLE derby_tickets(
 id text PRIMARY KEY, round_id text NOT NULL REFERENCES derby_rounds(id) ON DELETE RESTRICT, user_id text NOT NULL REFERENCES derby_accounts(user_id) ON DELETE RESTRICT,
 market text NOT NULL CHECK(market IN('WIN','PERFECTA','QUINELLA','TRIFECTA','TOP3','UNDER','OVER','ODD','EVEN')), picks integer[] NOT NULL,
 stake integer NOT NULL CHECK(stake BETWEEN 10 AND 500), odds_cents integer NOT NULL CHECK(odds_cents>0), payout integer CHECK(payout>=0), settled_at timestamptz,
 UNIQUE(round_id,user_id), CHECK((payout IS NULL)=(settled_at IS NULL))
);
CREATE INDEX derby_pending ON derby_tickets(round_id) WHERE payout IS NULL;
CREATE FUNCTION derby_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r public.derby_rounds; expected integer; required integer; won boolean; odds integer;
BEGIN
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='derby_rounds' AND TG_OP='UPDATE') THEN RAISE EXCEPTION 'Derby history immutable'; END IF;
 IF TG_TABLE_NAME='derby_rounds' THEN
  IF array_ndims(NEW.finish_order) IS DISTINCT FROM 1 OR array_lower(NEW.finish_order,1) IS DISTINCT FROM 1 OR cardinality(NEW.finish_order)<>NEW.field OR ARRAY(SELECT DISTINCT x FROM unnest(NEW.finish_order) x ORDER BY x) IS DISTINCT FROM ARRAY(SELECT generate_series(1,NEW.field)) THEN RAISE EXCEPTION 'Invalid finish order'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO r FROM public.derby_rounds WHERE id=NEW.round_id FOR SHARE;
 required:=CASE NEW.market WHEN 'TRIFECTA' THEN 3 WHEN 'PERFECTA' THEN 2 WHEN 'QUINELLA' THEN 2 WHEN 'WIN' THEN 1 WHEN 'TOP3' THEN 1 ELSE 0 END;
 IF (required>0 AND (array_ndims(NEW.picks) IS DISTINCT FROM 1 OR array_lower(NEW.picks,1) IS DISTINCT FROM 1)) OR cardinality(NEW.picks)<>required OR EXISTS(SELECT 1 FROM unnest(NEW.picks) p WHERE p IS NULL OR p<1 OR p>r.field) OR (SELECT count(DISTINCT p) FROM unnest(NEW.picks) p)<>required THEN RAISE EXCEPTION 'Invalid derby picks'; END IF;
 odds:=CASE NEW.market WHEN 'WIN' THEN r.field*90 WHEN 'TOP3' THEN r.field*30 WHEN 'PERFECTA' THEN r.field*(r.field-1)*90 WHEN 'QUINELLA' THEN r.field*(r.field-1)*45 WHEN 'TRIFECTA' THEN r.field*(r.field-1)*(r.field-2)*90 ELSE 180 END;
 IF NEW.odds_cents<>odds THEN RAISE EXCEPTION 'Invalid derby odds'; END IF;
 IF TG_OP='INSERT' THEN
  IF clock_timestamp()<r.opens_at OR clock_timestamp()>=r.starts_at OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Derby admission closed'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.round_id,NEW.user_id,NEW.market,NEW.picks,NEW.stake,NEW.odds_cents) IS DISTINCT FROM (OLD.id,OLD.round_id,OLD.user_id,OLD.market,OLD.picks,OLD.stake,OLD.odds_cents) OR OLD.payout IS NOT NULL OR NEW.payout IS NULL THEN RAISE EXCEPTION 'Derby ticket immutable'; END IF;
 IF clock_timestamp()<r.finishes_at OR NEW.settled_at IS DISTINCT FROM r.finishes_at THEN RAISE EXCEPTION 'Derby settlement not due'; END IF;
 won:=CASE NEW.market
 WHEN 'WIN' THEN NEW.picks[1]=r.finish_order[1]
 WHEN 'TOP3' THEN NEW.picks[1]=ANY(r.finish_order[1:3])
 WHEN 'PERFECTA' THEN NEW.picks=r.finish_order[1:2]
 WHEN 'TRIFECTA' THEN NEW.picks=r.finish_order[1:3]
 WHEN 'QUINELLA' THEN NEW.picks <@ r.finish_order[1:2]
 WHEN 'UNDER' THEN r.finish_order[1]<=r.field/2
 WHEN 'OVER' THEN r.finish_order[1]>r.field/2
 WHEN 'ODD' THEN r.finish_order[1]%2=1
 WHEN 'EVEN' THEN r.finish_order[1]%2=0 END;
 expected:=CASE WHEN won THEN floor(NEW.stake::numeric*odds/100)::integer ELSE 0 END;
 IF NEW.payout<>expected THEN RAISE EXCEPTION 'Invalid derby payout'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER derby_round_guard BEFORE INSERT OR UPDATE OR DELETE ON derby_rounds FOR EACH ROW EXECUTE FUNCTION derby_guard();
CREATE TRIGGER derby_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON derby_tickets FOR EACH ROW EXECUTE FUNCTION derby_guard();
CREATE FUNCTION derby_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
 IF TG_TABLE_NAME='derby_accounts' AND TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Derby account identity immutable'; END IF;
 SELECT balance INTO actual FROM public.derby_accounts WHERE user_id=NEW.user_id;
 SELECT 1000+COALESCE(sum(COALESCE(payout,0)-stake),0) INTO expected FROM public.derby_tickets WHERE user_id=NEW.user_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Derby balance does not match tickets'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER derby_account_check AFTER INSERT OR UPDATE ON derby_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION derby_balance_check();
CREATE CONSTRAINT TRIGGER derby_ticket_check AFTER INSERT OR UPDATE ON derby_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION derby_balance_check();
REVOKE ALL ON derby_accounts,derby_rounds,derby_tickets FROM PUBLIC;

UPDATE game_definitions SET description='Six or eight horses. Choose your finish and follow the 3D race. Free practice credits only.', "isActive"=false, "catalogStatus"='COMING_SOON', "updatedAt"=now() WHERE key='thunder_derby_3d';
