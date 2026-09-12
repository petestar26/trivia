/**
 * GroupCompetitionsPage — /competitions/:groupId
 *
 * Lists all competitions for a specific group.  Membership is enforced
 * server-side; the backend returns 403 if the user is not an active member.
 * Action affordances (badge, button) are driven by the server-derived `phase`
 * (UPCOMING/OPEN/ENDED), never by the persisted status alone.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api, Competition, CompetitionPhase } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const PHASE_LABEL: Record<CompetitionPhase, string> = {
  UPCOMING: 'Upcoming',
  OPEN: 'Open',
  ENDED: 'Ended',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const PHASE_COLOR: Record<CompetitionPhase, string> = {
  UPCOMING: 'text-yellow-600 dark:text-yellow-400',
  OPEN: 'text-green-600 dark:text-green-400',
  ENDED: 'text-rose-600 dark:text-rose-400',
  COMPLETED: 'text-blue-600 dark:text-blue-400',
  CANCELLED: 'text-gray-400',
};

export function GroupCompetitionsPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: competitions = [], isLoading, isError } = useQuery<Competition[]>({
    queryKey: ['competitions', groupId],
    queryFn: async () => {
      const res = await api.listCompetitionsForGroup(groupId!);
      return res.data ?? [];
    },
    enabled: !!groupId,
  });

  // ── Boundary refresh ─────────────────────────────────────────────
  // One focused timer to the nearest upcoming start/end boundary across the
  // visible (non-terminal) competitions; when it fires the list refetches so
  // phase badges flip UPCOMING→OPEN→ENDED without a manual reload. No polling.
  // Only near boundaries arm a timer: beyond this horizon the wait would
  // overflow setTimeout's 32-bit limit, and returning users are covered by
  // react-query's default refetchOnWindowFocus.
  const MAX_BOUNDARY_WAIT = 24 * 60 * 60 * 1000;
  useEffect(() => {
    const nextBoundary = competitions.reduce<number | null>((acc, comp) => {
      const start = new Date(comp.startsAt).getTime();
      const end = new Date(comp.endsAt).getTime();
      const now = Date.now();
      const boundary = now < start ? start : now < end ? end : null;
      if (boundary === null) return acc;
      return Math.min(acc ?? Infinity, boundary);
    }, null);

    if (nextBoundary === null) return;

    const wait = Math.max(0, nextBoundary - Date.now()) + 250;
    if (wait > MAX_BOUNDARY_WAIT) return;

    const timer = window.setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['competitions', groupId] });
    }, wait);

    return () => window.clearTimeout(timer);
  }, [competitions, groupId, queryClient]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-2xl mx-auto p-4">
        <Card>
          <CardContent className="py-8 text-center text-gray-500 dark:text-gray-400">
            Could not load competitions — you may not be an active member of this group.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => navigate('/competitions')}>
          ← Groups
        </Button>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Competitions</h1>
      </div>

      {competitions.length === 0 ? (
        <div className="py-16 text-center text-gray-500 dark:text-gray-400">
          No competitions in this group yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {competitions.map((comp) => {
            const gameName = comp.game?.name ?? '—';
            const now = Date.now();
            const started = new Date(comp.startsAt).getTime() <= now;
            const ended   = new Date(comp.endsAt).getTime()   <= now;
            const phase = comp.phase ?? (ended ? 'ENDED' : started ? 'OPEN' : 'UPCOMING');
            // List cards never advertise Join/Play: participation is only known
            // on the detail page. The card action is navigation only.
            const actionLabel = phase === 'OPEN' || phase === 'UPCOMING' ? 'View' : 'View results';

            return (
              <Card key={comp.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{comp.title}</CardTitle>
                    <div className="flex items-center gap-2">
                      {comp.isFull && (
                        <span className="text-xs font-semibold whitespace-nowrap text-orange-600 dark:text-orange-400">
                          Full
                        </span>
                      )}
                      <span className={`text-xs font-semibold whitespace-nowrap ${PHASE_COLOR[phase] ?? ''}`}>
                        {PHASE_LABEL[phase] ?? phase}
                      </span>
                    </div>
                  </div>
                  {comp.description && (
                    <CardDescription className="line-clamp-2">{comp.description}</CardDescription>
                  )}
                </CardHeader>

                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-3 text-sm text-gray-600 dark:text-gray-400">
                    <span>Game: <strong>{gameName}</strong></span>
                    <span>Entry: <strong>{comp.entryAmount > 0 ? `${comp.entryAmount} GP` : 'Free'}</strong></span>
                    {comp.maxParticipants && (
                      <span>Max: <strong>{comp.maxParticipants} players</strong></span>
                    )}
                  </div>

                  {(comp.rewardGamePoints > 0 || comp.rewardCoins > 0) && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">
                      Winner:{' '}
                      {[
                        comp.rewardGamePoints > 0 ? `${comp.rewardGamePoints} GP` : null,
                        comp.rewardCoins > 0 ? `${comp.rewardCoins} Coins` : null,
                      ]
                        .filter(Boolean)
                        .join(' + ')}
                    </p>
                  )}

                  <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>
                      {started ? 'Started' : 'Starts'}: {new Date(comp.startsAt).toLocaleDateString()}
                    </span>
                    <span>
                      {ended ? 'Ended' : 'Ends'}: {new Date(comp.endsAt).toLocaleDateString()}
                    </span>
                  </div>

                  <Button
                    size="sm"
                    onClick={() => navigate(`/competitions/${groupId}/${comp.id}`)}
                  >
                    {actionLabel}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}