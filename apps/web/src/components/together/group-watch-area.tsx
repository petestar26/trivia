import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { type TogetherSnapshot } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import { boundedRequest } from '@/lib/bounded-request';
import { useTogetherText } from '@/lib/i18n/together-text';
import { TogetherLobby } from './together-lobby';
import { TogetherGameResult } from './together-game-result';
import { useRoundUpdates } from './use-round-updates';

/** Watching only: mounting this component cannot confirm an entry or fund a wallet. */
export function GroupWatchArea({ userId, roundId }: { userId: string; roundId: string }) {
  const { t, num, money } = useTogetherText();
  const [clock, setClock] = useState(performance.now());
  const query = useQuery({
    queryKey: ['together-round', userId, roundId],
    queryFn: async ({ signal }) => {
      const sent = performance.now();
      const snapshot = unwrapData(
        await boundedRequest(
          (active) =>
            api.get<TogetherSnapshot>('/play-together/rounds/' + roundId, undefined, {
              signal: active,
            }),
          signal
        )
      );
      return { snapshot, sent, received: performance.now() };
    },
    refetchInterval: 1000,
    refetchOnReconnect: 'always',
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  useRoundUpdates(userId, roundId, query.data?.snapshot.round?.eventSequence);
  useEffect(() => {
    const timer = setInterval(() => setClock(performance.now()), 200);
    return () => clearInterval(timer);
  }, []);
  const value = query.data,
    round = value?.snapshot.round;
  const serverNow =
    value && !query.isError && clock - value.received < 5000
      ? value.snapshot.serverTime +
        (value.received - value.sent) / 2 +
        Math.max(0, clock - value.received)
      : null;
  if (!round)
    return (
      <p role="status">
        {t(query.isError ? 'Shared round updates are unavailable.' : 'Loading round…')}
      </p>
    );
  return (
    <div className="tg-group-watch" data-watch-round={round.id}>
      <p hidden={!!round.presentation}>
        {t('{count} confirmed', {
          count: round.entries.filter(
            (e) =>
              e.state !== 'REFUNDED' || round.settlement?.payouts.some((p) => p.entryId === e.id)
          ).length,
        })}{' '}
        · {t('Funded pool')}:{' '}
        {money(
          round.settlement?.funded ??
            round.entries.filter((e) => e.state === 'ACCEPTED').length * round.entryAmount,
          round.currency
        )}
      </p>
      {round.presentation || round.outcome || round.state === 'REFUNDED' ? (
        <TogetherGameResult round={round} userId={userId} serverNow={serverNow} />
      ) : (
        <TogetherLobby round={round} userId={userId} serverNow={serverNow} />
      )}
      <Link to={'/play-together/rounds/' + roundId}>{t('Open full round')}</Link>
    </div>
  );
}
