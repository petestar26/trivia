import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { NOTIFICATIONS_QUERY_KEY } from '@/lib/notifications-query-keys';
import { Button } from '@/components/ui/button';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  createdAt: string;
}

interface PageMeta {
  page: number;
  totalPages: number;
  hasNextPage: boolean;
  total: number;
}

// The bell only renders the newest page and "load more" walks pages back
// toward older notifications. This is a quoted-instance meta of the
// *cached* loaded list, not the raw server response.
interface LoadedState {
  items: NotificationItem[];
  unreadCount: number;
  meta: PageMeta | null;
}

const PANEL_LIMIT = 20;

export function NotificationBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // The nonce exists so that announcing the SAME outcome twice still
  // reaches assistive technology. Setting an identical string makes React
  // bail out, the text node never changes, and a live region that never
  // mutates is never announced — so marking a second notification read was
  // previously silent. The nonce alternates a zero-width space onto the
  // rendered text: a real DOM mutation that adds nothing a screen reader
  // speaks.
  const [status, setStatus] = useState({ message: '', nonce: 0 });
  const announce = (message: string) => setStatus((prev) => ({ message, nonce: prev.nonce + 1 }));
  const announcedText = status.message === '' ? '' : `${status.message}${status.nonce % 2 ? '\u200B' : ''}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const notificationsQuery = useQuery<LoadedState>({
    queryKey: NOTIFICATIONS_QUERY_KEY,
    queryFn: async () => {
      const res = await api.listNotifications({ limit: PANEL_LIMIT });
      const meta = res.meta as (PageMeta & { unreadCount?: number }) | undefined;
      return {
        items: (res.data ?? []) as NotificationItem[],
        unreadCount: meta?.unreadCount ?? 0,
        meta: meta
          ? { page: meta.page, totalPages: meta.totalPages, hasNextPage: meta.hasNextPage, total: meta.total }
          : null,
      };
    },
  });

  const items = notificationsQuery.data?.items ?? [];
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;
  const hasMeta = notificationsQuery.data?.meta ?? null;
  const hasNextPage = hasMeta?.hasNextPage ?? false;

  // Cached-success is defined by the query holding data, not by item count:
  // an empty inbox is a legitimate loaded state, and conflating it with
  // "never loaded" would drop a genuine "all caught up" for a destructive
  // first-load error.
  const hasCachedData = notificationsQuery.data !== undefined;
  const showInitialError = notificationsQuery.isError && !hasCachedData;
  const showRefreshError = notificationsQuery.isError && hasCachedData;

  // Load-more walks pages deterministically and guards against duplicate
  // fetches. When it fails, the already-loaded pages stay in place and
  // the failure surfaces as a retry affordance.
  const loadMoreMutation = useMutation({
    mutationFn: async () => {
      const meta = hasMeta;
      if (!meta?.hasNextPage) return null;
      const res = await api.listNotifications({ limit: PANEL_LIMIT, page: meta.page + 1 });
      const page = res.meta as (PageMeta & { unreadCount?: number }) | undefined;
      const newItems = (res.data ?? []) as NotificationItem[];
      const seen = new Set(queryClient.getQueryData<LoadedState>(NOTIFICATIONS_QUERY_KEY)?.items.map((n) => n.id) ?? []);
      const uniqueNew = newItems.filter((n) => !seen.has(n.id));
      return {
        items: uniqueNew,
        meta: page
          ? { page: page.page, totalPages: page.totalPages, hasNextPage: page.hasNextPage, total: page.total }
          : null,
        unreadCount: page?.unreadCount ?? queryClient.getQueryData<LoadedState>(NOTIFICATIONS_QUERY_KEY)?.unreadCount ?? 0,
      };
    },
    onSuccess: (next) => {
      if (!next) return;
      queryClient.setQueryData<LoadedState>(NOTIFICATIONS_QUERY_KEY, (current) => {
        const base = current ?? { items: [], unreadCount: 0, meta: null };
        return {
          items: [...base.items, ...next.items],
          unreadCount: next.unreadCount,
          meta: next.meta,
        };
      });
      if (next.items.length > 0) {
        announce(`Loaded ${next.items.length} more notification${next.items.length === 1 ? '' : 's'}.`);
      }
    },
    onError: () => {
      announce('Failed to load more notifications.');
    },
  });

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      announce('Notification marked as read.');
    },
    onError: () => {
      announce('Failed to mark notification as read.');
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
      announce('All notifications marked as read.');
    },
    onError: () => {
      announce('Failed to mark all notifications as read.');
    },
  });

  function handleToggle() {
    const next = !open;
    setOpen(next);
    // Opening the panel is an explicit "show me my notifications" gesture, so
    // it always goes back to the server: the app-wide 5-minute staleTime (see
    // main.tsx) would otherwise let the panel sit on a cached list for minutes,
    // and nothing else refreshes it — there is no polling or socket feed.
    // No separate in-flight check is needed to avoid duplicate requests:
    // React Query keys fetches by queryKey, so a refetch() issued while one
    // is already in flight for this same key shares that fetch rather than
    // starting a second one (verified: toggling closed/open rapidly during
    // an unresolved fetch does not increase the call count). cancelRefetch:
    // false additionally asks it to prefer the in-flight fetch outright
    // rather than aborting and restarting it.
    if (next) {
      void notificationsQuery.refetch({ cancelRefetch: false });
    }
  }

  // Close on outside click and on Escape. Focus is restored to the bell
  // only when Escape originated inside this disclosure (the trigger or the
  // panel) — never stealing focus from an unrelated form, dialog, or input
  // elsewhere on the page.
  useEffect(() => {
    if (!open) return;

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        const target = e.target as Node | null;
        const inside = (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) ?? false;
        setOpen(false);
        if (inside) {
          buttonRef.current?.focus();
        }
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative">
      {/* No aria-haspopup: `true` is a synonym for "menu", and this popup is
          a region, not a menu — promising a menu changes how a screen reader
          tells the user to interact with it. aria-expanded plus aria-controls
          is the disclosure pattern this actually implements. aria-controls is
          omitted while closed, because the panel is not in the DOM then and an
          IDREF pointing at nothing is invalid. */}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? 'notification-panel' : undefined}
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        onClick={handleToggle}
        className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <Bell className="h-5 w-5 text-gray-700 dark:text-gray-300" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-0.5 min-w-[1rem] h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-medium leading-4 text-center"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Announces mark-read/mark-all-read/error outcomes without depending
          on the panel being visually open — screen readers hear the result
          even if focus never enters the panel. Loading itself is conveyed
          via aria-busy on the panel below (not duplicated here as text, or
          "Loading notifications…" would exist twice in the accessible tree —
          once here, once in the panel body — which is exactly the kind of
          ambiguity a screen reader's "find" gesture stumbles on too). */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcedText}
      </span>

      {open && (
        <div
          id="notification-panel"
          ref={panelRef}
          role="region"
          aria-label="Notifications"
          aria-busy={notificationsQuery.isFetching}
          className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50"
        >
          <div className="flex items-center justify-between gap-2 p-3 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => markAllReadMutation.mutate()}
              disabled={markAllReadMutation.isPending || unreadCount === 0}
            >
              Mark all read
            </Button>
          </div>

          {notificationsQuery.isLoading ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading notifications…</p>
          ) : showInitialError ? (
            <div role="alert" className="p-4 space-y-2">
              <p className="text-sm text-red-600 dark:text-red-400">Failed to load notifications.</p>
              <Button size="sm" variant="outline" onClick={() => notificationsQuery.refetch()}>
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">You&apos;re all caught up.</p>
          ) : (
            <>
              {showRefreshError && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-2 px-3 py-2 border-b border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20"
                >
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    Couldn&apos;t refresh. Showing the last loaded notifications.
                  </p>
                  <Button size="sm" variant="outline" onClick={() => notificationsQuery.refetch()}>
                    Retry
                  </Button>
                </div>
              )}
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {items.map((n) => (
                  <li
                    key={n.id}
                    className={`p-3 ${!n.isRead ? 'bg-primary-50 dark:bg-primary-900/10' : ''}`}
                  >
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{n.title}</p>
                    <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{n.body}</p>
                    {!n.isRead && (
                      <button
                        type="button"
                        className="mt-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline disabled:opacity-50 disabled:no-underline"
                        onClick={() => markReadMutation.mutate(n.id)}
                        disabled={markReadMutation.isPending && markReadMutation.variables === n.id}
                      >
                        {markReadMutation.isPending && markReadMutation.variables === n.id ? 'Marking…' : 'Mark as read'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {loadMoreMutation.isError && (
                <div role="alert" className="flex items-center justify-between gap-2 px-3 py-2 border-t border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
                  <p className="text-xs text-amber-800 dark:text-amber-200">Couldn&apos;t load more notifications.</p>
                  <Button size="sm" variant="outline" onClick={() => loadMoreMutation.mutate()}>
                    Retry
                  </Button>
                </div>
              )}
              {hasNextPage && (
                <div className="p-2 border-t border-gray-200 dark:border-gray-700">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full"
                    onClick={() => loadMoreMutation.mutate()}
                    disabled={loadMoreMutation.isPending}
                  >
                    {loadMoreMutation.isPending ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}