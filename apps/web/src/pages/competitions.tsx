/**
 * CompetitionsPage — /competitions
 *
 * Shows the user's groups. Clicking a group navigates to its competition list
 * at /competitions/:groupId (GroupCompetitionsPage).
 *
 * Competitions are always scoped to a group, so the top-level page is a
 * group-picker rather than a flat list.
 */
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

  // Next-page fetches must never re-run the same request twice from a burst
  // of activations. `cancelRefetch: false` keeps a click that lands while a
  // page request is already in flight from cancelling (and silently
  // re-sending) that same page, so two same-tick activations produce exactly
  // one network call. Used for BOTH Load more and the next-page Retry.
  const loadNextPage = () => void fetchNextPage({ cancelRefetch: false });

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
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
        <Card>
          <CardContent className="py-8 text-center text-red-600 dark:text-red-400">
            Failed to load your groups.
          </CardContent>
        </Card>
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Select a group to view and join its competitions.
      </p>

      {/* Background refresh failure: keep the already-loaded cards on screen
          and surface a distinct, retryable message — NOT a "load more" error. */}
      {isRefetchError && showCards && (
        <div
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-600 dark:bg-red-900/30 dark:text-red-200 flex items-center gap-3"
        >
          <span className="flex-1">Couldn&apos;t refresh groups.</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}

      {!showCards && !isRefetchError ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400 space-y-3">
          <p>You are not a member of any groups yet.</p>
          <Button size="sm" onClick={() => navigate('/groups')}>
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
              the button area swaps to a clearly-labelled Retry. */}
          {(hasNextPage || isFetchNextPageError) && (
            <div className="flex flex-col items-center gap-2 pt-2">
              {isFetchNextPageError ? (
                <>
                  <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                    Couldn&apos;t load more groups.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadNextPage}
                    disabled={isFetchingNextPage}
                    aria-busy={isFetchingNextPage}
                  >
                    {isFetchingNextPage ? 'Retrying…' : 'Retry next page'}
                  </Button>
                </>
              ) : hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadNextPage}
                  disabled={isFetchingNextPage}
                  aria-busy={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              ) : null}
              <span role="status" aria-live="polite" className="sr-only">
                {isFetchingNextPage ? 'Loading more groups…' : ''}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}