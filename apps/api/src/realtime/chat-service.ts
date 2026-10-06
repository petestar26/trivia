import { lockSocialGroup } from '../groups/lifecycle.js';
import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { storage, generateStorageKey } from '@socialplay/storage';
import { STORAGE_BUCKETS, FILE_UPLOAD } from '@socialplay/shared';

export const MESSAGE_SENDER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

export async function getGroupOrThrow(groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });

  if (!group) {
    throw ApiError.notFound('Group not found');
  }

  return group;
}

export async function getGroupMembership(groupId: string, userId: string) {
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
export async function assertActiveMember(groupId: string, userId: string) {
  const membership = await getGroupMembership(groupId, userId);

  if (!membership || membership.status !== 'ACTIVE') {
    throw ApiError.forbidden('You are not a member of this group');
  }

  return membership;
}

// Verifies the user holds one of the allowed roles and is an ACTIVE member.
// Returns the membership. Used to scope management actions (OWNER/ADMIN/etc).
export async function assertGroupRole(
  groupId: string,
  userId: string,
  allowedRoles: string[]
) {
  const membership = await assertActiveMember(groupId, userId);

  if (!allowedRoles.includes(membership.role)) {
    throw ApiError.forbidden('You do not have permission to perform this action');
  }

  return membership;
}

// Loads a message and verifies it belongs to the given group.
// Returns the message or throws not-found, so that cross-group access is opaque.
export async function getMessageInGroup(groupId: string, messageId: string) {
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
      voiceMessage: true,
    },
  });

  if (!message || message.groupId !== groupId || message.isDeleted) {
    throw ApiError.notFound('Message not found');
  }

  return message;
}

const MESSAGE_INCLUDE = {
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
  voiceMessage: true,
} as const;

export function serializeMessage(message: any): any {
  const base = {
    id: message.id,
    clientRequestId: message.clientRequestId ?? null,
    groupId: message.groupId,
    userId: message.userId,
    content: message.isDeleted ? '' : message.content,
    type: message.type.toLowerCase(),
    sender: message.user,
    replyTo: message.replyTo ? serializeMessage(message.replyTo) : null,
    isEdited: message.isEdited,
    isDeleted: message.isDeleted,
    reactions: message.reactions ?? [],
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };

  if (message.voiceMessage) {
    return {
      ...base,
      voiceMessage: {
        id: message.voiceMessage.id,
        mimeType: message.voiceMessage.mimeType,
        duration: message.voiceMessage.duration,
        size: message.voiceMessage.size,
      },
    };
  }

  return base;
}

export interface CreateMessageArgs {
  groupId: string;
  userId: string;
  content: string;
  replyToId?: string;
  clientRequestId?: string;
}

// Validates and persists a message. Returns the canonical serialized message.
export async function createMessage(args: CreateMessageArgs) {
  const { groupId, userId, replyToId, clientRequestId } = args;
  const content = args.content.trim();
  if (!content || content.length > 5000) throw ApiError.badRequest('Write a message between 1 and 5,000 characters');
  if (clientRequestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientRequestId)) throw ApiError.badRequest('Invalid message receipt');
  return prisma.$transaction(async tx => {
    // Receipt lock precedes account/group locks and serializes exact retries.
    if (clientRequestId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`chat:${groupId}:${userId}:${clientRequestId}`},0))`;
    const {group}=await lockSocialGroup(tx,groupId,userId,false);
    if (clientRequestId) {
      const previous=await tx.message.findUnique({where:{groupId_userId_clientRequestId:{groupId,userId,clientRequestId}},include:MESSAGE_INCLUDE});
      if(previous) {
        if(previous.content!==content || previous.replyToId!==(replyToId??null)) throw ApiError.conflict('This receipt belongs to a different message');
        return {...serializeMessage(previous),isReplay:true};
      }
    }
    if(group.status!=='ACTIVE' || group.now>=group.expiresAt) throw ApiError.conflict('This group has closed. Its conversation is read-only.');
    if(replyToId) {
      const [parent]=await tx.$queryRaw<{id:string}[]>`SELECT id FROM messages WHERE id=${replyToId} AND "groupId"=${groupId} AND NOT "isDeleted" FOR SHARE`;
      if(!parent) throw ApiError.badRequest('Parent message not found in this group');
    }
    const message=await tx.message.create({data:{groupId,userId,content,type:'TEXT',replyToId,clientRequestId},include:MESSAGE_INCLUDE});
    return {...serializeMessage(message),isReplay:false};
  });
}

export interface CreateVoiceMessageArgs {
  groupId: string;
  userId: string;
  file: Buffer;
  fileName: string;
  mimeType: string;
  duration: number; // seconds
}

// Validates, stores audio, and creates Message + VoiceMessage atomically.
export async function createVoiceMessage(args: CreateVoiceMessageArgs) {
  const { groupId, userId, file, fileName, mimeType, duration } = args;

  // Validate file type
  if (!(FILE_UPLOAD.ALLOWED_AUDIO_TYPES as readonly string[]).includes(mimeType)) {
    throw ApiError.badRequest(`Audio type ${mimeType} not allowed. Supported: ${FILE_UPLOAD.ALLOWED_AUDIO_TYPES.join(', ')}`);
  }

  // Validate file size (5MB limit for voice messages)
  const MAX_VOICE_BYTES = 5 * 1024 * 1024;
  if (file.length > MAX_VOICE_BYTES) {
    throw ApiError.badRequest(`File size exceeds maximum of ${MAX_VOICE_BYTES} bytes`);
  }

  // Validate duration (max 5 minutes = 300 seconds)
  const MAX_VOICE_DURATION = 300;
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VOICE_DURATION) {
    throw ApiError.badRequest(`Duration exceeds maximum of ${MAX_VOICE_DURATION} seconds`);
  }

  await prisma.$transaction(tx=>lockSocialGroup(tx,groupId,userId));

  // Generate server-side storage key
  const storageKey = generateStorageKey(
    STORAGE_BUCKETS.VOICE_MESSAGES,
    fileName,
    userId
  );

  // Store the file
  await storage.upload({
    bucket: STORAGE_BUCKETS.VOICE_MESSAGES,
    key: storageKey,
    file,
    mimeType,
    originalName: fileName,
  });

  let stored: { message: any };
  try {
    // Create Message + VoiceMessage atomically
    stored = await prisma.$transaction(async (tx) => {
      await lockSocialGroup(tx,groupId,userId);
      const message = await tx.message.create({
        data: {
          groupId,
          userId,
          content: '', // Voice messages have empty content
          type: 'VOICE',
        },
        include: {
          user: { select: MESSAGE_SENDER_SELECT },
          voiceMessage: true,
        },
      });

      const voiceMessage = await tx.voiceMessage.create({
        data: {
          messageId: message.id,
          storageKey,
          mimeType,
          duration,
          size: file.length,
        },
      });

      return { message: { ...message, voiceMessage } };
    });
  } catch (err) {
    // DB write failed after storage succeeded: clean up the stored audio to avoid orphans.
    try {
      await storage.delete({
        bucket: STORAGE_BUCKETS.VOICE_MESSAGES,
        key: storageKey,
      });
    } catch {
      // Best-effort cleanup - ignore cleanup failures here.
    }
    throw err;
  }

  return serializeMessage(stored.message);
}
