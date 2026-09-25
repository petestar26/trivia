-- Migration E: Phase G0 corrective — BONUS session snapshot check
--
-- crypto.check game_sessions_snapshot_check (added in Migration D, 5g)
-- required "wagerCurrency" IS NOT NULL whenever "rulesVersion" is set.
-- That makes BONUS sessions (trivia) impossible to persist: the game_rules
-- rows for BONUS games carry a NULL wagerCurrency (see game_rules
-- mode/currency CHECK: BONUS -> wagerCurrency IS NULL), and trigger
-- game_sessions_insert_validate (Migration D, 5i) forces the session's
-- wagerCurrency to equal the referenced game_rules row -- i.e. NULL.
-- A trivia session therefore had to have wagerCurrency both NULL (5i) and
-- NOT NULL (5g), so every insert failed.
--
-- Relax the snapshot check: allow a NULL wagerCurrency on BONUS sessions
-- (still enforced to be NULL by the game_rules insert trigger), while WAGER
-- sessions keep the original "wagerCurrency must be present" requirement.
ALTER TABLE "game_sessions" DROP CONSTRAINT IF EXISTS "game_sessions_snapshot_check";

ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_snapshot_check"
    CHECK (
        "rulesVersion" IS NULL
        OR ("mode" IS NOT NULL AND "family" IS NOT NULL
            AND "rewardCurrency" IS NOT NULL
            AND "resultSchemaVersion" IS NOT NULL
            AND ("wagerCurrency" IS NOT NULL OR "mode" = 'BONUS'))
    );