-- Every function this schema defines now runs with a fixed search_path: this
-- schema, then pg_temp. Without it, PostgreSQL searches a session's
-- temporary schema FIRST for table names, so an ordinary role (no superuser,
-- not the owner, only DML grants) could create TEMP tables named like the
-- ledger tables - admin_adjustment_approvals, users, economic_operations -
-- fill them with invented rows, and every guard function would read those
-- instead of the real ones. That forged an ADMIN_ADJUST with no approval.
-- With pg_temp listed last, table and type names resolve to this schema
-- first; function names are never looked up in pg_temp at all.
--
-- Extension functions (pgcrypto) are left as installed, and so are the
-- functions that run as the owner - the ledger approval functions
-- (migrations 20260924000000 and 20260924010000) and every SECURITY DEFINER
-- guard (below) - which run with the stricter fixed path pg_catalog, pg_temp
-- and schema-qualified names. Invariant I3 checks both settings, so a later
-- migration that creates a function without its pin is reported.

-- The five older SECURITY DEFINER guards run as the owner whenever they
-- fire, so, like the ledger approval functions, they resolve names only in
-- pg_catalog and name this schema's tables: an object in public that the
-- owner did not create (an exact-type `=` or `<>` on game_mode, game_family
-- or CurrencyType, which the game guards compare) is never a candidate.
--   game_sessions_validate_rules_snapshot  every wager's session row
--   game_definitions_prevent_metadata_drift  a catalog update (the runtime
--                                          role may update game_definitions)
--   game_rules_immutable                   rules updates and deletes, which
--                                          the runtime role reaches only
--                                          through a game id's ON UPDATE
--                                          CASCADE, as the owner, and which
--                                          it refuses
--   game_rules_validate_parent             rules inserts: never the runtime
--                                          role's (no INSERT on game_rules,
--                                          no cascade or procedure inserts)
--   coin_allocations_guard                 behind coin_allocations_frozen,
--                                          which fires first and refuses
--                                          every write
-- Their rules are unchanged. They are corrected here, forward, rather than
-- in migrations 20260918030000, 20260922020000 and 20260922070000, which
-- another branch also carries.
CREATE OR REPLACE FUNCTION "coin_allocations_guard"()
RETURNS trigger AS $$
DECLARE
    prov RECORD;
    existing_sum BIGINT;
BEGIN
    IF NEW."allocatedAmount" IS NULL OR NEW."allocatedAmount" < 1 THEN
        RAISE EXCEPTION 'coin_allocations: allocatedAmount must be >= 1 (got %)',
            NEW."allocatedAmount";
    END IF;

    -- Lock the provenance row FOR UPDATE: serializes every concurrent
    -- allocation attempt against the SAME lot at the database level,
    -- independent of whatever locking the calling application code did.
    SELECT "userId", "amount" INTO prov
    FROM public."coin_provenance"
    WHERE "id" = NEW."provenanceId"
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'coin_allocations: provenance % not found', NEW."provenanceId";
    END IF;

    IF prov."userId" IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'coin_allocations: userId % does not own provenance %, which belongs to %',
            NEW."userId", NEW."provenanceId", prov."userId";
    END IF;

    -- Aggregate over-allocation guard: sum every OTHER allocation already
    -- recorded against this lot (excluding this row's own prior value on an
    -- UPDATE) and refuse if adding this allocation would push the total
    -- past the lot's amount. The prior version of this trigger compared
    -- only THIS allocation's own amount to the lot total, which is silent
    -- to N allocations that individually fit but collectively overrun it.
    SELECT COALESCE(pg_catalog.sum("allocatedAmount"), 0) INTO existing_sum
    FROM public."coin_allocations"
    WHERE "provenanceId" = NEW."provenanceId" AND "id" <> NEW."id";

    IF existing_sum + NEW."allocatedAmount" > prov."amount" THEN
        RAISE EXCEPTION 'coin_allocations: allocating % (% already allocated against this lot) would exceed provenance % amount %',
            NEW."allocatedAmount", existing_sum, NEW."provenanceId", prov."amount";
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "game_rules_validate_parent"()
RETURNS trigger AS $$
DECLARE
    parent RECORD;
BEGIN
    SELECT "mode", "family", "wagerCurrency", "rewardCurrency" INTO parent
    FROM public."game_definitions" WHERE "id" = NEW."gameId";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'game_rules: parent game_definitions % not found', NEW."gameId";
    END IF;
    IF NEW."mode" <> parent."mode"
       OR NEW."family" <> parent."family"
       OR NEW."wagerCurrency" IS DISTINCT FROM parent."wagerCurrency"
       OR NEW."rewardCurrency" <> parent."rewardCurrency"
    THEN
        RAISE EXCEPTION 'game_rules % disagrees with parent game_definitions %', NEW."id", NEW."gameId";
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "game_rules_immutable"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'game_rules is immutable: UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "game_sessions_validate_rules_snapshot"()
RETURNS trigger AS $$
DECLARE
    rule RECORD;
    humanMode text;
    humanFamily text;
BEGIN
    IF NEW."rulesVersion" IS NOT NULL THEN
        SELECT "mode", "family", "wagerCurrency", "rewardCurrency" INTO rule
        FROM public."game_rules"
        WHERE "gameId" = NEW."gameId" AND "version" = NEW."rulesVersion";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'game_sessions: referenced game_rules (gameId=%, version=%) not found', NEW."gameId", NEW."rulesVersion";
        END IF;

        -- Compare Prisma enum string names (game_mode is a native enum; cast to text)
        humanMode := NEW."mode"::text;
        humanFamily := NEW."family"::text;

        IF humanMode <> rule."mode"::text
           OR humanFamily <> rule."family"::text
           OR (NEW."wagerCurrency" IS DISTINCT FROM rule."wagerCurrency")
           OR NEW."rewardCurrency" <> rule."rewardCurrency"
        THEN
            RAISE EXCEPTION 'game_sessions % rule snapshot disagrees with game_rules %', NEW."id", NEW."rulesVersion";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

CREATE OR REPLACE FUNCTION "game_definitions_prevent_metadata_drift"()
RETURNS trigger AS $$
DECLARE
    rule RECORD;
BEGIN
    -- Only guard definitions that have an active (non-null) rules pointer.
    IF NEW."currentRulesVersion" IS NOT NULL THEN
        SELECT "mode", "family", "wagerCurrency", "rewardCurrency" INTO rule
        FROM public."game_rules"
        WHERE "gameId" = NEW."id" AND "version" = NEW."currentRulesVersion";

        IF NOT FOUND THEN
            RAISE EXCEPTION 'game_definitions % (key=%) points to missing game_rules v%',
                NEW."id", NEW."key", NEW."currentRulesVersion";
        END IF;

        IF NEW."mode" <> rule."mode"
           OR NEW."family" <> rule."family"
           OR NEW."wagerCurrency" IS DISTINCT FROM rule."wagerCurrency"
           OR NEW."rewardCurrency" <> rule."rewardCurrency"
        THEN
            RAISE EXCEPTION 'game_definitions % (key=%) metadata disagrees with active game_rules v%',
                NEW."id", NEW."key", NEW."currentRulesVersion";
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

DO $pin$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND NOT (COALESCE(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=pg_catalog, pg_temp'])
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = %I, pg_temp', fn.signature, current_schema());
  END LOOP;
END
$pin$;
