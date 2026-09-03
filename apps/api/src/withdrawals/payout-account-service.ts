import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

// W-1B Task B: user payout account service.
//
// UserPayoutAccount is the USER's fiat destination for a withdrawal —
// deliberately NOT AgentPaymentAccount, which is a different entity
// (agent-owned receiving accounts for coin purchases, with its own
// admin-approval lifecycle). Self-service only here: create/list/
// soft-disable, no admin approval step, no KYC (W-1A2/W-1B scope).

// ─── accountDetails validation against a method's fieldSchema ───
//
// Identical whitelist validation to payment-account-service.ts's
// validateAccountDetails — duplicated locally (that function is private
// to its own file) rather than exported cross-domain, matching this
// repo's existing precedent of small per-domain private helpers.
function validateAccountDetails(fieldSchema: unknown, accountDetails: unknown): Record<string, string> {
  const required = (fieldSchema as { requiredFields?: unknown })?.requiredFields;
  if (!Array.isArray(required) || required.some((f) => typeof f !== 'string')) {
    throw ApiError.internal('Payment method is misconfigured (invalid fieldSchema)');
  }

  if (!accountDetails || typeof accountDetails !== 'object' || Array.isArray(accountDetails)) {
    throw ApiError.badRequest('accountDetails must be an object');
  }

  const submitted = accountDetails as Record<string, unknown>;
  const allowed = new Set(required as string[]);

  for (const key of Object.keys(submitted)) {
    if (!allowed.has(key)) {
      throw ApiError.badRequest(`accountDetails contains an unsupported field: ${key}`);
    }
  }

  const clean: Record<string, string> = {};
  for (const field of required as string[]) {
    const value = submitted[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw ApiError.badRequest(`accountDetails.${field} is required`);
    }
    clean[field] = value.trim();
  }

  return clean;
}

/**
 * Opus W-1A2 carry-forward requirement #4: UserPayoutAccount.countryId
 * must equal PaymentMethodDefinition.countryId — Prisma cannot express a
 * cross-field FK equality constraint, so this is enforced here, mirroring
 * payment-account-service.ts's loadAndValidateMethod exactly.
 */
async function loadAndValidateMethod(countryId: string, methodDefId: string) {
  const country = await prisma.country.findUnique({ where: { id: countryId } });
  if (!country) throw ApiError.badRequest('Invalid country');
  if (!country.isActive || !country.agentPaymentEnabled) {
    throw ApiError.badRequest('Payouts are not available for this country');
  }

  const method = await prisma.paymentMethodDefinition.findUnique({ where: { id: methodDefId } });
  if (!method) throw ApiError.badRequest('Invalid payment method');
  if (!method.isActive) throw ApiError.badRequest('This payment method is not currently active');
  if (method.countryId !== countryId) {
    throw ApiError.badRequest('This payment method does not belong to the selected country');
  }

  return { country, method };
}

/** Keeps the last 4 characters of each string value, masks the rest. */
function maskAccountDetails(accountDetails: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(accountDetails)) {
    if (typeof value !== 'string') {
      masked[key] = value;
    } else if (value.length <= 4) {
      masked[key] = '*'.repeat(value.length);
    } else {
      masked[key] = '*'.repeat(value.length - 4) + value.slice(-4);
    }
  }
  return masked;
}

export interface CreateUserPayoutAccountArgs {
  countryId: string;
  methodDefId: string;
  accountDetails: unknown;
  displayLabel?: string;
}

/**
 * Create a payout account for the authenticated user. Identity is always
 * actorUserId — never accepted from the request body.
 */
export async function createUserPayoutAccount(
  actorUserId: string,
  args: CreateUserPayoutAccountArgs,
  context?: { ip?: string; userAgent?: string }
) {
  const { method } = await loadAndValidateMethod(args.countryId, args.methodDefId);
  const clean = validateAccountDetails(method.fieldSchema, args.accountDetails);

  if (args.displayLabel !== undefined && typeof args.displayLabel !== 'string') {
    throw ApiError.badRequest('displayLabel must be a string');
  }

  return prisma.$transaction(async (tx) => {
    const account = await tx.userPayoutAccount.create({
      data: {
        userId: actorUserId,
        countryId: args.countryId,
        methodDefId: args.methodDefId,
        accountDetails: clean,
        displayLabel: args.displayLabel?.trim() || null,
        status: 'ACTIVE',
      },
    });

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'USER_PAYOUT_ACCOUNT_CREATED',
        entity: 'UserPayoutAccount',
        entityId: account.id,
        newData: { countryId: args.countryId, methodDefId: args.methodDefId, status: 'ACTIVE' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return account;
  });
}

/** List the caller's own payout accounts, with accountDetails masked. */
export async function listOwnPayoutAccounts(actorUserId: string) {
  const accounts = await prisma.userPayoutAccount.findMany({
    where: { userId: actorUserId },
    orderBy: { createdAt: 'desc' },
  });
  return accounts.map((a) => ({
    ...a,
    accountDetails: maskAccountDetails(a.accountDetails as Record<string, unknown>),
  }));
}

/** Get one of the caller's own payout accounts, with accountDetails masked. */
export async function getOwnPayoutAccount(actorUserId: string, accountId: string) {
  const account = await prisma.userPayoutAccount.findUnique({ where: { id: accountId } });
  if (!account) throw ApiError.notFound('Payout account not found');
  if (account.userId !== actorUserId) throw ApiError.forbidden('This payout account does not belong to you');
  return { ...account, accountDetails: maskAccountDetails(account.accountDetails as Record<string, unknown>) };
}

/**
 * Ownership + active-status check used internally by withdrawal-service.ts
 * to load the FULL, UNMASKED account for building Withdrawal.paymentSnapshot
 * — the agent needs the real details to actually pay the user. Never
 * exposed through a read-facing route; masking happens only in the two
 * functions above.
 */
export async function loadOwnActivePayoutAccountForWithdrawal(actorUserId: string, accountId: string) {
  const account = await prisma.userPayoutAccount.findUnique({ where: { id: accountId } });
  if (!account) throw ApiError.badRequest('Invalid payout account');
  if (account.userId !== actorUserId) throw ApiError.forbidden('This payout account does not belong to you');
  if (account.status !== 'ACTIVE') throw ApiError.badRequest('This payout account is not currently active');
  return account;
}

/** Soft-disable one of the caller's own payout accounts. Atomic claim. */
export async function disableOwnPayoutAccount(
  actorUserId: string,
  accountId: string,
  context?: { ip?: string; userAgent?: string }
) {
  const before = await prisma.userPayoutAccount.findUnique({ where: { id: accountId } });
  if (!before) throw ApiError.notFound('Payout account not found');
  if (before.userId !== actorUserId) throw ApiError.forbidden('This payout account does not belong to you');

  const claim = await prisma.userPayoutAccount.updateMany({
    where: { id: accountId, userId: actorUserId, status: 'ACTIVE' },
    data: { status: 'DISABLED', disabledAt: new Date() },
  });
  if (claim.count === 0) {
    throw ApiError.conflict('This payout account is already disabled');
  }

  await prisma.auditLog.create({
    data: {
      userId: actorUserId,
      action: 'USER_PAYOUT_ACCOUNT_DISABLED',
      entity: 'UserPayoutAccount',
      entityId: accountId,
      oldData: { status: 'ACTIVE' },
      newData: { status: 'DISABLED' },
      ip: context?.ip,
      userAgent: context?.userAgent,
    },
  });

  return { id: accountId, status: 'DISABLED' as const };
}
