import { useTogetherText } from '@/lib/i18n/together-text';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Radio, Trophy } from 'lucide-react';
import { togetherGame, type TogetherGroupActivity } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { useState } from 'react';
import { GroupWatchArea } from '@/components/together/group-watch-area';

/** A group-wide doorway. Viewing this card never joins or funds a round. */
export function GroupRoundActivity({ groupId }: { groupId: string }) {
  const { t } = useTogetherText();

  const { user } = useAuth();
  const [watching, setWatching] = useState(true);
  const query = useQuery({
    queryKey: ['together-group-activity', user?.id, groupId],
    enabled: !!user,
    queryFn: ({ signal }) =>
      boundedRequest(
        async (active) =>
          unwrapData(
            await api.get<TogetherGroupActivity>(
              `/play-together/groups/${encodeURIComponent(groupId)}/activity`,
              undefined,
              { signal: active }
            )
          ),
        signal
      ),
    refetchInterval: 5000,
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  if (query.isError)
    return (
      <p className="text-sm text-slate-500" role="status">
        {t('Shared round updates are unavailable.')}{' '}
        <Link className="underline" to={`/groups/${groupId}/games`}>
          {t('Open group games')}
        </Link>
      </p>
    );
  const { activeRound, latestResult } = query.data ?? {};
  if (!activeRound && !latestResult) return null;
  return (
    <div>
      <aside
        aria-label={t('Your group’s shared round')}
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-slate-800 dark:border-rose-900 dark:bg-slate-900 dark:text-slate-100"
      >
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            {activeRound ? <Radio size={16} /> : <Trophy size={16} />}{' '}
            {t(togetherGame((activeRound ?? latestResult)!.game).name)}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {activeRound
              ? `${t('{count} confirmed', { count: activeRound.participants })} · ${activeRound.state === 'OPEN' ? t('Entries open') : t('Round in progress')} · ${t('Watching is free')}`
              : t('Round complete · Results and payouts saved for your group')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {(activeRound || latestResult) && (
            <button
              type="button"
              onClick={() => setWatching(!watching)}
              aria-expanded={watching}
              className="inline-flex items-center gap-2 rounded-lg bg-rose-800 px-3 py-2 font-semibold text-white"
            >
              {watching ? t('Hide game') : t('Watch live')}
              <ArrowRight size={15} />
            </button>
          )}
          {latestResult && (
            <Link
              className="font-semibold underline"
              to={`/play-together/rounds/${latestResult.id}#group-results`}
            >
              {t('View group result')}
            </Link>
          )}
        </div>
      </aside>
      {watching && (activeRound || latestResult) && user && (
        <GroupWatchArea
          key={(activeRound ?? latestResult)!.id}
          userId={user.id}
          roundId={(activeRound ?? latestResult)!.id}
        />
      )}
    </div>
  );
}
