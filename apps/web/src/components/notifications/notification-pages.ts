import type { InfiniteData } from '@tanstack/react-query';
import type { NotificationInfo, NotificationListMeta } from '@socialplay/shared';
import type { ApiResponse } from '@/lib/api';

/** The fields the inbox actually renders — nothing else is retained in the cache. */
export type NotificationItem = Pick<NotificationInfo, 'id' | 'type' | 'title' | 'body' | 'isRead' | 'createdAt'>;

/** One fetched page of the inbox, exactly as the query stores it. */
export interface NotificationPage {
  items: NotificationItem[];
  /** The page number that was requested — the cursor `getNextPageParam` advances from. */
  page: number;
  hasNextPage: boolean;
  /**
   * The caller's TOTAL unread count as of this response. Not the number of
   * unread rows on the page or in the list: it is a server-side fact about the
   * whole inbox, and the badge must show it even when most of the unread
   * notifications are on pages that have not been loaded.
   */
  unreadCount: number;
}

export type NotificationInbox = InfiniteData<NotificationPage, number>;

export function toNotificationPage(
  res: ApiResponse<NotificationInfo[], NotificationListMeta>,
  requestedPage: number
): NotificationPage {
  // An unsuccessful body must not be read as "your inbox is empty".
  if (!res.success) throw new Error(res.error?.message ?? 'Failed to load notifications');
  const rows = Array.isArray(res.data) ? res.data : [];
  const meta = res.meta;
  return {
    items: rows.map(({ id, type, title, body, isRead, createdAt }) => ({ id, type, title, body, isRead, createdAt })),
    page: requestedPage,
    hasNextPage: meta?.hasNextPage === true,
    unreadCount: typeof meta?.unreadCount === 'number' ? meta.unreadCount : 0,
  };
}

/**
 * Every loaded page, flattened in order, one row per notification id.
 *
 * Pages are fetched by offset while the inbox keeps growing at the top, so a
 * notification that arrives between two page fetches shifts everything down
 * and the same row can legitimately appear at the end of one page and the
 * start of the next. Deduplication happens here — at render time only — and
 * never in the cache, so the stored pages stay exactly what the server sent.
 */
export function flattenNotificationPages(pages: readonly NotificationPage[] | undefined): NotificationItem[] {
  const seen = new Set<string>();
  const out: NotificationItem[] = [];
  for (const page of pages ?? []) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/** The badge count: the freshest page's server-reported total, never a count of visible rows. */
export function inboxUnreadCount(pages: readonly NotificationPage[] | undefined): number {
  if (!pages || pages.length === 0) return 0;
  // A refresh re-fetches pages front to back and a next-page fetch appends, so
  // the last page is always the most recently fetched.
  return pages[pages.length - 1].unreadCount;
}

const withUnread = (pages: NotificationPage[], unreadCount: number, mapItem: (n: NotificationItem) => NotificationItem) =>
  pages.map((p) => ({ ...p, unreadCount, items: p.items.map(mapItem) }));

/**
 * Mark one notification read INSIDE the page structure — every loaded page and
 * the cursor are kept — and drop the server-reported unread total by one if
 * this call actually flipped an unread row.
 *
 * Returns undefined when nothing is cached: `setQueryData` treats that as "do
 * not write", so a late response for an inbox that has since been discarded
 * cannot resurrect a cache entry.
 */
export function applyMarkRead(data: NotificationInbox | undefined, id: string): NotificationInbox | undefined {
  if (!data) return undefined;
  const wasUnread = data.pages.some((p) => p.items.some((n) => n.id === id && !n.isRead));
  if (!wasUnread) return data;
  const unread = Math.max(0, inboxUnreadCount(data.pages) - 1);
  return { ...data, pages: withUnread(data.pages, unread, (n) => (n.id === id ? { ...n, isRead: true } : n)) };
}

/** Mark everything read in place: all loaded pages and the cursor stay, the unread total becomes 0. */
export function applyMarkAllRead(data: NotificationInbox | undefined): NotificationInbox | undefined {
  if (!data) return undefined;
  return { ...data, pages: withUnread(data.pages, 0, (n) => (n.isRead ? n : { ...n, isRead: true })) };
}
