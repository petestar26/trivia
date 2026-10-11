-- Free, non-transferable scores only. No stake, wallet, balance or financial ledger.
CREATE TABLE number_practice_rounds (
 id text PRIMARY KEY,
 user_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 request_id text NOT NULL CHECK(request_id ~ '^[a-zA-Z0-9_-]{16,64}$'),
 guess smallint NOT NULL CHECK(guess BETWEEN 1 AND 100),
 target smallint NOT NULL CHECK(target BETWEEN 1 AND 100),
 rules_id text NOT NULL CHECK(rules_id='number-challenge-practice-v1'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,request_id)
);
CREATE INDEX number_practice_history ON number_practice_rounds(user_id,created_at DESC,id DESC);
CREATE FUNCTION number_practice_immutable() RETURNS trigger LANGUAGE plpgsql
 SET search_path = pg_catalog, public AS $$
BEGIN RAISE EXCEPTION 'Number practice receipts are immutable'; END; $$;
CREATE TRIGGER number_practice_immutable BEFORE UPDATE OR DELETE ON number_practice_rounds
 FOR EACH ROW EXECUTE FUNCTION number_practice_immutable();
REVOKE ALL ON number_practice_rounds FROM PUBLIC;
REVOKE ALL ON FUNCTION number_practice_immutable() FROM PUBLIC;
