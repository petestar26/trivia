import { sessionRevision, sessionSignedOut } from './session';

/**
 * One-time launch intents.
 *
 * Two member pages start something as soon as they load: /sports/open creates
 * a sportsbook session, and /casino?game=<id> launches a provider game. A
 * login, a pasted or bookmarked link, a reload or browser Back must never be
 * what starts them. So the in-app click that means "open this now" writes a
 * short-lived, single-use intent bound to the member and the target, and the
 * page launches on load only when it can consume a matching intent. Anything
 * else waits for a fresh click on the page itself.
 *
 * localStorage is used because the sportsbook deliberately opens in a new tab,
 * which shares localStorage (not sessionStorage) with the tab that was clicked.
 * If storage is unavailable no intent exists, and the page simply asks.
 */
export type LaunchKind = 'sports' | 'casino';

const PREFIX = 'salem-launch-intent:';
const MAX_AGE_MS = 60_000;
const NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StoredIntent {
  kind: LaunchKind;
  userId: string;
  target: string;
  at: number;
  revision: string;
}

function storage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function forgetExpired(store: Storage, now: number) {
  try {
    for (let index = store.length - 1; index >= 0; index -= 1) {
      const key = store.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const at = Number((JSON.parse(store.getItem(key) ?? '{}') as Partial<StoredIntent>).at);
      if (!(now - at >= 0 && now - at <= MAX_AGE_MS)) store.removeItem(key);
    }
  } catch {
    /* Expired intents are harmless: they can never be consumed. */
  }
}

/** Record a click's intent to launch `target` now. Returns the nonce, or null if it cannot be stored. */
export function createLaunchIntent(kind: LaunchKind, userId: string, target = ''): string | null {
  const store = storage();
  if (
    !store ||
    !userId ||
    sessionSignedOut() ||
    !navigator.locks ||
    typeof crypto?.randomUUID !== 'function'
  )
    return null;
  const now = Date.now();
  forgetExpired(store, now);
  const nonce = crypto.randomUUID();
  try {
    store.setItem(
      PREFIX + nonce,
      JSON.stringify({
        kind,
        userId,
        target,
        at: now,
        revision: sessionRevision(),
      } satisfies StoredIntent)
    );
    return store.getItem(PREFIX + nonce) ? nonce : null;
  } catch {
    return null;
  }
}

export interface LaunchPermit {
  expiresAt: number;
}

/**
 * A permit only for a fresh intent created by this member for this launch. The
 * intent is removed whatever the outcome, so it can never be used twice.
 */
export async function consumeLaunchPermit(
  kind: LaunchKind,
  userId: string | undefined,
  nonce: string | null,
  target = ''
): Promise<LaunchPermit | null> {
  if (!userId || !nonce || !NONCE.test(nonce)) return null;
  const store = storage();
  if (!store) return null;
  if (!navigator.locks) {
    try {
      store.removeItem(PREFIX + nonce);
    } catch {
      /* Fail closed if storage is denied. */
    }
    return null;
  }
  const revision = sessionRevision();
  const navigationType = (
    performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined
  )?.type;
  const restoredNavigation = navigationType === 'reload' || navigationType === 'back_forward';
  const key = PREFIX + nonce;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await navigator.locks.request(
      key,
      { mode: 'exclusive', signal: controller.signal },
      () => {
        const raw = store.getItem(key);
        store.removeItem(key);
        if (!raw) return null;
        const intent = JSON.parse(raw) as Partial<StoredIntent>;
        const age = Date.now() - Number(intent.at);
        const valid =
          !restoredNavigation &&
          !sessionSignedOut() &&
          sessionRevision() === revision &&
          intent.revision === revision &&
          intent.kind === kind &&
          intent.userId === userId &&
          intent.target === target &&
          age >= 0 &&
          age <= MAX_AGE_MS;
        return valid ? { expiresAt: Number(intent.at) + MAX_AGE_MS } : null;
      }
    );
  } catch {
    // A denied/interrupted lock must not leave a grant for another navigation.
    try {
      store.removeItem(key);
    } catch {
      /* Storage denial still fails closed. */
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Boolean convenience for callers that act immediately after consumption. */
export async function consumeLaunchIntent(
  kind: LaunchKind,
  userId: string | undefined,
  nonce: string | null,
  target = ''
): Promise<boolean> {
  return (await consumeLaunchPermit(kind, userId, nonce, target)) !== null;
}
