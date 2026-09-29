-- Migration E2: G0 — Rules Hash Verification + GameDefinition↔GameRules Agreement Guard
-- Corrections to the 20260918* migrations, written as a separate migration.
--
-- 1. Verifies the rules_hash recorded for every existing v1 rule matches the
--    deterministic canonical hash (rules_hash(), defined by the seed) of:
--    - dice / number_challenge / lucky_spin: game_definitions.configuration
--    - trivia: the fixed BONUS reward-rule JSON (the seed stores a
--      hand-written rules value for trivia, so its hash derives from that).
-- 2. Adds a trigger that prevents GameDefinition metadata (mode/family/
--    wagerCurrency/rewardCurrency) from being updated in a way that would
--    disagree with the current active GameRules row.

-- 1. HASH VERIFICATION: existing v1 rows must match the expected seed hash.
-- The catalog and rules are read and verified below: lock them against
-- writers first, so a concurrent edit is either committed before this
-- migration reads them or waits until it has finished.
-- With every writer stopped these locks are free. If a writer is still
-- running, the gate waits at most lock_timeout and then fails, changing
-- nothing, instead of hanging the deploy; a deadlock with such a writer ends
-- the same way for whichever side PostgreSQL aborts. See
-- docs/deployment/ledger-upgrade-gate.md ("If a migration fails").
SET LOCAL lock_timeout = '20s';
LOCK TABLE "game_definitions", "game_rules" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    bad RECORD;
BEGIN
    FOR bad IN
        SELECT r."id", d."key", r."version", r."rulesHash",
               CASE d."key"
                   WHEN 'trivia' THEN
                       "rules_hash"('{"correctPoints": 30, "restricted": true, "withdrawable": false}'::jsonb)
                   ELSE
                       "rules_hash"(d."configuration")
               END AS expected
        FROM "game_rules" r
        JOIN "game_definitions" d ON d."id" = r."gameId"
    LOOP
        IF bad."rulesHash" <> bad.expected THEN
            RAISE EXCEPTION 'game_rules % (key=%, v=%) rulesHash mismatch: expected % but stored %',
                bad."id", bad."key", bad."version", bad.expected, bad."rulesHash";
        END IF;
    END LOOP;
END $$;

-- 2. TRIGGER: prevent GameDefinition metadata drift from the active rules row.
CREATE OR REPLACE FUNCTION "game_definitions_prevent_metadata_drift"()
RETURNS trigger AS $$
DECLARE
    rule RECORD;
BEGIN
    -- Only guard definitions that have an active (non-null) rules pointer.
    IF NEW."currentRulesVersion" IS NOT NULL THEN
        SELECT "mode", "family", "wagerCurrency", "rewardCurrency" INTO rule
        FROM "game_rules"
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "game_definitions_prevent_metadata_drift" ON "game_definitions";
CREATE TRIGGER "game_definitions_prevent_metadata_drift"
BEFORE UPDATE OF "mode", "family", "wagerCurrency", "rewardCurrency", "currentRulesVersion" ON "game_definitions"
FOR EACH ROW EXECUTE FUNCTION "game_definitions_prevent_metadata_drift"();