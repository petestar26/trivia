-- Isolated virtual ETB for the provider integration pilot. No cash wallet links.
CREATE TABLE sg_test_players (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 username text NOT NULL UNIQUE CHECK(username ~ '^st_[a-f0-9]{32}$'),
 balance_cents bigint NOT NULL DEFAULT 100000 CHECK(balance_cents BETWEEN 0 AND 9000000000000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE sg_test_movements (
 call_id text PRIMARY KEY CHECK(length(call_id) BETWEEN 1 AND 256),
 username text NOT NULL REFERENCES sg_test_players(username) ON DELETE RESTRICT,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 action text NOT NULL CHECK(action IN ('debit','credit')),
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 0 AND 1000000000),
 error integer NOT NULL CHECK(error IN (0,1,2)),
 balance_cents bigint NOT NULL CHECK(balance_cents BETWEEN 0 AND 9000000000000),
 round_id text NOT NULL CHECK(length(round_id)<=256), game_id text NOT NULL CHECK(length(game_id)<=256),
 rollback boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sg_test_movements_player ON sg_test_movements(username,created_at DESC);
CREATE FUNCTION sg_test_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') OR (TG_TABLE_NAME='sg_test_movements' AND TG_OP='UPDATE') THEN RAISE EXCEPTION 'Test receipts are immutable'; END IF;
 IF TG_TABLE_NAME='sg_test_players' THEN
  IF TG_OP='INSERT' AND NEW.balance_cents<>100000 THEN RAISE EXCEPTION 'Invalid test opening balance'; END IF;
  IF TG_OP='UPDATE' AND (NEW.user_id,NEW.username,NEW.created_at) IS DISTINCT FROM (OLD.user_id,OLD.username,OLD.created_at) THEN RAISE EXCEPTION 'Test identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION sg_test_reconcile() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE expected bigint; actual bigint;
BEGIN
 SELECT balance_cents INTO actual FROM public.sg_test_players WHERE username=NEW.username;
 SELECT 100000+COALESCE(sum(CASE WHEN error<>0 THEN 0 WHEN action='debit' THEN -amount_cents ELSE amount_cents END),0) INTO expected FROM public.sg_test_movements WHERE username=NEW.username;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Test wallet does not reconcile'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sg_test_player_guard BEFORE INSERT OR UPDATE OR DELETE ON sg_test_players FOR EACH ROW EXECUTE FUNCTION sg_test_guard();
CREATE TRIGGER sg_test_movement_guard BEFORE INSERT OR UPDATE OR DELETE ON sg_test_movements FOR EACH ROW EXECUTE FUNCTION sg_test_guard();
CREATE TRIGGER sg_test_player_truncate BEFORE TRUNCATE ON sg_test_players FOR EACH STATEMENT EXECUTE FUNCTION sg_test_guard();
CREATE TRIGGER sg_test_movement_truncate BEFORE TRUNCATE ON sg_test_movements FOR EACH STATEMENT EXECUTE FUNCTION sg_test_guard();
CREATE CONSTRAINT TRIGGER sg_test_balance_player AFTER INSERT OR UPDATE ON sg_test_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sg_test_reconcile();
CREATE CONSTRAINT TRIGGER sg_test_balance_movement AFTER INSERT ON sg_test_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sg_test_reconcile();
REVOKE ALL ON sg_test_players,sg_test_movements FROM PUBLIC;
REVOKE ALL ON FUNCTION sg_test_guard(),sg_test_reconcile() FROM PUBLIC;
