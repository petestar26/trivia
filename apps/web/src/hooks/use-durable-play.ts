import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { newIdempotencyKey, playGame, unwrapData } from '@/lib/api';
import type { GamePlayResult } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

/**
 * One play request whose outcome the server has not conclusively answered
 * yet: the idempotency key and the exact body it was first sent with.
 */
export interface PendingPlay {
  key: string;
  body: Record<string, unknown>;
}

const STORAGE_PREFIX = 'playqube:pending-play';

/** Scoped by user and game: another user in this tab never sees it. */
export function pendingPlayStorageKey(userId: string, gameKey: string): string {
  return `${STORAGE_PREFIX}:${userId}:${gameKey}`;
}

/** Stable JSON with sorted keys, so a request compares by content. */
export function canonicalPlayBody(body: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) {
    if (body[key] !== undefined) sorted[key] = body[key];
  }
  return JSON.stringify(sorted);
}

function readPending(storageKey: string): PendingPlay | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPlay>;
    if (typeof parsed.key === 'string' && parsed.body && typeof parsed.body === 'object') {
      return { key: parsed.key, body: parsed.body };
    }
  } catch {
    // Unreadable storage holds no usable request.
  }
  return null;
}

function writePending(storageKey: string, pending: PendingPlay): void {
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
  } catch {
    // Storage unavailable (private mode, quota): the in-memory copy still
    // retries within this page; only a reload loses it.
  }
}

function clearPending(storageKey: string): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Whether a failed play is the server's conclusive refusal. A terminal 4xx
 * (invalid request, forbidden, conflicting key...) will never succeed on a
 * retry, so the pending request ends. A network failure, a lost response,
 * a timeout (408), rate limiting (429) or a server error (5xx) may hide a
 * settled round: the request stays pending and is retried exactly.
 */
export function isConclusiveFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const { status } = JSON.parse(error.message) as { status?: unknown };
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
  } catch {
    return false;
  }
}

export interface DurablePlayHandlers<T> {
  onStart?: () => void;
  onSettled?: (result: T, isReplay: boolean) => void;
  onFailed?: (error: unknown, conclusive: boolean) => void;
}

/**
 * Durable, exactly-once play for one game. The idempotency key is created
 * once per round and stored with the exact request body in sessionStorage
 * BEFORE the first send, so a lost response or a reload can only ever retry
 * that same request: the server then replays the settled round instead of
 * playing a new one. While a request is pending, every play (and a remount)
 * resends exactly it; edited form values wait for the next round, which gets
 * a new key. Only a conclusive server answer clears it.
 */
export function useDurablePlay<T extends GamePlayResult>(gameKey: string, handlers: DurablePlayHandlers<T> = {}) {
  const { user } = useAuth();
  const storageKey = user ? pendingPlayStorageKey(user.id, gameKey) : null;
  const [pending, setPending] = useState<PendingPlay | null>(() => (storageKey ? readPending(storageKey) : null));
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const mutation = useMutation({
    mutationFn: async (request: PendingPlay & { storageKey: string }) => {
      const response = await playGame<T>(gameKey, request.body, request.key);
      const data = unwrapData(response, `${gameKey} play response`);
      return { data, isReplay: data.isReplay === true };
    },
    onMutate: () => handlersRef.current.onStart?.(),
    onSuccess: (round, request) => {
      clearPending(request.storageKey);
      setPending(null);
      handlersRef.current.onSettled?.(round.data, round.isReplay);
    },
    onError: (error, request) => {
      const conclusive = isConclusiveFailure(error);
      if (conclusive) {
        clearPending(request.storageKey);
        setPending(null);
      }
      handlersRef.current.onFailed?.(error, conclusive);
    },
  });
  const mutateRef = useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;

  // On mount and whenever the signed-in user changes: load that user's own
  // unconfirmed request for this game, if any, and resume exactly it.
  useEffect(() => {
    if (!storageKey) {
      setPending(null);
      return;
    }
    const stored = readPending(storageKey);
    setPending(stored);
    if (stored) mutateRef.current({ ...stored, storageKey });
  }, [storageKey]);

  const play = useCallback((body: Record<string, unknown>) => {
    if (!storageKey) return;
    const unconfirmed = readPending(storageKey);
    if (unconfirmed) {
      setPending(unconfirmed);
      mutateRef.current({ ...unconfirmed, storageKey });
      return;
    }
    const request: PendingPlay = { key: newIdempotencyKey(), body };
    writePending(storageKey, request);
    setPending(request);
    mutateRef.current({ ...request, storageKey });
  }, [storageKey]);

  /** True when a pending request exists and differs from `body`. */
  const pendingDiffersFrom = useCallback((body: Record<string, unknown>) => (
    pending !== null && canonicalPlayBody(pending.body) !== canonicalPlayBody(body)
  ), [pending]);

  return { play, pending, pendingDiffersFrom, mutation };
}
