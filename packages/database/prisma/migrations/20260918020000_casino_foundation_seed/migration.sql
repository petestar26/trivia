-- Migration C: Casino Foundation - Seed + Backfill
-- Backfills existing games, seeds 13 catalog entries, creates immutable rules v1,
-- activates current_rules_version pointers. Uses ON CONFLICT DO NOTHING for
-- immutable rules.

-- The catalog and rules are read and verified below: lock them against
-- writers first, so a concurrent edit is either committed before this
-- migration reads them or waits until it has finished.
LOCK TABLE "game_definitions", "game_rules" IN SHARE ROW EXCLUSIVE MODE;

-- 0. Insert the 4 original game definitions if absent (they are normally
--    seeded at API runtime; a migration-fresh DB must be self-contained).
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'lucky_spin', 'Lucky Spin',
    'Spin the wheel and try your luck! Different segments offer different multipliers.',
    'LUCKY_SPIN', 'WAGER', 'INSTANT', 'RETIRED', true, 10, 500,
    'COINS', 'COINS',
    '{"outcomes": [{"name": "LOSE", "multiplier": 0, "probability": 0.45}, {"name": "SMALL_WIN", "multiplier": 1.5, "probability": 0.25}, {"name": "MEDIUM_WIN", "multiplier": 3, "probability": 0.15}, {"name": "LARGE_WIN", "multiplier": 5, "probability": 0.10}, {"name": "JACKPOT", "multiplier": 10, "probability": 0.05}]}',
    now()
) ON CONFLICT ("key") DO NOTHING;

INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'dice', 'Dice',
    'Roll the dice! A sum of 7 or higher doubles your bet.',
    'DICE', 'WAGER', 'INSTANT', 'AVAILABLE', true, 5, 1000,
    'COINS', 'COINS',
    '{"winThreshold": 7, "multiplier": 2}',
    now()
) ON CONFLICT ("key") DO NOTHING;

INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'number_challenge', 'Number Challenge',
    'Guess a number between 1 and 100. The closer you are, the more you win!',
    'NUMBER_CHALLENGE', 'WAGER', 'INSTANT', 'AVAILABLE', true, 10, 200,
    'COINS', 'COINS',
    '{"range": {"min": 1, "max": 100}, "rewards": {"exact": 5, "within1": 3, "within5": 2, "within10": 1.5}}',
    now()
) ON CONFLICT ("key") DO NOTHING;

INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'trivia', 'Trivia',
    'Answer trivia questions correctly to earn rewards!',
    'TRIVIA', 'BONUS', 'INSTANT', 'AVAILABLE', true, 5, 100,
    NULL, 'COINS',
    '{"correctMultiplier": 3}',
    now()
) ON CONFLICT ("key") DO NOTHING;

-- 1. Backfill existing game_definitions with mode/family/currencies/catalog_status
-- lucky_spin (legacy) -> RETIRED, keeps its id, gets legacy rules v1
UPDATE "game_definitions" SET
    "mode" = 'WAGER',
    "family" = 'INSTANT',
    "catalogStatus" = 'RETIRED',
    "wagerCurrency" = 'COINS',
    "rewardCurrency" = 'COINS'
WHERE "key" = 'lucky_spin';

-- dice -> AVAILABLE, COINS wager, INSTANT
UPDATE "game_definitions" SET
    "mode" = 'WAGER',
    "family" = 'INSTANT',
    "catalogStatus" = 'AVAILABLE',
    "wagerCurrency" = 'COINS',
    "rewardCurrency" = 'COINS'
WHERE "key" = 'dice';

-- number_challenge -> AVAILABLE, COINS wager, INSTANT
UPDATE "game_definitions" SET
    "mode" = 'WAGER',
    "family" = 'INSTANT',
    "catalogStatus" = 'AVAILABLE',
    "wagerCurrency" = 'COINS',
    "rewardCurrency" = 'COINS'
WHERE "key" = 'number_challenge';

-- trivia -> AVAILABLE, BONUS, COINS reward (restricted), INSTANT
UPDATE "game_definitions" SET
    "mode" = 'BONUS',
    "family" = 'INSTANT',
    "catalogStatus" = 'AVAILABLE',
    "wagerCurrency" = NULL,
    "rewardCurrency" = 'COINS'
WHERE "key" = 'trivia';

-- 2. Seed the 9 coming-soon games + Spin Win itself
-- spin_win (Spin Win) - COMING_SOON, COINS wager, INSTANT
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'spin_win', 'Spin Win',
    'Spin the wheel and try your luck! Different segments offer different multipliers.',
    'SPIN_WIN', 'WAGER', 'INSTANT', 'COMING_SOON', false, 10, 500,
    'COINS', 'COINS',
    '{"outcomes": [{"name": "LOSE", "multiplier": 0, "probability": 0.45}, {"name": "SMALL_WIN", "multiplier": 1.5, "probability": 0.25}, {"name": "MEDIUM_WIN", "multiplier": 3, "probability": 0.15}, {"name": "LARGE_WIN", "multiplier": 5, "probability": 0.10}, {"name": "JACKPOT", "multiplier": 10, "probability": 0.05}]}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- thunder_derby_3d
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'thunder_derby_3d', 'Thunder Derby 3D',
    'Race through the thunder in this high-octane 3D derby.',
    'THUNDER_DERBY_3D', 'WAGER', 'SCHEDULED_RACE', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- neon_hounds_3d
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'neon_hounds_3d', 'Neon Hounds 3D',
    'Chase neon prey through a cyberpunk cityscape.',
    'NEON_HOUNDS_3D', 'WAGER', 'SCHEDULED_RACE', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- turbo_circuit_3d
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'turbo_circuit_3d', 'Turbo Circuit 3D',
    'Master the turbo circuit in this 3D racing challenge.',
    'TURBO_CIRCUIT_3D', 'WAGER', 'SCHEDULED_RACE', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- starfall_nebula
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'starfall_nebula', 'Starfall Nebula',
    'Navigate the starfall nebula and collect cosmic rewards.',
    'STARFALL_NEBULA', 'WAGER', 'SCHEDULED_DRAW', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- jungle_dash_3d
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'jungle_dash_3d', 'Jungle Dash 3D',
    'Dash through the jungle in this 3D adventure.',
    'JUNGLE_DASH_3D', 'WAGER', 'SCHEDULED_RACE', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- turbo_keno
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'turbo_keno', 'Turbo Keno',
    'Fast-paced keno with turbo multipliers.',
    'TURBO_KENO', 'WAGER', 'SCHEDULED_DRAW', 'COMING_SOON', false, 5, 500,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- crystal_trail
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'crystal_trail', 'Crystal Trail',
    'Follow the crystal trail to uncover hidden treasures.',
    'CRYSTAL_TRAIL', 'WAGER', 'SCHEDULED_DRAW', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- heat_vault
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'heat_vault', 'Heat Vault',
    'Crack the heat vault and claim the molten rewards.',
    'HEAT_VAULT', 'WAGER', 'INSTANT', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- strait_rush
INSERT INTO "game_definitions" ("id", "key", "name", "description", "type", "mode", "family", "catalogStatus", "isActive", "minBet", "maxBet", "wagerCurrency", "rewardCurrency", "configuration", "updatedAt")
VALUES (
    gen_random_uuid()::text, 'strait_rush', 'Strait Rush',
    'Race through the strait in this high-speed rush.',
    'STRAIT_RUSH', 'WAGER', 'SCHEDULED_RACE', 'COMING_SOON', false, 10, 1000,
    'COINS', 'COINS', '{}'
, now()
) ON CONFLICT ("key") DO NOTHING;

-- countable: 13 AVAILABLE/COMING_SOON entries after legacy lucky_spin (RETIRED)
-- Public catalog = AVAILABLE + COMING_SOON, RETIRED excluded.

-- 3. Insert immutable rules v1:
--    dice, number_challenge, lucky_spin (legacy) -> WAGER/COINS
--    trivia -> BONUS/NULL wager/COINS reward (restricted coins)
--
-- Rules are stored and hashed in canonical form. Every number is normalized
-- by value (0.1, 0.10 and 1e-1 are one number and hash the same), object keys
-- follow jsonb's fixed order and arrays keep theirs. Two rules documents hash
-- equally exactly when they are equal as jsonb, so a real rule change (0.11)
-- still changes the hash while a writer's number formatting does not: the
-- pre-casino API stores lucky_spin's 0.10 as 0.1, and an upgraded database
-- must end with the same rules and hash as a fresh one.
CREATE OR REPLACE FUNCTION "canonical_rules_jsonb"(document jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT CASE jsonb_typeof(document)
    WHEN 'object' THEN COALESCE(
      (SELECT jsonb_object_agg(member.key, "canonical_rules_jsonb"(member.value))
       FROM jsonb_each(document) AS member),
      '{}'::jsonb)
    WHEN 'array' THEN COALESCE(
      (SELECT jsonb_agg("canonical_rules_jsonb"(element.value) ORDER BY element.position)
       FROM jsonb_array_elements(document) WITH ORDINALITY AS element(value, position)),
      '[]'::jsonb)
    WHEN 'number' THEN to_jsonb(trim_scale((document #>> '{}')::numeric))
    ELSE document
  END
$$;

CREATE OR REPLACE FUNCTION "rules_hash"(document jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT encode(digest("canonical_rules_jsonb"(document)::text, 'sha256'), 'hex')
$$;

INSERT INTO "game_rules" ("gameId", "version", "mode", "family", "wagerCurrency", "rewardCurrency", "rules", "resultSchemaVersion", "rulesHash")
SELECT d."id", 1, d."mode", d."family", d."wagerCurrency", d."rewardCurrency",
       "canonical_rules_jsonb"(d."configuration"),
       1,
       "rules_hash"(d."configuration")
FROM "game_definitions" d
WHERE d."key" = 'lucky_spin'
ON CONFLICT DO NOTHING;

INSERT INTO "game_rules" ("gameId", "version", "mode", "family", "wagerCurrency", "rewardCurrency", "rules", "resultSchemaVersion", "rulesHash")
SELECT d."id", 1, d."mode", d."family", d."wagerCurrency", d."rewardCurrency",
       "canonical_rules_jsonb"(d."configuration"),
       1,
       "rules_hash"(d."configuration")
FROM "game_definitions" d
WHERE d."key" = 'dice'
ON CONFLICT DO NOTHING;

INSERT INTO "game_rules" ("gameId", "version", "mode", "family", "wagerCurrency", "rewardCurrency", "rules", "resultSchemaVersion", "rulesHash")
SELECT d."id", 1, d."mode", d."family", d."wagerCurrency", d."rewardCurrency",
       "canonical_rules_jsonb"(d."configuration"),
       1,
       "rules_hash"(d."configuration")
FROM "game_definitions" d
WHERE d."key" = 'number_challenge'
ON CONFLICT DO NOTHING;

INSERT INTO "game_rules" ("gameId", "version", "mode", "family", "wagerCurrency", "rewardCurrency", "rules", "resultSchemaVersion", "rulesHash")
SELECT d."id", 1, d."mode", d."family", d."wagerCurrency", d."rewardCurrency",
       "canonical_rules_jsonb"('{"correctPoints": 30, "restricted": true, "withdrawable": false}'::jsonb),
       1,
       "rules_hash"('{"correctPoints": 30, "restricted": true, "withdrawable": false}'::jsonb)
FROM "game_definitions" d
WHERE d."key" = 'trivia'
ON CONFLICT DO NOTHING;

-- 4. Activate current_rules_version for the 4 games with real rules
UPDATE "game_definitions" SET "currentRulesVersion" = 1
WHERE "key" IN ('lucky_spin', 'dice', 'number_challenge', 'trivia');

-- 5. Coming-soon games keep current_rules_version = NULL (no rules yet)
-- No action needed - already NULL by default

-- 6. Ethiopia is the first enabled casino jurisdiction (country policy foundation)
INSERT INTO "country_casino_policies" (
    "countryCode", "version", "status", "enabledAt",
    "minWithdrawal", "maxWithdrawal", "dailyWithdrawalLimit", "monthlyWithdrawalLimit",
    "playthroughMultiplier", "qualifyingGames", "maxQualifyingStake",
    "holdingPeriodHours", "giftDailyLimit", "kycTierRequired",
    "supportedPaymentMethods", "withdrawalFeePercent", "manualReviewThreshold",
    "notes"
)
VALUES (
    'ET', 1, 'ENABLED', now(),
    100, 100000, 30000, 200000,
    1.0, '["dice","number_challenge"]', 1000,
    0, 5000, 1,
    '[]', 0.02, 50000,
    'Ethiopia is the first PlayQube casino jurisdiction (G0 foundation).'
)
ON CONFLICT ("countryCode", "version") DO NOTHING;