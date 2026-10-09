ALTER TYPE "GameType" ADD VALUE IF NOT EXISTS 'SKY_CRASH';
CREATE TABLE sky_crash_accounts (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 balance bigint NOT NULL DEFAULT 1000 CHECK(balance BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE sky_crash_rounds (
 id text PRIMARY KEY, opens_at timestamptz NOT NULL, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 crash_cents integer NOT NULL CHECK(crash_cents BETWEEN 100 AND 2001),
 seed text NOT NULL CHECK(seed ~ '^[a-f0-9]{64}$'), commitment text NOT NULL CHECK(commitment ~ '^[a-f0-9]{64}$'),
 CHECK(starts_at=opens_at+interval '15 seconds' AND ends_at=opens_at+interval '60 seconds')
);
CREATE TABLE sky_crash_tickets (
 id text PRIMARY KEY, round_id text NOT NULL REFERENCES sky_crash_rounds(id) ON DELETE RESTRICT,
 user_id text NOT NULL REFERENCES sky_crash_accounts(user_id) ON DELETE RESTRICT,
 stake integer NOT NULL CHECK(stake BETWEEN 10 AND 500), auto_cents integer CHECK(auto_cents BETWEEN 101 AND 2000),
 payout integer CHECK(payout>=0), paid_cents integer CHECK(paid_cents BETWEEN 0 AND 2000), settled_at timestamptz,
 UNIQUE(round_id,user_id), CHECK((payout IS NULL AND paid_cents IS NULL AND settled_at IS NULL) OR (payout IS NOT NULL AND paid_cents IS NOT NULL AND settled_at IS NOT NULL))
);
CREATE INDEX sky_crash_pending ON sky_crash_tickets(round_id) WHERE payout IS NULL;
CREATE FUNCTION sky_crash_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r public.sky_crash_rounds; crash_at timestamptz; auto_at timestamptz; expected integer; now_at timestamptz;
BEGIN
 IF TG_OP='DELETE' OR (TG_TABLE_NAME='sky_crash_rounds' AND TG_OP='UPDATE') THEN RAISE EXCEPTION 'Crash history is immutable'; END IF;
 IF TG_TABLE_NAME='sky_crash_rounds' THEN RETURN NEW; END IF;
 SELECT * INTO r FROM public.sky_crash_rounds WHERE id=NEW.round_id FOR SHARE;
 now_at:=clock_timestamp();
 IF TG_OP='INSERT' THEN
  IF now_at<r.opens_at OR now_at>=r.starts_at OR NEW.payout IS NOT NULL THEN RAISE EXCEPTION 'Crash admission closed'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id,NEW.round_id,NEW.user_id,NEW.stake,NEW.auto_cents) IS DISTINCT FROM (OLD.id,OLD.round_id,OLD.user_id,OLD.stake,OLD.auto_cents) OR OLD.payout IS NOT NULL OR NEW.payout IS NULL THEN RAISE EXCEPTION 'Crash ticket is immutable'; END IF;
 crash_at:=r.starts_at+ceil(10000*ln(r.crash_cents::double precision/100))*interval '1 millisecond';
 auto_at:=r.starts_at+ceil(10000*ln(NEW.auto_cents::double precision/100))*interval '1 millisecond';
 IF NEW.auto_cents<r.crash_cents AND now_at>=auto_at THEN
  expected:=NEW.auto_cents;
  IF NEW.settled_at IS DISTINCT FROM auto_at THEN RAISE EXCEPTION 'Crash auto receipt invalid'; END IF;
 ELSIF now_at>=crash_at THEN
  expected:=0;
  IF NEW.settled_at IS DISTINCT FROM crash_at THEN RAISE EXCEPTION 'Crash loss receipt invalid'; END IF;
 ELSE
  IF NEW.settled_at<r.starts_at OR NEW.settled_at>=crash_at OR NEW.settled_at>now_at OR now_at-NEW.settled_at>interval '1 second' THEN RAISE EXCEPTION 'Crash cashout time invalid'; END IF;
  expected:=least(2000,floor(100*exp(extract(epoch FROM NEW.settled_at-r.starts_at)*1000/10000))::integer);
 END IF;
 IF NEW.paid_cents<>expected OR NEW.payout<>floor(NEW.stake::numeric*expected/100) THEN RAISE EXCEPTION 'Crash payout invalid'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crash_round_guard BEFORE UPDATE OR DELETE ON sky_crash_rounds FOR EACH ROW EXECUTE FUNCTION sky_crash_guard();
CREATE TRIGGER crash_ticket_guard BEFORE INSERT OR UPDATE OR DELETE ON sky_crash_tickets FOR EACH ROW EXECUTE FUNCTION sky_crash_guard();
CREATE FUNCTION sky_crash_balance_check() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE actual bigint; expected bigint;
BEGIN
 IF TG_TABLE_NAME='sky_crash_accounts' AND TG_OP='UPDATE' AND NEW.user_id<>OLD.user_id THEN RAISE EXCEPTION 'Crash account identity immutable'; END IF;
 SELECT balance INTO actual FROM public.sky_crash_accounts WHERE user_id=NEW.user_id;
 SELECT 1000+COALESCE(sum(COALESCE(payout,0)-stake),0) INTO expected FROM public.sky_crash_tickets WHERE user_id=NEW.user_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Crash balance does not match tickets'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER crash_account_check AFTER INSERT OR UPDATE ON sky_crash_accounts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sky_crash_balance_check();
CREATE CONSTRAINT TRIGGER crash_ticket_check AFTER INSERT OR UPDATE ON sky_crash_tickets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sky_crash_balance_check();
REVOKE ALL ON sky_crash_accounts,sky_crash_rounds,sky_crash_tickets FROM PUBLIC;
