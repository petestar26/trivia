import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';
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

export function serializeMessage(message: any) {
  const base = {
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

  if (message.voiceMessage) {
    return {
      ...base,
      voiceMessage: {
        id: message.voiceMessage.id,
        storageKey: message.voiceMessage.storageKey,
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
}

// Validates and persists a message. Returns the canonical serialized message.
export async function createMessage(args: CreateMessageArgs) {
  const { groupId, userId, content, replyToId } = args;

  if (!content.trim()) {
    throw ApiError.badRequest('Message cannot be whitespace only');
  }

  await getGroupOrThrow(groupId);
  await assertActiveMember(groupId, userId);

  const data: { content: string; type: 'TEXT'; replyToId?: string } = {
    content,
    type: 'TEXT',
  };

  if (replyToId) {
    const parent = await prisma.message.findUnique({
      where: { id: replyToId },
    });

    if (!parent || parent.groupId !== groupId || parent.isDeleted) {
      throw ApiError.badRequest('Parent message not found in this group');
    }

    data.replyToId = replyToId;
  }

  const message = await prisma.message.create({
    data: {
      groupId,
      userId,
      content: data.content,
      type: data.type,
      replyToId: data.replyToId,
    },
    include: MESSAGE_INCLUDE,
  });

  return serializeMessage(message);
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
  if (!FILE_UPLOAD.ALLOWED_AUDIO_TYPES.includes(mimeType)) {
    throw ApiError.badRequest(`Audio type ${mimeType} not allowed. Supported: ${FILE_UPLOAD.ALLOWED_AUDIO_TYPES.join(', ')}`);
  }

  // Validate file size (5MB limit for voice messages)
  const MAX_VOICE_BYTES = 5 * 1024 * 1024;
  if (file.length > MAX_VOICE_BYTES) {
    throw ApiError.badRequest(`File size exceeds maximum of ${MAX_VOICE_BYTES} bytes`);
  }

  // Validate duration (max 5 minutes = 300 seconds)
  const MAX_VOICE_DURATION = 300;
  if (duration > MAX_VOICE_DURATION) {
    throw ApiError.badRequest(`Duration exceeds maximum of ${MAX_VOICE_DURATION} seconds`);
  }

  await getGroupOrThrow(groupId);
  await assertActiveMember(groupId, userId);

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

  let stored: { message: any; voiceMessage: any };
  try {
    // Create Message + VoiceMessage atomically
    stored = await prisma.$transaction(async (tx) => {
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

// Deletes the stored audio file for a voice message.
export async function deleteVoiceMessageStorage(messageId: string): Promise<void> {
  const voiceMessage = await prisma.voiceMessage.findUnique({
    where: { messageId },
  });

  if (voiceMessage) {
    try {
      await storage.delete({
        bucket: STORAGE_BUCKETS.VOICE_MESSAGES,
        key: voiceMessage.storageKey,
      });
    } catch {
      // Best-effort cleanup - log but don't throw
    }
  }
}
