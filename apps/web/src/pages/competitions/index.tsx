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

// Compatibility fallback for the brief deployment window where a page bundle
// is ahead of the API and `phase` is absent from a competition payload. Uses
// the exact lifecycle semantics: terminal persisted statuses override
// timestamps; otherwise UPCOMING/OPEN/ENDED is decided by the clock.
function phaseFallback(
  status: Competition['status'] | undefined,
  startsAt: string,
  endsAt: string,
): CompetitionPhase {
  if (status === 'COMPLETED' || status === 'CANCELLED') return status;
  const now = Date.now();
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (now < start) return 'UPCOMING';
  if (now <= end) return 'OPEN';
  return 'ENDED';
}

// setTimeout's 32-bit signed limit. Long-horizon boundary waits are chained in
// slices of at most this many ms, so a far-future startsAt/endsAt can never
// overflow the delay (which would clamp to 1 ms and fire immediately).
const MAX_TIMEOUT = 2_147_483_647;

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
    // Explicit recovery hook: boundary changes become visible on tab return
    // even if the local re-arming chain was torn down while the tab was away.
    refetchOnWindowFocus: true,
  });

  // ── Boundary refresh ─────────────────────────────────────────────
  // One focused timer chain to the NEAREST upcoming start/end boundary across
  // the visible (non-terminal) competitions; when it fires the list refetches
  // so phase badges flip UPCOMING→OPEN→ENDED without a manual reload. No
  // polling — no network request fires between boundaries. Long horizons are
  // handled by bounded chained waiting: the remaining local delay is recomputed
  // every ≤ 2^31 - 1 ms, so setTimeout can never overflow and a boundary is
  // never abandoned merely because it is far away. At now === endsAt the OPEN
  // phase is still valid, so a refresh is still scheduled just past the
  // boundary to flip to ENDED.
  useEffect(() => {
    const nextBoundary = competitions.reduce<number | null>((acc, comp) => {
      const start = new Date(comp.startsAt).getTime();
      const end = new Date(comp.endsAt).getTime();
      const now = Date.now();
      // Skip terminal statuses: their phase is persisted, not time-driven.
      if (comp.status === 'COMPLETED' || comp.status === 'CANCELLED') return acc;
      const boundary = now < start ? start : now <= end ? end : null;
      if (boundary === null) return acc;
      return Math.min(acc ?? Infinity, boundary);
    }, null);

    if (nextBoundary === null) return;

    let cancelled = false;
    let timer: number | undefined;

    const arm = () => {
      if (cancelled) return;
      const remaining = Math.max(0, nextBoundary - Date.now());
      if (remaining > MAX_TIMEOUT) {
        timer = window.setTimeout(arm, MAX_TIMEOUT);
        return;
      }
      timer = window.setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['competitions', groupId] });
      }, remaining + 250);
    };

    arm();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
            const phase = comp.phase ?? phaseFallback(comp.status, comp.startsAt, comp.endsAt);
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