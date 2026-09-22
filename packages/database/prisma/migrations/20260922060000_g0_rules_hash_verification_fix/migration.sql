-- Migration E6: G0 — Fixed-Literal Rules Hash Verification
-- Forward-only correction of 20260922020000_g0_rules_hash_verification
-- (deployed migration is NOT edited/replaced in place).
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
-- database, not derived from any column at check time. (These literals are
-- exactly what the original migration's own verification proved correct at
-- seed time. Reproducing them requires standing up a fresh database,
-- applying migrations through the seed, and reading game_rules.rulesHash
-- directly:
--   SELECT d.key, r."rulesHash" FROM game_rules r
--   JOIN game_definitions d ON d.id = r."gameId";
-- which is how these literals were obtained.)
--
-- No additional immutability trigger is needed here: game_rules rows are
-- ALREADY unconditionally immutable — see "game_rules_immutable" in
-- 20260918030000_casino_foundation_validate, which rejects every UPDATE or
-- DELETE on this table outright. A hash verified once against a fixed
-- literal therefore stays true forever, precisely because the row it
-- describes can never change under it. A future correction to a game's
-- rules ships as a NEW version row (a new gameId+version, with its own
-- fresh hash), never a mutation of an existing one.
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
            WHEN 'lucky_spin' THEN 'c5ee330f1e2f43ef876c958e1f741072102ce878acc7f7c4104b61fbb49f5fc9'
            WHEN 'number_challenge' THEN 'b90a3b891ac3d29fa466532ee3597aa0852c8deb8afd29c5a4b7a6a663c8117e'
            WHEN 'trivia' THEN '1fc5cec60a93bafd4c6bd605992f5738316677ec0554f2fb5606b13665897d58'
        END;

        IF bad."rulesHash" <> expected THEN
            RAISE EXCEPTION 'game_rules % (key=%, v=%) rulesHash mismatch against FIXED expected seed hash: expected % but stored %',
                bad."id", bad."key", bad."version", expected, bad."rulesHash";
        END IF;
    END LOOP;
END $$;
