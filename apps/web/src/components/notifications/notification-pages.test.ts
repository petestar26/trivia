import { describe, expect, it } from 'vitest';
import {
  applyMarkAllRead,
  applyMarkRead,
  flattenNotificationPages,
  inboxUnreadCount,
  toNotificationPage,
  type NotificationInbox,
  type NotificationPage,
} from './notification-pages';
import { makeRows, serveInboxPage } from '@/test/notification-fixtures';

const row = (id: string, isRead = false) => ({ id, type: 'SYSTEM', title: id, body: id, isRead, createdAt: '2024-01-01T00:00:00.000Z' });
const pageOf = (ids: string[], overrides: Partial<NotificationPage> = {}): NotificationPage => ({
  items: ids.map((id) => row(id)),
  page: 1,
  hasNextPage: false,
  unreadCount: ids.length,
  ...overrides,
});
const inbox = (...pages: NotificationPage[]): NotificationInbox => ({ pages, pageParams: pages.map((_, i) => i + 1) });

describe('toNotificationPage', () => {
  it('keeps only what the inbox renders and takes the cursor from the REQUESTED page', () => {
    const res = serveInboxPage(makeRows('u', 25), { page: 2, limit: 20 });
    const p = toNotificationPage(res, 2);
    expect(p.page).toBe(2);
    expect(p.items).toHaveLength(5);
    expect(Object.keys(p.items[0]).sort()).toEqual(['body', 'createdAt', 'id', 'isRead', 'title', 'type']);
    expect(p.hasNextPage).toBe(false);
    expect(p.unreadCount).toBe(25);
  });

  it('never trusts a missing meta into claiming more pages', () => {
    expect(toNotificationPage({ success: true, data: [] }, 1)).toEqual({ items: [], page: 1, hasNextPage: false, unreadCount: 0 });
  });

  it('an unsuccessful body is an error, not an empty inbox', () => {
    expect(() => toNotificationPage({ success: false, error: { code: 'X', message: 'nope' } }, 1)).toThrow('nope');
  });
});

describe('flattenNotificationPages', () => {
  it('flattens in order and keeps the first occurrence of a row that appears on two pages', () => {
    const flat = flattenNotificationPages([pageOf(['a', 'b', 'c']), pageOf(['c', 'd'])]);
    expect(flat.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not mutate the pages it reads', () => {
    const pages = [pageOf(['a', 'b']), pageOf(['b', 'c'])];
    flattenNotificationPages(pages);
    expect(pages.map((p) => p.items.length)).toEqual([2, 2]);
  });

  it('handles nothing loaded', () => {
    expect(flattenNotificationPages(undefined)).toEqual([]);
    expect(flattenNotificationPages([])).toEqual([]);
  });
});

describe('inboxUnreadCount', () => {
  it('is the freshest (last) page\'s server total — not a count of loaded rows', () => {
    expect(inboxUnreadCount([pageOf(['a'], { unreadCount: 40 }), pageOf(['b'], { unreadCount: 39 })])).toBe(39);
    expect(inboxUnreadCount(undefined)).toBe(0);
  });
});

describe('applyMarkRead', () => {
  it('flips the row in place, keeps every page and the cursor, and lowers the server total by one on every page', () => {
    const before = inbox(pageOf(['a', 'b'], { unreadCount: 10, hasNextPage: true }), pageOf(['c'], { page: 2, unreadCount: 10 }));
    const after = applyMarkRead(before, 'c')!;
    expect(after.pages.map((p) => p.items.map((n) => n.isRead))).toEqual([[false, false], [true]]);
    expect(after.pages.map((p) => p.unreadCount)).toEqual([9, 9]);
    expect(after.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(after.pages[0].hasNextPage).toBe(true);
    expect(after.pageParams).toEqual([1, 2]);
    // The input is untouched.
    expect(before.pages[1].items[0].isRead).toBe(false);
    expect(before.pages[0].unreadCount).toBe(10);
  });

  it('marks a row that was shifted onto two pages everywhere it appears, decrementing once', () => {
    const before = inbox(pageOf(['a', 'b'], { unreadCount: 5 }), pageOf(['b', 'c'], { page: 2, unreadCount: 5 }));
    const after = applyMarkRead(before, 'b')!;
    expect(after.pages.map((p) => p.items.map((n) => n.isRead))).toEqual([[false, true], [true, false]]);
    expect(after.pages.map((p) => p.unreadCount)).toEqual([4, 4]);
  });

  it('is a no-op (same object) for a row that is already read or not loaded — the total is not decremented twice', () => {
    const before = inbox({ ...pageOf(['a']), items: [row('a', true), row('b')], unreadCount: 1 });
    expect(applyMarkRead(before, 'a')).toBe(before);
    expect(applyMarkRead(before, 'zzz')).toBe(before);
  });

  it('never goes below zero', () => {
    const before = inbox(pageOf(['a'], { unreadCount: 0 }));
    expect(applyMarkRead(before, 'a')!.pages[0].unreadCount).toBe(0);
  });

  it('returns undefined when nothing is cached, so setQueryData will not write', () => {
    expect(applyMarkRead(undefined, 'a')).toBeUndefined();
  });
});

describe('applyMarkAllRead', () => {
  it('marks every loaded row on every page read and zeroes the total, keeping the cursor', () => {
    const before = inbox(pageOf(['a', 'b'], { unreadCount: 30, hasNextPage: true }), pageOf(['c'], { page: 2, unreadCount: 30 }));
    const after = applyMarkAllRead(before)!;
    expect(after.pages.flatMap((p) => p.items).every((n) => n.isRead)).toBe(true);
    expect(after.pages.map((p) => p.unreadCount)).toEqual([0, 0]);
    expect(after.pages[0].hasNextPage).toBe(true);
    expect(after.pageParams).toEqual([1, 2]);
    expect(before.pages[0].items[0].isRead).toBe(false);
  });

  it('returns undefined when nothing is cached', () => {
    expect(applyMarkAllRead(undefined)).toBeUndefined();
  });
});
