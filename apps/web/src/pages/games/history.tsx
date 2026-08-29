import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface GameHistoryItem {
  id: string;
  game: { key: string; name: string };
  betAmount: number;
  rewardAmount: number;
  isWin: boolean;
  result: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

interface HistoryResponse {
  data: GameHistoryItem[];
  meta: { page: number; total: number; totalPages: number };
}

const GAME_ICONS: Record<string, string> = {
  lucky_spin: '🎡',
  dice: '🎲',
  number_challenge: '🔢',
  trivia: '🧠',
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function GameHistoryPage() {
  const [page, setPage] = useState(1);
  const limit = 15;

  const { data, isLoading, isFetching } = useQuery<HistoryResponse>({
    queryKey: ['game-history', page],
    queryFn: async () => {
      const res = await api.get<{ data: GameHistoryItem[]; meta: HistoryResponse['meta'] }>(
        '/games/history',
        { page, limit }
      );
      return {
        data: res.data ?? [],
        meta: res.meta ?? { page, total: 0, totalPages: 0 },
      };
    },
  });

  const sessions = data?.data ?? [];
  const totalPages = data?.meta.totalPages ?? 0;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Game History</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Your recent games and results.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-500 border-t-transparent"></div>
        </div>
      ) : sessions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-10 text-center text-gray-500 dark:text-gray-400">
          No games yet. Head to the Games hub to play!
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
            >
              <div className="text-3xl">{GAME_ICONS[s.game.key] ?? '🎮'}</div>
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-gray-900 dark:text-white">
                  {s.game.name}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {formatDate(s.completedAt ?? s.createdAt)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  Bet: <span className="font-medium">{s.betAmount} GP</span>
                </div>
                {s.isWin ? (
                  <div className="text-sm font-semibold text-green-600 dark:text-green-400">
                    +{s.rewardAmount} GP
                  </div>
                ) : (
                  <div className="text-sm text-red-600 dark:text-red-400">−{s.betAmount} GP</div>
                )}
              </div>
            </div>
          ))}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-4">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || isFetching}
                className="px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {page} of {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages || isFetching}
                className="px-4 py-2 text-sm bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
