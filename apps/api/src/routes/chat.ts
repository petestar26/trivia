import { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { ApiError, authenticate } from '../middleware';
import {
  assertActiveMember,
  createMessage,
  createVoiceMessage,
  deleteVoiceMessageStorage,
  getGroupOrThrow,
  getMessageInGroup,
  MESSAGE_SENDER_SELECT,
  serializeMessage,
} from '../realtime/chat-service';
import { storage } from '@socialplay/storage';
import { STORAGE_BUCKETS } from '@socialplay/shared';
import { safeRecordActivity } from '../rewards/activity-service';

type GroupMemberRole = 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER';

const MANAGER_ROLES: GroupMemberRole[] = ['OWNER', 'ADMIN'];

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
      const message = await createMessage({
        groupId: request.params.id,
        userId: request.user!.sub,
        content: request.body.content,
        replyToId: request.body.replyToId,
      });

      reply.status(201).send({
        success: true,
        data: message,
      });

      // Server-verified activity (post-commit, best-effort).
      safeRecordActivity(request.user!.sub, { type: 'MESSAGE' });
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

      // Clean up voice message storage before deleting the message
      if (message.voiceMessage) {
        await deleteVoiceMessageStorage(message.id);
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

  // ─── Voice Messages ─────────────────────────────────────────

  // Upload voice message
  server.post<{
    Params: { id: string };
  }>(
    '/:id/voice-messages',
    {
      preHandler: [authenticate],
      rateLimit: { max: 10, timeWindow: '1 minute' },
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const groupId = request.params.id;
      const userId = request.user!.sub;

      await getGroupOrThrow(groupId);
      await assertActiveMember(groupId, userId);

      // Parse multipart upload
      const parts = request.parts();
      let fileData: Buffer | null = null;
      let fileName = 'voice-message.ogg';
      let mimeType = 'audio/ogg';
      let duration = 0;

      for await (const part of parts) {
        if (part.type === 'file') {
          // Collect file data into buffer
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          fileData = Buffer.concat(chunks);
          fileName = part.filename || fileName;
          mimeType = part.mimetype || mimeType;
        } else if (part.type === 'field' && part.fieldname === 'duration') {
          const val = typeof part.value === 'string' ? parseInt(part.value, 10) : 0;
          if (!isNaN(val) && val > 0) {
            duration = val;
          }
        }
      }

      if (!fileData) {
        throw ApiError.badRequest('Audio file is required');
      }

      const message = await createVoiceMessage({
        groupId,
        userId,
        file: fileData,
        fileName,
        mimeType,
        duration,
      });

      reply.status(201).send({
        success: true,
        data: message,
      });

      // Server-verified activity (post-commit, best-effort).
      safeRecordActivity(request.user!.sub, { type: 'VOICE_MESSAGE' });
    }
  );

  // Stream/download voice message audio
  server.get<{
    Params: { id: string; messageId: string };
  }>(
    '/:id/voice-messages/:messageId',
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
    async (request, reply) => {
      const groupId = request.params.id;
      const messageId = request.params.messageId;

      await getGroupOrThrow(groupId);
      await assertActiveMember(groupId, request.user!.sub);

      const message = await getMessageInGroup(groupId, messageId);

      if (!message.voiceMessage) {
        throw ApiError.notFound('Voice message not found');
      }

      // Get the audio file from storage
      const audioBuffer = await storage.download({
        bucket: STORAGE_BUCKETS.VOICE_MESSAGES,
        key: message.voiceMessage.storageKey,
      });

      const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer as any);

      // Set appropriate headers for audio streaming
      reply.header('Content-Type', message.voiceMessage.mimeType);
      reply.header('Content-Length', buffer.length);
      reply.header('Accept-Ranges', 'bytes');
      reply.header('Cache-Control', 'private, max-age=3600');

      reply.send(buffer);
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
