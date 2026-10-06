-- W-0: Security Step-Up Foundation
--
-- ADDITIVE ONLY. This migration creates two new enums and four new tables.
-- It does not drop, alter, rename, or rewrite any existing table, column,
-- index, or constraint. No financial table (wallets, wallet_transactions,
-- agent_inventories, agent_orders, agent_reservations,
-- agent_order_settlements, agent_disputes) is touched. No existing data is
-- modified.
--
-- The only relationship to an existing table is four FOREIGN KEYs onto
-- users(id); the users table itself is unchanged.

-- CreateEnum
CREATE TYPE "SecurityFactorStatus" AS ENUM ('PENDING_ACTIVATION', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "SecurityChallengePurpose" AS ENUM ('TOTP_ENROLLMENT', 'STEP_UP');

-- CreateTable
CREATE TABLE "user_totp_factors" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "status" "SecurityFactorStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "lastUsedTimeStep" INTEGER,
    "activatedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "lastVerifiedAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_totp_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "SecurityChallengePurpose" NOT NULL,
    "challenge" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "step_up_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "factorType" TEXT NOT NULL,
    "tokenIat" INTEGER NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_up_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_security_policies" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requiresStepUpForSensitiveOps" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_security_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- At most one TOTP factor per user: this uniqueness is what makes
-- concurrent enrollment attempts deterministic (the loser gets P2002).
CREATE UNIQUE INDEX "user_totp_factors_userId_key" ON "user_totp_factors"("userId");

-- CreateIndex
CREATE INDEX "user_totp_factors_status_idx" ON "user_totp_factors"("status");

-- CreateIndex
-- Globally unique challenge value: prevents any possibility of two live
-- challenges colliding, and is the backstop for single-use consumption.
CREATE UNIQUE INDEX "security_challenges_challenge_key" ON "security_challenges"("challenge");

-- CreateIndex
CREATE INDEX "security_challenges_userId_purpose_idx" ON "security_challenges"("userId", "purpose");

-- CreateIndex
CREATE INDEX "security_challenges_expiresAt_idx" ON "security_challenges"("expiresAt");

-- CreateIndex
CREATE INDEX "step_up_verifications_userId_purpose_expiresAt_idx" ON "step_up_verifications"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "step_up_verifications_expiresAt_idx" ON "step_up_verifications"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_security_policies_userId_key" ON "user_security_policies"("userId");

-- AddForeignKey
ALTER TABLE "user_totp_factors" ADD CONSTRAINT "user_totp_factors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_challenges" ADD CONSTRAINT "security_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "step_up_verifications" ADD CONSTRAINT "step_up_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_security_policies" ADD CONSTRAINT "user_security_policies_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
