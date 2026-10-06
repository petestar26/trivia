-- Migration E4: G0 — Add LEGACY_UNTRACKED coin provenance type
-- Forward-only. A Postgres `ALTER TYPE ... ADD VALUE` cannot be used in the
-- same transaction that added it, so this value is added in its OWN
-- migration, with nothing else in it. The next migration
-- (g0_legacy_provenance_backfill) is the first to reference it, and the
-- application (see LEGACY_UNTRACKED / LEGACY_REQUIRED_PLAYTHROUGH in
-- apps/api/src/economy/provenance-service.ts) mints it at runtime for any
-- wallet balance that reaches settlement without a tracked provenance lot
-- to explain it.
ALTER TYPE "coin_provenance_type" ADD VALUE 'LEGACY_UNTRACKED';
