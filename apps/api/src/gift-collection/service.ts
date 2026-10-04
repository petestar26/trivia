import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import { GIFT_COLLECTION_POLICY, giftAmounts } from '@socialplay/shared';
import type { CollectibleGift, GiftAction, GiftActionReceipt, GiftChatCard, GiftCollectionSnapshot, OwnedGift } from '@socialplay/shared';
import { ApiError } from '../middleware/api-error.js';
import { applyBalanceChanges } from '../economy/wallet-service.js';

type Tx = Prisma.TransactionClient;
type Catalog = CollectibleGift & { isActive: boolean };
type Item = OwnedGift & { ownerId: string; state: 'OWNED' | 'CONVERTED'; latestOperationId: string };
const pageSize = 12;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function lockGiftUsers(tx: Tx, actorId: string, recipientId = actorId) {
  const ids = [...new Set([actorId, recipientId])].sort();
  const users = await tx.$queryRaw<{ id: string; username: string; status: string }[]>`
    SELECT id, username, status::text FROM users WHERE id=ANY(${ids}::text[]) ORDER BY id FOR SHARE`;
  if (users.length !== ids.length || users.some(user => user.status !== 'ACTIVE')) {
    throw ApiError.forbidden('Gift participants must have active accounts');
  }
  return users;
}

export async function lockGiftGroup(tx: Tx, groupId: string, actorId: string, recipientId = actorId, writing = true) {
  const groups = await tx.$queryRaw<{ status: string; expiresAt: Date; now: Date }[]>`SELECT status::text,"expiresAt",clock_timestamp() AS now FROM groups WHERE id=${groupId} FOR SHARE`;
  if (!groups[0] || (writing && (groups[0].status !== 'ACTIVE' || groups[0].now >= groups[0].expiresAt))) throw ApiError.forbidden('This group is not available');
  const ids = [...new Set([actorId, recipientId])];
  const members = await tx.$queryRaw<{ userId: string; status: string }[]>`
    SELECT "userId",status::text FROM group_members WHERE "groupId"=${groupId} AND "userId"=ANY(${ids}::text[]) ORDER BY id FOR SHARE`;
  if (members.length !== ids.length || members.some(member => member.status !== 'ACTIVE')) {
    throw ApiError.forbidden('Both people must be active members of this group');
  }
}

function canonicalAction(input: GiftAction): GiftAction {
  if (!input || input.policyId !== GIFT_COLLECTION_POLICY) throw ApiError.badRequest('Review the current gift terms before confirming');
  if (input.kind === 'BUY') {
    giftAmounts(input.faceValue);
    if ((input.groupId !== null && !uuid.test(input.groupId)) || !uuid.test(input.recipientId) || !/^[a-z0-9-]{1,64}$/.test(input.catalogId)) throw ApiError.badRequest('Invalid gift purchase');
    return { kind: 'BUY', groupId: input.groupId, catalogId: input.catalogId, recipientId: input.recipientId, faceValue: input.faceValue, policyId: input.policyId };
  }
  if (!uuid.test(input.itemId) || !Number.isInteger(input.version) || input.version < 0) throw ApiError.badRequest('Invalid owned gift');
  if (input.kind === 'SEND') {
    if (!uuid.test(input.groupId) || !uuid.test(input.recipientId)) throw ApiError.badRequest('Invalid gift recipient');
    return { kind: 'SEND', groupId: input.groupId, itemId: input.itemId, recipientId: input.recipientId, version: input.version, policyId: input.policyId };
  }
  if (input.kind !== 'CONVERT') throw ApiError.badRequest('Unknown gift action');
  giftAmounts(input.faceValue);
  return { kind: 'CONVERT', itemId: input.itemId, version: input.version, faceValue: input.faceValue, policyId: input.policyId };
}

export function createGiftCollectionService(db: PrismaClient) {
  return {
    async snapshot(groupId: string | null, userId: string, page = 1): Promise<GiftCollectionSnapshot> {
      if (!Number.isInteger(page) || page < 1 || page > 100000) throw ApiError.badRequest('Invalid inventory page');
      return db.$transaction(async tx => {
        await lockGiftUsers(tx, userId); if (groupId) await lockGiftGroup(tx, groupId, userId, userId, false);
        const catalog = await tx.$queryRaw<CollectibleGift[]>`
          SELECT id,name,emoji,description,theme,face_value AS "faceValue" FROM collectible_gift_catalog WHERE is_active ORDER BY face_value,id`;
        const owned = await tx.$queryRaw<OwnedGift[]>`
          SELECT id,catalog_id AS "catalogId",name,emoji,theme,face_value AS "faceValue",version,acquired_at AS "acquiredAt",'' AS description
          FROM collectible_gift_items WHERE owner_id=${userId} AND state='OWNED'
          ORDER BY acquired_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
        const counts = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::integer AS count FROM collectible_gift_items WHERE owner_id=${userId} AND state='OWNED'`;
        const wallet = await tx.wallet.findUnique({ where: { userId }, select: { gamePointsBalance: true } });
        return { policyId: GIFT_COLLECTION_POLICY, balance: wallet?.gamePointsBalance ?? 0, catalog, owned, totalOwned: counts[0].count, page, pageSize };
      });
    },

    async act(actorId: string, requestId: string, input: GiftAction): Promise<GiftActionReceipt> {
      if (!uuid.test(requestId)) throw ApiError.badRequest('A gift request receipt is required');
      const action = canonicalAction(input);
      return db.$transaction(async tx => {
        // Serialize exact retries before checking mutable membership, ownership, or catalog state.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`collectible-gift:${actorId}:${requestId}`},0))`;
        const previous = await tx.$queryRaw<{ request: GiftAction; response: GiftActionReceipt }[]>`
          SELECT request,response FROM collectible_gift_operations WHERE actor_id=${actorId} AND request_id=${requestId}`;
        if (previous[0]) {
          if (JSON.stringify(canonicalAction(previous[0].request)) !== JSON.stringify(action)) throw ApiError.conflict('This receipt belongs to a different gift action');
          return { ...previous[0].response, isReplay: true };
        }
        const recipientId = action.kind === 'CONVERT' ? actorId : action.recipientId;
        const users = await lockGiftUsers(tx, actorId, recipientId);
        const groupId = action.kind === 'CONVERT' ? null : action.groupId;
        if (groupId) await lockGiftGroup(tx, groupId, actorId, recipientId);
        if (!groupId && recipientId !== actorId) throw ApiError.badRequest('Choose a group to send this gift');
        if (action.kind === 'SEND' && recipientId === actorId) throw ApiError.badRequest('Choose another member to receive this gift');

        let gift: Catalog | Item;
        if (action.kind === 'BUY') {
          const rows = await tx.$queryRaw<Catalog[]>`SELECT id,name,emoji,description,theme,face_value AS "faceValue",is_active AS "isActive"
            FROM collectible_gift_catalog WHERE id=${action.catalogId} FOR SHARE`;
          if (!rows[0]?.isActive) throw ApiError.badRequest('This gift is no longer available');
          gift = rows[0];
          if (gift.faceValue !== action.faceValue) throw ApiError.badRequest('The gift price changed. Review it before buying');
        } else {
          const rows = await tx.$queryRaw<Item[]>`SELECT id,catalog_id AS "catalogId",owner_id AS "ownerId",name,emoji,theme,
            face_value AS "faceValue",state,version,latest_operation_id AS "latestOperationId",acquired_at AS "acquiredAt",'' AS description
            FROM collectible_gift_items WHERE id=${action.itemId} FOR UPDATE`;
          if (!rows[0] || rows[0].ownerId !== actorId || rows[0].state !== 'OWNED' || rows[0].version !== action.version) {
            throw ApiError.badRequest('This gift changed or is no longer in your collection. Refresh to continue');
          }
          gift = rows[0];
          if (action.kind === 'CONVERT' && gift.faceValue !== action.faceValue) throw ApiError.badRequest('Gift conversion amount changed');
        }
        const amounts = giftAmounts(gift.faceValue);
        const operationId = randomUUID(); const itemId = action.kind === 'BUY' ? randomUUID() : action.itemId;
        const version = action.kind === 'BUY' ? 0 : action.version + 1;
        const previousOperationId = action.kind === 'BUY' ? null : (gift as Item).latestOperationId;
        // Only the actor's GP wallet changes. Transfers carry an owned item, never a second point credit.
        await tx.wallet.upsert({ where: { userId: actorId }, create: { userId: actorId }, update: {} });
        await tx.$queryRaw`SELECT id FROM wallets WHERE "userId"=${actorId} FOR UPDATE`;
        let walletTransactionId: string | null = null;
        const amount = action.kind === 'BUY' ? amounts.purchaseTotal : action.kind === 'CONVERT' ? amounts.conversionReturn : 0;
        const fee = action.kind === 'CONVERT' ? amounts.conversionFee : 0;
        if (amount) {
          const result = await applyBalanceChanges(tx, actorId, [{ currency: 'GAME_POINTS', amount,
            ledgerType: action.kind === 'BUY' ? 'DEBIT' : 'CREDIT',
            transactionType: action.kind === 'BUY' ? 'GAME_POINT_DEBIT' : 'GAME_POINT_CREDIT',
            referenceType: 'GIFT', referenceId: operationId,
            description: action.kind === 'BUY' ? `Bought ${gift.name} · no purchase fee` : `Converted ${gift.name} · ${fee} point fee (10%)` }]);
          walletTransactionId = result.transactions[0].id;
        }
        const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const at = clock[0].now;
        if (action.kind === 'BUY') {
          await tx.$executeRaw`INSERT INTO collectible_gift_items(id,catalog_id,owner_id,name,emoji,theme,face_value,state,version,latest_operation_id,created_at,acquired_at)
            VALUES(${itemId},${action.catalogId},${recipientId},${gift.name},${gift.emoji},${gift.theme},${gift.faceValue},'OWNED',0,${operationId},${at},${at})`;
        } else {
          await tx.$executeRaw`UPDATE collectible_gift_items SET owner_id=${recipientId},state=${action.kind === 'CONVERT' ? 'CONVERTED' : 'OWNED'},
            version=${version},latest_operation_id=${operationId},acquired_at=${at} WHERE id=${itemId}`;
        }
        const recipient = users.find(user => user.id === recipientId)!;
        const card: GiftChatCard = { itemId, name: gift.name, emoji: gift.emoji, theme: gift.theme, faceValue: gift.faceValue, recipientId, recipientUsername: recipient.username };
        let messageId: string | null = null;
        if (groupId && recipientId !== actorId) {
          const message = await tx.message.create({ data: { groupId, userId: actorId, type: 'GIFT', content: `Sent ${gift.name} to @${recipient.username}` } });
          messageId = message.id;
        }
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId: actorId }, select: { gamePointsBalance: true } });
        const response: GiftActionReceipt = { operationId, requestId, kind: action.kind, itemId, amount, fee,
          balance: wallet.gamePointsBalance, createdAt: at.toISOString(), groupId, messageId, gift: card };
        await tx.$executeRaw`INSERT INTO collectible_gift_operations(id,actor_id,request_id,kind,item_id,recipient_id,version,previous_operation_id,
          amount,fee,wallet_transaction_id,group_id,message_id,request,response,created_at)
          VALUES(${operationId},${actorId},${requestId},${action.kind},${itemId},${recipientId},${version},${previousOperationId},${amount},${fee},
          ${walletTransactionId},${groupId},${messageId},${JSON.stringify(action)}::jsonb,${JSON.stringify(response)}::jsonb,${at})`;
        return { ...response, isReplay: false };
      }, { timeout: 15000 });
    },
  };
}

/** Called only after message/group authorization; stored cards cannot be forged by text. */
export async function giftCardsForMessages(db: PrismaClient, messageIds: string[]) {
  if (!messageIds.length) return new Map<string, GiftChatCard>();
  const rows = await db.$queryRaw<{ messageId: string; gift: GiftChatCard }[]>`
    SELECT message_id AS "messageId",response->'gift' AS gift FROM collectible_gift_operations WHERE message_id=ANY(${messageIds}::text[])`;
  return new Map(rows.map(row => [row.messageId, row.gift]));
}
