import { GameArtwork } from '@/components/member/game-artwork';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { requestStatus } from '@/lib/request-error';
import { useLocation } from 'react-router-dom';

import {
  memberGameDestination,
  memberGameLabel,
  memberGameUnavailableDescription,
  PRACTICE_ROUTES,
  type MemberGame as GameCatalogItem,
} from '@/lib/member-game-catalog';

interface WalletData {
  coinsBalance: number;
  gamePointsBalance: number;
}

interface GamesPageProps {
  mode?: 'WAGER' | 'BONUS';
  title?: string;
  description?: string;
  emptyMessage?: string;
}

export function GamesPage({
  mode,
  title = 'Games',
  description = 'Explore our games for solo play, free practice and group PVP. Check each game’s availability.',
  emptyMessage = 'No games available right now.',
}: GamesPageProps = {}) {
  const { user } = useAuth();
  const location = useLocation();
  const queryMode = new URLSearchParams(location.search).get('mode');
  const selectedMode =
    mode ?? (queryMode === 'WAGER' || queryMode === 'BONUS' ? queryMode : undefined);

  const {
    data: games,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<GameCatalogItem[]>({
    queryKey: ['games'],
    queryFn: async () => {
      return unwrapData<GameCatalogItem[]>(
        await api.get<GameCatalogItem[]>('/games'),
        'Games response'
      );
    },
  });

  const { data: wallet } = useQuery<WalletData>({
    queryKey: ['wallet', user?.id],
    queryFn: async () => {
      return unwrapData<WalletData>(await api.get<WalletData>('/wallet'), 'Wallet response');
    },
    enabled: !!user?.id,
  });

  if (isLoading) {
    return (
      <div
        className="flex items-center justify-center py-20"
        role="status"
        aria-label="Loading games"
      >
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  if (isError)
    return (
      <div
        role="alert"
        className="rounded-xl border border-amber-300 bg-amber-50 p-6 text-gray-900"
      >
        <h1 className="text-xl font-bold">{title}</h1>
        <p className="mt-2">
          {requestStatus(error) === 401
            ? 'Your session is unavailable. Sign in again to load games.'
            : 'Unable to load games. Please retry.'}
        </p>
        {requestStatus(error) === 401 ? (
          <Link
            to="/login"
            state={{ from: location }}
            className="mt-4 inline-block rounded-lg bg-primary-600 px-4 py-2 text-white"
          >
            Sign in again
          </Link>
        ) : (
          <button
            onClick={() => void refetch()}
            className="mt-4 rounded-lg bg-primary-600 px-4 py-2 text-white"
          >
            Retry
          </button>
        )}
      </div>
    );

  const practiceRoutes = PRACTICE_ROUTES;
  const publicGames = (games ?? [])
    .filter((g) => g.catalogStatus !== 'RETIRED' && (!selectedMode || g.mode === selectedMode))
    .sort((a, b) => Number(!!practiceRoutes[b.key]) - Number(!!practiceRoutes[a.key]));

  return (
    <div className="qube-catalog space-y-6">
      <div className="qube-catalog-header flex flex-wrap items-start justify-between gap-5 p-6 sm:p-9">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            to="/casino"
            className="rounded-lg border border-rose-300/30 px-4 py-2 text-sm font-medium text-rose-200"
          >
            Casino · provider demos
          </Link>
          <Link
            to="/games/history"
            className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            History
          </Link>
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 px-4 py-2">
            <span className="text-xs text-gray-500 dark:text-gray-400">Coins</span>
            <div className="text-lg font-bold text-primary-600 dark:text-primary-400">
              {wallet?.coinsBalance ?? '—'}
            </div>
          </div>
        </div>
      </div>

      <nav aria-label="Play modes" className="flex flex-wrap gap-3 text-sm">
        {(
          [
            ['All our games', '/games', undefined],
            ['Solo practice', '/games?mode=WAGER', 'WAGER'],
            ['Free games', '/games?mode=BONUS', 'BONUS'],
          ] as const
        ).map(([label, destination, filter]) => (
          <Link
            key={destination}
            to={destination}
            aria-current={selectedMode === filter ? 'page' : undefined}
            className={
              selectedMode === filter
                ? 'rounded-full bg-emerald-100 px-4 py-2 font-semibold text-emerald-900'
                : 'rounded-full border border-slate-300 px-4 py-2 dark:text-white'
            }
          >
            {label}
          </Link>
        ))}
        <Link
          className="rounded-full border border-slate-300 px-4 py-2 dark:text-white"
          to="/groups"
        >
          Group PVP · play together →
        </Link>
      </nav>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {publicGames.map((game) => {
          const practice = memberGameDestination(game) && practiceRoutes[game.key];
          const destination = memberGameDestination(game);
          const isPlayable = !!destination;
          const isTrivia = game.key === 'trivia';

          const cardContent = (
            <div className={`qube-catalog-card ${isPlayable ? 'is-playable' : 'is-unavailable'}`}>
              <GameArtwork kind={game.key} practiceAvailable={game.practiceAvailable} />
              <div className="qube-catalog-copy">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{game.name}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                  {isPlayable
                    ? isTrivia
                      ? 'Practice questions with instant feedback. No Coins, Game Points or cash prizes.'
                      : game.description
                    : memberGameUnavailableDescription(game)}
                </p>
                {practice ? (
                  <div className="mt-5">
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900">
                      Free practice
                    </span>
                    <p className="mt-3 text-xs text-gray-500">
                      {game.key === 'number_challenge'
                        ? 'Instant number reveals'
                        : game.key === 'thunder_derby_3d'
                          ? 'Three- or four-minute races'
                          : game.key === 'virtual_football_3d'
                            ? 'Five-minute matchweeks'
                            : 'One-minute rounds'}{' '}
                      · no Coins or cash prizes
                    </p>
                    <p className="mt-4 font-semibold text-emerald-700 dark:text-emerald-300">
                      Play practice →
                    </p>
                  </div>
                ) : !isPlayable ? (
                  <div className="mt-3">
                    <span className="inline-block text-xs font-medium px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                      {memberGameLabel(game)}
                    </span>
                  </div>
                ) : isTrivia ? (
                  <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    Practice · no stake · no rewards
                  </div>
                ) : (
                  <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                    Bet: {game.minBet} – {game.maxBet} Coins
                  </div>
                )}
              </div>
            </div>
          );

          if (isPlayable) {
            return (
              <Link key={game.id} to={destination!}>
                {cardContent}
              </Link>
            );
          }

          return <div key={game.id}>{cardContent}</div>;
        })}

        {publicGames.length === 0 && (
          <div className="col-span-full text-center py-16 text-gray-500 dark:text-gray-400">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}
