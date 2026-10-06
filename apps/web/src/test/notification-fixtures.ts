import type { NotificationInfo, NotificationListMeta } from '@socialplay/shared';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface InboxResponse {
  success: true;
  data: NotificationInfo[];
  meta: NotificationListMeta;
}

/**
 * `count` notifications for `owner`, NEWEST FIRST (index 0 is the newest), the
 * order the API returns them in. Titles are `<owner> notification NN` so a
 * test can tell whose row it is looking at; ids are `<owner>-nNN`.
 */
export function makeRows(
  owner: string,
  count: number,
  isUnread: (index: number) => boolean = () => true
): NotificationInfo[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      id: `${owner}-n${n}`,
      userId: owner,
      type: 'SYSTEM',
      title: `${owner} notification ${n}`,
      body: `${owner} body ${n}`,
      isRead: !isUnread(i),
      createdAt: new Date(Date.UTC(2024, 0, 1) + (count - i) * 60_000).toISOString(),
    };
  });
}

/** What GET /notifications returns for `rows` — same offset paging and meta as the real route. */
export function serveInboxPage(
  rows: readonly NotificationInfo[],
  params: { page?: number; limit?: number } = {}
): InboxResponse {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const total = rows.length;
  const totalPages = Math.ceil(total / limit);
  return {
    success: true,
    data: rows.slice((page - 1) * limit, page * limit),
    meta: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      unreadCount: rows.filter((r) => !r.isRead).length,
    },
  };
}

/** A tiny stateful inbox, so a refetch after a mark-read sees what the server would now say. */
export function createInbox(rows: NotificationInfo[]) {
  const state = { rows };
  return {
    get rows() {
      return state.rows;
    },
    list: (params: { page?: number; limit?: number } = {}) => serveInboxPage(state.rows, params),
    markRead(id: string) {
      state.rows = state.rows.map((r) => (r.id === id ? { ...r, isRead: true } : r));
      return { success: true, data: state.rows.find((r) => r.id === id) };
    },
    markAll() {
      const updated = state.rows.filter((r) => !r.isRead).length;
      state.rows = state.rows.map((r) => (r.isRead ? r : { ...r, isRead: true }));
      return { success: true, data: { updated } };
    },
    /** A new notification arrives at the top: every existing row shifts down one position. */
    prepend(row: NotificationInfo) {
      state.rows = [row, ...state.rows];
    },
  };
}
