import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import { PRACTICE_GIFT_POLICY, giftAmounts } from '@socialplay/shared';
import type { CollectibleGift, GiftAction, GiftActionReceipt, GiftChatCard, GiftCollectionSnapshot, OwnedGift } from '@socialplay/shared';
import { ApiError } from '../middleware/api-error.js';
import { lockGiftUsers, lockGiftGroup } from './service.js';

type Tx = Prisma.TransactionClient;
type Catalog = CollectibleGift & { isActive: boolean };
type Item = OwnedGift & { ownerId: string; state: 'OWNED' | 'CONVERTED'; latestOperationId: string };
const pageSize = 12;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalAction(input: GiftAction): GiftAction {
  if (!input || input.policyId !== PRACTICE_GIFT_POLICY) throw ApiError.badRequest('Review the current gift terms before confirming');
  if (input.kind === 'BUY') {
    giftAmounts(input.faceValue);
    if (input.faceValue < 500) throw ApiError.badRequest('Minimum gift purchase is 500 practice ETB');
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

export function createPracticeGiftCollectionService(db: PrismaClient) {
  return {
    async snapshot(groupId: string | null, userId: string, page = 1): Promise<GiftCollectionSnapshot> {
      if (!Number.isInteger(page) || page < 1 || page > 100000) throw ApiError.badRequest('Invalid inventory page');
      return db.$transaction(async tx => {
        await lockGiftUsers(tx, userId); if (groupId) await lockGiftGroup(tx, groupId, userId, userId, false);
        const catalog = await tx.$queryRaw<CollectibleGift[]>`
          SELECT id,name,emoji,description,theme,face_value AS "faceValue" FROM practice_etb_gift_catalog WHERE is_active ORDER BY face_value,id`;
        const owned = await tx.$queryRaw<OwnedGift[]>`
          SELECT id,catalog_id AS "catalogId",name,emoji,theme,face_value AS "faceValue",version,acquired_at AS "acquiredAt",'' AS description
          FROM practice_etb_gift_items WHERE owner_id=${userId} AND state='OWNED'
          ORDER BY acquired_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
        const counts = await tx.$queryRaw<{ count: number }[]>`SELECT count(*)::integer AS count FROM practice_etb_gift_items WHERE owner_id=${userId} AND state='OWNED'`;
        await tx.$executeRaw`INSERT INTO practice_etb_gift_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
        const [wallet] = await tx.$queryRaw<{ balance: number }[]>`SELECT balance FROM practice_etb_gift_accounts WHERE user_id=${userId}`;
        return { policyId: PRACTICE_GIFT_POLICY, balance: wallet.balance, catalog, owned, totalOwned: counts[0].count, page, pageSize };
      });
    },

    async act(actorId: string, requestId: string, input: GiftAction): Promise<GiftActionReceipt> {
      if (!uuid.test(requestId)) throw ApiError.badRequest('A gift request receipt is required');
      const action = canonicalAction(input);
      return db.$transaction(async tx => {
        // Serialize exact retries before checking mutable membership, ownership, or catalog state.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`collectible-gift:${actorId}:${requestId}`},0))`;
        const previous = await tx.$queryRaw<{ request: GiftAction; response: GiftActionReceipt }[]>`
          SELECT request,response FROM practice_etb_gift_operations WHERE actor_id=${actorId} AND request_id=${requestId}`;
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
            FROM practice_etb_gift_catalog WHERE id=${action.catalogId} FOR SHARE`;
          if (!rows[0]?.isActive) throw ApiError.badRequest('This gift is no longer available');
          gift = rows[0];
          if (gift.faceValue !== action.faceValue) throw ApiError.badRequest('The gift price changed. Review it before buying');
        } else {
          const rows = await tx.$queryRaw<Item[]>`SELECT id,catalog_id AS "catalogId",owner_id AS "ownerId",name,emoji,theme,
            face_value AS "faceValue",state,version,latest_operation_id AS "latestOperationId",acquired_at AS "acquiredAt",'' AS description
            FROM practice_etb_gift_items WHERE id=${action.itemId} FOR UPDATE`;
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
        // Lock the isolated virtual account. Financial wallets are never read or changed.
        await tx.$executeRaw`INSERT INTO practice_etb_gift_accounts(user_id) VALUES(${actorId}) ON CONFLICT DO NOTHING`;
        const [account] = await tx.$queryRaw<{ balance: number }[]>`SELECT balance FROM practice_etb_gift_accounts WHERE user_id=${actorId} FOR UPDATE`;
        const amount = action.kind === 'BUY' ? amounts.purchaseTotal : action.kind === 'CONVERT' ? amounts.conversionReturn : 0;
        const fee = action.kind === 'CONVERT' ? amounts.conversionFee : 0;
        if (action.kind === 'BUY' && account.balance < amount) throw ApiError.badRequest('Not enough practice ETB for this gift');
        const delta = action.kind === 'BUY' ? -amount : action.kind === 'CONVERT' ? amount : 0;
        if (!Number.isSafeInteger(account.balance + delta) || account.balance + delta > 2147483647) throw ApiError.badRequest('Practice balance limit reached');
        if (delta) await tx.$executeRaw`UPDATE practice_etb_gift_accounts SET balance=balance+${delta} WHERE user_id=${actorId}`;
        const clock = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const at = clock[0].now;
        if (action.kind === 'BUY') {
          await tx.$executeRaw`INSERT INTO practice_etb_gift_items(id,catalog_id,owner_id,name,emoji,theme,face_value,state,version,latest_operation_id,created_at,acquired_at)
            VALUES(${itemId},${action.catalogId},${recipientId},${gift.name},${gift.emoji},${gift.theme},${gift.faceValue},'OWNED',0,${operationId},${at},${at})`;
        } else {
          await tx.$executeRaw`UPDATE practice_etb_gift_items SET owner_id=${recipientId},state=${action.kind === 'CONVERT' ? 'CONVERTED' : 'OWNED'},
            version=${version},latest_operation_id=${operationId},acquired_at=${at} WHERE id=${itemId}`;
        }
        const recipient = users.find(user => user.id === recipientId)!;
        const card: GiftChatCard = { itemId, name: gift.name, emoji: gift.emoji, theme: gift.theme, faceValue: gift.faceValue, recipientId, recipientUsername: recipient.username, currency: 'PRACTICE_ETB' };
        let messageId: string | null = null;
        if (groupId && recipientId !== actorId) {
          const message = await tx.message.create({ data: { groupId, userId: actorId, type: 'GIFT', content: `Sent ${gift.name} to @${recipient.username}` } });
          messageId = message.id;
        }
        const [wallet] = await tx.$queryRaw<{ balance: number }[]>`SELECT balance FROM practice_etb_gift_accounts WHERE user_id=${actorId}`;
        const response: GiftActionReceipt = { operationId, requestId, kind: action.kind, itemId, amount, fee,
          balance: wallet.balance, createdAt: at.toISOString(), groupId, messageId, gift: card };
        await tx.$executeRaw`INSERT INTO practice_etb_gift_operations(id,actor_id,request_id,kind,item_id,recipient_id,version,previous_operation_id,
          amount,fee,group_id,message_id,request,response,created_at)
          VALUES(${operationId},${actorId},${requestId},${action.kind},${itemId},${recipientId},${version},${previousOperationId},${amount},${fee},
          ${groupId},${messageId},${JSON.stringify(action)}::jsonb,${JSON.stringify(response)}::jsonb,${at})`;
        return { ...response, isReplay: false };
      }, { timeout: 15000 });
    },
  };
}

/** Called only after message/group authorization; stored cards cannot be forged by text. */
export async function practiceGiftCardsForMessages(db: PrismaClient, messageIds: string[]) {
  if (!messageIds.length) return new Map<string, GiftChatCard>();
  const rows = await db.$queryRaw<{ messageId: string; gift: GiftChatCard }[]>`
    SELECT message_id AS "messageId",response->'gift' AS gift FROM practice_etb_gift_operations WHERE message_id=ANY(${messageIds}::text[])`;
  return new Map(rows.map(row => [row.messageId, row.gift]));
}
