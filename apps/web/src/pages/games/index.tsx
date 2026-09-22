import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, unwrapData } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

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

const GAME_ICONS: Record<string, string> = {
  dice: '🎲',
  number_challenge: '🔢',
  trivia: '🧠',
  spin_win: '🎡',
  thunder_derby_3d: '⚡',
  neon_hounds_3d: '🐕',
  turbo_circuit_3d: '🏎️',
  starfall_nebula: '⭐',
  jungle_dash_3d: '🌴',
  turbo_keno: '🔢',
  crystal_trail: '💎',
  heat_vault: '🔥',
  strait_rush: '🏁',
};

const GAME_ROUTES: Record<string, string> = {
  dice: 'dice',
  number_challenge: 'number-challenge',
  trivia: 'trivia',
};

export function GamesPage() {
  const { user } = useAuth();

  const { data: games, isLoading } = useQuery<GameCatalogItem[]>({
    queryKey: ['games'],
    queryFn: async () => {
      return unwrapData<GameCatalogItem[]>(await api.get<GameCatalogItem[]>('/games'), 'Games response');
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
      <div className="flex items-center justify-center py-20" role="status" aria-label="Loading games">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent" />
      </div>
    );
  }

  const publicGames = (games ?? []).filter(g => g.catalogStatus !== 'RETIRED');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Games</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Play games and earn Coins.
          </p>
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {publicGames.map((game) => {
          const isComingSoon = game.catalogStatus === 'COMING_SOON';
          const isPlayable = game.catalogStatus === 'AVAILABLE' && GAME_ROUTES[game.key];
          const isTrivia = game.key === 'trivia';

          const cardContent = (
            <div
              className={`bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 transition-shadow ${
                isPlayable ? 'hover:shadow-md' : 'opacity-70'
              }`}
            >
              <div className="text-4xl mb-3">{GAME_ICONS[game.key] ?? '🎮'}</div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{game.name}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
                {game.description}
              </p>
              {isComingSoon ? (
                <div className="mt-3">
                  <span className="inline-block text-xs font-medium px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                    Coming soon
                  </span>
                </div>
              ) : isTrivia ? (
                <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
                  Free to play · Earn Coins
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
              <Link key={game.id} to={`/games/${GAME_ROUTES[game.key]}`}>
                {cardContent}
              </Link>
            );
          }

          return <div key={game.id}>{cardContent}</div>;
        })}

        {publicGames.length === 0 && (
          <div className="col-span-full text-center py-16 text-gray-500 dark:text-gray-400">
            No games available right now.
          </div>
        )}
      </div>
    </div>
  );
}
