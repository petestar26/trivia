import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import {
  notificationsInboxKey,
  notificationsScopeKey,
  purgeForeignNotificationScopes,
} from '@/lib/notifications-query-keys';
import { Button } from '@/components/ui/button';
import {
  applyMarkAllRead,
  applyMarkRead,
  flattenNotificationPages,
  inboxUnreadCount,
  toNotificationPage,
  type NotificationInbox,
  type NotificationPage,
} from './notification-pages';

const PANEL_LIMIT = 20;
const PANEL_ID = 'notification-panel';

async function fetchNotificationPage(page: number, signal: AbortSignal): Promise<NotificationPage> {
  const res = await api.listNotifications({ limit: PANEL_LIMIT, page }, { signal });
  return toNotificationPage(res, page);
}

/**
 * A user activation whose settlement may have to put keyboard focus back.
 *
 * The control that was activated can leave the DOM as a consequence of what it
 * did — Load more is gone once the last page has arrived, a successful Retry
 * dismisses the banner that held it, Mark as read disappears from a row that is
 * now read — and Chromium answers the removal of a focused element by dropping
 * focus onto <body>. Each request names where a keyboard user should land
 * instead. Requests exist only when the activated control actually HAD focus,
 * so focus is never pulled toward anyone who clicked with a pointer.
 */
type FocusRequest = { trigger: HTMLElement; settled: boolean } & (
  | { kind: 'appended'; knownIds: ReadonlySet<string> }
  | { kind: 'row'; rowId: string }
  | { kind: 'retry' }
);

function focusIsInside(panel: HTMLElement): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body && panel.contains(active);
}

function resolveFocusTarget(panel: HTMLElement, request: FocusRequest): HTMLElement {
  const rows = Array.from(panel.querySelectorAll<HTMLElement>('[data-notification-id]'));
  const firstAction = (candidates: HTMLElement[]) =>
    candidates
      .map((row) => row.querySelector<HTMLElement>('[data-action="mark-read"]'))
      .find((el): el is HTMLElement => el !== null);

  switch (request.kind) {
    case 'appended': {
      // The first notification the user has not seen yet that they can act on;
      // failing that the first new row itself, so the next Tab continues from
      // where the new content begins; failing that the panel.
      const appended = rows.filter((row) => !request.knownIds.has(row.dataset.notificationId ?? ''));
      return firstAction(appended) ?? appended[0] ?? panel;
    }
    case 'row':
      // The row survives the action even though its button does not.
      return rows.find((row) => row.dataset.notificationId === request.rowId) ?? panel;
    case 'retry':
      return panel.querySelector<HTMLElement>('[data-action="retry"]') ?? firstAction(rows) ?? rows[0] ?? panel;
  }
}

/**
 * The notification bell.
 *
 * The inbox is private, per-account data, so nothing in here is allowed to
 * depend on which account happened to be signed in earlier:
 *
 *  - The identity comes from the authenticated user, and until it is resolved
 *    nothing is rendered and nothing is requested (fail closed).
 *  - Every query key is `['notifications', userId, ...]`, so two accounts can
 *    never share a cache entry (see notifications-query-keys.ts).
 *  - The inbox body is keyed by the user id, so all local state — the open
 *    panel, announcements, focus bookkeeping — is discarded, never carried, at
 *    an identity change; and its teardown cancels that account's in-flight
 *    requests, whose late results are discarded rather than delivered.
 *  - Whenever an identity is established, queries belonging to any OTHER
 *    account are cancelled and removed.
 *  - Mutation callbacks act only on the key of the identity that started them.
 *
 * AuthProvider also clears the whole query cache at every identity boundary.
 * That is defence in depth: none of the above assumes it happens.
 */
export function NotificationBell() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userId = typeof user?.id === 'string' && user.id !== '' ? user.id : null;

  useEffect(() => {
    purgeForeignNotificationScopes(queryClient, userId);
  }, [queryClient, userId]);

  if (userId === null) return null;
  return <NotificationInbox key={userId} userId={userId} />;
}

function NotificationInbox({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const inboxKey = useMemo(() => notificationsInboxKey(userId, PANEL_LIMIT), [userId]);
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
  const announcedText = status.message === '' ? '' : `${status.message}${status.nonce % 2 ? '​' : ''}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const focusRequestRef = useRef<FocusRequest | null>(null);
  const [, setSettleTick] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // This account's inbox is going away — sign-out, an account switch, or
      // the header unmounting. Cancel what is still in flight for it so that a
      // late response has nowhere to land. Cancelling is deliberately the only
      // thing done here: removing the queries from inside an effect cleanup
      // would orphan the live observer StrictMode re-attaches, and stale
      // leftovers are removed by the identity-establishing effect in
      // NotificationBell instead.
      void queryClient.cancelQueries({ queryKey: notificationsScopeKey(userId) });
    };
  }, [queryClient, userId]);

  const inbox = useInfiniteQuery({
    queryKey: inboxKey,
    // `signal` is forwarded to fetch: unmounting aborts the request itself,
    // not just the interest in its result.
    queryFn: ({ pageParam, signal }) => fetchNotificationPage(pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => (lastPage.hasNextPage ? lastPage.page + 1 : undefined),
  });

  const pages = inbox.data?.pages;
  const items = useMemo(() => flattenNotificationPages(pages), [pages]);
  const unreadCount = inboxUnreadCount(pages);
  const { hasNextPage } = inbox;

  // Cached-success is defined by the query holding data, not by item count:
  // an empty inbox is a legitimate loaded state, and conflating it with
  // "never loaded" would drop a genuine "all caught up" for a destructive
  // first-load error.
  const hasCachedData = inbox.data !== undefined;

  // WHICH kind of failure is on screen, remembered across the retry that
  // follows it. React Query clears or reclassifies its own error the moment a
  // retry starts (with no data it goes back to `pending`; after a next-page
  // failure a refresh resets the fetch direction), so deriving the message from
  // it alone would unmount the very Retry button the user just activated — and
  // Chromium answers that by dropping focus onto <body> for the whole request.
  // Kept as state adjusted during render (React's documented pattern for
  // state derived from a changing input), so there is no frame of lag.
  type Failure = 'initial' | 'refresh' | 'next-page';
  const [rememberedFailure, setRememberedFailure] = useState<Failure | null>(null);
  let failure: Failure | null = rememberedFailure;
  if (inbox.isSuccess) {
    failure = null;
  } else if (inbox.isError && !inbox.isFetching) {
    failure = !hasCachedData ? 'initial' : inbox.isFetchNextPageError ? 'next-page' : 'refresh';
  }
  if (failure !== rememberedFailure) setRememberedFailure(failure);

  const showInitialError = failure === 'initial' && !hasCachedData;
  const showLoading = !hasCachedData && !showInitialError;
  // A failed refresh, whatever the cache holds — including an empty inbox.
  // A failed NEXT-PAGE fetch has its own message, below.
  const refreshFailed = hasCachedData && failure === 'refresh';
  // Stays true while a retry of the failed page is in flight, so the control
  // the user activated keeps its place in the tree (and its focus).
  const nextPageFailed = hasCachedData && inbox.isFetchNextPageError;
  const paginationBusy = inbox.isFetching;

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.markNotificationRead(id),
    onSuccess: (_res, id) => {
      // Acts on THIS identity's key only — even if the account has been
      // switched since the request was made. If that inbox was discarded these
      // are no-ops: an absent query is not written to and is not refetched.
      queryClient.setQueryData<NotificationInbox>(inboxKey, (current) => applyMarkRead(current, id));
      // The patch makes the change visible now; the refetch reconciles every
      // loaded page (and the server's unread total) with the server.
      void queryClient.invalidateQueries({ queryKey: inboxKey, exact: true });
      announce('Notification marked as read.');
    },
    onError: () => {
      announce('Failed to mark notification as read.');
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.markAllNotificationsRead(),
    onSuccess: () => {
      queryClient.setQueryData<NotificationInbox>(inboxKey, (current) => applyMarkAllRead(current));
      void queryClient.invalidateQueries({ queryKey: inboxKey, exact: true });
      announce('All notifications marked as read.');
    },
    onError: () => {
      announce('Failed to mark all notifications as read.');
    },
  });

  // Load more and the next-page Retry are the same control and share this path.
  //
  // Single-flight comes from the query, not from React: whether a fetch is in
  // flight is read from the cache, which changes synchronously when
  // `fetchNextPage` is called, so a second activation in the same tick (before
  // React has re-rendered) sees it. It also covers a background refresh —
  // `fetchNextPage` issued while one is running would be handed the refresh's
  // promise and never fetch a page at all, so the control is unavailable then.
  // `cancelRefetch: false` is the second layer: were a fetch to slip through, it
  // joins the in-flight request instead of cancelling and re-sending it (the
  // default `cancelRefetch: true` is how a double click becomes two requests).
  async function loadMore(trigger: HTMLElement) {
    if (queryClient.isFetching({ queryKey: inboxKey, exact: true }) > 0) return;
    if (!hasNextPage) return;

    const knownIds = new Set(items.map((n) => n.id));
    const request: FocusRequest | null =
      document.activeElement === trigger ? { kind: 'appended', trigger, knownIds, settled: false } : null;
    focusRequestRef.current = request;
    announce('Loading more notifications…');

    const result = await inbox.fetchNextPage({ cancelRefetch: false });
    if (!mountedRef.current) return;
    if (result.isFetching) {
      // A newer fetch (a mark-read reconciliation) superseded this one; its
      // outcome is the one that will settle the UI.
      if (focusRequestRef.current === request) focusRequestRef.current = null;
      return;
    }
    if (request) request.settled = true;
    if (result.isFetchNextPageError) {
      announce('Failed to load more notifications.');
    } else {
      const added = flattenNotificationPages(result.data?.pages).filter((n) => !knownIds.has(n.id)).length;
      announce(added > 0 ? `Loaded ${added} more notification${added === 1 ? '' : 's'}.` : 'No more notifications to load.');
    }
  }

  // Retry after a failed initial load or a failed refresh. Same single-flight
  // rule as loadMore: read from the query, refuse while anything is in flight.
  async function refresh(trigger: HTMLElement) {
    if (queryClient.isFetching({ queryKey: inboxKey, exact: true }) > 0) return;
    const request: FocusRequest | null =
      document.activeElement === trigger ? { kind: 'retry', trigger, settled: false } : null;
    focusRequestRef.current = request;
    const result = await inbox.refetch({ cancelRefetch: false });
    if (!mountedRef.current) return;
    if (request) request.settled = true;
    // The Retry button stays put (and stays focused) when this fails again, so
    // nothing on screen changes: say so.
    if (result.isError && !result.isFetching) {
      announce(result.data === undefined ? 'Failed to load notifications.' : "Couldn't refresh notifications.");
    }
    setSettleTick((t) => t + 1);
  }

  function markRead(id: string, trigger: HTMLElement) {
    const hadFocus = document.activeElement === trigger;
    markReadMutation.mutate(id, {
      onSuccess: () => {
        if (hadFocus && mountedRef.current) {
          focusRequestRef.current = { kind: 'row', rowId: id, trigger, settled: true };
        }
      },
    });
  }

  // Runs after every render while a request is pending, so it observes the DOM
  // that the settled state actually produced.
  useLayoutEffect(() => {
    const request = focusRequestRef.current;
    if (!request) return;
    const panel = panelRef.current;
    if (!panel) {
      focusRequestRef.current = null;
      return;
    }
    if (!request.settled) return;

    // Whether the activated control should have left the DOM by now. A settled
    // request whose control is still there in a state that says it should be
    // gone is a render that has not caught up yet — wait for the next one.
    const expectedGone =
      request.kind === 'appended' ? !hasNextPage : request.kind === 'retry' ? failure === null : true;
    if (request.trigger.isConnected) {
      if (!expectedGone) focusRequestRef.current = null;
      return;
    }

    focusRequestRef.current = null;
    // Focus that already landed somewhere in the panel is left alone.
    if (focusIsInside(panel)) return;
    resolveFocusTarget(panel, request).focus();
  });

  function handleToggle() {
    const next = !open;
    setOpen(next);
    // Opening the panel is an explicit "show me my notifications" gesture, so
    // it always goes back to the server: the app-wide 5-minute staleTime (see
    // main.tsx) would otherwise let the panel sit on a cached list for minutes,
    // and nothing else refreshes it — there is no polling or socket feed.
    // The refetch re-fetches every page already loaded, front to back, so the
    // list never collapses to its first page. `cancelRefetch: false` joins a
    // fetch that is already in flight — including a next-page request the user
    // started — instead of cancelling it and starting over.
    if (next) {
      void inbox.refetch({ cancelRefetch: false });
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
        aria-controls={open ? PANEL_ID : undefined}
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

      {/* Announces mark-read/mark-all-read/pagination outcomes without
          depending on the panel being visually open — screen readers hear the
          result even if focus never enters the panel. Loading itself is
          conveyed via aria-busy on the panel below (not duplicated here as
          text, or "Loading notifications…" would exist twice in the
          accessible tree — once here, once in the panel body — which is
          exactly the kind of ambiguity a screen reader's "find" gesture
          stumbles on too). */}
      <span role="status" aria-live="polite" className="sr-only">
        {announcedText}
      </span>

      {open && (
        <div
          id={PANEL_ID}
          ref={panelRef}
          tabIndex={-1}
          role="region"
          aria-label="Notifications"
          aria-busy={inbox.isFetching}
          className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50 focus:outline-none"
        >
          <div className="flex items-center justify-between gap-2 p-3 border-b border-gray-200 dark:border-gray-700">
            <span className="text-sm font-semibold text-gray-900 dark:text-white">Notifications</span>
            {/* aria-disabled, never native `disabled`: the button that was just
                activated becomes unavailable the moment its request starts (and
                again once nothing is unread), and Chromium drops focus onto
                <body> when a focused control becomes natively disabled. */}
            <Button
              size="sm"
              variant="ghost"
              className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
              aria-disabled={markAllReadMutation.isPending || unreadCount === 0 || undefined}
              onClick={() => {
                if (markAllReadMutation.isPending || unreadCount === 0) return;
                markAllReadMutation.mutate();
              }}
            >
              Mark all read
            </Button>
          </div>

          {showLoading ? (
            <p className="p-4 text-sm text-gray-500 dark:text-gray-400">Loading notifications…</p>
          ) : showInitialError ? (
            <div className="p-4 space-y-2">
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                Failed to load notifications.
              </p>
              <Button
                size="sm"
                variant="outline"
                data-action="retry"
                className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                aria-disabled={inbox.isFetching || undefined}
                onClick={(e) => void refresh(e.currentTarget)}
              >
                {inbox.isFetching ? 'Retrying…' : 'Retry'}
              </Button>
            </div>
          ) : (
            <>
              {refreshFailed && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20">
                  <p role="alert" className="text-xs text-amber-800 dark:text-amber-200">
                    {items.length === 0
                      ? "Couldn't refresh. You may have new notifications."
                      : "Couldn't refresh. Showing the last loaded notifications."}
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    data-action="retry"
                    className="aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    aria-label="Retry refreshing notifications"
                    aria-disabled={inbox.isFetching || undefined}
                    onClick={(e) => void refresh(e.currentTarget)}
                  >
                    {inbox.isFetching ? 'Retrying…' : 'Retry'}
                  </Button>
                </div>
              )}
              {items.length === 0 ? (
                <p className="p-4 text-sm text-gray-500 dark:text-gray-400">
                  {refreshFailed ? 'No notifications to show.' : "You're all caught up."}
                </p>
              ) : (
                <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                  {items.map((n) => {
                    const marking = markReadMutation.isPending && markReadMutation.variables === n.id;
                    return (
                      <li
                        key={n.id}
                        data-notification-id={n.id}
                        tabIndex={-1}
                        className={`p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${
                          !n.isRead ? 'bg-primary-50 dark:bg-primary-900/10' : ''
                        }`}
                      >
                        <p className="text-sm font-medium text-gray-900 dark:text-white">{n.title}</p>
                        <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">{n.body}</p>
                        {!n.isRead && (
                          <button
                            type="button"
                            data-action="mark-read"
                            className="mt-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:underline aria-disabled:opacity-50 aria-disabled:no-underline"
                            aria-disabled={marking || undefined}
                            onClick={(e) => {
                              if (marking) return;
                              markRead(n.id, e.currentTarget);
                            }}
                          >
                            {marking ? 'Marking…' : 'Mark as read'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {(hasNextPage || nextPageFailed) && (
                <div className="p-2 border-t border-gray-200 dark:border-gray-700">
                  {/* One control for Load more AND its Retry. It is the same
                      element in the same position across every state, so a
                      keyboard user who activates it keeps their place: it is
                      never natively disabled while a page is pending (that would
                      blur it) and never replaced by a different element when the
                      fetch fails. */}
                  {nextPageFailed && (
                    <p role="alert" className="px-1 pb-2 text-xs text-amber-800 dark:text-amber-200">
                      Couldn&apos;t load more notifications.
                    </p>
                  )}
                  <Button
                    size="sm"
                    variant={nextPageFailed ? 'outline' : 'ghost'}
                    className="w-full aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                    data-next-page-control
                    aria-disabled={paginationBusy || undefined}
                    aria-busy={inbox.isFetchingNextPage}
                    aria-label={nextPageFailed ? 'Retry loading more notifications' : undefined}
                    onClick={(e) => void loadMore(e.currentTarget)}
                  >
                    {inbox.isFetchingNextPage
                      ? nextPageFailed
                        ? 'Retrying…'
                        : 'Loading…'
                      : nextPageFailed
                        ? 'Retry'
                        : 'Load more'}
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
