-- Migration E6: G0 — Fixed-Literal Rules Hash Verification
-- Correction of 20260922020000_g0_rules_hash_verification, written as a
-- separate migration.
--
-- The problem: the original migration's verification re-derived "expected"
-- by hashing game_definitions.configuration AT MIGRATION-RUN TIME:
--     encode(digest(d."configuration"::text, 'sha256'), 'hex')
-- That is tautological as an integrity check: "expected" is defined as
-- "whatever configuration currently says", so it can only ever catch drift
-- that happened strictly BEFORE this exact migration runs, and it proves
-- nothing about the value it is nominally protecting — a rulesHash and its
-- comparison baseline that changed together would still "match".
--
-- The fix: verify the four v1 rulesHash values against FIXED literal
-- hashes instead — copied from an already-migrated, already-verified
-- database, not derived from any column at check time. (Reproducing them
-- requires standing up a fresh database, applying migrations through the
-- seed, and reading game_rules.rulesHash directly:
--   SELECT d.key, r."rulesHash" FROM game_rules r
--   JOIN game_definitions d ON d.id = r."gameId";
-- which is how these literals were obtained.)
--
-- The literals are canonical hashes (rules_hash(), see the seed): numbers
-- compare by value, so a database whose pre-casino API wrote lucky_spin's
-- 0.10 as 0.1 verifies against the same literal as a fresh install, while
-- any real rule change (0.11, a new threshold) still fails here. The
-- pre-upgrade gate (20260917900000) refuses such a change earlier, before
-- any schema is touched.
--
-- No additional immutability trigger is needed here: game_rules rows are
-- ALREADY unconditionally immutable — see "game_rules_immutable" in
-- 20260918030000_casino_foundation_validate, which rejects every UPDATE or
-- DELETE on this table outright. A hash verified once against a fixed
-- literal therefore stays true forever, precisely because the row it
-- describes can never change under it. A future correction to a game's
-- rules ships as a NEW version row (a new gameId+version, with its own
-- fresh hash), never a mutation of an existing one.
-- The catalog and rules are read and verified below: lock them against
-- writers first, so a concurrent edit is either committed before this
-- migration reads them or waits until it has finished.
LOCK TABLE "game_definitions", "game_rules" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    bad RECORD;
    expected TEXT;
BEGIN
    FOR bad IN
        SELECT r."id", d."key", r."version", r."rulesHash"
        FROM "game_rules" r
        JOIN "game_definitions" d ON d."id" = r."gameId"
        WHERE r."version" = 1
          AND d."key" IN ('dice', 'lucky_spin', 'number_challenge', 'trivia')
    LOOP
        expected := CASE bad."key"
            WHEN 'dice' THEN 'b27e863a963398aa362d5c6732c2645d103bb636ef82730b9be66ce4257aa366'
            WHEN 'lucky_spin' THEN 'db0f5bcfe9109a753e6885dbb093c86b8e84d867778fda15e42ff8ab367b3645'
            WHEN 'number_challenge' THEN 'b90a3b891ac3d29fa466532ee3597aa0852c8deb8afd29c5a4b7a6a663c8117e'
            WHEN 'trivia' THEN 'b0b41630cf8053cde34eebfe9aca34dee1772533a6f0629bef86d7e4c903c6f9'
        END;

        IF bad."rulesHash" <> expected THEN
            RAISE EXCEPTION 'game_rules % (key=%, v=%) rulesHash mismatch against FIXED expected seed hash: expected % but stored %',
                bad."id", bad."key", bad."version", expected, bad."rulesHash";
        END IF;
    END LOOP;
END $$;
