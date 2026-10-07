import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { verifyTotpForUser } from './totp-service.js';

/**
 * Step-up authentication primitive (W-0).
 *
 * This is the reusable seam future sensitive operations call. W-0
 * deliberately integrates it with NOTHING — no withdrawal, no wallet, no
 * agent flow exists that consumes it yet.
 *
 * A step-up result is explicitly NOT a "verified forever" flag. Every
 * record is bound to:
 *   user + purpose + token instance (iat) + verifiedAt + expiresAt
 * and is single-use at the point of consumption.
 *
 * CONTEXT-BINDING LIMITATION (documented, not hidden): the access token
 * in this repository carries no session id, `jti`, or `tokenVersion`
 * claim — only `sub`/`iat`/`exp`. True per-session binding would require
 * changing token issuance, which is outside W-0's boundary. Binding to
 * `iat` means a step-up does not survive a token refresh, which is the
 * strongest binding reachable without modifying authentication. Two
 * tokens minted for the same user in the same clock second would share an
 * `iat`; see the final report's Remaining Decisions.
 */

/** Bounded lifetime — a step-up authorises a near-term action, not a session. */
const STEP_UP_TTL_SECONDS = 300;

/** Factor types that can satisfy a step-up. W-0 implements TOTP only. */
export type StepUpFactorType = 'TOTP';

export interface StepUpContext {
  userId: string;
  /** `iat` claim of the access token presented on this request. */
  tokenIat: number;
}

export interface StepUpResult {
  id: string;
  purpose: string;
  expiresAt: Date;
}

/**
 * Performs a step-up verification and records a bounded authorisation.
 *
 * `purpose` scopes the result: an authorisation minted for one purpose
 * can never satisfy another.
 */
export async function performStepUp(
  ctx: StepUpContext,
  purpose: string,
  factorType: StepUpFactorType,
  code: string,
  context?: { ip?: string; userAgent?: string }
): Promise<StepUpResult> {
  if (factorType !== 'TOTP') {
    // Unknown factor types are rejected explicitly rather than ignored.
    throw ApiError.badRequest('Unsupported authentication factor');
  }

  await verifyTotpForUser(ctx.userId, code, context);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + STEP_UP_TTL_SECONDS * 1000);

  const record = await prisma.stepUpVerification.create({
    data: {
      userId: ctx.userId,
      purpose,
      factorType,
      tokenIat: ctx.tokenIat,
      verifiedAt: now,
      expiresAt,
    },
    select: { id: true, purpose: true, expiresAt: true },
  });

  await prisma.auditLog.create({
    data: {
      userId: ctx.userId,
      action: 'SECURITY_STEP_UP_SUCCEEDED',
      entity: 'StepUpVerification',
      entityId: record.id,
      // Metadata only — no code, no secret, no token.
      newData: { purpose, factorType, expiresAt: expiresAt.toISOString() },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  return record;
}

/**
 * Asserts that the caller holds a valid, unexpired, unconsumed step-up
 * for this exact purpose and token instance — and CONSUMES it.
 *
 * This is the function future sensitive operations should call. It is
 * single-use by design: consumption is an atomic conditional claim, so
 * one step-up cannot authorise two operations, even concurrently.
 *
 * Throws (never returns false) so a caller cannot accidentally treat a
 * falsy result as success.
 */
export async function requireStepUp(
  ctx: StepUpContext,
  purpose: string,
  tx?: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
): Promise<void> {
  const db = tx ?? prisma;
  const now = new Date();

  const candidate = await db.stepUpVerification.findFirst({
    where: {
      userId: ctx.userId,
      purpose,
      tokenIat: ctx.tokenIat,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    orderBy: { verifiedAt: 'desc' },
    select: { id: true },
  });

  if (!candidate) {
    throw ApiError.forbidden('Step-up authentication required', {
      code: 'STEP_UP_REQUIRED',
    });
  }

  // Atomic single-use claim — a concurrent second consumer matches zero
  // rows and is rejected.
  const claim = await db.stepUpVerification.updateMany({
    where: { id: candidate.id, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });

  if (claim.count === 0) {
    throw ApiError.forbidden('Step-up authentication required', {
      code: 'STEP_UP_REQUIRED',
    });
  }
}

/**
 * Whether a user's policy requires step-up for sensitive operations.
 *
 * Future-facing: W-0 has no sensitive operation that calls this. Absent a
 * policy row the answer is `false` — W-0 does not silently turn on a
 * requirement for existing users.
 */
export async function requiresStepUp(userId: string): Promise<boolean> {
  const policy = await prisma.userSecurityPolicy.findUnique({
    where: { userId },
    select: { requiresStepUpForSensitiveOps: true },
  });
  return policy?.requiresStepUpForSensitiveOps ?? false;
}

/** Purpose is independent from withdrawals and bound to the current token. */
export const DISABLE_STEP_UP_POLICY_PURPOSE = 'DISABLE_STEP_UP_POLICY';

/** Disabling protection, its single-use authorization and notification are atomic. */
export async function setOwnStepUpPolicy(
  userId: string,
  required: boolean,
  context?: { ip?: string; userAgent?: string; tokenIat?: number }
): Promise<{ requiresStepUpForSensitiveOps: boolean }> {
  return prisma.$transaction(async (tx) => {
    if (required) {
      const factor = await tx.userTotpFactor.findUnique({
        where: { userId }, select: { status: true },
      });
      if (!factor || factor.status !== 'ACTIVE') {
        throw ApiError.badRequest(
          'Enable an authentication factor before requiring step-up verification'
        );
      }
    } else {
      // Fail closed even when no policy row exists. A cookie alone must never
      // create an unprotected policy or bypass the dedicated authorization.
      if (!Number.isInteger(context?.tokenIat)) {
        throw ApiError.forbidden('Step-up authentication required', { code: 'STEP_UP_REQUIRED' });
      }
      await requireStepUp(
        { userId, tokenIat: context!.tokenIat! }, DISABLE_STEP_UP_POLICY_PURPOSE, tx
      );
    }
    const policy = await tx.userSecurityPolicy.upsert({
      where: { userId },
      create: { userId, requiresStepUpForSensitiveOps: required },
      update: { requiresStepUpForSensitiveOps: required },
      select: { requiresStepUpForSensitiveOps: true },
    });
    await tx.auditLog.create({
      data: {
        userId, action: 'SECURITY_POLICY_UPDATED', entity: 'UserSecurityPolicy', entityId: userId,
        newData: { requiresStepUpForSensitiveOps: required },
        ip: context?.ip, userAgent: context?.userAgent,
      },
    });
    if (!required) {
      await tx.notification.create({
        data: {
          userId, type: 'SYSTEM', title: 'Withdrawal verification disabled',
          body: 'Authenticator verification for sensitive operations was disabled. If this was not you, secure your account immediately.',
          data: { securityEvent: 'STEP_UP_POLICY_DISABLED' },
        },
      });
    }
    return policy;
  });
}
