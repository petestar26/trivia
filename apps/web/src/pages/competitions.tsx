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

  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    // Kept as a single-segment key — GroupsPage's create/join mutations
    // invalidate `['groups-for-competitions']` as a prefix, which must
    // still match this query for those invalidations to keep working.
    queryKey: ['groups-for-competitions'],
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
    getNextPageParam: (lastPage) => (lastPage.meta?.hasNextPage ? (lastPage.meta.page ?? 1) + 1 : undefined),
  });

  const groups = data?.pages.flatMap((p) => p.groups) ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  // Only when there's nothing already loaded to show — a failed
  // `fetchNextPage()` after a successful first page leaves the groups
  // already on screen alone (see the inline retry note near Load more
  // below) rather than replacing them with a full-page error.
  if (isError && groups.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-red-600 dark:text-red-400">
            Failed to load your groups.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Select a group to view and join its competitions.
      </p>

      {groups.length === 0 ? (
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

          {(hasNextPage || isError) && (
            <div className="flex flex-col items-center gap-2 pt-2">
              {isError && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  Couldn&apos;t load more groups.
                </p>
              )}
              {hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  aria-busy={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
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
