import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware';

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
} as const;

export function serializeMessage(message: any) {
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
