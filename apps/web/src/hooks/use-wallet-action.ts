import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { requestStatus } from '@/lib/request-error';
import { useAuth } from '@/providers/auth-provider';

export interface WalletAction {
  path: string;
  body: Record<string, unknown>;
}
export function walletError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Request failed. Please try again.';
  try {
    const parsed = JSON.parse(message);
    return parsed.message ?? parsed.error?.message ?? message;
  } catch {
    return message;
  }
}
// Only mutations with server idempotency/state-transition protection belong here.
export function validWalletAction(value: unknown): value is WalletAction {
  if (!value || typeof value !== 'object') return false;
  const v = value as WalletAction;
  return (
    typeof v.path === 'string' &&
    /^\/(agent-orders|agent-disputes|withdrawals)(\/[a-zA-Z0-9/-]+)?$/.test(v.path) &&
    !!v.body &&
    typeof v.body === 'object' &&
    !Array.isArray(v.body) &&
    typeof v.body.idempotencyKey === 'string' &&
    v.body.idempotencyKey.length >= 8
  );
}
export function useWalletAction() {
  const { user } = useAuth();
  const key = `playqube.wallet-pending.${user?.id}`;
  const cache = useQueryClient();
  const [initial] = useState(() => {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return { pending: null, error: '' };
      const pending: unknown = JSON.parse(raw);
      if (!validWalletAction(pending)) throw Error();
      return {
        pending,
        error: 'An earlier request needs confirmation. Retry it before starting another.',
      };
    } catch {
      return {
        pending: null,
        error: 'Saved request unavailable. Restore browser storage and reload before continuing.',
      };
    }
  });
  const [pending, setPending] = useState<WalletAction | null>(initial.pending);
  const [message, setMessage] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const storageBlocked = !!initial.error && !initial.pending;
  async function run(path: string, body: Record<string, unknown> = {}) {
    if (!user || active.current || storageBlocked) return;
    const action = pending ?? { path, body: { ...body, idempotencyKey: crypto.randomUUID() } };
    if (!validWalletAction(action)) {
      setMessage('This operation is not supported.');
      return;
    }
    active.current = true;
    setBusy(true);
    try {
      sessionStorage.setItem(key, JSON.stringify(action));
      setPending(action);
    } catch {
      setMessage('Enable browser storage before continuing. No request was sent.');
      active.current = false;
      setBusy(false);
      return;
    }
    try {
      await boundedRequest((signal) => api.post(action.path, action.body, undefined, { signal }));
      sessionStorage.removeItem(key);
      setPending(null);
      setMessage('Request confirmed. Your records have been updated.');
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['wallet'] }),
        cache.invalidateQueries({ queryKey: ['wallet-transactions'] }),
        cache.invalidateQueries({ queryKey: ['payments'] }),
      ]);
    } catch (error) {
      const status = requestStatus(error);
      // Timeout, 5xx and uncertain transport failures retain the same intent.
      if ([400, 401, 403, 404, 409, 422].includes(status ?? 0)) {
        try {
          sessionStorage.removeItem(key);
          setPending(null);
        } catch {
          /* keep retry visible */
        }
      }
      setMessage(walletError(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return { run, pending, message, busy, blocked: busy || !!pending || storageBlocked };
}
