import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GIFT_COLLECTION_POLICY } from '@socialplay/shared';
import type { GiftAction, GiftActionReceipt } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';

export interface GiftAttempt { key: string; action: GiftAction; name: string; emoji: string; faceValue: number; recipientLabel: string }
const receiptKey = (userId: string) => `playqube.pending-collectible.${userId}`;
export function readGiftAttempt(userId: string): GiftAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(receiptKey(userId)) ?? 'null');
    return value && typeof value.key === 'string' && typeof value.name === 'string' &&
      value.action?.policyId === GIFT_COLLECTION_POLICY && ['BUY', 'SEND', 'CONVERT'].includes(value.action.kind) ? value : null;
  } catch { return null; }
}
function friendlyError(error: unknown) {
  try { const data = JSON.parse((error as Error).message); return data.message || data.error?.message || 'Could not confirm this action. Retry the same request.'; }
  catch { return 'Could not confirm this action. Retry the same request.'; }
}
export function useGiftAction(userId: string, onComplete: () => void) {
  const cache = useQueryClient(); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [attempt, setAttempt] = useState<GiftAttempt | null>(() => readGiftAttempt(userId));
  const [notice, setNotice] = useState('');
  const refresh = () => {
    for (const queryKey of [['gift-collection', userId], ['wallet'], ['wallet-transactions'], ['messages']]) {
      void cache.invalidateQueries({ queryKey });
    }
  };
  function clearReceipt(key: string) {
    if (readGiftAttempt(userId)?.key === key) sessionStorage.removeItem(receiptKey(userId));
    setAttempt(null);
  }
  const mutation = useMutation({ mutationFn: (a: GiftAttempt) => boundedRequest(async () =>
    unwrapData(await api.postWithIdempotency<GiftActionReceipt>(`/gift-collection/${a.action.kind.toLowerCase()}`, a.key, a.action))),
    onSuccess: (result, a) => {
      if (!alive.current) return;
      clearReceipt(a.key); onComplete(); refresh();
      setNotice(result.kind === 'CONVERT' ? `Gift converted. ${result.amount} Game Points added. Fee: ${result.fee} points.`
        : result.messageId ? `Gift delivered to @${result.gift.recipientUsername}. It is now in their collection and the group chat.`
        : 'Gift added to your collection. No purchase fee.');
    },
    onError: (error, a) => {
      if (!alive.current) return;
      if (requestStatus(error) === 400) clearReceipt(a.key);
      setNotice(friendlyError(error)); refresh();
    },
  });
  function submit(next?: GiftAttempt) {
    if (mutation.isPending) return;
    const a = attempt ?? next;
    if (!a) return;
    if (!attempt) {
      try { sessionStorage.setItem(receiptKey(userId), JSON.stringify(a)); }
      catch { setNotice('Unable to save your retry receipt. No action was sent.'); return; }
      setAttempt(a);
    }
    mutation.mutate(a);
  }
  return { attempt, notice, setNotice, submit, isPending: mutation.isPending };
}
