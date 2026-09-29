-- Committed game sessions are replay records: an exact replay of an
-- idempotency key returns the stored response without re-validating it, and
-- history, rules and settlement audits read the stored snapshots. The
-- insert-time validation (20260918030000, game_sessions_insert_validate)
-- therefore has to be matched by immutability after insert.
--
-- Every session this release writes is inserted already COMPLETED, together
-- with its settlement, so no session has a lifecycle transition left to
-- make: the table is append-only. Nothing may change a session's identity
-- (user, game, idempotency key, fingerprint), its request or response
-- snapshot, result, stake or reward, rules and result-schema versions, mode,
-- family, currencies, settlement currencies, play context, status or
-- completion time, and no session may be deleted. A future writer that needs
-- a pre-completion transition must add it here, precisely, in its own
-- reviewed migration.
CREATE OR REPLACE FUNCTION "game_session_immutability_guard"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'game_sessions is append-only: session % is a committed replay record and cannot be deleted', OLD."id";
  END IF;
  RAISE EXCEPTION 'game_sessions is append-only: session % is a committed replay record and cannot change', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "game_session_immutability_guard"
BEFORE UPDATE OR DELETE ON "game_sessions"
FOR EACH ROW EXECUTE FUNCTION "game_session_immutability_guard"();
