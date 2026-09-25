-- Migration E5: G0 — Legacy/Untracked Coin Provenance Backfill
-- Forward-only, one-time backfill. For every wallet whose coinsBalance
-- exceeds the sum of its user's tracked coin_provenance rows (coins
-- credited before this provenance system existed, or by any path that
-- never created a provenance row), mint ONE conservative LEGACY_UNTRACKED
-- RESTRICTED provenance lot for exactly the untracked gap.
--
-- This is deliberately conservative, not merely explanatory: an untracked
-- gap is a compliance unknown, so it becomes RESTRICTED with a
-- requiredPlaythrough far beyond anything organic play can reach
-- (2,000,000,000 — mirrors LEGACY_REQUIRED_PLAYTHROUGH in
-- apps/api/src/economy/provenance-service.ts), never silently withdrawable.
-- From this point on, every coin every wallet holds has a provenance row —
-- the same runtime fallback in provenance-service.ts covers any balance
-- that reaches a debit without having been backfilled here (credited after
-- this migration ran, or by some future path that still forgets to create
-- provenance).
--
-- Safe on a fresh database: no wallets exist yet, so the SELECT returns no
-- rows and this is a no-op. Safe to run once against a populated database.
-- Idempotent: guarded so that if it were ever re-applied, no user would
-- receive a second LEGACY_UNTRACKED lot from this backfill (a user with a
-- pre-existing LEGACY_UNTRACKED lot — from this backfill or from the
-- runtime fallback firing before this migration ran — is skipped, since
-- their gap is already explained).
INSERT INTO "coin_provenance" (
    "id", "userId", "amount", "provenanceType", "restrictionStatus",
    "originalSource", "requiredPlaythrough", "completedPlaythrough",
    "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    w."userId",
    gap."amount",
    'LEGACY_UNTRACKED',
    'RESTRICTED',
    'LEGACY_UNTRACKED',
    2000000000,
    0,
    now(),
    now()
FROM "wallets" w
JOIN LATERAL (
    SELECT w."coinsBalance" - COALESCE(SUM(cp."amount"), 0) AS "amount"
    FROM "coin_provenance" cp
    WHERE cp."userId" = w."userId"
) gap ON true
WHERE gap."amount" > 0
  AND NOT EXISTS (
      SELECT 1 FROM "coin_provenance" existing
      WHERE existing."userId" = w."userId" AND existing."provenanceType" = 'LEGACY_UNTRACKED'
  );
