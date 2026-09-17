/**
 * Canonical React Query key for the notification inbox.
 *
 * Shared between the bell (which owns the query) and any page that performs
 * an action known to create a notification for the current viewer (e.g.
 * group moderation), so those actions can invalidate the bell's data
 * without the key ever drifting between call sites.
 */
export const NOTIFICATIONS_QUERY_KEY = ['notifications'] as const;
