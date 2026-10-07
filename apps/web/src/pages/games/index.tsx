import { Dice5, CircleDot, Grid3X3, Brain, Gamepad2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { requestStatus } from '@/lib/request-error';
import { useLocation } from 'react-router-dom';

interface GameCatalogItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  mode: string;
  family: string;
  catalogStatus: string;
  wagerCurrency: string | null;
  rewardCurrency: string;
  currentRulesVersion: number | null;
  minBet: number;
  maxBet: number;
  isActive: boolean;
}

interface WalletData {
  coinsBalance: number;
  gamePointsBalance: number;
}

const GAME_ROUTES: Record<string, string> = {
  dice: 'dice',
  number_challenge: 'number-challenge',
  spin_win: 'spin-win/play',
  trivia: 'trivia',
};

interface GamesPageProps {
  mode?: 'WAGER' | 'BONUS';
  title?: string;
  description?: string;
  emptyMessage?: string;
}

export function GamesPage({
  mode,
  title = 'Games',
  description = 'Play games and earn Coins.',
  emptyMessage = 'No games available right now.',
}: GamesPageProps = {}) {
  const { user } = useAuth();
  const location = useLocation();

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

  const practiceRoutes: Record<string,string> = {dice:'/games/dice',spin_win:'/games/spin-win',turbo_keno:'/games/turbo-keno'};
  const publicGames = (games ?? []).filter(
    (g) => g.catalogStatus !== 'RETIRED' && (!mode || g.mode === mode)
  ).sort((a,b)=>Number(!!practiceRoutes[b.key])-Number(!!practiceRoutes[a.key]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-5 rounded-3xl bg-gradient-to-br from-emerald-950 to-slate-900 p-6 text-white sm:p-9">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{description}</p>
        </div>
        <div className="flex items-center gap-3">
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

      {mode === 'WAGER' && <nav aria-label="Play modes" className="flex flex-wrap gap-3 text-sm"><span className="rounded-full bg-emerald-100 px-4 py-2 font-semibold text-emerald-900">System practice · every minute</span><Link className="rounded-full border border-slate-300 px-4 py-2 dark:text-white" to="/groups">Group PVP · play together →</Link><Link className="rounded-full border border-slate-300 px-4 py-2 dark:text-white" to="/games">Free games →</Link></nav>}
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {publicGames.map((game) => {
          const practice = practiceRoutes[game.key];
          const Icon = game.key==='dice'?Dice5:game.key==='spin_win'?CircleDot:game.key==='turbo_keno'?Grid3X3:game.key==='trivia'?Brain:Gamepad2;
          const isComingSoon = game.catalogStatus === 'COMING_SOON';
          const isPlayable = !!practice || (game.isActive && game.catalogStatus === 'AVAILABLE' && GAME_ROUTES[game.key]);
          const isTrivia = game.key === 'trivia';

          const cardContent = (
            <div
              className={`bg-white dark:bg-gray-800 h-full rounded-2xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 transition-shadow ${
                isPlayable ? 'hover:shadow-md' : 'opacity-70'
              }`}
            >
              <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><Icon size={30} aria-hidden="true"/></div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{game.name}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                {game.description}
              </p>
              {practice ? (<div className="mt-5"><span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-900">Free practice</span><p className="mt-3 text-xs text-gray-500">One-minute rounds · no Coins or cash prizes</p><p className="mt-4 font-semibold text-emerald-700 dark:text-emerald-300">Play practice →</p></div>) : isComingSoon ? (
                <div className="mt-3">
                  <span className="inline-block text-xs font-medium px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    Coming soon
                  </span>

                </div>
              ) : isTrivia ? (
                <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                  Free · no stake · restricted bonus Coins
                </div>
              ) : (
                <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                  Bet: {game.minBet} – {game.maxBet} Coins
                </div>
              )}
            </div>
          );

          if (isPlayable) {
            return (
              <Link key={game.id} to={practice ?? `/games/${GAME_ROUTES[game.key]}`}>
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
