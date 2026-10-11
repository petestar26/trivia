-- Shared one-minute practice rounds. Historical instant receipts remain unchanged.
CREATE TABLE number_timed_rounds (
 id text PRIMARY KEY,
 round_number bigint NOT NULL UNIQUE CHECK(round_number >= 0),
 opens_at timestamptz NOT NULL,
 closes_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 target smallint CHECK(target BETWEEN 1 AND 100),
 CHECK(id='number-v2:' || round_number::text),
 CHECK(opens_at=to_timestamp(round_number::double precision*60)),
 CHECK(closes_at=opens_at+interval '30 seconds'),
 CHECK(ends_at=opens_at+interval '60 seconds')
);
CREATE TABLE number_timed_entries (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 round_id text NOT NULL REFERENCES number_timed_rounds(id) ON DELETE RESTRICT,
 request_id text NOT NULL CHECK(request_id ~ '^[a-zA-Z0-9_-]{16,64}$'),
 guess smallint NOT NULL CHECK(guess BETWEEN 1 AND 100),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,request_id),
 UNIQUE(user_id,round_id)
);
CREATE INDEX number_timed_history ON number_timed_entries(user_id,created_at DESC,id DESC);
CREATE FUNCTION number_timed_round_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Number rounds are immutable'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.target IS NOT NULL THEN RAISE EXCEPTION 'Number target must be drawn after entries close'; END IF;
 ELSE
   IF ROW(NEW.id,NEW.round_number,NEW.opens_at,NEW.closes_at,NEW.ends_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.round_number,OLD.opens_at,OLD.closes_at,OLD.ends_at)
      OR OLD.target IS NOT NULL OR NEW.target IS NULL OR clock_timestamp()<OLD.closes_at THEN
     RAISE EXCEPTION 'Number round transition refused';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER number_timed_round_guard BEFORE INSERT OR UPDATE OR DELETE ON number_timed_rounds
 FOR EACH ROW EXECUTE FUNCTION number_timed_round_guard();
CREATE FUNCTION number_timed_entry_guard() RETURNS trigger LANGUAGE plpgsql
 SET search_path=public,pg_temp AS $$
DECLARE r number_timed_rounds%ROWTYPE;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Number entries are immutable'; END IF;
 SELECT * INTO r FROM number_timed_rounds WHERE id=NEW.round_id FOR SHARE;
 IF NOT FOUND OR clock_timestamp()<r.opens_at OR clock_timestamp()>=r.closes_at OR r.target IS NOT NULL THEN
   RAISE EXCEPTION 'Number entry window closed' USING ERRCODE='PNC01';
 END IF;
 NEW.created_at:=clock_timestamp();
 RETURN NEW;
END; $$;
CREATE TRIGGER number_timed_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON number_timed_entries
 FOR EACH ROW EXECUTE FUNCTION number_timed_entry_guard();
REVOKE ALL ON number_timed_rounds,number_timed_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION number_timed_round_guard(),number_timed_entry_guard() FROM PUBLIC;

CREATE INDEX number_timed_due ON number_timed_rounds(closes_at) WHERE target IS NULL;
