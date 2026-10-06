-- Slice 4B: Post-4A EMAIL identity reconciliation (data-only).
-- Purpose: reconcile Users created by old pre-4A containers during the 4A
-- rolling-deployment window that lack a matching EMAIL UserAuthIdentity.
-- No schema change. No runtime API change. No ownership-verification upgrade.
--
-- IMPORTANT: 4B creates its own PostgreSQL transaction (BEGIN ... COMMIT)
-- and does NOT rely upon Prisma's default migration wrapping behavior.
-- All steps below are correctness-relevant and MUST commit atomically:
--   STEP 1 failure  -> zero reconciliation writes
--   STEP 2 failure  -> zero reconciliation writes committed
--   STEP 3 failure  -> STEP 2 reconciliation writes roll back
--   connection loss before COMMIT -> PostgreSQL rolls the transaction back

BEGIN;

-- STEP 1 — Cross-user conflict guard (FAIL CLOSED).
-- If any EMAIL identity's providerSubject equals a DIFFERENT User's email,
-- the invariant cannot be satisfied by insertion and a silent skip or
-- reassignment would corrupt ownership. Abort loudly before any write.
DO $$
DECLARE
  conflicting INT;
BEGIN
  SELECT count(*) INTO conflicting
  FROM "users" u
  WHERE u."email" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM "user_auth_identities" i
      WHERE i."provider" = 'EMAIL'
        AND i."providerSubject" = u."email"
        AND i."userId" <> u."id"
    );

  IF conflicting > 0 THEN
    RAISE EXCEPTION
      'Slice 4B reconciliation aborted: % EMAIL identity row(s) carry a providerSubject equal to another User''s email. Resolve manually; never auto-reassign an identity.',
      conflicting;
  END IF;
END
$$;

-- STEP 2 — Bounded reconciliation INSERT.
-- Insert an EMAIL identity for every non-null-email User that does not
-- already have an exact same-user matching identity. Idempotency comes from
-- the NOT EXISTS guard (no ON CONFLICT suppression here).
-- providerSubject is the verbatim User email. verifiedAt/lastUsedAt = NULL
-- (reconciliation does NOT mean ownership was verified).
INSERT INTO "user_auth_identities"
    ("id", "userId", "provider", "providerSubject", "verifiedAt", "lastUsedAt", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    u."id",
    'EMAIL',
    u."email",
    NULL,
    NULL,
    u."createdAt",
    now()
FROM "users" u
WHERE u."email" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "user_auth_identities" i
    WHERE i."userId" = u."id"
      AND i."provider" = 'EMAIL'
      AND i."providerSubject" = u."email"
  );

-- STEP 3 — Self-verifying post-condition.
-- Recalculate the missing-identity invariant. If any non-null-email User
-- still lacks a matching EMAIL identity, raise BEFORE COMMIT so the STEP 2
-- inserts roll back with the transaction.
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT count(*) INTO remaining
  FROM "users" u
  WHERE u."email" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "user_auth_identities" i
      WHERE i."userId" = u."id"
        AND i."provider" = 'EMAIL'
        AND i."providerSubject" = u."email"
    );

  IF remaining > 0 THEN
    RAISE EXCEPTION
      'Slice 4B post-condition failed: % User(s) with non-null email still lack a matching EMAIL identity.',
      remaining;
  END IF;

  RAISE NOTICE 'Slice 4B reconciliation complete: missing_legacy_identity = 0';
END
$$;

COMMIT;