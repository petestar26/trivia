/**
 * CompetitionsPage — /competitions
 *
 * Shows the user's groups. Clicking a group navigates to its competition list
 * at /competitions/:groupId (GroupCompetitionsPage).
 *
 * Competitions are always scoped to a group, so the top-level page is a
 * group-picker rather than a flat list.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/lib/api';
import { COMPETITIONS_HUB_GROUPS_QUERY_KEY } from '@/lib/groups-query-keys';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface GroupSummary {
  id: string;
  name: string;
  description?: string | null;
  isMember: boolean;
  memberRole?: string;
  memberCount: number;
}

interface GroupListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

interface GroupsPage {
  groups: GroupSummary[];
  meta?: GroupListMeta;
}

// Matches the server's own default page size (see GET /groups) so a page
// here corresponds to a page there.
const PAGE_LIMIT = 20;

/**
 * A user activation whose settlement may have to put keyboard focus back.
 * The activated control can unmount when its request settles — Load more is
 * replaced by "Retry next page" on failure, the footer control disappears on
 * the final page, and the error view is replaced by content after a
 * successful Retry — which would otherwise drop focus to <body>.
 */
interface FocusIntent {
  kind: 'next-page' | 'refresh';
  /** How many groups were rendered when the user activated the control. */
  groupCountBefore: number;
}

export function CompetitionsPage() {
  const navigate = useNavigate();

  const {
    data,
    isLoading,
    isError,
    isRefetchError,
    isFetchNextPageError,
    fetchNextPage,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
  } = useInfiniteQuery({
    // Kept as a single-segment key — GroupsPage's create/join mutations
    // invalidate `['groups-for-competitions']` as a prefix, which must
    // still match this query for those invalidations to keep working.
    queryKey: COMPETITIONS_HUB_GROUPS_QUERY_KEY,
    queryFn: async ({ pageParam }): Promise<GroupsPage> => {
      // GET /groups?mine=true does the membership filtering server-side —
      // ACTIVE groups where the caller has an ACTIVE membership, private
      // groups included — before pagination, so every one of the user's
      // groups is reachable via `meta`/`fetchNextPage` rather than only
      // whatever fits in one arbitrarily-sized request.
      const res = await api.listGroups({ mine: true, limit: PAGE_LIMIT, page: pageParam });
      return {
        groups: (res.data ?? []) as GroupSummary[],
        meta: res.meta as GroupListMeta | undefined,
      };
    },
    initialPageParam: 1,
    // The next page is derived from the successful `lastPageParam` — never
    // trusted from `meta.page` (the server may omit it or echo the requested
    // value) — and only advances while the server actually claims a next
    // page exists.
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      if (lastPage.meta?.hasNextPage !== true) return undefined;
      return (lastPageParam as number) + 1;
    },
  });

  const groups = data?.pages.flatMap((p) => p.groups) ?? [];
  const showCards = groups.length > 0;

  const rootRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const focusIntentRef = useRef<FocusIntent | null>(null);
  const [settledIntent, setSettledIntent] = useState<FocusIntent | null>(null);
  // Once the user has paged, the footer (and its status region) stays mounted
  // so the final "all loaded" announcement lands in an existing live region.
  const [paginationEngaged, setPaginationEngaged] = useState(false);
  const [completionMessage, setCompletionMessage] = useState('');

  // Records the latest user activation and marks it settled when its request
  // finishes; an older activation superseded by a newer one never acts.
  const trackActivation = (intent: FocusIntent, request: Promise<unknown>) => {
    focusIntentRef.current = intent;
    const settle = () => {
      if (focusIntentRef.current === intent) setSettledIntent(intent);
    };
    void request.then(settle, settle);
  };

  // Next-page fetches must never re-run the same request twice from a burst
  // of activations. `cancelRefetch: false` keeps a click that lands while a
  // page request is already in flight from cancelling (and silently
  // re-sending) that same page, so two same-tick activations produce exactly
  // one network call. Used for BOTH Load more and the next-page Retry.
  //
  // A background refetch (invalidation/refetchQueries while the list is
  // already cached) must not blur the focused Load more button: Chromium
  // drops focus onto <body> when a focused control becomes natively
  // disabled. During that window Load more stays focusable with
  // `aria-disabled` and the handler below refuses to run, so no duplicate
  // request escapes the guard. Only a user-initiated next-page fetch keeps
  // the native `disabled` so the control reads as genuinely unavailable.
  const isBackgroundRefetching = isFetching && !isFetchingNextPage && !isLoading;
  const loadNextPage = () => {
    if (isBackgroundRefetching) return;
    setPaginationEngaged(true);
    setCompletionMessage('');
    trackActivation({ kind: 'next-page', groupCountBefore: groups.length }, fetchNextPage({ cancelRefetch: false }));
  };

  // Initial-load Retry and background-refresh Retry both re-run the query.
  const retryRefresh = () => {
    trackActivation({ kind: 'refresh', groupCountBefore: groups.length }, refetch());
  };

  // Runs after the DOM reflects a settled user activation. Background
  // refetches never create an intent, so they can never move focus.
  useLayoutEffect(() => {
    const intent = settledIntent;
    if (!intent || focusIntentRef.current !== intent || isFetching) return;
    focusIntentRef.current = null;

    const active = document.activeElement;
    // Focus is restored only when it was lost with the activated control
    // (fell back to <body>) or still sits in the footer being re-rendered —
    // never pulled away from wherever the user has moved in the meantime.
    const focusLost =
      !active ||
      active === document.body ||
      (intent.kind === 'next-page' && (footerRef.current?.contains(active) ?? false));
    const focusNth = (selector: string, index = 0) => {
      const nodes = rootRef.current?.querySelectorAll<HTMLElement>(selector);
      if (!nodes || nodes.length === 0) return false;
      nodes[Math.min(index, nodes.length - 1)].focus();
      return true;
    };

    if (intent.kind === 'next-page') {
      if (isFetchNextPageError) {
        // The failure itself is announced by the footer's role="alert".
        setCompletionMessage('');
        if (focusLost) focusNth('[data-next-page-control]');
      } else if (hasNextPage) {
        setCompletionMessage(`Showing ${groups.length} groups.`);
        if (focusLost) focusNth('[data-next-page-control]');
      } else {
        setCompletionMessage(`All ${groups.length} groups loaded.`);
        if (focusLost) focusNth('[data-group-action]', intent.groupCountBefore);
      }
      return;
    }

    if (!focusLost) return;
    if (isError) {
      focusNth('[data-refresh-retry]');
    } else if (!focusNth('[data-group-action]')) {
      focusNth('[data-empty-cta]');
    }
  }, [settledIntent, isFetching, isError, isFetchNextPageError, hasNextPage, groups.length]);

  // Initial load — observable and announced by assistive tech.
  if (isLoading) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading your groups"
        className="flex items-center justify-center py-20"
      >
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
        <span className="sr-only">Loading your groups…</span>
      </div>
    );
  }

  // Initial request failure — nothing has ever rendered, so offer a
  // full-page recovery with a Retry instead of the empty-state CTA
  // (which would claim the user belongs to no groups).
  if (isError && !isRefetchError && !showCards) {
    return (
      <div ref={rootRef} className="max-w-3xl mx-auto p-4 space-y-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
        <p role="alert" className="text-center text-sm text-red-600 dark:text-red-400">
          Failed to load your groups.
        </p>
        <div className="flex justify-center">
          <Button variant="outline" size="sm" data-refresh-retry onClick={retryRefresh} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  const footerHasControl = hasNextPage || isFetchNextPageError;

  return (
    <div ref={rootRef} className="max-w-3xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Select a group to view and join its competitions.
      </p>

      {/* Background refresh failure: whatever was already loaded — cards or
          the empty state — stays on screen, with a distinct, retryable
          message that is NOT a "load more" error. */}
      {isRefetchError && (
        <div
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-600 dark:bg-red-900/30 dark:text-red-200 flex items-center gap-3"
        >
          <span role="alert" className="flex-1">Couldn&apos;t refresh groups.</span>
          <Button variant="outline" size="sm" data-refresh-retry onClick={retryRefresh} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}

      {!showCards ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400 space-y-3">
          <p>You are not a member of any groups yet.</p>
          <Button size="sm" data-empty-cta onClick={() => navigate('/groups')}>
            Create a group
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {groups.map((group) => (
              <Card key={group.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{group.name}</CardTitle>
                  {group.description && (
                    <CardDescription className="line-clamp-2">{group.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                    {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
                    {group.memberRole && ` · ${group.memberRole}`}
                  </p>
                  <Button
                    size="sm"
                    data-group-action
                    onClick={() => navigate(`/competitions/${group.id}`)}
                  >
                    View competitions
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Next-page failure and Load more share the footer. A failed
              fetchNextPage keeps the already-loaded cards on screen; only
              the button area swaps to a clearly-labelled Retry. Both
              controls stay native-disabled only while a user-initiated
              next-page fetch is in flight; during a background refetch they
              switch to `aria-disabled` so Chromium never drops focus from the
              focused control to <body>. The activation guard in loadNextPage
              rejects any click while a background refetch is running. */}
          {(footerHasControl || paginationEngaged) && (
            <div ref={footerRef} className={footerHasControl ? 'flex flex-col items-center gap-2 pt-2' : undefined}>
              {isFetchNextPageError ? (
                <>
                  <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                    Couldn&apos;t load more groups.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    data-next-page-control
                    onClick={loadNextPage}
                    disabled={isFetchingNextPage}
                    aria-disabled={isBackgroundRefetching || undefined}
                    aria-busy={isFetchingNextPage}
                  >
                    {isFetchingNextPage ? 'Retrying…' : 'Retry next page'}
                  </Button>
                </>
              ) : hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  data-next-page-control
                  onClick={loadNextPage}
                  disabled={isFetchingNextPage}
                  aria-disabled={isBackgroundRefetching || undefined}
                  aria-busy={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
              <span role="status" aria-live="polite" className="sr-only">
                {isFetchingNextPage ? 'Loading more groups…' : completionMessage}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
