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
  if (!store || !userId || typeof crypto?.randomUUID !== 'function') return null;
  const now = Date.now();
  forgetExpired(store, now);
  const nonce = crypto.randomUUID();
  try {
    store.setItem(
      PREFIX + nonce,
      JSON.stringify({ kind, userId, target, at: now } satisfies StoredIntent)
    );
    return store.getItem(PREFIX + nonce) ? nonce : null;
  } catch {
    return null;
  }
}

/**
 * True only for a fresh intent created by this member for this launch. The
 * intent is removed whatever the outcome, so it can never be used twice.
 */
export function consumeLaunchIntent(
  kind: LaunchKind,
  userId: string | undefined,
  nonce: string | null,
  target = ''
): boolean {
  if (!userId || !nonce || !NONCE.test(nonce)) return false;
  const store = storage();
  if (!store) return false;
  const key = PREFIX + nonce;
  try {
    const raw = store.getItem(key);
    store.removeItem(key);
    if (!raw) return false;
    const intent = JSON.parse(raw) as Partial<StoredIntent>;
    const age = Date.now() - Number(intent.at);
    return (
      intent.kind === kind &&
      intent.userId === userId &&
      intent.target === target &&
      age >= 0 &&
      age <= MAX_AGE_MS
    );
  } catch {
    return false;
  }
}
