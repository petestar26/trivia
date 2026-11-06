import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GIFT_COLLECTION_POLICY, PRACTICE_GIFT_POLICY } from '@socialplay/shared';
import type { GiftAction, GiftActionReceipt } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { useLanguage } from '@/providers/language-provider';
import type { MessageValues } from '@/lib/i18n/types';

export interface GiftAttempt {
  key: string;
  action: GiftAction;
  name: string;
  emoji: string;
  faceValue: number;
  recipientLabel: string;
}
const receiptKey = (userId: string) => `playqube.pending-collectible.${userId}`;
export function readGiftAttempt(userId: string): GiftAttempt | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(receiptKey(userId)) ?? 'null');
    return value &&
      typeof value.key === 'string' &&
      typeof value.name === 'string' &&
      [GIFT_COLLECTION_POLICY, PRACTICE_GIFT_POLICY].includes(value.action?.policyId) &&
      ['BUY', 'SEND', 'CONVERT'].includes(value.action.kind)
      ? value
      : null;
  } catch {
    return null;
  }
}
function friendlyError(error: unknown) {
  try {
    const data = JSON.parse((error as Error).message);
    return (
      data.message ||
      data.error?.message ||
      'Could not confirm this action. Retry the same request.'
    );
  } catch {
    return 'Could not confirm this action. Retry the same request.';
  }
}
export function useGiftAction(userId: string, onComplete: () => void) {
  const cache = useQueryClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [attempt, setAttempt] = useState<GiftAttempt | null>(() => readGiftAttempt(userId));
  const { t } = useLanguage();
  const [noticeSource, setNoticeSource] = useState<{ message: string; values?: MessageValues }>({
    message: '',
  });
  const setNotice = (message: string, values?: MessageValues) =>
    setNoticeSource({ message, values });
  const values = noticeSource.values && { ...noticeSource.values };
  if (values && typeof values.unit === 'string') values.unit = t(values.unit);
  if (values && typeof values.feeUnit === 'string') values.feeUnit = t(values.feeUnit);
  const notice = t(noticeSource.message, values);
  const refresh = () => {
    for (const queryKey of [
      ['gift-collection', userId],
      ['wallet'],
      ['wallet-transactions'],
      ['messages'],
    ]) {
      void cache.invalidateQueries({ queryKey });
    }
  };
  function clearReceipt(key: string) {
    if (readGiftAttempt(userId)?.key === key) sessionStorage.removeItem(receiptKey(userId));
    setAttempt(null);
  }
  const mutation = useMutation({
    mutationFn: (a: GiftAttempt) =>
      boundedRequest(async () =>
        unwrapData(
          await api.postWithIdempotency<GiftActionReceipt>(
            `/gift-collection/${a.action.kind.toLowerCase()}`,
            a.key,
            a.action
          )
        )
      ),
    onSuccess: (result, a) => {
      if (!alive.current) return;
      clearReceipt(a.key);
      onComplete();
      refresh();
      if (result.kind === 'CONVERT')
        setNotice('Gift converted. {amount} {unit} added. Fee: {fee} {feeUnit}.', {
          amount: result.amount,
          fee: result.fee,
          unit: a.action.policyId === PRACTICE_GIFT_POLICY ? 'practice ETB' : 'Game Points',
          feeUnit: a.action.policyId === PRACTICE_GIFT_POLICY ? 'practice ETB' : 'points',
        });
      else if (result.messageId)
        setNotice(
          'Gift delivered to @{username}. It is now in their collection and the group chat.',
          { username: result.gift.recipientUsername ?? '' }
        );
      else setNotice('Gift added to your collection. No purchase fee.');
    },
    onError: (error, a) => {
      if (!alive.current) return;
      if (requestStatus(error) === 400) clearReceipt(a.key);
      setNotice(friendlyError(error));
      refresh();
    },
  });
  function submit(next?: GiftAttempt) {
    if (mutation.isPending) return;
    const a = attempt ?? next;
    if (!a) return;
    if (!attempt) {
      try {
        sessionStorage.setItem(receiptKey(userId), JSON.stringify(a));
      } catch {
        setNotice('Unable to save your retry receipt. No action was sent.');
        return;
      }
      setAttempt(a);
    }
    mutation.mutate(a);
  }
  return { attempt, notice, setNotice, submit, isPending: mutation.isPending };
}
