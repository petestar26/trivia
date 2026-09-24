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

/** What storage holds for a key, or `ok: false` when the browser cannot read it. */
type StoredPending = { ok: true; pending: PendingPlay | null } | { ok: false };

function readPending(storageKey: string): StoredPending {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return { ok: false };
  }
  if (!raw) return { ok: true, pending: null };
  try {
    const parsed = JSON.parse(raw) as Partial<PendingPlay>;
    if (typeof parsed.key === 'string' && parsed.body && typeof parsed.body === 'object') {
      return { ok: true, pending: { key: parsed.key, body: parsed.body } };
    }
  } catch {
    // A corrupt entry holds no usable request.
  }
  return { ok: true, pending: null };
}

/** Stores the request and reads it back; false when the browser cannot keep it. */
function persistPending(storageKey: string, pending: PendingPlay): boolean {
  const text = JSON.stringify(pending);
  try {
    window.sessionStorage.setItem(storageKey, text);
    if (window.sessionStorage.getItem(storageKey) === text) return true;
  } catch {
    // Storage unavailable (blocked site data, private mode, quota).
  }
  clearPending(storageKey);
  return false;
}

function clearPending(storageKey: string): boolean {
  try {
    window.sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

export const PLAY_STORAGE_UNAVAILABLE = 'Nothing was sent: this browser cannot keep this round safe across a reload. '
  + 'Allow this site to store data (private browsing can block it), then try again.';

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
 * BEFORE the first send; if the browser cannot store it, nothing is sent
 * (storageError says why), because a reload would then lose the key of a
 * round the server may have settled. While the page is mounted, its
 * in-memory copy of the pending request is authoritative: a lost response is
 * retried with exactly that key and body even if storage fails later, and a
 * new key is never created while it is unresolved. Storage only carries the
 * request across a reload. While a request is pending, every play (and a
 * remount) resends exactly it; edited form values wait for the next round,
 * which gets a new key. Only a conclusive server answer ends it.
 */
export function useDurablePlay<T extends GamePlayResult>(gameKey: string, handlers: DurablePlayHandlers<T> = {}) {
  const { user } = useAuth();
  const storageKey = user ? pendingPlayStorageKey(user.id, gameKey) : null;
  // Each signed-in user's pending request on this page, by storage key, and
  // the keys the server has answered whose stored copy could not be removed.
  const remembered = useRef(new Map<string, PendingPlay>());
  const answered = useRef(new Set<string>());
  const recall = useCallback((key: string): StoredPending => {
    const inMemory = remembered.current.get(key);
    if (inMemory) return { ok: true, pending: inMemory };
    const stored = readPending(key);
    if (!stored.ok || !stored.pending) return stored;
    if (answered.current.has(stored.pending.key)) {
      if (clearPending(key)) answered.current.delete(stored.pending.key);
      return { ok: true, pending: null };
    }
    remembered.current.set(key, stored.pending);
    return stored;
  }, []);
  const forget = useCallback((key: string, request: PendingPlay) => {
    if (remembered.current.get(key)?.key === request.key) remembered.current.delete(key);
    if (!clearPending(key)) answered.current.add(request.key);
  }, []);

  const [pending, setPending] = useState<PendingPlay | null>(() => {
    if (!storageKey) return null;
    const stored = recall(storageKey);
    return stored.ok ? stored.pending : null;
  });
  const [storageError, setStorageError] = useState<string | null>(null);
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
      forget(request.storageKey, request);
      setPending(null);
      handlersRef.current.onSettled?.(round.data, round.isReplay);
    },
    onError: (error, request) => {
      const conclusive = isConclusiveFailure(error);
      if (conclusive) {
        forget(request.storageKey, request);
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
    setStorageError(null);
    if (!storageKey) {
      setPending(null);
      return;
    }
    const stored = recall(storageKey);
    const unconfirmed = stored.ok ? stored.pending : null;
    setPending(unconfirmed);
    if (unconfirmed) mutateRef.current({ ...unconfirmed, storageKey });
  }, [storageKey, recall]);

  const play = useCallback((body: Record<string, unknown>) => {
    if (!storageKey) return;
    const stored = recall(storageKey);
    if (!stored.ok) {
      // Cannot tell whether an earlier round is unresolved: send nothing.
      setStorageError(PLAY_STORAGE_UNAVAILABLE);
      return;
    }
    if (stored.pending) {
      setStorageError(null);
      setPending(stored.pending);
      mutateRef.current({ ...stored.pending, storageKey });
      return;
    }
    const request: PendingPlay = { key: newIdempotencyKey(), body };
    if (!persistPending(storageKey, request)) {
      setStorageError(PLAY_STORAGE_UNAVAILABLE);
      return;
    }
    remembered.current.set(storageKey, request);
    setStorageError(null);
    setPending(request);
    mutateRef.current({ ...request, storageKey });
  }, [storageKey, recall]);

  /** True when a pending request exists and differs from `body`. */
  const pendingDiffersFrom = useCallback((body: Record<string, unknown>) => (
    pending !== null && canonicalPlayBody(pending.body) !== canonicalPlayBody(body)
  ), [pending]);

  return { play, pending, pendingDiffersFrom, mutation, storageError };
}
