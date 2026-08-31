import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

const PLATFORM_ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

/**
 * Verifies the caller holds a platform admin role, checked against the
 * User's own record — not merely trusted from the route layer. Mirrors the
 * existing assertGroupRole/assertActiveMember pattern (chat-service.ts):
 * authorization lives in the service function itself, which is what makes
 * every approve/reject/status function below independently testable without
 * a live HTTP/JWT layer, exactly like createCompetition's assertGroupRole.
 *
 * Deliberately reads User.role directly rather than trusting a caller-
 * supplied role string — the route layer's requirePermission check is a
 * first line of defense, this is the second, and neither is optional.
 */
export async function assertPlatformAdmin(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
  if (!user) throw ApiError.unauthorized('Authentication required');
  if (!PLATFORM_ADMIN_ROLES.includes(user.role)) {
    throw ApiError.forbidden('Admin privileges required');
  }
  return user;
}

// ─── Agent status transition table ──────────────────────────────
//
// The single source of truth for which Agent.status transitions are legal.
// Every status-changing function below claims a transition FROM this table,
// never an ad-hoc check — this is what keeps "only legal transitions occur"
// provable in one place rather than scattered per-function.
const LEGAL_AGENT_TRANSITIONS: Record<string, string[]> = {
  PENDING_VERIFICATION: ['ACTIVE'], // via application approval only
  ACTIVE: ['TEMPORARILY_SUSPENDED', 'UNDER_REVIEW', 'DISABLED'],
  TEMPORARILY_SUSPENDED: ['ACTIVE', 'DISABLED'],
  UNDER_REVIEW: ['ACTIVE', 'TEMPORARILY_SUSPENDED', 'DISABLED'],
  DISABLED: [], // terminal — no transitions out in this phase
};

// Agent statuses in which self-service actions (payment-account
// create/edit) are permitted. A suspended/disabled/under-review agent
// cannot change their payout destination while under administrative
// scrutiny — a deliberate, security-relevant restriction (Phase D §9/§Race I).
export const AGENT_SELF_SERVICE_STATUSES = ['PENDING_VERIFICATION', 'ACTIVE'];

export interface SubmitAgentApplicationArgs {
  countryId: string;
  displayName: string;
  contactEmail: string;
  contactPhone?: string;
}

function validateApplicationInput(args: SubmitAgentApplicationArgs) {
  if (!args.countryId || typeof args.countryId !== 'string') {
    throw ApiError.badRequest('countryId is required');
  }
  if (!args.displayName || typeof args.displayName !== 'string' || args.displayName.trim().length === 0) {
    throw ApiError.badRequest('displayName is required');
  }
  if (
    !args.contactEmail ||
    typeof args.contactEmail !== 'string' ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.contactEmail)
  ) {
    throw ApiError.badRequest('A valid contactEmail is required');
  }
  if (args.contactPhone !== undefined && typeof args.contactPhone !== 'string') {
    throw ApiError.badRequest('contactPhone must be a string');
  }
  return {
    countryId: args.countryId,
    displayName: args.displayName.trim(),
    contactEmail: args.contactEmail.trim(),
    contactPhone: args.contactPhone?.trim() || null,
  };
}

/**
 * Submit an agent application. Only the minimal profile fields the platform
 * actually needs are stored (Phase B §7) — no speculative KYC/identity
 * documents, since Phase A confirmed no such infrastructure exists.
 *
 * First-time application: creates the Agent identity (PENDING_VERIFICATION)
 * and its first AgentApplication (SUBMITTED) atomically. Agent.userId's
 * unique constraint is the concurrency backstop for two simultaneous
 * first-time submissions — see the P2002 handling below.
 *
 * Re-application (existing Agent, no live SUBMITTED application): creates a
 * NEW AgentApplication row without ever mutating or replacing the old one.
 * Guarded by locking the Agent row first (SELECT ... FOR UPDATE) so two
 * concurrent re-application attempts cannot both create a live application —
 * the schema has no unique constraint that could do this instead, so the row
 * lock is the mechanism, exactly as used for Mode 2's room claims.
 */
export async function submitAgentApplication(
  userId: string,
  rawArgs: SubmitAgentApplicationArgs,
  context?: { ip?: string; userAgent?: string }
) {
  const args = validateApplicationInput(rawArgs);

  const existing = await prisma.agent.findUnique({ where: { userId } });

  if (!existing) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const agent = await tx.agent.create({
          data: {
            userId,
            countryId: args.countryId,
            status: 'PENDING_VERIFICATION',
            displayName: args.displayName,
            contactEmail: args.contactEmail,
            contactPhone: args.contactPhone,
          },
        });

        const application = await tx.agentApplication.create({
          data: {
            agentId: agent.id,
            submittedData: {
              displayName: args.displayName,
              contactEmail: args.contactEmail,
              contactPhone: args.contactPhone,
              countryId: args.countryId,
            },
            status: 'SUBMITTED',
          },
        });

        await tx.auditLog.create({
          data: {
            userId,
            action: 'AGENT_APPLICATION_SUBMITTED',
            entity: 'Agent',
            entityId: agent.id,
            newData: { agentId: agent.id, applicationId: application.id, status: agent.status },
            ip: context?.ip,
            userAgent: context?.userAgent,
          },
        });

        await tx.notification.create({
          data: {
            userId,
            type: 'AGENT_APPLICATION_RECEIVED',
            title: 'Agent Application Received',
            body: 'Your agent application has been received and is awaiting review.',
            data: { agentId: agent.id, applicationId: application.id },
          },
        });

        return { agent, application };
      });

      return result;
    } catch (err) {
      // A concurrent first-time submission from the same user won the race
      // for Agent.userId's unique constraint — never a second live Agent.
      if ((err as { code?: string }).code === 'P2002') {
        throw ApiError.conflict('You already have an agent application in progress');
      }
      throw err;
    }
  }

  // Re-application path — lock the Agent row first so two concurrent
  // re-application attempts cannot both observe "no live application" and
  // both create one. This is the same SELECT ... FOR UPDATE discipline used
  // throughout the escrow/room work, applied here because AgentApplication
  // has no unique constraint that could serve as the concurrency gate.
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ status: string }[]>`
      SELECT "status" FROM "agents" WHERE "id" = ${existing.id} FOR UPDATE
    `;
    const agentStatus = locked[0]?.status;
    if (!agentStatus) throw ApiError.notFound('Agent not found');

    if (agentStatus !== 'PENDING_VERIFICATION') {
      throw ApiError.conflict(
        agentStatus === 'ACTIVE'
          ? 'You already have an active agent account'
          : 'Your agent account cannot accept a new application in its current state'
      );
    }

    const liveApplication = await tx.agentApplication.findFirst({
      where: { agentId: existing.id, status: 'SUBMITTED' },
    });
    if (liveApplication) {
      throw ApiError.conflict('You already have an agent application in progress');
    }

    const agent = await tx.agent.update({
      where: { id: existing.id },
      data: {
        countryId: args.countryId,
        displayName: args.displayName,
        contactEmail: args.contactEmail,
        contactPhone: args.contactPhone,
      },
    });

    const application = await tx.agentApplication.create({
      data: {
        agentId: agent.id,
        submittedData: {
          displayName: args.displayName,
          contactEmail: args.contactEmail,
          contactPhone: args.contactPhone,
          countryId: args.countryId,
        },
        status: 'SUBMITTED',
      },
    });

    await tx.auditLog.create({
      data: {
        userId,
        action: 'AGENT_APPLICATION_SUBMITTED',
        entity: 'Agent',
        entityId: agent.id,
        newData: { agentId: agent.id, applicationId: application.id, reapplication: true },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId,
        type: 'AGENT_APPLICATION_RECEIVED',
        title: 'Agent Application Received',
        body: 'Your agent application has been received and is awaiting review.',
        data: { agentId: agent.id, applicationId: application.id, reapplication: true },
      },
    });

    return { agent, application };
  });
}

/**
 * Approve an agent application. Transactional, atomically claims BOTH the
 * application and the agent status transition as conditional updates — the
 * first statement of the transaction, before any audit/notification write.
 *
 * Concurrency: two admins approving the same application race on the
 * application's conditional claim (WHERE status = 'SUBMITTED'). Exactly one
 * wins; the loser's claim affects zero rows and returns a deterministic
 * "already reviewed" result with no audit/notification duplication.
 */
export async function approveAgentApplication(
  adminId: string,
  applicationId: string,
  reviewNote: string | undefined,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.agentApplication.findUnique({
      where: { id: applicationId },
      include: { agent: { select: { userId: true } } },
    });
    if (!before) throw ApiError.notFound('Application not found');
    if (before.agent.userId === adminId) {
      throw ApiError.forbidden('You cannot review your own agent application');
    }

    const reviewedAt = new Date();
    const claim = await tx.agentApplication.updateMany({
      where: { id: applicationId, status: 'SUBMITTED' },
      data: { status: 'APPROVED', reviewedBy: adminId, reviewedAt, reviewNote: reviewNote ?? null },
    });

    if (claim.count === 0) {
      const current = await tx.agentApplication.findUnique({ where: { id: applicationId } });
      return {
        applicationId,
        alreadyReviewed: true,
        status: current?.status ?? 'UNKNOWN',
        reviewedBy: current?.reviewedBy ?? null,
      };
    }

    const agentClaim = await tx.agent.updateMany({
      where: { id: before.agentId, status: 'PENDING_VERIFICATION' },
      data: { status: 'ACTIVE' },
    });
    if (agentClaim.count === 0) {
      // The application was still SUBMITTED but the agent had already left
      // PENDING_VERIFICATION through some other path — an inconsistent state
      // that should never occur given the transition table above. Fail loud
      // rather than silently activate/leave a mismatched state.
      throw ApiError.conflict('Agent is not in a state that can be activated by this approval');
    }

    const agent = await tx.agent.findUnique({ where: { id: before.agentId } });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_APPLICATION_APPROVED',
        entity: 'AgentApplication',
        entityId: applicationId,
        oldData: { status: 'SUBMITTED', agentStatus: 'PENDING_VERIFICATION' },
        newData: { status: 'APPROVED', agentStatus: 'ACTIVE', reviewNote: reviewNote ?? null },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId: agent!.userId,
        type: 'AGENT_APPLICATION_APPROVED',
        title: 'Agent Application Approved',
        body: 'Your agent application has been approved. Your account is now active.',
        data: { agentId: agent!.id, applicationId },
      },
    });

    return { applicationId, alreadyReviewed: false, status: 'APPROVED', agentId: agent!.id };
  });
}

/**
 * Reject an agent application. Same atomic-claim shape as approval, but the
 * Agent explicitly stays in PENDING_VERIFICATION (never transitions to
 * ACTIVE, never silently becomes DISABLED) so a later re-application remains
 * legal — see submitAgentApplication's re-application path.
 */
export async function rejectAgentApplication(
  adminId: string,
  applicationId: string,
  reviewNote: string,
  context?: { ip?: string; userAgent?: string }
) {
  if (!reviewNote || reviewNote.trim().length === 0) {
    throw ApiError.badRequest('A review note is required to reject an application');
  }
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.agentApplication.findUnique({
      where: { id: applicationId },
      include: { agent: { select: { userId: true } } },
    });
    if (!before) throw ApiError.notFound('Application not found');
    if (before.agent.userId === adminId) {
      throw ApiError.forbidden('You cannot review your own agent application');
    }

    const reviewedAt = new Date();
    const claim = await tx.agentApplication.updateMany({
      where: { id: applicationId, status: 'SUBMITTED' },
      data: { status: 'REJECTED', reviewedBy: adminId, reviewedAt, reviewNote: reviewNote.trim() },
    });

    if (claim.count === 0) {
      const current = await tx.agentApplication.findUnique({ where: { id: applicationId } });
      return {
        applicationId,
        alreadyReviewed: true,
        status: current?.status ?? 'UNKNOWN',
        reviewedBy: current?.reviewedBy ?? null,
      };
    }

    // Deliberately NOT touching Agent.status — it remains PENDING_VERIFICATION,
    // which is exactly what keeps re-application legal (Phase D §2/§4).
    const agent = await tx.agent.findUnique({ where: { id: before.agentId } });

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action: 'AGENT_APPLICATION_REJECTED',
        entity: 'AgentApplication',
        entityId: applicationId,
        oldData: { status: 'SUBMITTED' },
        newData: { status: 'REJECTED', reviewNote: reviewNote.trim() },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    await tx.notification.create({
      data: {
        userId: agent!.userId,
        type: 'AGENT_APPLICATION_REJECTED',
        title: 'Agent Application Rejected',
        body: 'Your agent application was not approved. You may submit a new application.',
        data: { agentId: agent!.id, applicationId, reason: reviewNote.trim() },
      },
    });

    return { applicationId, alreadyReviewed: false, status: 'REJECTED', agentId: agent!.id };
  });
}

/**
 * Shared implementation for every Agent.status transition beyond approval
 * (suspend / reactivate / under-review / disable). Every legal transition is
 * looked up in LEGAL_AGENT_TRANSITIONS and claimed atomically — the exact
 * same conditional-updateMany-as-first-statement pattern used everywhere
 * else in this codebase's money/lifecycle code.
 */
async function changeAgentStatus(
  adminId: string,
  agentId: string,
  targetStatus: string,
  action: string,
  notificationType: string | null,
  notificationBody: string | null,
  reason: string | undefined,
  context?: { ip?: string; userAgent?: string }
) {
  await assertPlatformAdmin(adminId);

  return prisma.$transaction(async (tx) => {
    const before = await tx.agent.findUnique({ where: { id: agentId } });
    if (!before) throw ApiError.notFound('Agent not found');
    if (before.userId === adminId) {
      throw ApiError.forbidden('You cannot change the status of your own agent account');
    }

    const legalFrom = Object.entries(LEGAL_AGENT_TRANSITIONS)
      .filter(([, to]) => to.includes(targetStatus))
      .map(([from]) => from);

    if (!legalFrom.includes(before.status)) {
      throw ApiError.badRequest(
        `Cannot transition agent from ${before.status} to ${targetStatus}`
      );
    }

    const claim = await tx.agent.updateMany({
      where: { id: agentId, status: { in: legalFrom } },
      data:
        targetStatus === 'TEMPORARILY_SUSPENDED'
          ? { status: targetStatus, suspendedAt: new Date(), suspendedReason: reason ?? null }
          : targetStatus === 'DISABLED'
            ? { status: targetStatus, disabledAt: new Date() }
            : targetStatus === 'ACTIVE'
              ? { status: targetStatus, suspendedAt: null, suspendedReason: null }
              : { status: targetStatus },
    });

    if (claim.count === 0) {
      // Lost a race against a concurrent status change — no audit, no
      // notification, deterministic conflict.
      const current = await tx.agent.findUnique({ where: { id: agentId } });
      throw ApiError.conflict(
        `Agent status already changed concurrently (now ${current?.status})`
      );
    }

    await tx.auditLog.create({
      data: {
        userId: adminId,
        action,
        entity: 'Agent',
        entityId: agentId,
        oldData: { status: before.status },
        newData: { status: targetStatus, reason: reason ?? null },
        ip: context?.ip,
        userAgent: context?.userAgent,
      },
    });

    if (notificationType && notificationBody) {
      await tx.notification.create({
        data: {
          userId: before.userId,
          type: notificationType,
          title: 'Agent Account Update',
          body: notificationBody,
          data: { agentId, status: targetStatus, reason: reason ?? null },
        },
      });
    }

    return { agentId, status: targetStatus };
  });
}

export async function suspendAgent(
  adminId: string,
  agentId: string,
  reason: string,
  context?: { ip?: string; userAgent?: string }
) {
  if (!reason || reason.trim().length === 0) {
    throw ApiError.badRequest('A suspension reason is required');
  }
  return changeAgentStatus(
    adminId,
    agentId,
    'TEMPORARILY_SUSPENDED',
    'AGENT_SUSPENDED',
    'AGENT_SUSPENDED',
    `Your agent account has been temporarily suspended: ${reason.trim()}`,
    reason,
    context
  );
}

export async function reactivateAgent(
  adminId: string,
  agentId: string,
  context?: { ip?: string; userAgent?: string }
) {
  return changeAgentStatus(
    adminId,
    agentId,
    'ACTIVE',
    'AGENT_REACTIVATED',
    null, // no dedicated notification type was specified for reactivation in Phase D's list
    null,
    undefined,
    context
  );
}

export async function markAgentUnderReview(
  adminId: string,
  agentId: string,
  reason: string | undefined,
  context?: { ip?: string; userAgent?: string }
) {
  return changeAgentStatus(
    adminId,
    agentId,
    'UNDER_REVIEW',
    'AGENT_UNDER_REVIEW',
    null,
    null,
    reason,
    context
  );
}

export async function disableAgent(
  adminId: string,
  agentId: string,
  reason: string | undefined,
  context?: { ip?: string; userAgent?: string }
) {
  return changeAgentStatus(
    adminId,
    agentId,
    'DISABLED',
    'AGENT_DISABLED',
    null,
    null,
    reason,
    context
  );
}

// ─── Reads / authorization helpers ──────────────────────────────

export async function getAgentByUserId(userId: string) {
  return prisma.agent.findUnique({ where: { userId } });
}

/**
 * Resolves the caller's own Agent identity or throws. Used by every
 * agent-self-service route — Agent identity is ALWAYS derived from the
 * authenticated session, never from a client-supplied agentId (Phase D §6).
 */
export async function requireOwnAgent(userId: string) {
  const agent = await prisma.agent.findUnique({ where: { userId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  return agent;
}

export async function getAgentApplicationHistory(agentId: string) {
  return prisma.agentApplication.findMany({
    where: { agentId },
    orderBy: { submittedAt: 'desc' },
  });
}

export async function listSubmittedApplications() {
  return prisma.agentApplication.findMany({
    where: { status: 'SUBMITTED' },
    orderBy: { submittedAt: 'asc' },
    include: { agent: { select: { id: true, displayName: true, countryId: true, userId: true } } },
  });
}
