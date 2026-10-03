import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@socialplay/database';
import { CHAT_REACTIONS } from '@socialplay/shared';
import type { ChatReactionType } from '@socialplay/shared';
import { ApiError } from '../middleware/api-error.js';
import { lockGiftGroup, lockGiftUsers } from '../gift-collection/service.js';

/** Setting a desired state makes retries safe; a repeated delete is also successful. */
export async function setMessageReaction(db: PrismaClient, groupId: string, userId: string, messageId: string, type: ChatReactionType, active: boolean) {
  if (!CHAT_REACTIONS.some(reaction => reaction.type === type)) throw ApiError.badRequest('Unknown reaction');
  return db.$transaction(async tx => {
    await lockGiftUsers(tx, userId);
    await lockGiftGroup(tx, groupId, userId);
    const messages = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM messages WHERE id=${messageId} AND "groupId"=${groupId} AND NOT "isDeleted" FOR SHARE`;
    if (!messages[0]) throw ApiError.notFound('Message not found');
    if (active) {
      await tx.$executeRaw`INSERT INTO message_reactions(id,"messageId","userId",type,"createdAt")
        VALUES(${randomUUID()},${messageId},${userId},${type}::"ReactionType",clock_timestamp())
        ON CONFLICT ("messageId","userId",type) DO NOTHING`;
    } else {
      await tx.messageReaction.deleteMany({ where: { messageId, userId, type } });
    }
    return { messageId, userId, type, active };
  });
}
