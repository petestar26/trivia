-- Migration D: Casino Foundation - Validate + Constraints
-- Validates existing data, adds NOT NULL, CHECK constraints, triggers, and FKs.
-- Trivia is BONUS with NULL wager currency and COINS (restricted) reward currency.

-- 1. VALIDATION: All AVAILABLE games have valid rules pointer
DO $$
DECLARE
    missing RECORD;
BEGIN
    FOR missing IN
        SELECT d."id", d."key", d."currentRulesVersion"
        FROM "game_definitions" d
        WHERE d."catalogStatus" = 'AVAILABLE'
          AND (d."currentRulesVersion" IS NULL
               OR NOT EXISTS (
                   SELECT 1 FROM "game_rules" r
                   WHERE r."gameId" = d."id" AND r."version" = d."currentRulesVersion"
               ))
    LOOP
        RAISE EXCEPTION 'AVAILABLE game % (id=%) has invalid/missing currentRulesVersion=%',
            missing."key", missing."id", missing."currentRulesVersion";
    END LOOP;
END $$;

-- 2. VALIDATION: WAGER/BONUS currency rules
DO $$
DECLARE
    bad RECORD;
BEGIN
    FOR bad IN
        SELECT d."id", d."key", d."mode", d."wagerCurrency", d."rewardCurrency"
        FROM "game_definitions" d
        WHERE d."catalogStatus" <> 'RETIRED'
    LOOP
        IF bad."mode" = 'WAGER' THEN
            IF bad."wagerCurrency" IS NULL OR bad."wagerCurrency" <> 'COINS' OR bad."rewardCurrency" IS NULL OR bad."rewardCurrency" <> 'COINS' THEN
                RAISE EXCEPTION 'WAGER game % must use COINS wager+reward', bad."key";
            END IF;
        ELSIF bad."mode" = 'BONUS' THEN
            IF bad."wagerCurrency" IS NOT NULL OR bad."rewardCurrency" IS NULL THEN
                RAISE EXCEPTION 'BONUS game % must have NULL wager + reward set', bad."key";
            END IF;
        END IF;
        IF bad."key" = 'trivia' AND (bad."mode" <> 'BONUS' OR bad."wagerCurrency" IS NOT NULL OR bad."rewardCurrency" <> 'COINS') THEN
            RAISE EXCEPTION 'Trivia must be BONUS, null wager, COINS reward';
        END IF;
    END LOOP;
END $$;

-- 3. VALIDATION: game_rules agree with parent definitions
DO $$
DECLARE
    bad RECORD;
BEGIN
    FOR bad IN
        SELECT r."id", r."gameId"
        FROM "game_rules" r
        JOIN "game_definitions" d ON d."id" = r."gameId"
        WHERE r."mode" <> d."mode"
           OR r."family" <> d."family"
           OR r."wagerCurrency" IS DISTINCT FROM d."wagerCurrency"
           OR r."rewardCurrency" <> d."rewardCurrency"
    LOOP
        RAISE EXCEPTION 'game_rules % disagrees with parent game_definitions %', bad."id", bad."gameId";
    END LOOP;
END $$;

-- 4. VALIDATION: legacy lucky_spin RETIRED + has rules
DO $$
DECLARE
    lucky RECORD;
BEGIN
    SELECT "catalogStatus", "currentRulesVersion" INTO lucky FROM "game_definitions" WHERE "key" = 'lucky_spin';
    IF lucky."catalogStatus" <> 'RETIRED' OR lucky."currentRulesVersion" IS NULL THEN
        RAISE EXCEPTION 'lucky_spin must be RETIRED with rules pointer';
    END IF;
END $$;

-- 5. NOW ADD CONSTRAINTS

-- 5a. NOT NULL on backfilled columns (RETIRED/COMING_SOON/AVAILABLE all set)
ALTER TABLE "game_definitions" ALTER COLUMN "mode" SET NOT NULL;
ALTER TABLE "game_definitions" ALTER COLUMN "family" SET NOT NULL;
ALTER TABLE "game_definitions" ALTER COLUMN "catalogStatus" SET NOT NULL;
ALTER TABLE "game_definitions" ALTER COLUMN "rewardCurrency" SET NOT NULL;

-- 5b. CHECK constraints
ALTER TABLE "game_definitions" ADD CONSTRAINT "game_definitions_mode_currency_check"
    CHECK (
        ("mode" = 'WAGER' AND "wagerCurrency" = 'COINS' AND "rewardCurrency" = 'COINS')
        OR ("mode" = 'BONUS' AND "wagerCurrency" IS NULL)
    );

ALTER TABLE "game_definitions" ADD CONSTRAINT "game_definitions_trivia_check"
    CHECK (
        "key" <> 'trivia'
        OR ("mode" = 'BONUS' AND "wagerCurrency" IS NULL AND "rewardCurrency" = 'COINS')
    );

ALTER TABLE "game_definitions" ADD CONSTRAINT "game_definitions_catalog_rules_check"
    CHECK (
        "catalogStatus" <> 'AVAILABLE' OR "currentRulesVersion" IS NOT NULL
    );

ALTER TABLE "game_rules" ADD CONSTRAINT "game_rules_mode_currency_check"
    CHECK (
        ("mode" = 'WAGER' AND "wagerCurrency" = 'COINS' AND "rewardCurrency" = 'COINS')
        OR ("mode" = 'BONUS' AND "wagerCurrency" IS NULL)
    );

-- 5c. game_rules INSERT trigger validates against parent definition
CREATE OR REPLACE FUNCTION "game_rules_validate_parent"()
RETURNS trigger AS $$
DECLARE
    parent RECORD;
BEGIN
    SELECT "mode", "family", "wagerCurrency", "rewardCurrency" INTO parent
    FROM "game_definitions" WHERE "id" = NEW."gameId";
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "game_rules_insert_validate" ON "game_rules";
CREATE TRIGGER "game_rules_insert_validate"
BEFORE INSERT ON "game_rules"
FOR EACH ROW EXECUTE FUNCTION "game_rules_validate_parent"();

-- 5d. game_rules immutable (no UPDATE/DELETE)
CREATE OR REPLACE FUNCTION "game_rules_immutable"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'game_rules is immutable: UPDATE/DELETE not allowed';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "game_rules_immutable" ON "game_rules";
CREATE TRIGGER "game_rules_immutable"
BEFORE UPDATE OR DELETE ON "game_rules"
FOR EACH ROW EXECUTE FUNCTION "game_rules_immutable"();

-- 5e. Composite FK: game_definitions(id, currentRulesVersion) -> game_rules(gameId, version)
ALTER TABLE "game_definitions"
ADD CONSTRAINT "game_definitions_rules_version_fkey"
FOREIGN KEY ("id", "currentRulesVersion") REFERENCES "game_rules" ("gameId", "version");

-- 5f. game_rules FK
ALTER TABLE "game_rules"
ADD CONSTRAINT "game_rules_gameId_fkey"
FOREIGN KEY ("gameId") REFERENCES "game_definitions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5g. game_sessions snapshot CHECK
ALTER TABLE "game_sessions" ADD CONSTRAINT "game_sessions_snapshot_check"
    CHECK (
        "rulesVersion" IS NULL
        OR ("mode" IS NOT NULL AND "family" IS NOT NULL
            AND "wagerCurrency" IS NOT NULL AND "rewardCurrency" IS NOT NULL
            AND "resultSchemaVersion" IS NOT NULL)
    );

-- 5h. Composite FK: game_sessions(gameId, rulesVersion) -> game_rules(gameId, version)
ALTER TABLE "game_sessions"
ADD CONSTRAINT "game_sessions_rules_version_fkey"
FOREIGN KEY ("gameId", "rulesVersion") REFERENCES "game_rules" ("gameId", "version");

-- 5i. game_sessions INSERT trigger validates rule snapshot against game_rules
CREATE OR REPLACE FUNCTION "game_sessions_validate_rules_snapshot"()
RETURNS trigger AS $$
DECLARE
    rule RECORD;
    humanMode text;
    humanFamily text;
BEGIN
    IF NEW."rulesVersion" IS NOT NULL THEN
        SELECT "mode", "family", "wagerCurrency", "rewardCurrency" INTO rule
        FROM "game_rules"
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS "game_sessions_insert_validate" ON "game_sessions";
CREATE TRIGGER "game_sessions_insert_validate"
BEFORE INSERT ON "game_sessions"
FOR EACH ROW EXECUTE FUNCTION "game_sessions_validate_rules_snapshot"();

-- 5j. coin provenance FKs (wall off; foundation fail-closed)
ALTER TABLE "coin_provenance"
ADD CONSTRAINT "coin_provenance_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_provenance"
ADD CONSTRAINT "coin_provenance_walletTransactionId_fkey"
FOREIGN KEY ("walletTransactionId") REFERENCES "wallet_transactions" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "coin_provenance"
ADD CONSTRAINT "coin_provenance_countryPolicyId_fkey"
FOREIGN KEY ("countryPolicyId") REFERENCES "country_casino_policies" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "coin_allocations"
ADD CONSTRAINT "coin_allocations_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_allocations"
ADD CONSTRAINT "coin_allocations_provenanceId_fkey"
FOREIGN KEY ("provenanceId") REFERENCES "coin_provenance" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coin_allocations"
ADD CONSTRAINT "coin_allocations_gameSessionId_fkey"
FOREIGN KEY ("gameSessionId") REFERENCES "game_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE;