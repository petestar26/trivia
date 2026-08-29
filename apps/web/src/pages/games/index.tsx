import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import { useEffect } from 'react';

interface GameCatalogItem {
  id: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  minBet: number;
  maxBet: number;
  isActive: boolean;
}

interface WalletData {
  coinsBalance: number;
  gamePointsBalance: number;
}

const GAME_ICONS: Record<string, string> = {
  lucky_spin: '🎡',
  dice: '🎲',
  number_challenge: '🔢',
  trivia: '🧠',
};

const GAME_ROUTES: Record<string, string> = {
  lucky_spin: 'lucky-spin',
  dice: 'dice',
  number_challenge: 'number-challenge',
  trivia: 'trivia',
};

export function GamesPage() {
  const { user } = useAuth();
  const { id: userId } = user;

  const { data: gamesData, isLoading } = useQuery<{ data: GameCatalogItem[] }>({
    queryKey: ['games'],
    queryFn: async () => {
      const res = await api.get<{ data: GameCatalogItem[] }>('/games');
      return res.data;
    },
  });
  const games = gamesData?.data;

  const { data: wallet, refetch: refetchWallet } = useQuery<WalletData>({
    queryKey: ['wallet', userId],
    queryFn: async () => {
      const res = await api.get<WalletData>('/wallet');
      return res.data;
    },
  });

  useEffect(() => {
    // Any time games load, refresh wallet balance
    refetchWallet();
  }, [refetchWallet]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Games</h1>
          <p className="text-gray-600 dark:text-gray-400">
            Play fun mini-games with your Game Points.
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
            <span className="text-xs text-gray-500 dark:text-gray-400">Game Points</span>
            <div className="text-lg font-bold text-primary-600 dark:text-primary-400">
              {wallet?.gamePointsBalance ?? '—'}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(games ?? []).map((game) => (
          <Link
            key={game.id}
            to={`/games/${GAME_ROUTES[game.key] ?? game.key}`}
            className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-5 hover:shadow-md transition-shadow"
          >
            <div className="text-4xl mb-3">{GAME_ICONS[game.key] ?? '🎮'}</div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{game.name}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">
              {game.description}
            </p>
            <div className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Bet: {game.minBet} – {game.maxBet} GP
            </div>
          </Link>
        ))}
        {(games ?? []).length === 0 && (
          <div className="col-span-full text-center py-16 text-gray-500 dark:text-gray-400">
            No games available right now.
          </div>
        )}
      </div>
    </div>
  );
}
