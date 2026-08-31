import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
import { emitToUser } from '../realtime/broadcast';
import { assertPlatformAdmin, AGENT_SELF_SERVICE_STATUSES } from './agent-service';

// Phase G scope note: this implements exactly what the schema defines under
// "Admin ↔ agent communication" — ONE conversation per agent
// (AgentConversation.agentId is @unique), with exactly two participant
// roles (MessageSenderRole: ADMIN | AGENT). There is no customer role and
// no per-order/per-dispute conversation scoping in the schema; individual
// messages may optionally TAG a related order/dispute via the existing
// nullable relatedOrderId/relatedDisputeId fields, but that never changes
// who may participate or where the conversation "belongs".

const MESSAGE_MAX_LENGTH = 5000; // matches packages/shared/src/constants.ts MESSAGE_MAX_LENGTH
const DEFAULT_PAGE_LIMIT = 20; // matches the existing pagination convention (packages/shared/src/validation.ts)
const MAX_PAGE_LIMIT = 100;

/**
 * Get-or-create the single conversation for an agent. AgentConversation.agentId
 * is @unique, so this follows the same idempotent-creation discipline used
 * throughout this codebase (agent-service.ts's first-time application,
 * inventory-service.ts's first-time funding): find, and on a concurrent
 * create-create race, catch P2002 and refetch rather than assuming
 * find-then-create is safe on its own.
 */
async function getOrCreateConversation(agentId: string) {
  const existing = await prisma.agentConversation.findUnique({ where: { agentId } });
  if (existing) return existing;

  try {
    return await prisma.agentConversation.create({ data: { agentId } });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      const winner = await prisma.agentConversation.findUnique({ where: { agentId } });
      if (winner) return winner;
    }
    throw err;
  }
}

async function loadAgentOrThrow(agentId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) throw ApiError.notFound('Agent not found');
  return agent;
}

/** Verifies a supplied relatedOrderId/relatedDisputeId genuinely belongs to
 * this agent — a message tag is not an authorization bypass: a party
 * cannot reference another agent's order/dispute just by supplying its id. */
async function validateRelatedRefs(agentId: string, relatedOrderId?: string, relatedDisputeId?: string) {
  if (relatedOrderId) {
    const order = await prisma.agentOrder.findUnique({ where: { id: relatedOrderId }, select: { agentId: true } });
    if (!order || order.agentId !== agentId) {
      throw ApiError.badRequest('relatedOrderId does not belong to this conversation\'s agent');
    }
  }
  if (relatedDisputeId) {
    const dispute = await prisma.dispute.findUnique({
      where: { id: relatedDisputeId },
      include: { order: { select: { agentId: true } } },
    });
    if (!dispute || dispute.order.agentId !== agentId) {
      throw ApiError.badRequest('relatedDisputeId does not belong to this conversation\'s agent');
    }
  }
}

function validateBody(body: string) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw ApiError.badRequest('Message body is required');
  }
  if (body.length > MESSAGE_MAX_LENGTH) {
    throw ApiError.badRequest(`Message body must be at most ${MESSAGE_MAX_LENGTH} characters`);
  }
  return body.trim();
}

export interface SendMessageArgs {
  body: string;
  relatedOrderId?: string;
  relatedDisputeId?: string;
}

/**
 * Agent sends a message in their own conversation. Agent identity is
 * always re-resolved from actorUserId (never a client-supplied agentId),
 * mirroring resolveOwnAgentForSelfService's discipline in
 * payment-account-service.ts. Blocked for an agent whose account is not in
 * AGENT_SELF_SERVICE_STATUSES — the same restriction Phase D already
 * applies to every other agent self-service action, extended here rather
 * than inventing a new one.
 */
export async function sendMessageAsAgent(actorUserId: string, rawArgs: SendMessageArgs) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  if (!AGENT_SELF_SERVICE_STATUSES.includes(agent.status)) {
    throw ApiError.forbidden('Your agent account cannot send messages in its current state');
  }

  const body = validateBody(rawArgs.body);
  await validateRelatedRefs(agent.id, rawArgs.relatedOrderId, rawArgs.relatedDisputeId);

  const conversation = await getOrCreateConversation(agent.id);

  const message = await prisma.agentMessage.create({
    data: {
      conversationId: conversation.id,
      senderId: actorUserId,
      senderRole: 'AGENT',
      body,
      relatedOrderId: rawArgs.relatedOrderId ?? null,
      relatedDisputeId: rawArgs.relatedDisputeId ?? null,
    },
  });

  // No realtime emission here: the recipient is "whichever admin happens to
  // be watching", and no admin-specific broadcast room exists anywhere in
  // ws/index.ts. Inventing one would be new realtime architecture, out of
  // scope per Section 15 — admins see new agent messages via the existing
  // admin-queue read pattern (listConversationsWithUnreadForAdmin below),
  // matching how the pending-applications/pending-payment-accounts/
  // open-disputes queues already work in this codebase. Reported as
  // NOT APPLICABLE in the Phase G report, not silently skipped.

  // No audit record for individual messages — matches the existing
  // convention (realtime/chat-service.ts's createMessage is not audited
  // either); see the Phase G report for the explicit reasoning.

  return message;
}

/**
 * Admin sends a message to a specific agent's conversation. Admin
 * authorization is verified inside the service (assertPlatformAdmin), not
 * only at the route. Notifies the agent via the one existing, matching
 * enum value (AGENT_ADMIN_MESSAGE) and delivers realtime via the existing
 * per-user Socket.io room (emitToUser) — the agent's own userId is a
 * single, server-resolved recipient, exactly the shape that channel
 * already supports safely.
 */
export async function sendMessageAsAdmin(adminId: string, agentId: string, rawArgs: SendMessageArgs) {
  await assertPlatformAdmin(adminId);
  const agent = await loadAgentOrThrow(agentId);

  const body = validateBody(rawArgs.body);
  await validateRelatedRefs(agent.id, rawArgs.relatedOrderId, rawArgs.relatedDisputeId);

  const conversation = await getOrCreateConversation(agent.id);

  const message = await prisma.agentMessage.create({
    data: {
      conversationId: conversation.id,
      senderId: adminId,
      senderRole: 'ADMIN',
      body,
      relatedOrderId: rawArgs.relatedOrderId ?? null,
      relatedDisputeId: rawArgs.relatedDisputeId ?? null,
    },
  });

  await prisma.notification.create({
    data: {
      userId: agent.userId,
      type: 'AGENT_ADMIN_MESSAGE',
      title: 'New Message from Admin',
      body: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      data: { conversationId: conversation.id, messageId: message.id },
    },
  });

  emitToUser(agent.userId, 'agent-message:new', {
    conversationId: conversation.id,
    messageId: message.id,
    senderRole: 'ADMIN',
    createdAt: message.createdAt,
  });

  // No audit record for individual messages — see sendMessageAsAgent above.

  return message;
}

/**
 * Resolves whether actorUserId may access a conversation: the conversation's
 * own agent, or a platform admin. No customer role exists to consider.
 */
async function requireConversationAccess(actorUserId: string, conversation: { agentId: string }) {
  const agent = await prisma.agent.findUnique({ where: { id: conversation.agentId }, select: { userId: true } });
  if (agent && agent.userId === actorUserId) return 'agent' as const;
  const user = await prisma.user.findUnique({ where: { id: actorUserId }, select: { role: true } });
  if (user && (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN')) return 'admin' as const;
  throw ApiError.forbidden('You do not have access to this conversation');
}

export async function getOwnConversation(actorUserId: string) {
  const agent = await prisma.agent.findUnique({ where: { userId: actorUserId } });
  if (!agent) throw ApiError.forbidden('You do not have an agent account');
  return getOrCreateConversation(agent.id);
}

export async function getConversationForAgent(adminId: string, agentId: string) {
  await assertPlatformAdmin(adminId);
  await loadAgentOrThrow(agentId);
  return getOrCreateConversation(agentId);
}

export interface ListMessagesArgs {
  cursor?: string; // last-seen AgentMessage id — returns messages strictly after it
  limit?: number;
}

/**
 * Deterministic, cursor-based pagination: ordered by (createdAt, id) so
 * that duplicate timestamps never produce an unstable or duplicate/skipped
 * page, and — unlike offset/skip pagination — a page already fetched can
 * never shift under concurrent inserts (Race H). limit is bounded exactly
 * like the existing pagination convention (packages/shared/src/validation.ts:
 * max 100, default 20).
 *
 * Also marks messages from the OTHER party as read (readAt) on view — the
 * natural, minimal lifecycle for the schema's existing nullable readAt
 * field; no separate mark-as-read endpoint is invented.
 */
export async function listMessages(actorUserId: string, conversationId: string, args: ListMessagesArgs = {}) {
  const conversation = await prisma.agentConversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw ApiError.notFound('Conversation not found');
  const role = await requireConversationAccess(actorUserId, conversation);

  const limit = Math.min(Math.max(1, args.limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);

  const messages = await prisma.agentMessage.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    take: limit,
  });

  const otherPartyRole = role === 'agent' ? 'ADMIN' : 'AGENT';
  const unreadIds = messages.filter((m) => m.senderRole === otherPartyRole && !m.readAt).map((m) => m.id);
  if (unreadIds.length > 0) {
    await prisma.agentMessage.updateMany({ where: { id: { in: unreadIds } }, data: { readAt: new Date() } });
  }

  return {
    messages,
    nextCursor: messages.length === limit ? messages[messages.length - 1].id : null,
  };
}

export async function listConversationsWithUnreadForAdmin() {
  const unread = await prisma.agentMessage.groupBy({
    by: ['conversationId'],
    where: { senderRole: 'AGENT', readAt: null },
    _count: { _all: true },
  });
  if (unread.length === 0) return [];

  const conversations = await prisma.agentConversation.findMany({
    where: { id: { in: unread.map((u) => u.conversationId) } },
    include: { agent: { select: { id: true, displayName: true, userId: true } } },
  });

  const countByConversation = new Map(unread.map((u) => [u.conversationId, u._count._all]));
  return conversations.map((c) => ({ ...c, unreadCount: countByConversation.get(c.id) ?? 0 }));
}
