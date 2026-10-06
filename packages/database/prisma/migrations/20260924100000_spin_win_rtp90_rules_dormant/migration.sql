-- Publish the immutable 90% Spin Win rules without enabling Coin wagering.
-- Activation requires a separate, reviewed migration and jurisdiction decision.
-- A deployment with a modified or already-versioned catalog must stop rather
-- than silently attach these rules to a different game definition.
BEGIN;
SET LOCAL lock_timeout = '20s';
LOCK TABLE "game_definitions", "game_rules" IN SHARE ROW EXCLUSIVE MODE;

DO $rules$
DECLARE
  spin_id text;
BEGIN
  SELECT "id" INTO spin_id
  FROM "game_definitions"
  WHERE "key" = 'spin_win' AND "type" = 'SPIN_WIN'
    AND "mode" = 'WAGER' AND "family" = 'INSTANT'
    AND "wagerCurrency" = 'COINS' AND "rewardCurrency" = 'COINS'
    AND "catalogStatus" = 'COMING_SOON' AND "isActive" = false
    AND "currentRulesVersion" IS NULL AND "minBet" = 10 AND "maxBet" = 500;

  IF spin_id IS NULL OR EXISTS (
    SELECT 1 FROM "game_rules" WHERE "gameId" = spin_id
  ) THEN
    RAISE EXCEPTION 'Spin Win rules preparation stopped: disabled seed or empty rules history differs from expected state';
  END IF;

  INSERT INTO "game_rules"
    ("gameId", "version", "mode", "family", "wagerCurrency", "rewardCurrency",
     "rules", "resultSchemaVersion", "rulesHash")
  SELECT spin_id, 1, 'WAGER', 'INSTANT', 'COINS', 'COINS',
         "canonical_rules_jsonb"('{"rulesId":"single-zero-rtp90-v2"}'::jsonb),
         1, "rules_hash"('{"rulesId":"single-zero-rtp90-v2"}'::jsonb);
END
$rules$;

-- Intentionally no change to game_definitions.currentRulesVersion,
-- catalogStatus, isActive, country policies, or any player balance.
COMMIT;
