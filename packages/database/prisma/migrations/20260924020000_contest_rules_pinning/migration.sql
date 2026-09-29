-- Challenges and group competitions pin the exact immutable game_rules
-- version they were created under. Every round scores and snapshots from
-- that row, never from the mutable game_definitions configuration, so a
-- later rules version (a new currentRulesVersion) cannot change a contest
-- that is already running.
--
-- Existing contests were created by the pre-casino API under the legacy
-- configuration, which the pre-upgrade gate and 20260922060000 verified to
-- equal rules version 1 of every legacy game. They are pinned to their
-- game's current version, which at this point of the upgrade is exactly that
-- version 1. A contest whose game has no rules cannot be pinned: the NOT NULL
-- constraint then stops the upgrade instead of leaving it unpinned.
LOCK TABLE "game_definitions", "game_rules", "game_challenges", "group_competitions" IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE "game_challenges" ADD COLUMN "rulesVersion" INTEGER;
ALTER TABLE "group_competitions" ADD COLUMN "rulesVersion" INTEGER;

UPDATE "game_challenges" c SET "rulesVersion" = d."currentRulesVersion"
FROM "game_definitions" d WHERE d."id" = c."gameId";
UPDATE "group_competitions" c SET "rulesVersion" = d."currentRulesVersion"
FROM "game_definitions" d WHERE d."id" = c."gameId";

ALTER TABLE "game_challenges" ALTER COLUMN "rulesVersion" SET NOT NULL;
ALTER TABLE "group_competitions" ALTER COLUMN "rulesVersion" SET NOT NULL;

ALTER TABLE "game_challenges" ADD CONSTRAINT "game_challenges_rules_fkey"
  FOREIGN KEY ("gameId", "rulesVersion") REFERENCES "game_rules"("gameId", "version")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "group_competitions" ADD CONSTRAINT "group_competitions_rules_fkey"
  FOREIGN KEY ("gameId", "rulesVersion") REFERENCES "game_rules"("gameId", "version")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The pin is fixed at creation: neither the game nor the rules version of a
-- contest may change afterwards.
CREATE OR REPLACE FUNCTION "contest_rules_pin_guard"()
RETURNS trigger AS $$
BEGIN
  IF NEW."gameId" IS DISTINCT FROM OLD."gameId" OR NEW."rulesVersion" IS DISTINCT FROM OLD."rulesVersion" THEN
    RAISE EXCEPTION '% % is pinned to game % rules version %; its game and rules cannot change',
      TG_TABLE_NAME, OLD."id", OLD."gameId", OLD."rulesVersion";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "game_challenges_rules_pin_guard"
BEFORE UPDATE ON "game_challenges"
FOR EACH ROW EXECUTE FUNCTION "contest_rules_pin_guard"();
CREATE TRIGGER "group_competitions_rules_pin_guard"
BEFORE UPDATE ON "group_competitions"
FOR EACH ROW EXECUTE FUNCTION "contest_rules_pin_guard"();
