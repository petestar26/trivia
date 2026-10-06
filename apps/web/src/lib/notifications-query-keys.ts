import type { QueryClient } from '@tanstack/react-query';

/**
 * React Query keys for the notification inbox.
 *
 * EVERY notification query key is scoped by the authenticated user's id:
 *
 *   ['notifications', <userId>, ...]
 *
 * There is deliberately no shared, identity-free inbox key. A notification
 * inbox is private, per-account data; when the key carried no identity, one
 * account's cached pages — and any request still in flight for it — occupied
 * the very same cache slot the next account's inbox reads from, so
 * cross-account isolation rested entirely on somebody remembering to clear the
 * cache at every identity change. With the identity in the key, account A's
 * data and account B's data can never be the same cache entry, whatever else
 * happens around them.
 */
export const NOTIFICATIONS_ROOT_KEY = ['notifications'] as const;

/** Everything cached for one account: `['notifications', userId]`. */
export function notificationsScopeKey(userId: string) {
  return [...NOTIFICATIONS_ROOT_KEY, userId] as const;
}

/** The infinite inbox query for one account and page size. */
export function notificationsInboxKey(userId: string, limit: number) {
  return [...notificationsScopeKey(userId), 'inbox', { limit }] as const;
}

/**
 * Cancel and remove every notification query that does not belong to
 * `keepUserId` (pass null to remove them all — nobody is signed in).
 *
 * Removing a query also destroys its retryer, so a request still in flight for
 * another account has nowhere to deliver its result. Called whenever an
 * identity is established; it is what lets the inbox stay isolated even on a
 * QueryClient that was NOT cleared at the identity change.
 */
export function purgeForeignNotificationScopes(queryClient: QueryClient, keepUserId: string | null): void {
  queryClient.removeQueries({
    queryKey: NOTIFICATIONS_ROOT_KEY,
    predicate: (query) => query.queryKey[1] !== keepUserId,
  });
}
