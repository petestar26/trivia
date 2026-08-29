/**
 * GroupCompetitionsPage — /competitions/:groupId
 *
 * Lists all competitions for a specific group.  Membership is enforced
 * server-side; the backend returns 403 if the user is not an active member.
 */
import { useQuery } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { api, Competition } from '@/lib/api';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  ACTIVE:    'Active',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

const STATUS_COLOR: Record<string, string> = {
  SCHEDULED: 'text-yellow-600 dark:text-yellow-400',
  ACTIVE:    'text-green-600 dark:text-green-400',
  COMPLETED: 'text-blue-600 dark:text-blue-400',
  CANCELLED: 'text-gray-400',
};

export function GroupCompetitionsPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();

  const { data: competitions = [], isLoading, isError } = useQuery<Competition[]>({
    queryKey: ['competitions', groupId],
    queryFn: async () => {
      const res = await api.listCompetitionsForGroup(groupId!);
      return res.data ?? [];
    },
    enabled: !!groupId,
  });

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

            return (
              <Card key={comp.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{comp.title}</CardTitle>
                    <span className={`text-xs font-semibold whitespace-nowrap ${STATUS_COLOR[comp.status] ?? ''}`}>
                      {STATUS_LABEL[comp.status] ?? comp.status}
                    </span>
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
                    {comp.status === 'ACTIVE' ? 'Play' :
                     comp.status === 'SCHEDULED' ? 'View / Join' :
                     'View results'}
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
