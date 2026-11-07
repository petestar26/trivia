import { useTogetherText } from '@/lib/i18n/together-text';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Radio, Trophy } from 'lucide-react';
import { togetherGame, type TogetherGroupActivity } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useAuth } from '@/providers/auth-provider';
import { useEffect, useState } from 'react';
import { GroupWatchArea } from '@/components/together/group-watch-area';

/** A group-wide doorway. Viewing this card never joins or funds a round. */
export function GroupRoundActivity({
  groupId,
  onWatchStateChange,
}: {
  groupId: string;
  onWatchStateChange?: (watching: boolean) => void;
}) {
  const { t } = useTogetherText();

  const { user } = useAuth();
  const [watchChoice, setWatchChoice] = useState<{ roundId: string; open: boolean } | null>(null);
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
  const { activeRound, latestResult } = query.data ?? {};
  const displayedRound = activeRound ?? latestResult;
  const watching =
    watchChoice?.roundId === displayedRound?.id ? (watchChoice?.open ?? false) : !!activeRound;
  // Keep a round being watched visible through settlement. An old result on
  // first opening chat stays compact so it does not displace the conversation.
  useEffect(() => {
    if (activeRound && watchChoice?.roundId !== activeRound.id)
      setWatchChoice({ roundId: activeRound.id, open: true });
  }, [activeRound?.id, watchChoice?.roundId]);
  useEffect(() => {
    onWatchStateChange?.(
      !!(query.data?.activeRound || query.data?.latestResult) && watching && !query.isError
    );
  }, [
    query.data?.activeRound?.id,
    query.data?.latestResult?.id,
    watching,
    query.isError,
    onWatchStateChange,
  ]);
  if (query.isError)
    return (
      <p className="text-sm text-slate-500" role="status">
        {t('Shared round updates are unavailable.')}{' '}
        <Link className="underline" to={`/groups/${groupId}/games`}>
          {t('Open group games')}
        </Link>
      </p>
    );
  if (!activeRound && !latestResult) return null;
  return (
    <div className="tg-group-activity">
      <aside aria-label={t('Your group’s shared round')} className="tg-group-activity-bar">
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
              onClick={() => setWatchChoice({ roundId: displayedRound!.id, open: !watching })}
              aria-expanded={watching}
              className="tg-watch-toggle"
            >
              {watching ? t('Hide game') : activeRound ? t('Watch live') : t('View result')}
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
