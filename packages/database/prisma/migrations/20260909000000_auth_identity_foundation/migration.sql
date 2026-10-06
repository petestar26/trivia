-- Slice 4A: Multi-provider identity foundation.
-- One canonical PlayQube User owns zero or more authentication identities.

-- Migration order is load-bearing. ON CONFLICT(provider, "providerSubject")
-- requires a pre-existing unique index (SQLSTATE 42P10 otherwise), so the
-- unique index MUST be created before the legacy backfill below.

-- STEP 1 — AuthProvider enum
CREATE TYPE "AuthProvider" AS ENUM ('EMAIL', 'PHONE', 'GOOGLE', 'TELEGRAM');

-- STEP 2 — identity table + FK + userId index
CREATE TABLE "user_auth_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_auth_identities_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "user_auth_identities"
    ADD CONSTRAINT "user_auth_identities_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "user_auth_identities_userId_idx" ON "user_auth_identities"("userId");

-- STEP 3 — provider + providerSubject unique index (BEFORE backfill)
CREATE UNIQUE INDEX "user_auth_identities_provider_providerSubject_key"
    ON "user_auth_identities"("provider", "providerSubject");

-- STEP 4 — initial legacy backfill for existing Users.
-- providerSubject = User.email VERBATIM (no normalization in 4A).
-- verifiedAt = NULL : legacy EMAIL identity existence does NOT mean ownership
-- verification. lastUsedAt = NULL.
-- This is an INITIAL backfill only; old containers may still register new
-- email/password Users without an identity during rolling deployment. The
-- future Slice 4B reconciliation closes that finite gap.
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
ON CONFLICT ("provider", "providerSubject") DO NOTHING;

-- STEP 5 — email + passwordHash become nullable (provider-only accounts)
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "passwordHash" DROP NOT NULL;