import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { AGENT_SELF_SERVICE_STATUSES, assertPlatformAdmin } from './agent-service';

// ─── accountDetails validation against a method's fieldSchema ───
//
// PaymentMethodDefinition.fieldSchema has the shape { requiredFields: string[] }.
// Validation is a strict whitelist: every required field must be present as a
// non-empty string, and no field outside the whitelist is accepted — this is
// what "do not silently accept fields not defined by the schema" (Phase D §6)
// means in practice, since accountDetails is otherwise unstructured JSON.
function validateAccountDetails(fieldSchema: unknown, accountDetails: unknown): Record<string, string> {
  const required = (fieldSchema as { requiredFields?: unknown })?.requiredFields;
  if (!Array.isArray(required) || required.some((f) => typeof f !== 'string')) {
    throw ApiError.internal('Payment method is misconfigured (invalid fieldSchema)');
  }

  if (
    !accountDetails ||
    typeof accountDetails !== 'object' ||
    Array.isArray(accountDetails)
  ) {
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
 * Validates the country/payment-method consistency invariant from Phase B/C
 * correction C — PaymentMethodDefinition.countryId must equal the target
 * country, the method and country must both be active, and the method type
 * must be a defined enum value (guaranteed by Prisma once loaded, checked
 * here defensively). This is the server-side enforcement Phase C's schema
 * comment explicitly deferred to this phase.
 */
async function loadAndValidateMethod(countryId: string, methodDefId: string) {
  const country = await prisma.country.findUnique({ where: { id: countryId } });
  if (!country) throw ApiError.badRequest('Invalid country');
  if (!country.isActive || !country.agentPaymentEnabled) {
    throw ApiError.badRequest('Agent payments are not available for this country');
  }

  const method = await prisma.paymentMethodDefinition.findUnique({ where: { id: methodDefId } });
  if (!method) throw ApiError.badRequest('Invalid payment method');
  if (!method.isActive) throw ApiError.badRequest('This payment method is not currently active');
  if (method.countryId !== countryId) {
    throw ApiError.badRequest('This payment method does not belong to the selected country');
  }

  return { country, method };
}

export interface CreatePaymentAccountArgs {
  countryId: string;
  methodDefId: string;
  accountDetails: unknown;
}

/**
 * Resolves the caller's OWN Agent identity by looking it up fresh from
 * actorUserId — never accepted as a parameter that could be paired with the
 * wrong user. This makes "operate on someone else's Agent" structurally
 * impossible rather than merely checked, and is what makes
 * createAgentPaymentAccount/updateAgentPaymentAccount independently
 * testable for the "agent cannot manage another agent" requirement without
 * relying on the route layer having done the right thing first.
 */
async function resolveOwnAgentForSelfService(actorUserId: string) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  if (!AGENT_SELF_SERVICE_STATUSES.includes(agent.status)) {
    throw ApiError.forbidden('Your agent account cannot manage payment accounts in its current state');
  }
  return agent;
}

/**
 * Create a payment account for the authenticated agent. The Agent identity
 * is always re-resolved from actorUserId inside this function — never
 * accepted as a pre-resolved id/status pair (Phase D §6/§17).
 */
export async function createAgentPaymentAccount(
  actorUserId: string,
  args: CreatePaymentAccountArgs,
  context?: { ip?: string; userAgent?: string }
) {
  const agent = await resolveOwnAgentForSelfService(actorUserId);

  const { method } = await loadAndValidateMethod(args.countryId, args.methodDefId);
  const clean = validateAccountDetails(method.fieldSchema, args.accountDetails);

  return prisma.$transaction(async (tx) => {
    const account = await tx.agentPaymentAccount.create({
      data: {
        agentId: agent.id,
        countryId: args.countryId,
        methodDefId: args.methodDefId,
        status: 'PENDING_APPROVAL',
        accountDetails: clean,
      },
    });

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'AGENT_PAYMENT_ACCOUNT_CREATED',
        entity: 'AgentPaymentAccount',
        entityId: account.id,
        newData: { agentId: agent.id, methodDefId: args.methodDefId, countryId: args.countryId, status: 'PENDING_APPROVAL' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return account;
  });
}

/**
 * Edit an existing payment account. Any material change forces
 * APPROVED -> PENDING_APPROVAL (Phase D §9) — editing never leaves an
 * account silently approved with different details than what was reviewed.
 * Legal from APPROVED, PENDING_APPROVAL, or REJECTED; not from DISABLED
 * (Phase B never defined a re-enable-via-edit path, so none is invented
 * here).
 *
 * Concurrency: the conditional claim's WHERE targets the account's CURRENT
 * status among the legal-to-edit set, so two concurrent edits, or an edit
 * racing an admin approval/rejection, resolve to exactly one winner — the
 * loser's claim affects zero rows.
 */
export async function updateAgentPaymentAccount(
  actorUserId: string,
  accountId: string,
  args: CreatePaymentAccountArgs,
  context?: { ip?: string; userAgent?: string }
) {
  const agent = await resolveOwnAgentForSelfService(actorUserId);

  const { method } = await loadAndValidateMethod(args.countryId, args.methodDefId);
  const clean = validateAccountDetails(method.fieldSchema, args.accountDetails);

  return prisma.$transaction(async (tx) => {
    const before = await tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
    if (!before) throw ApiError.notFound('Payment account not found');
    if (before.agentId !== agent.id) throw ApiError.forbidden('Not your payment account');

    const claim = await tx.agentPaymentAccount.updateMany({
      where: {
        id: accountId,
        agentId: agent.id,
        status: { in: ['APPROVED', 'PENDING_APPROVAL', 'REJECTED'] },
      },
      data: {
        countryId: args.countryId,
        methodDefId: args.methodDefId,
        accountDetails: clean,
        status: 'PENDING_APPROVAL',
        reviewedBy: null,
        reviewedAt: null,
      },
    });

    if (claim.count === 0) {
      const current = await tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
      throw ApiError.conflict(
        `Payment account cannot be edited in its current state (${current?.status})`
      );
    }

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        action: 'AGENT_PAYMENT_ACCOUNT_MODIFIED',
        entity: 'AgentPaymentAccount',
        entityId: accountId,
        // Old/new state are recorded WITHOUT the actual account details —
        // audit the fact and shape of the change, never the credentials
        // themselves (Phase D §13, "do not log secrets").
        oldData: { status: before.status, methodDefId: before.methodDefId, countryId: before.countryId },
        newData: { status: 'PENDING_APPROVAL', methodDefId: args.methodDefId, countryId: args.countryId },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
  });
}

export async function approveAgentPaymentAccount(
  adminId: string,
  accountId: string,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.agentPaymentAccount.findUnique({
      where: { id: accountId },
      include: { agent: { select: { userId: true } } },
    });
    if (!before) throw ApiError.notFound('Payment account not found');
    if (before.agent.userId === adminId) {
      throw ApiError.forbidden('You cannot review your own payment account');
    }

    // Re-verify the country/method relationship at approval time too, per
    // Phase D §7 — a defense-in-depth re-check, not trusting that it still
    // holds just because it held at creation.
    const method = await tx.paymentMethodDefinition.findUnique({ where: { id: before.methodDefId } });
    if (!method || !method.isActive || method.countryId !== before.countryId) {
      throw ApiError.conflict('Payment method/country relationship is no longer valid — cannot approve');
    }

    // Pin the claim to the exact row version just read (updatedAt), not only
    // its status. Without this, an agent editing accountDetails between the
    // admin's read above and this UPDATE would still satisfy
    // status='PENDING_APPROVAL' and get silently approved with content the
    // admin never actually reviewed — status alone is not a strong enough
    // gate here the way it is for the application/agent-status transitions,
    // because editing a payment account does not change its status away from
    // PENDING_APPROVAL the way a competing approve/reject would.
    const claim = await tx.agentPaymentAccount.updateMany({
      where: { id: accountId, status: 'PENDING_APPROVAL', updatedAt: before.updatedAt },
      data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt: new Date() },
    });

    if (claim.count === 0) {
      const current = await tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
      if (current && current.status === 'PENDING_APPROVAL') {
        throw ApiError.conflict(
          'Payment account was modified after being loaded for review — please reload and try again'
        );
      }
      return { accountId, alreadyReviewed: true, status: current?.status ?? 'UNKNOWN' };
    }

    const agent = await tx.agent.findUnique({ where: { id: before.agentId } });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_PAYMENT_ACCOUNT_APPROVED',
        entity: 'AgentPaymentAccount',
        entityId: accountId,
        oldData: { status: 'PENDING_APPROVAL' },
        newData: { status: 'APPROVED' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId: agent!.userId,
        type: 'AGENT_PAYMENT_ACCOUNT_APPROVED',
        title: 'Payment Account Approved',
        body: 'One of your payment accounts has been approved and can now be used for orders.',
        data: { accountId, agentId: before.agentId },
      },
    });

    return { accountId, alreadyReviewed: false, status: 'APPROVED' };
  });
}

export async function rejectAgentPaymentAccount(
  adminId: string,
  accountId: string,
  reviewNote: string,
  context?: { ip?: string; userAgent?: string }
) {
  if (!reviewNote || reviewNote.trim().length === 0) {
    throw ApiError.badRequest('A review note is required to reject a payment account');
  }
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.agentPaymentAccount.findUnique({
      where: { id: accountId },
      include: { agent: { select: { userId: true } } },
    });
    if (!before) throw ApiError.notFound('Payment account not found');
    if (before.agent.userId === adminId) {
      throw ApiError.forbidden('You cannot review your own payment account');
    }

    // Same optimistic-version pin as approveAgentPaymentAccount, for the same
    // reason: a status-only claim cannot distinguish "already reviewed" from
    // "edited since I loaded it".
    const claim = await tx.agentPaymentAccount.updateMany({
      where: { id: accountId, status: 'PENDING_APPROVAL', updatedAt: before.updatedAt },
      data: { status: 'REJECTED', reviewedBy: adminId, reviewedAt: new Date() },
    });

    if (claim.count === 0) {
      const current = await tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
      if (current && current.status === 'PENDING_APPROVAL') {
        throw ApiError.conflict(
          'Payment account was modified after being loaded for review — please reload and try again'
        );
      }
      return { accountId, alreadyReviewed: true, status: current?.status ?? 'UNKNOWN' };
    }

    const agent = await tx.agent.findUnique({ where: { id: before.agentId } });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_PAYMENT_ACCOUNT_REJECTED',
        entity: 'AgentPaymentAccount',
        entityId: accountId,
        oldData: { status: 'PENDING_APPROVAL' },
        newData: { status: 'REJECTED', reviewNote: reviewNote.trim() },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId: agent!.userId,
        type: 'AGENT_PAYMENT_ACCOUNT_REJECTED',
        title: 'Payment Account Rejected',
        body: `One of your payment accounts was not approved: ${reviewNote.trim()}`,
        data: { accountId, agentId: before.agentId },
      },
    });

    return { accountId, alreadyReviewed: false, status: 'REJECTED' };
  });
}

/**
 * Shared disable implementation. `verifyOwnership` is called INSIDE the
 * transaction with the loaded row and must throw if the actor is not
 * entitled to disable it — the two exported wrappers below supply that
 * check themselves rather than trusting a caller-supplied boolean flag,
 * which was the previous (rejected) shape of this function.
 */
async function disablePaymentAccountInternal(
  actorId: string,
  accountId: string,
  verifyOwnership: (tx: any, account: { agentId: string }) => Promise<void>,
  context?: { ip?: string; userAgent?: string }
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
    if (!before) throw ApiError.notFound('Payment account not found');
    await verifyOwnership(tx, before);

    const claim = await tx.agentPaymentAccount.updateMany({
      where: { id: accountId, status: { in: ['APPROVED', 'PENDING_APPROVAL'] } },
      data: { status: 'DISABLED' },
    });

    if (claim.count === 0) {
      const current = await tx.agentPaymentAccount.findUnique({ where: { id: accountId } });
      throw ApiError.conflict(
        `Payment account cannot be disabled in its current state (${current?.status})`
      );
    }

    await tx.auditLog.create({
      data: {
        userId: actorId,
        action: 'AGENT_PAYMENT_ACCOUNT_DISABLED',
        entity: 'AgentPaymentAccount',
        entityId: accountId,
        oldData: { status: before.status },
        newData: { status: 'DISABLED' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    return { accountId, status: 'DISABLED' };
  });
}

/**
 * Agent self-service disable. Never deletes the row — history is preserved
 * (Phase D §10/§34). Legal from APPROVED or PENDING_APPROVAL; a REJECTED
 * account is already unusable, and disabling an already-DISABLED account is
 * a no-op guarded by the same conditional claim.
 */
export async function disableOwnPaymentAccount(
  actorUserId: string,
  accountId: string,
  context?: { ip?: string; userAgent?: string }
) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');

  return disablePaymentAccountInternal(
    actorUserId,
    accountId,
    async (_tx, account) => {
      if (account.agentId !== agent.id) throw ApiError.forbidden('Not your payment account');
    },
    context
  );
}

/**
 * Admin-initiated disable. Ownership is irrelevant here by design — an
 * admin may disable any agent's account — but the caller's admin privilege
 * is verified INSIDE this function, not trusted from the route.
 */
export async function adminDisablePaymentAccount(
  adminId: string,
  accountId: string,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);
  return disablePaymentAccountInternal(adminId, accountId, async () => {}, context);
}

export async function listOwnPaymentAccounts(agentId: string) {
  return prisma.agentPaymentAccount.findMany({
    where: { agentId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listPendingPaymentAccounts() {
  return prisma.agentPaymentAccount.findMany({
    where: { status: 'PENDING_APPROVAL' },
    orderBy: { createdAt: 'asc' },
    include: { agent: { select: { id: true, displayName: true, countryId: true } } },
  });
}
