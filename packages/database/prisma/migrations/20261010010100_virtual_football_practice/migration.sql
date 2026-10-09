-- Virtual Football 3D practice. Separate, non-transferable practice credits and records.
-- No Coins, no financial ledger, no wallet tables, no cash value.

CREATE TABLE football_accounts(
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 balance bigint NOT NULL DEFAULT 1000 CHECK(balance BETWEEN 0 AND 9007199254740991)
);

-- A matchweek is committed (seed hashed, fixtures priced) only inside its own selection
-- window, so history is never fabricated after the fact. Missed weeks simply have no row.
CREATE TABLE football_matchweeks(
 id text PRIMARY KEY CHECK(id ~ '^vf-s[1-9][0-9]{0,5}-w(0[1-9]|[12][0-9]|3[0-8])$'),
 season_no integer NOT NULL CHECK(season_no>=1),
 week_no integer NOT NULL CHECK(week_no BETWEEN 1 AND 38),
 rules_id text NOT NULL CHECK(rules_id ~ '^virtual-football-3d-practice-v[0-9]+$'),
 rules_digest text NOT NULL CHECK(rules_digest ~ '^[a-f0-9]{64}$'),
 opens_at timestamptz NOT NULL,
 kickoff_at timestamptz NOT NULL,
 full_time_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 seed text NOT NULL CHECK(seed ~ '^[a-f0-9]{64}$'),
 commitment text NOT NULL CHECK(commitment ~ '^[a-f0-9]{64}$'),
 UNIQUE(season_no,week_no),
 CHECK(id='vf-s'||season_no||'-w'||lpad(week_no::text,2,'0')),
 CHECK(kickoff_at=opens_at+interval '230 seconds' AND full_time_at=kickoff_at+interval '60 seconds' AND ends_at=opens_at+interval '300 seconds')
);

CREATE TABLE football_fixtures(
 id text PRIMARY KEY CHECK(id ~ '^vf-s[1-9][0-9]{0,5}-w(0[1-9]|[12][0-9]|3[0-8])-f(0[1-9]|10)$'),
 matchweek_id text NOT NULL REFERENCES football_matchweeks(id) ON DELETE RESTRICT,
 slot integer NOT NULL CHECK(slot BETWEEN 1 AND 10),
 home_club integer NOT NULL CHECK(home_club BETWEEN 1 AND 20),
 away_club integer NOT NULL CHECK(away_club BETWEEN 1 AND 20),
 home_attack integer NOT NULL CHECK(home_attack BETWEEN 50 AND 200),
 home_defence integer NOT NULL CHECK(home_defence BETWEEN 50 AND 200),
 away_attack integer NOT NULL CHECK(away_attack BETWEEN 50 AND 200),
 away_defence integer NOT NULL CHECK(away_defence BETWEEN 50 AND 200),
 offer_digest text NOT NULL CHECK(offer_digest ~ '^[a-f0-9]{64}$'),
 commitment text NOT NULL CHECK(commitment ~ '^[a-f0-9]{64}$'),
 ft_home smallint NOT NULL CHECK(ft_home BETWEEN 0 AND 6),
 ft_away smallint NOT NULL CHECK(ft_away BETWEEN 0 AND 6),
 ht_home smallint NOT NULL CHECK(ht_home BETWEEN 0 AND 6),
 ht_away smallint NOT NULL CHECK(ht_away BETWEEN 0 AND 6),
 first_scorer text NOT NULL CHECK(first_scorer IN('H','A','N')),
 goal_sides text[] NOT NULL,
 goal_halves smallint[] NOT NULL,
 goal_at_ms integer[] NOT NULL,
 UNIQUE(matchweek_id,slot),
 CHECK(home_club<>away_club AND ft_home+ft_away<=6 AND ht_home<=ft_home AND ht_away<=ft_away),
 CHECK(id LIKE matchweek_id||'-f%' AND right(id,2)=lpad(slot::text,2,'0'))
);

CREATE TABLE football_tickets(
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES football_accounts(user_id) ON DELETE RESTRICT,
 matchweek_id text NOT NULL REFERENCES football_matchweeks(id) ON DELETE RESTRICT,
 idempotency_key text NOT NULL CHECK(idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'),
 rules_id text NOT NULL,
 rules_digest text NOT NULL CHECK(rules_digest ~ '^[a-f0-9]{64}$'),
 line_count smallint NOT NULL CHECK(line_count BETWEEN 1 AND 8),
 leg_count smallint NOT NULL CHECK(leg_count BETWEEN 1 AND 20),
 total_stake integer NOT NULL CHECK(total_stake BETWEEN 5 AND 1000),
 total_return integer CHECK(total_return>=0 AND total_return<=100000),
 settled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,idempotency_key),
 CHECK((total_return IS NULL)=(settled_at IS NULL))
);
CREATE INDEX football_tickets_pending ON football_tickets(matchweek_id) WHERE settled_at IS NULL;
CREATE INDEX football_tickets_member ON football_tickets(user_id,created_at DESC);

CREATE TABLE football_ticket_lines(
 ticket_id text NOT NULL REFERENCES football_tickets(id) ON DELETE RESTRICT,
 line_no smallint NOT NULL CHECK(line_no BETWEEN 1 AND 8),
 kind text NOT NULL CHECK(kind IN('SINGLE','MULTIPLE')),
 stake integer NOT NULL CHECK(stake BETWEEN 5 AND 500),
 leg_count smallint NOT NULL CHECK(leg_count BETWEEN 1 AND 5),
 odds_product numeric NOT NULL CHECK(odds_product>0 AND scale(odds_product)=0),
 max_return integer NOT NULL CHECK(max_return BETWEEN 1 AND 50000),
 payout integer CHECK(payout>=0 AND payout<=50000),
 PRIMARY KEY(ticket_id,line_no),
 CHECK((kind='SINGLE' AND leg_count=1) OR (kind='MULTIPLE' AND leg_count BETWEEN 2 AND 5))
);

CREATE TABLE football_ticket_legs(
 ticket_id text NOT NULL,
 line_no smallint NOT NULL,
 leg_no smallint NOT NULL CHECK(leg_no BETWEEN 1 AND 5),
 fixture_id text NOT NULL REFERENCES football_fixtures(id) ON DELETE RESTRICT,
 selection text NOT NULL,
 odds_cents integer NOT NULL CHECK(odds_cents BETWEEN 110 AND 100000),
 PRIMARY KEY(ticket_id,line_no,leg_no),
 FOREIGN KEY(ticket_id,line_no) REFERENCES football_ticket_lines(ticket_id,line_no) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------------------
-- Selection grammar and evaluation. Must stay identical to packages/shared model.ts
-- (verified against all 94 selections x 295 outcomes in football.native.ts).
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION football_result(h integer, a integer) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS
$$ SELECT CASE WHEN h>a THEN '1' WHEN h=a THEN 'X' ELSE '2' END $$;

CREATE FUNCTION football_selection_valid(sel text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS
$$ SELECT COALESCE(sel ~ '^(FT:[1X2]|HT:[1X2]|HTFT:[1X2]/[1X2]|DC:(1X|12|X2)|OU:(1\.5|2\.5|3\.5):[OU]|BTTS:(FT|HT):[YN]|TG:[HA]:[YN]|TOU:[HA]:1\.5:[OU]|OE:[OE]|TOT:[0-6]|SCORE:(0-[0-6]|1-[0-5]|2-[0-4]|3-[0-3]|4-[0-2]|5-[01]|6-0)|FIRST:[HAN]|FTBTTS:[1X2]:[YN]|FTOU:[1X2]:2\.5:[OU]|EH:(-1|\+1):[1X2])$', false) $$;

CREATE FUNCTION football_leg_wins(sel text, fh integer, fa integer, hh integer, ha integer, first_s text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE p1 text:=split_part(sel,':',1); p2 text:=split_part(sel,':',2); p3 text:=split_part(sel,':',3); p4 text:=split_part(sel,':',4);
 goals integer:=fh+fa; side_goals integer;
BEGIN
 IF NOT public.football_selection_valid(sel) THEN RETURN NULL; END IF;
 CASE p1
  WHEN 'FT' THEN RETURN public.football_result(fh,fa)=p2;
  WHEN 'HT' THEN RETURN public.football_result(hh,ha)=p2;
  WHEN 'HTFT' THEN RETURN public.football_result(hh,ha)=split_part(p2,'/',1) AND public.football_result(fh,fa)=split_part(p2,'/',2);
  WHEN 'DC' THEN RETURN CASE p2 WHEN '1X' THEN fh>=fa WHEN '12' THEN fh<>fa ELSE fh<=fa END;
  WHEN 'OU' THEN RETURN CASE p3 WHEN 'O' THEN goals*10>(p2::numeric*10)::integer ELSE goals*10<(p2::numeric*10)::integer END;
  WHEN 'BTTS' THEN RETURN (CASE p2 WHEN 'FT' THEN fh>0 AND fa>0 ELSE hh>0 AND ha>0 END)=(p3='Y');
  WHEN 'TG' THEN RETURN ((CASE p2 WHEN 'H' THEN fh ELSE fa END)>0)=(p3='Y');
  WHEN 'TOU' THEN
   side_goals:=CASE p2 WHEN 'H' THEN fh ELSE fa END;
   RETURN CASE p4 WHEN 'O' THEN side_goals>=2 ELSE side_goals<=1 END;
  WHEN 'OE' THEN RETURN CASE p2 WHEN 'O' THEN goals%2=1 ELSE goals%2=0 END;
  WHEN 'TOT' THEN RETURN goals=p2::integer;
  WHEN 'SCORE' THEN RETURN fh=split_part(p2,'-',1)::integer AND fa=split_part(p2,'-',2)::integer;
  WHEN 'FIRST' THEN RETURN first_s=p2;
  WHEN 'FTBTTS' THEN RETURN public.football_result(fh,fa)=p2 AND ((fh>0 AND fa>0)=(p3='Y'));
  WHEN 'FTOU' THEN RETURN public.football_result(fh,fa)=p2 AND (CASE p4 WHEN 'O' THEN goals>=3 ELSE goals<=2 END);
  WHEN 'EH' THEN RETURN public.football_result(fh+p2::integer,fa)=p3;
  ELSE RETURN NULL;
 END CASE;
END $$;

-- ---------------------------------------------------------------------------------------
-- Row guards: immutable history, admission window, settlement only when due and exact.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION football_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE mw public.football_matchweeks; fx public.football_fixtures; tk public.football_tickets; ln public.football_ticket_lines;
 leg record; won boolean; expected integer; n integer; goal_count integer; base integer; prev integer; i integer; h_count integer; a_count integer; h1 integer; a1 integer; first_expected text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Football history immutable'; END IF;

 IF TG_TABLE_NAME='football_matchweeks' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Football matchweek immutable'; END IF;
  IF clock_timestamp()<NEW.opens_at OR clock_timestamp()>=NEW.kickoff_at THEN RAISE EXCEPTION 'Football matchweek can only be committed during its selection window'; END IF;
  RETURN NEW;
 END IF;

 IF TG_TABLE_NAME='football_fixtures' THEN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Football fixture immutable'; END IF;
  SELECT * INTO mw FROM public.football_matchweeks WHERE id=NEW.matchweek_id;
  IF clock_timestamp()<mw.opens_at OR clock_timestamp()>=mw.kickoff_at THEN RAISE EXCEPTION 'Football fixture can only be committed during its selection window'; END IF;
  IF EXISTS(SELECT 1 FROM public.football_fixtures f WHERE f.matchweek_id=NEW.matchweek_id AND (f.home_club IN(NEW.home_club,NEW.away_club) OR f.away_club IN(NEW.home_club,NEW.away_club))) THEN RAISE EXCEPTION 'Each club plays once per matchweek'; END IF;
  goal_count:=COALESCE(cardinality(NEW.goal_sides),0);
  IF goal_count>6 OR goal_count<>COALESCE(cardinality(NEW.goal_halves),0) OR goal_count<>COALESCE(cardinality(NEW.goal_at_ms),0)
   OR (goal_count>0 AND (array_ndims(NEW.goal_sides)<>1 OR array_ndims(NEW.goal_halves)<>1 OR array_ndims(NEW.goal_at_ms)<>1 OR array_lower(NEW.goal_sides,1)<>1 OR array_lower(NEW.goal_halves,1)<>1 OR array_lower(NEW.goal_at_ms,1)<>1))
   OR goal_count<>NEW.ft_home+NEW.ft_away THEN RAISE EXCEPTION 'Invalid football goal timeline'; END IF;
  h_count:=0; a_count:=0; h1:=0; a1:=0; prev:=NULL;
  FOR i IN 1..goal_count LOOP
   IF NEW.goal_sides[i] IS NULL OR NEW.goal_sides[i] NOT IN('H','A') OR NEW.goal_halves[i] IS NULL OR NEW.goal_halves[i] NOT IN(1,2) OR NEW.goal_at_ms[i] IS NULL THEN RAISE EXCEPTION 'Invalid football goal timeline'; END IF;
   base:=CASE NEW.goal_halves[i] WHEN 1 THEN 0 ELSE 32000 END;
   IF NEW.goal_at_ms[i]<base+1500 OR NEW.goal_at_ms[i]>base+26500 OR (NEW.goal_at_ms[i]-base-1500)%500<>0 THEN RAISE EXCEPTION 'Invalid football goal time'; END IF;
   IF prev IS NOT NULL AND (NEW.goal_at_ms[i]<=prev OR (NEW.goal_halves[i]=NEW.goal_halves[i-1] AND NEW.goal_at_ms[i]-prev<4000) OR NEW.goal_halves[i]<NEW.goal_halves[i-1]) THEN RAISE EXCEPTION 'Football goals must be strictly increasing'; END IF;
   prev:=NEW.goal_at_ms[i];
   IF NEW.goal_sides[i]='H' THEN h_count:=h_count+1; ELSE a_count:=a_count+1; END IF;
   IF NEW.goal_halves[i]=1 THEN IF NEW.goal_sides[i]='H' THEN h1:=h1+1; ELSE a1:=a1+1; END IF; END IF;
  END LOOP;
  IF h_count<>NEW.ft_home OR a_count<>NEW.ft_away OR h1<>NEW.ht_home OR a1<>NEW.ht_away THEN RAISE EXCEPTION 'Football score does not match goal timeline'; END IF;
  first_expected:=CASE WHEN goal_count=0 THEN 'N' ELSE NEW.goal_sides[1] END;
  IF NEW.first_scorer IS DISTINCT FROM first_expected THEN RAISE EXCEPTION 'Football first scorer does not match goal timeline'; END IF;
  RETURN NEW;
 END IF;

 IF TG_TABLE_NAME='football_tickets' THEN
  SELECT * INTO mw FROM public.football_matchweeks WHERE id=NEW.matchweek_id;
  IF TG_OP='INSERT' THEN
   IF clock_timestamp()<mw.opens_at OR clock_timestamp()>=mw.kickoff_at OR NEW.total_return IS NOT NULL OR NEW.settled_at IS NOT NULL THEN RAISE EXCEPTION 'Football admission closed'; END IF;
   IF NEW.rules_id<>mw.rules_id OR NEW.rules_digest<>mw.rules_digest THEN RAISE EXCEPTION 'Football rules mismatch'; END IF;
   IF (SELECT count(*) FROM public.football_tickets t WHERE t.user_id=NEW.user_id AND t.matchweek_id=NEW.matchweek_id)>=10 THEN RAISE EXCEPTION 'Football ticket limit reached'; END IF;
   RETURN NEW;
  END IF;
  IF (NEW.id,NEW.user_id,NEW.matchweek_id,NEW.idempotency_key,NEW.request_hash,NEW.receipt_hash,NEW.rules_id,NEW.rules_digest,NEW.line_count,NEW.leg_count,NEW.total_stake,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.user_id,OLD.matchweek_id,OLD.idempotency_key,OLD.request_hash,OLD.receipt_hash,OLD.rules_id,OLD.rules_digest,OLD.line_count,OLD.leg_count,OLD.total_stake,OLD.created_at)
   OR OLD.total_return IS NOT NULL OR NEW.total_return IS NULL THEN RAISE EXCEPTION 'Football receipt immutable'; END IF;
  IF clock_timestamp()<mw.full_time_at OR NEW.settled_at IS DISTINCT FROM mw.full_time_at THEN RAISE EXCEPTION 'Football settlement not due'; END IF;
  SELECT count(*) INTO n FROM public.football_ticket_lines l WHERE l.ticket_id=NEW.id AND l.payout IS NOT NULL;
  IF n<>NEW.line_count OR NEW.total_return IS DISTINCT FROM (SELECT sum(l.payout) FROM public.football_ticket_lines l WHERE l.ticket_id=NEW.id) THEN RAISE EXCEPTION 'Invalid football settled return'; END IF;
  RETURN NEW;
 END IF;

 IF TG_TABLE_NAME='football_ticket_lines' THEN
  SELECT * INTO tk FROM public.football_tickets WHERE id=NEW.ticket_id;
  SELECT * INTO mw FROM public.football_matchweeks WHERE id=tk.matchweek_id;
  IF TG_OP='INSERT' THEN
   IF clock_timestamp()<mw.opens_at OR clock_timestamp()>=mw.kickoff_at OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Football admission closed'; END IF;
   RETURN NEW;
  END IF;
  IF (NEW.ticket_id,NEW.line_no,NEW.kind,NEW.stake,NEW.leg_count,NEW.odds_product,NEW.max_return) IS DISTINCT FROM (OLD.ticket_id,OLD.line_no,OLD.kind,OLD.stake,OLD.leg_count,OLD.odds_product,OLD.max_return)
   OR OLD.payout IS NOT NULL OR NEW.payout IS NULL THEN RAISE EXCEPTION 'Football line immutable'; END IF;
  IF clock_timestamp()<mw.full_time_at THEN RAISE EXCEPTION 'Football settlement not due'; END IF;
  won:=true; n:=0;
  FOR leg IN SELECT l.selection,f.ft_home,f.ft_away,f.ht_home,f.ht_away,f.first_scorer FROM public.football_ticket_legs l JOIN public.football_fixtures f ON f.id=l.fixture_id WHERE l.ticket_id=NEW.ticket_id AND l.line_no=NEW.line_no LOOP
   n:=n+1;
   IF NOT public.football_leg_wins(leg.selection,leg.ft_home,leg.ft_away,leg.ht_home,leg.ht_away,leg.first_scorer) THEN won:=false; END IF;
  END LOOP;
  IF n<>NEW.leg_count THEN RAISE EXCEPTION 'Football line legs incomplete'; END IF;
  expected:=CASE WHEN won THEN floor(NEW.stake::numeric*NEW.odds_product/power(100::numeric,NEW.leg_count::numeric))::integer ELSE 0 END;
  IF NEW.payout<>expected THEN RAISE EXCEPTION 'Invalid football payout'; END IF;
  RETURN NEW;
 END IF;

 -- football_ticket_legs
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Football selection immutable'; END IF;
 SELECT * INTO tk FROM public.football_tickets WHERE id=NEW.ticket_id;
 SELECT * INTO mw FROM public.football_matchweeks WHERE id=tk.matchweek_id;
 IF clock_timestamp()<mw.opens_at OR clock_timestamp()>=mw.kickoff_at THEN RAISE EXCEPTION 'Football admission closed'; END IF;
 SELECT * INTO fx FROM public.football_fixtures WHERE id=NEW.fixture_id;
 IF fx.matchweek_id IS DISTINCT FROM tk.matchweek_id THEN RAISE EXCEPTION 'Selection is not in this matchweek'; END IF;
 IF NOT public.football_selection_valid(NEW.selection) THEN RAISE EXCEPTION 'Invalid football selection'; END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER football_matchweek_guard BEFORE INSERT OR UPDATE OR DELETE ON football_matchweeks FOR EACH ROW EXECUTE FUNCTION football_guard();
CREATE TRIGGER football_fixture_guard BEFORE INSERT OR UPDATE OR DELETE ON football_fixtures FOR EACH ROW EXECUTE FUNCTION football_guard();
CREATE TRIGGER football_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON football_tickets FOR EACH ROW EXECUTE FUNCTION football_guard();
CREATE TRIGGER football_line_guard BEFORE INSERT OR UPDATE OR DELETE ON football_ticket_lines FOR EACH ROW EXECUTE FUNCTION football_guard();
CREATE TRIGGER football_leg_guard BEFORE INSERT OR UPDATE OR DELETE ON football_ticket_legs FOR EACH ROW EXECUTE FUNCTION football_guard();

-- ---------------------------------------------------------------------------------------
-- Deferred whole-ticket integrity and account conservation. Flushed before success.
-- ---------------------------------------------------------------------------------------
CREATE FUNCTION football_ticket_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE tid text; tk public.football_tickets; ln record; product numeric; n integer; total_legs integer:=0; total_max integer:=0; lg record; sigs integer; mx integer;
BEGIN
 tid:=CASE TG_TABLE_NAME WHEN 'football_tickets' THEN NEW.id ELSE NEW.ticket_id END;
 SELECT * INTO tk FROM public.football_tickets WHERE id=tid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Football ticket missing'; END IF;
 IF (SELECT count(*) FROM public.football_ticket_lines l WHERE l.ticket_id=tid)<>tk.line_count
  OR (SELECT COALESCE(sum(l.stake),0) FROM public.football_ticket_lines l WHERE l.ticket_id=tid)<>tk.total_stake
  OR (SELECT count(DISTINCT l.line_no) FILTER (WHERE l.line_no BETWEEN 1 AND tk.line_count) FROM public.football_ticket_lines l WHERE l.ticket_id=tid)<>tk.line_count THEN RAISE EXCEPTION 'Invalid football ticket lines'; END IF;
 FOR ln IN SELECT * FROM public.football_ticket_lines l WHERE l.ticket_id=tid ORDER BY l.line_no LOOP
  product:=1; n:=0;
  FOR lg IN SELECT * FROM public.football_ticket_legs g WHERE g.ticket_id=tid AND g.line_no=ln.line_no ORDER BY g.leg_no LOOP
   n:=n+1;
   IF lg.leg_no<>n THEN RAISE EXCEPTION 'Invalid football leg order'; END IF;
   product:=product*lg.odds_cents;
  END LOOP;
  IF n<>ln.leg_count OR product<>ln.odds_product THEN RAISE EXCEPTION 'Invalid football line odds'; END IF;
  IF (SELECT count(DISTINCT g.fixture_id) FROM public.football_ticket_legs g WHERE g.ticket_id=tid AND g.line_no=ln.line_no)<>n THEN RAISE EXCEPTION 'A multiple takes one selection per match'; END IF;
  IF floor(product/power(100::numeric,(n-1)::numeric))>1000000 THEN RAISE EXCEPTION 'Football combined odds above limit'; END IF;
  mx:=floor(ln.stake::numeric*product/power(100::numeric,n::numeric))::integer;
  IF ln.max_return<>mx OR mx>50000 THEN RAISE EXCEPTION 'Invalid football line return'; END IF;
  total_legs:=total_legs+n; total_max:=total_max+mx;
 END LOOP;
 IF total_legs<>tk.leg_count OR total_max>100000 THEN RAISE EXCEPTION 'Invalid football ticket totals'; END IF;
 SELECT count(DISTINCT sig) INTO sigs FROM (SELECT l.line_no, l.kind||'|'||string_agg(g.fixture_id||'#'||g.selection,',' ORDER BY g.fixture_id,g.selection) AS sig FROM public.football_ticket_lines l JOIN public.football_ticket_legs g ON g.ticket_id=l.ticket_id AND g.line_no=l.line_no WHERE l.ticket_id=tid GROUP BY l.line_no,l.kind) s;
 IF sigs<>tk.line_count THEN RAISE EXCEPTION 'Duplicate football lines'; END IF;
 IF tk.total_return IS NOT NULL AND tk.total_return IS DISTINCT FROM (SELECT sum(l.payout) FROM public.football_ticket_lines l WHERE l.ticket_id=tid) THEN RAISE EXCEPTION 'Invalid football settled return'; END IF;
 RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER football_ticket_integrity_t AFTER INSERT OR UPDATE ON football_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football_ticket_integrity();
CREATE CONSTRAINT TRIGGER football_ticket_integrity_l AFTER INSERT OR UPDATE ON football_ticket_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football_ticket_integrity();
CREATE CONSTRAINT TRIGGER football_ticket_integrity_g AFTER INSERT OR UPDATE ON football_ticket_legs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football_ticket_integrity();

CREATE FUNCTION football_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
 IF TG_TABLE_NAME='football_accounts' AND TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Football account identity immutable'; END IF;
 SELECT balance INTO actual FROM public.football_accounts WHERE user_id=NEW.user_id;
 SELECT 1000+COALESCE(sum(COALESCE(total_return,0)-total_stake),0) INTO expected FROM public.football_tickets WHERE user_id=NEW.user_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Football balance does not match tickets'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER football_account_balance AFTER INSERT OR UPDATE ON football_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football_balance_check();
CREATE CONSTRAINT TRIGGER football_ticket_balance AFTER INSERT OR UPDATE ON football_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION football_balance_check();

REVOKE ALL ON football_accounts,football_matchweeks,football_fixtures,football_tickets,football_ticket_lines,football_ticket_legs FROM PUBLIC;
