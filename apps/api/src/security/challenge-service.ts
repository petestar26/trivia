import { randomBytes } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

/**
 * Single-use, short-lived, user- and purpose-bound security challenges.
 *
 * Security purpose (W-0 §6): a challenge proves that a verification step
 * was initiated by this server, for this user, for this specific purpose,
 * recently — and that it has not already been redeemed. It is not a
 * general-purpose token: nothing outside this subsystem may mint or
 * consume one.
 */

export type ChallengePurpose = 'TOTP_ENROLLMENT' | 'STEP_UP';

/** Deliberately short — a challenge is a live interaction, not a session. */
const CHALLENGE_TTL_SECONDS = 300;
const CHALLENGE_BYTES = 32; // 256 bits

export interface IssuedChallenge {
  id: string;
  challenge: string;
  expiresAt: Date;
}

/**
 * Issues a challenge bound to a user and purpose.
 *
 * `userId` is always supplied by the caller from the authenticated
 * session — never from a request body.
 */
export async function issueChallenge(
  userId: string,
  purpose: ChallengePurpose,
  ttlSeconds: number = CHALLENGE_TTL_SECONDS
): Promise<IssuedChallenge> {
  const challenge = randomBytes(CHALLENGE_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const record = await prisma.securityChallenge.create({
    data: { userId, purpose, challenge, expiresAt },
    select: { id: true, challenge: true, expiresAt: true },
  });

  return record;
}

/**
 * Atomically consumes a challenge, or throws.
 *
 * Consumption is a single conditional UPDATE — the same atomic-claim
 * idiom the rest of this codebase uses for exactly-once transitions. Two
 * concurrent redemptions of the same challenge cannot both succeed:
 * PostgreSQL serialises them on the row, and the loser sees
 * `consumedAt IS NOT NULL` and matches zero rows.
 *
 * Every failure mode returns the SAME error message so a caller cannot
 * distinguish "wrong user", "wrong purpose", "expired", "already used",
 * or "never existed" — that distinction would leak whether another user's
 * challenge exists.
 */
export async function consumeChallenge(
  userId: string,
  purpose: ChallengePurpose,
  challenge: string,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<void> {
  const db = tx ?? prisma;
  const now = new Date();

  const claim = await db.securityChallenge.updateMany({
    where: {
      challenge,
      userId,
      purpose,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { consumedAt: now },
  });

  if (claim.count === 0) {
    throw ApiError.badRequest('Invalid or expired challenge');
  }
}

/**
 * Best-effort cleanup of expired challenges.
 *
 * Not required for correctness — `consumeChallenge` already refuses
 * anything expired — purely hygiene for the table. No scheduler exists in
 * this repository, so this is exported for a future sweep rather than
 * invoked automatically.
 */
export async function purgeExpiredChallenges(before: Date = new Date()): Promise<number> {
  const result = await prisma.securityChallenge.deleteMany({
    where: { expiresAt: { lt: before } },
  });
  return result.count;
}
