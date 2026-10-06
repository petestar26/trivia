-- Slice 5: User→User Referral Foundation (additive only).
-- Adds users.referralCode + referrals table + self-referral CHECK.
-- No rewards, no attribution backfill, no schema drift beyond Prisma's
-- 5-model expectations.
--
-- IMPORTANT: 4B-style explicit transaction. 5 creates its own PostgreSQL
-- transaction (BEGIN ... COMMIT) and does NOT rely upon Prisma's default
-- migration wrapping behavior. Any correctness-relevant step failure rolls
-- back the entire migration.

BEGIN;

-- ─── Schema (Prisma-generated DDL, exactly matching schema.prisma) ───
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "referralCode" TEXT;

-- CreateTable
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referredUserId" TEXT NOT NULL,
    "referrerUserId" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique index for User.referralCode must exist BEFORE backfill
-- so any generated duplicate would fail loudly instead of being suppressed)
CREATE UNIQUE INDEX "referrals_referredUserId_key" ON "referrals"("referredUserId");

CREATE INDEX "referrals_referrerUserId_idx" ON "referrals"("referrerUserId");

CREATE UNIQUE INDEX "users_referralCode_key" ON "users"("referralCode");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredUserId_fkey" FOREIGN KEY ("referredUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrerUserId_fkey" FOREIGN KEY ("referrerUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Self-referral DB invariant (SQL-only; Prisma cannot model CHECK) ───
ALTER TABLE "referrals"
    ADD CONSTRAINT "referrals_no_self_referral_check"
    CHECK ("referredUserId" <> "referrerUserId");

-- ─── Existing-user referral-code backfill (collision-resolving) ───
-- Every existing User gets its own 8-char canonical code from the locked
-- alphabet. Generation retries on collision against any already-present
-- (or previously assigned) code; a recoverable collision never aborts and
-- never leaves a User without a code.
DO $$
DECLARE
  u RECORD;
  code TEXT;
  tries INT;
  i INT;
BEGIN
  FOR u IN
    SELECT "id" FROM "users" WHERE "referralCode" IS NULL
  LOOP
    tries := 0;
    LOOP
      tries := tries + 1;
      code := '';
      FOR i IN 1..8 LOOP
        code := code || substring(
          '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
          from (1 + floor(random() * 31))::int
          for 1
        );
      END LOOP;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "users" WHERE "referralCode" = code
      );
      IF tries >= 50 THEN
        RAISE EXCEPTION
          'Slice 5 referral-code backfill could not generate a unique code for user % after % tries',
          u."id", tries;
      END IF;
    END LOOP;

    UPDATE "users" SET "referralCode" = code WHERE "id" = u."id";
  END LOOP;
END
$$;

-- ─── Post-conditions (before COMMIT) ───
DO $$
DECLARE
  null_count INT;
  dup_count INT;
  bad_fmt INT;
  ref_count BIGINT;
BEGIN
  -- A. every existing User has a non-null referralCode after backfill
  SELECT count(*) INTO null_count FROM "users" WHERE "referralCode" IS NULL;
  IF null_count > 0 THEN
    RAISE EXCEPTION 'Slice 5 post-condition A failed: % user(s) still lack referralCode', null_count;
  END IF;

  -- B. no duplicate non-null referralCode
  SELECT count(*) INTO dup_count FROM (
    SELECT "referralCode" FROM "users"
    WHERE "referralCode" IS NOT NULL
    GROUP BY "referralCode" HAVING count(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Slice 5 post-condition B failed: duplicate referralCode values present';
  END IF;

  -- C. all populated codes match the canonical 8-char locked alphabet
  SELECT count(*) INTO bad_fmt FROM "users"
    WHERE "referralCode" IS NOT NULL
      AND "referralCode" !~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$';
  IF bad_fmt > 0 THEN
    RAISE EXCEPTION 'Slice 5 post-condition C failed: % code(s) outside canonical format', bad_fmt;
  END IF;

  -- D. ZERO Referral attribution rows created by migration
  SELECT count(*) INTO ref_count FROM "referrals";
  IF ref_count <> 0 THEN
    RAISE EXCEPTION 'Slice 5 post-condition D failed: % Referral row(s) must not be backfilled', ref_count;
  END IF;

  RAISE NOTICE 'Slice 5 referral foundation migration complete (referralCode backfill OK; referrals backfill = 0)';
END
$$;

COMMIT;