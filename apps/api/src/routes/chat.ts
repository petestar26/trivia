import { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';

type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';
type GroupMemberStatus = 'ACTIVE' | 'PENDING' | 'BANNED' | 'MUTED' | 'LEFT';

const MANAGER_ROLES: GroupMemberRole[] = ['OWNER', 'ADMIN'];

const MESSAGE_SENDER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

async function getGroupOrThrow(groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });

  if (!group) {
    throw ApiError.notFound('Group not found');
  }

  return group;
}

async function getGroupMembership(groupId: string, userId: string) {
  return prisma.groupMember.findUnique({
    where: {
      groupId_userId: {
        groupId,
        userId,
      },
    },
  });
}

// Verifies the user is an ACTIVE member of the group. Returns the membership.
async function assertActiveMember(groupId: string, userId: string) {
  const membership = await getGroupMembership(groupId, userId);

  if (!membership || membership.status !== 'ACTIVE') {
    throw ApiError.forbidden('You are not a member of this group');
  }

  return membership;
}

// Loads a message and verifies it belongs to the given group.
// Returns the message or throws not-found, so that cross-group access is opaque.
async function getMessageInGroup(groupId: string, messageId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: {
      user: { select: MESSAGE_SENDER_SELECT },
      replyTo: {
        include: {
          user: { select: MESSAGE_SENDER_SELECT },
        },
      },
      reactions: {
        select: {
          userId: true,
          type: true,
        },
      },
    },
  });

  if (!message || message.groupId !== groupId || message.isDeleted) {
    throw ApiError.notFound('Message not found');
  }

  return message;
}

function serializeMessage(message: {
  id: string;
  groupId: string;
  userId: string;
  content: string;
  type: string;
  isEdited: boolean;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  replyToId?: string | null;
  user?: { id: string; username: string; displayName: string; avatarUrl?: string };
  replyTo?: any;
  reactions?: Array<{ userId: string; type: string }>;
}) {
  return {
    id: message.id,
    groupId: message.groupId,
    userId: message.userId,
    content: message.content,
    type: message.type.toLowerCase(),
    sender: message.user,
    replyTo: message.replyTo ? serializeMessage(message.replyTo) : null,
    isEdited: message.isEdited,
    isDeleted: message.isDeleted,
    reactions: message.reactions ?? [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

export async function chatRoutes(server: FastifyInstance): Promise<void> {
  // Create message
  server.post<{
    Params: { id: string };
    Body: { content: string; replyToId?: string };
  }>(
    '/:id/messages',
    {
      preHandler: [authenticate],
      rateLimit: { max: 30, timeWindow: '1 minute' },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 5000 },
            replyToId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const groupId = request.params.id;
      const userId = request.user!.sub;

      const content = request.body.content;
      if (!content.trim()) {
        throw ApiError.badRequest('Message cannot be whitespace only');
      }

      await getGroupOrThrow(groupId);
      await assertActiveMember(groupId, userId);

      const data: { content: string; type: 'TEXT'; replyToId?: string } = {
        content,
        type: 'TEXT',
      };

      if (request.body.replyToId) {
        const parent = await prisma.message.findUnique({
          where: { id: request.body.replyToId },
        });

        if (!parent || parent.groupId !== groupId || parent.isDeleted) {
          throw ApiError.badRequest('Parent message not found in this group');
        }

        data.replyToId = request.body.replyToId;
      }

      const message = await prisma.message.create({
        data: {
          groupId,
          userId,
          content: data.content,
          type: data.type,
          replyToId: data.replyToId,
        },
        include: {
          user: { select: MESSAGE_SENDER_SELECT },
          replyTo: {
            include: {
              user: { select: MESSAGE_SENDER_SELECT },
            },
          },
          reactions: {
            select: {
              userId: true,
              type: true,
            },
          },
        },
      });

      reply.status(201).send({
        success: true,
        data: serializeMessage(message),
      });
    }
  );

  // Get message history
  server.get<{
    Params: { id: string };
    Querystring: { page?: number; limit?: number };
  }>(
    '/:id/messages',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const page = request.query.page ?? 1;
      const limit = request.query.limit ?? 20;

      await getGroupOrThrow(groupId);
      await assertActiveMember(groupId, request.user!.sub);

      const where = { groupId, isDeleted: false };

      const [messages, total] = await Promise.all([
        prisma.message.findMany({
          where,
          orderBy: { createdAt: 'asc' },
          skip: (page - 1) * limit,
          take: limit,
          include: {
            user: { select: MESSAGE_SENDER_SELECT },
            replyTo: {
              include: {
                user: { select: MESSAGE_SENDER_SELECT },
              },
            },
            reactions: {
              select: {
                userId: true,
                type: true,
              },
            },
          },
        }),
        prisma.message.count({ where }),
      ]);

      const totalPages = Math.ceil(total / limit);

      return {
        success: true,
        data: messages.map(serializeMessage),
        meta: {
          page,
          limit,
          total,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
      };
    }
  );

  // Get single message
  server.get<{ Params: { id: string; messageId: string } }>(
    '/:id/messages/:messageId',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'messageId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            messageId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;

      await getGroupOrThrow(groupId);
      await assertActiveMember(groupId, request.user!.sub);

      const message = await getMessageInGroup(groupId, request.params.messageId);

      return {
        success: true,
        data: serializeMessage(message),
      };
    }
  );

  // Update message
  server.put<{
    Params: { id: string; messageId: string };
    Body: { content: string };
  }>(
    '/:id/messages/:messageId',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'messageId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            messageId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['content'],
          properties: {
            content: { type: 'string', minLength: 1, maxLength: 5000 },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const messageId = request.params.messageId;
      const userId = request.user!.sub;

      const content = request.body.content;
      if (!content.trim()) {
        throw ApiError.badRequest('Message cannot be whitespace only');
      }

      await assertActiveMember(groupId, userId);

      const message = await getMessageInGroup(groupId, messageId);

      if (message.userId !== userId) {
        throw ApiError.forbidden('You can only edit your own messages');
      }

      const updated = await prisma.message.update({
        where: { id: message.id },
        data: {
          content,
          isEdited: true,
        },
        include: {
          user: { select: MESSAGE_SENDER_SELECT },
          replyTo: {
            include: {
              user: { select: MESSAGE_SENDER_SELECT },
            },
          },
          reactions: {
            select: {
              userId: true,
              type: true,
            },
          },
        },
      });

      return {
        success: true,
        data: serializeMessage(updated),
      };
    }
  );

  // Delete message
  server.delete<{ Params: { id: string; messageId: string } }>(
    '/:id/messages/:messageId',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'messageId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            messageId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const messageId = request.params.messageId;
      const userId = request.user!.sub;

      const membership = await assertActiveMember(groupId, userId);

      const message = await getMessageInGroup(groupId, messageId);

      const isOwn = message.userId === userId;
      const isManager = MANAGER_ROLES.includes(membership.role as GroupMemberRole);

      if (!isOwn && !isManager) {
        throw ApiError.forbidden('You can only delete your own messages');
      }

      await prisma.message.update({
        where: { id: message.id },
        data: { isDeleted: true },
      });

      return {
        success: true,
        data: { message: 'Message deleted' },
      };
    }
  );

  // Add reaction
  server.post<{
    Params: { id: string; messageId: string };
    Body: { type: string };
  }>(
    '/:id/messages/:messageId/reactions',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'messageId'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            messageId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['type'],
          properties: {
            type: {
              type: 'string',
              enum: ['LIKE', 'LOVE', 'LAUGH', 'WOW', 'SAD', 'ANGRY'],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const groupId = request.params.id;
      const messageId = request.params.messageId;
      const userId = request.user!.sub;
      const type = request.body.type;

      await assertActiveMember(groupId, userId);

      const message = await getMessageInGroup(groupId, messageId);

      try {
        const reaction = await prisma.messageReaction.create({
          data: {
            messageId: message.id,
            userId,
            type: type as 'LIKE' | 'LOVE' | 'LAUGH' | 'WOW' | 'SAD' | 'ANGRY',
          },
        });

        reply.status(201).send({
          success: true,
          data: { id: reaction.id, type: reaction.type, userId: reaction.userId },
        });
      } catch (err) {
        if (isPrismaUniqueViolation(err)) {
          throw ApiError.conflict('You already reacted with this reaction type');
        }
        throw err;
      }
    }
  );

  // Remove reaction
  server.delete<{ Params: { id: string; messageId: string; type: string } }>(
    '/:id/messages/:messageId/reactions/:type',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id', 'messageId', 'type'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            messageId: { type: 'string', format: 'uuid' },
            type: {
              type: 'string',
              enum: ['LIKE', 'LOVE', 'LAUGH', 'WOW', 'SAD', 'ANGRY'],
            },
          },
        },
      },
    },
    async (request) => {
      const groupId = request.params.id;
      const messageId = request.params.messageId;
      const userId = request.user!.sub;
      const type = request.params.type;

      await assertActiveMember(groupId, userId);

      const message = await getMessageInGroup(groupId, messageId);

      const result = await prisma.messageReaction.deleteMany({
        where: {
          messageId: message.id,
          userId,
          type: type as 'LIKE' | 'LOVE' | 'LAUGH' | 'WOW' | 'SAD' | 'ANGRY',
        },
      });

      if (result.count === 0) {
        throw ApiError.notFound('Reaction not found');
      }

      return {
        success: true,
        data: { message: 'Reaction removed' },
      };
    }
  );
}

function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
