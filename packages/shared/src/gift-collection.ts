/** Fixed-value Game Point gifts. No Coins, cash withdrawal or resale pricing. */
export const GIFT_COLLECTION_POLICY = 'gift-points-buy0-convert10-v1' as const;
export const GIFT_CONVERSION_PERCENT = 10;
export function giftAmounts(faceValue: number) {
  if (!Number.isSafeInteger(faceValue) || faceValue < 10 || faceValue > 10000 || faceValue % 10 !== 0) {
    throw new Error('Gift value must be 10–10,000 points, in steps of 10');
  }
  return { faceValue, purchaseFee: 0, purchaseTotal: faceValue,
    conversionFee: faceValue / 10, conversionReturn: faceValue * 9 / 10 };
}
export type GiftTheme = 'rose' | 'amber' | 'violet' | 'sky' | 'emerald' | 'indigo';
export interface CollectibleGift {
  id: string; name: string; emoji: string; description: string; theme: GiftTheme; faceValue: number;
}
export interface OwnedGift extends CollectibleGift {
  catalogId: string; version: number; acquiredAt: string;
}
export interface GiftCollectionSnapshot {
  policyId: typeof GIFT_COLLECTION_POLICY; balance: number; catalog: CollectibleGift[];
  owned: OwnedGift[]; totalOwned: number; page: number; pageSize: number;
}
export type GiftAction =
  | { kind: 'BUY'; groupId: string | null; catalogId: string; recipientId: string; faceValue: number; policyId: string }
  | { kind: 'SEND'; groupId: string; itemId: string; recipientId: string; version: number; policyId: string }
  | { kind: 'CONVERT'; itemId: string; version: number; faceValue: number; policyId: string };
export interface GiftChatCard {
  itemId: string; name: string; emoji: string; theme: GiftTheme; faceValue: number;
  recipientId: string; recipientUsername: string;
}
export interface GiftActionReceipt {
  operationId: string; requestId: string; kind: GiftAction['kind']; itemId: string;
  amount: number; fee: number; balance: number; createdAt: string;
  groupId: string | null; messageId: string | null; gift: GiftChatCard; isReplay?: boolean;
}
export const CHAT_REACTIONS = [
  { type: 'LIKE', emoji: '👍', label: 'Like' }, { type: 'LOVE', emoji: '❤️', label: 'Love' },
  { type: 'LAUGH', emoji: '😂', label: 'Laugh' }, { type: 'WOW', emoji: '😮', label: 'Wow' },
  { type: 'SAD', emoji: '😢', label: 'Sad' }, { type: 'ANGRY', emoji: '😡', label: 'Angry' },
] as const;
export type ChatReactionType = typeof CHAT_REACTIONS[number]['type'];
