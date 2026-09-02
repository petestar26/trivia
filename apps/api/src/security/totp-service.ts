import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { ApiError } from '../middleware';
import { encryptSecret, decryptSecret, isTotpEncryptionConfigured } from './crypto';
import {
  generateTotpSecret,
  verifyTotpCode,
  buildOtpAuthUri,
  TOTP_DIGITS,
} from './totp';
import { issueChallenge, consumeChallenge } from './challenge-service';

/**
 * TOTP factor lifecycle (W-0).
 *
 * Ownership is ALWAYS derived from the authenticated `userId` passed by
 * the route layer from `request.user.sub`. No function here accepts a
 * user identifier, credential id, or status from a request body.
 *
 * Nothing in this module logs, audits, or returns the shared secret after
 * enrollment start.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

/** Safe, client-facing view of a factor. Never includes secret material. */
export interface TotpFactorView {
  type: 'TOTP';
  status: 'PENDING_ACTIVATION' | 'ACTIVE' | 'DISABLED';
  activatedAt: Date | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
}

function toView(factor: {
  status: string;
  activatedAt: Date | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
}): TotpFactorView {
  return {
    type: 'TOTP',
    status: factor.status as TotpFactorView['status'],
    activatedAt: factor.activatedAt,
    lastVerifiedAt: factor.lastVerifiedAt,
    createdAt: factor.createdAt,
  };
}

async function writeAudit(
  userId: string,
  action: string,
  newData: Record<string, unknown>,
  context?: { ip?: string; userAgent?: string }
): Promise<void> {
  // Audit payloads carry status/metadata only — never secrets, codes, or
  // challenge values. See W-0 §12.
  await prisma.auditLog.create({
    data: {
      userId,
      action,
      entity: 'UserTotpFactor',
      entityId: userId,
      newData: newData as object,
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });
}

/**
 * Starts TOTP enrollment: mints a secret, stores it encrypted in
 * PENDING_ACTIVATION state, and returns the provisioning URI exactly once.
 *
 * Concurrency: `userId` is UNIQUE on user_totp_factors, so two concurrent
 * enrollments cannot both create a factor. Re-starting enrollment while
 * still PENDING_ACTIVATION deliberately REPLACES the pending secret (the
 * user may have lost the QR code); re-starting once ACTIVE is refused so
 * an attacker with a live session cannot silently swap a victim's factor.
 */
export async function startTotpEnrollment(
  userId: string,
  context?: { ip?: string; userAgent?: string }
): Promise<{ otpauthUri: string; secret: string; challenge: string; expiresAt: Date }> {
  if (!isTotpEncryptionConfigured()) {
    throw ApiError.serviceUnavailable('Two-factor authentication is not available on this server');
  }

  const existing = await prisma.userTotpFactor.findUnique({ where: { userId } });
  if (existing && existing.status === 'ACTIVE') {
    throw ApiError.conflict('Two-factor authentication is already enabled');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw ApiError.notFound('User not found');

  const secret = generateTotpSecret();
  const encryptedSecret = encryptSecret(secret);

  // upsert keyed on the unique userId: deterministic under concurrency,
  // and resets replay/lockout state for the fresh secret.
  await prisma.userTotpFactor.upsert({
    where: { userId },
    create: { userId, encryptedSecret, status: 'PENDING_ACTIVATION' },
    update: {
      encryptedSecret,
      status: 'PENDING_ACTIVATION',
      lastUsedTimeStep: null,
      failedAttempts: 0,
      lockedUntil: null,
      activatedAt: null,
      disabledAt: null,
    },
  });

  const challenge = await issueChallenge(userId, 'TOTP_ENROLLMENT');

  await writeAudit(userId, 'TOTP_ENROLLMENT_STARTED', { status: 'PENDING_ACTIVATION' }, context);

  return {
    otpauthUri: buildOtpAuthUri({
      secret,
      accountName: user.email,
      issuer: config.JWT_ISSUER,
    }),
    secret,
    challenge: challenge.challenge,
    expiresAt: challenge.expiresAt,
  };
}

/**
 * Activates a pending TOTP factor by proving possession of the secret.
 *
 * Requires the enrollment challenge, so activation cannot be driven by a
 * replayed or out-of-band request. The challenge is consumed inside the
 * same transaction as the activation claim, so a concurrent double
 * activation cannot occur.
 */
export async function activateTotpFactor(
  userId: string,
  challenge: string,
  code: string,
  context?: { ip?: string; userAgent?: string }
): Promise<TotpFactorView> {
  const factor = await prisma.userTotpFactor.findUnique({ where: { userId } });
  if (!factor || factor.status !== 'PENDING_ACTIVATION') {
    throw ApiError.badRequest('No pending two-factor enrollment');
  }

  const secret = decryptSecret(factor.encryptedSecret);
  const result = verifyTotpCode(secret, code, { minTimeStep: factor.lastUsedTimeStep });
  if (!result.valid || result.timeStep === null) {
    await writeAudit(userId, 'TOTP_ENROLLMENT_FAILED', { reason: 'invalid_code' }, context);
    throw ApiError.badRequest('Invalid verification code');
  }

  const activated = await prisma.$transaction(async (tx) => {
    // Consumes the challenge atomically — throws if reused/expired.
    await consumeChallenge(userId, 'TOTP_ENROLLMENT', challenge, tx);

    // Atomic conditional claim: only a still-PENDING factor activates.
    const claim = await tx.userTotpFactor.updateMany({
      where: { userId, status: 'PENDING_ACTIVATION' },
      data: {
        status: 'ACTIVE',
        activatedAt: new Date(),
        lastVerifiedAt: new Date(),
        lastUsedTimeStep: result.timeStep,
        failedAttempts: 0,
        lockedUntil: null,
      },
    });
    if (claim.count === 0) {
      throw ApiError.conflict('Two-factor enrollment is no longer pending');
    }

    return tx.userTotpFactor.findUniqueOrThrow({ where: { userId } });
  });

  await writeAudit(userId, 'TOTP_ENABLED', { status: 'ACTIVE' }, context);

  // Security notification via the existing Notification infrastructure —
  // no new notification architecture, no new enum value.
  await prisma.notification.create({
    data: {
      userId,
      type: 'SYSTEM',
      title: 'Two-factor authentication enabled',
      body: 'Two-factor authentication was enabled on your account. If this was not you, secure your account immediately.',
      data: { securityEvent: 'TOTP_ENABLED' },
    },
  });

  return toView(activated);
}

/**
 * Verifies a TOTP code for an ACTIVE factor.
 *
 * Enforces: active-only, lockout, replay protection (monotonic time
 * step), and constant-time code comparison. Returns the matched time step
 * so callers can record a bounded step-up.
 */
export async function verifyTotpForUser(
  userId: string,
  code: string,
  context?: { ip?: string; userAgent?: string }
): Promise<{ verified: true; timeStep: number }> {
  const factor = await prisma.userTotpFactor.findUnique({ where: { userId } });

  // Uniform error for "no factor" and "disabled factor" — does not reveal
  // whether the user has ever enrolled.
  if (!factor || factor.status !== 'ACTIVE') {
    throw ApiError.badRequest('Two-factor verification failed');
  }

  if (factor.lockedUntil && factor.lockedUntil > new Date()) {
    throw ApiError.rateLimited('Too many failed attempts. Try again later.');
  }

  const secret = decryptSecret(factor.encryptedSecret);
  const result = verifyTotpCode(secret, code, { minTimeStep: factor.lastUsedTimeStep });

  if (!result.valid || result.timeStep === null) {
    // ATOMIC increment — NOT a read-then-write. `factor` above is a stale
    // snapshot: computing `factor.failedAttempts + 1` and writing it back
    // as an absolute value loses increments under concurrency, so N
    // parallel wrong codes would advance the counter by 1 instead of N and
    // an attacker could brute-force past the lockout by submitting guesses
    // in parallel rather than serially. `{ increment: 1 }` compiles to
    // `SET "failedAttempts" = "failedAttempts" + 1`, which PostgreSQL
    // serialises on the row, so every concurrent failure is counted.
    const updated = await prisma.userTotpFactor.update({
      where: { userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });

    // Lockout is decided from the ATOMICALLY updated value, never from the
    // stale pre-read. Applied as a separate conditional write so that
    // whichever concurrent attempt crosses the threshold sets the lock.
    if (updated.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      await prisma.userTotpFactor.updateMany({
        where: { userId, status: 'ACTIVE' },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) },
      });
    }

    await writeAudit(
      userId,
      'TOTP_VERIFICATION_FAILED',
      { failedAttempts: updated.failedAttempts },
      context
    );
    throw ApiError.badRequest('Two-factor verification failed');
  }

  // Replay protection: advance the consumed time step atomically. The
  // guard `lastUsedTimeStep < result.timeStep` means two concurrent
  // submissions of the SAME code cannot both succeed.
  const claim = await prisma.userTotpFactor.updateMany({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [{ lastUsedTimeStep: null }, { lastUsedTimeStep: { lt: result.timeStep } }],
    },
    data: {
      lastUsedTimeStep: result.timeStep,
      lastVerifiedAt: new Date(),
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
  if (claim.count === 0) {
    throw ApiError.badRequest('Two-factor verification failed');
  }

  return { verified: true, timeStep: result.timeStep };
}

/**
 * Disables the caller's TOTP factor.
 *
 * Requires a current valid code so a hijacked session cannot silently
 * strip the account's second factor. The row is retained in DISABLED
 * state rather than deleted, preserving security history.
 */
export async function disableTotpFactor(
  userId: string,
  code: string,
  context?: { ip?: string; userAgent?: string }
): Promise<TotpFactorView> {
  await verifyTotpForUser(userId, code, context);

  const claim = await prisma.userTotpFactor.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'DISABLED', disabledAt: new Date() },
  });
  if (claim.count === 0) {
    // Concurrent disable already won — deterministic, not an error state
    // the caller can exploit.
    throw ApiError.conflict('Two-factor authentication is not currently enabled');
  }

  await writeAudit(userId, 'TOTP_DISABLED', { status: 'DISABLED' }, context);

  await prisma.notification.create({
    data: {
      userId,
      type: 'SYSTEM',
      title: 'Two-factor authentication disabled',
      body: 'Two-factor authentication was disabled on your account. If this was not you, secure your account immediately.',
      data: { securityEvent: 'TOTP_DISABLED' },
    },
  });

  const factor = await prisma.userTotpFactor.findUniqueOrThrow({ where: { userId } });
  return toView(factor);
}

/** Lists the caller's own factors. Never exposes secret material. */
export async function listOwnFactors(userId: string): Promise<TotpFactorView[]> {
  const factor = await prisma.userTotpFactor.findUnique({ where: { userId } });
  // A DISABLED factor is intentionally still listed so the user can see
  // their own security history.
  return factor ? [toView(factor)] : [];
}

export const TOTP_CODE_LENGTH = TOTP_DIGITS;
