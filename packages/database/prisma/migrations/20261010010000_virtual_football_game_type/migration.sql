-- Enum value only. The value is used by the catalog migration that follows, never in this
-- one, so the change is safe on PostgreSQL 13 and later (a new enum value cannot be used
-- inside the transaction that adds it).
ALTER TYPE "GameType" ADD VALUE IF NOT EXISTS 'VIRTUAL_FOOTBALL_3D';
