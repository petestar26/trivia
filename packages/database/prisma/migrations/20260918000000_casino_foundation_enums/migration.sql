-- Migration A: Casino Foundation - Enums Only
-- Creates all new enum types and extends GameType.
-- No data uses the new values yet; that happens in Migration C.

-- 1. Game participation modes
CREATE TYPE "game_mode" AS ENUM ('WAGER', 'BONUS');

-- 2. Game engine families
CREATE TYPE "game_family" AS ENUM ('INSTANT', 'SCHEDULED_DRAW', 'SCHEDULED_RACE');

-- 3. Catalog visibility status (includes RETIRED for legacy Lucky Spin)
CREATE TYPE "game_catalog_status" AS ENUM ('AVAILABLE', 'COMING_SOON', 'RETIRED');

-- 4. Play/settlement context for every session
CREATE TYPE "play_context" AS ENUM ('SOLO_WAGER', 'COMPETITION_ROUND', 'CHALLENGE_ROUND', 'BONUS');

-- 5. Coin provenance and restriction
CREATE TYPE "coin_provenance_type" AS ENUM (
    'PURCHASE', 'GAME_WIN', 'TRIVIA_REWARD', 'REFERRAL_REWARD',
    'PROMOTION', 'GIFT_SENT', 'GIFT_RECEIVED', 'BONUS_UNLOCK',
    'WITHDRAWAL', 'ADMIN_ADJUSTMENT', 'COMPETITION_PRIZE', 'TASK_REWARD'
);

CREATE TYPE "coin_restriction_status" AS ENUM ('RESTRICTED', 'UNRESTRICTED', 'PLAYING_THROUGH', 'EXPIRED');

-- 6. Country policy status
CREATE TYPE "country_casino_status" AS ENUM ('ENABLED', 'DISABLED', 'RESTRICTED');

-- 7. Extend GameType with 10 new values (Spin Win + 9 coming-soon games)
ALTER TYPE "GameType" ADD VALUE 'SPIN_WIN';
ALTER TYPE "GameType" ADD VALUE 'THUNDER_DERBY_3D';
ALTER TYPE "GameType" ADD VALUE 'NEON_HOUNDS_3D';
ALTER TYPE "GameType" ADD VALUE 'TURBO_CIRCUIT_3D';
ALTER TYPE "GameType" ADD VALUE 'STARFALL_NEBULA';
ALTER TYPE "GameType" ADD VALUE 'JUNGLE_DASH_3D';
ALTER TYPE "GameType" ADD VALUE 'TURBO_KENO';
ALTER TYPE "GameType" ADD VALUE 'CRYSTAL_TRAIL';
ALTER TYPE "GameType" ADD VALUE 'HEAT_VAULT';
ALTER TYPE "GameType" ADD VALUE 'STRAIT_RUSH';
