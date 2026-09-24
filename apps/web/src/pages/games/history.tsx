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
  mode: string;
  family: string;
  rulesVersion: number | null;
  resultSchemaVersion: number | null;
  playContext: string;
  settlementDebitCurrency: string | null;
  settlementCreditCurrency: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface HistoryResponse {
  data: GameHistoryItem[];
  meta: { page: number; total: number; totalPages: number };
}

const GAME_ICONS: Record<string, string> = {
  lucky_spin: '🎡',
  spin_win: '🎡',
  dice: '🎲',
  number_challenge: '🔢',
  trivia: '🧠',
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

function currencyLabel(code: string): string {
  const c = code.toLowerCase().replace(/[\s_]/g, '');
  if (c === 'coins' || c === 'coin') return 'Coins';
  if (c === 'gamepoints' || c === 'gamepoint' || c === 'gp') return 'GP';
  return code;
}

// A contest round moves no wallet value: its entry fee was paid once, in Game
// Points, into the contest's escrow. It is never shown as a stake or a debit.
const CONTEST_ROUND_LABELS: Record<string, string> = {
  COMPETITION_ROUND: 'Competition round',
  CHALLENGE_ROUND: 'Challenge round',
};

function RoundSettlement({ session }: { session: GameHistoryItem }) {
  const contestLabel = CONTEST_ROUND_LABELS[session.playContext];
  const debit = session.settlementDebitCurrency;
  const credit = session.settlementCreditCurrency;
  return (
    <div className="text-right">
      {contestLabel ? (
        <div className="text-sm font-medium text-gray-700 dark:text-gray-200">{contestLabel}</div>
      ) : debit && session.betAmount > 0 ? (
        <div className="text-sm text-gray-600 dark:text-gray-300">
          Bet: <span className="font-medium">{session.betAmount} {currencyLabel(debit)}</span>
        </div>
      ) : null}
      {credit && session.rewardAmount > 0 ? (
        <div className="text-sm font-semibold text-green-600 dark:text-green-400">
          +{session.rewardAmount} {currencyLabel(credit)}
        </div>
      ) : !contestLabel && debit && session.betAmount > 0 && !session.isWin ? (
        <div className="text-sm text-red-600 dark:text-red-400">−{session.betAmount} {currencyLabel(debit)}</div>
      ) : contestLabel ? (
        <div className="text-xs text-gray-500 dark:text-gray-400">Entry paid once to the contest</div>
      ) : null}
    </div>
  );
}

export function GameHistoryPage() {
  const [page, setPage] = useState(1);
  const limit = 15;

  const { data, isLoading, isFetching } = useQuery<HistoryResponse>({
    queryKey: ['game-history', page],
    queryFn: async () => {
      const res = await api.get<GameHistoryItem[]>('/games/history', { page, limit });
      return {
        data: res.data ?? [],
        meta: (res.meta as HistoryResponse['meta']) ?? { page, total: 0, totalPages: 0 },
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
              data-testid={`history-row-${s.id}`}
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
                {(s.mode || s.family || s.rulesVersion != null || s.resultSchemaVersion != null) && (
                  <div className="text-xs text-gray-400 dark:text-gray-500">
                    {[s.mode, s.family].filter(Boolean).join(' · ')}
                    {s.rulesVersion != null && `${s.mode || s.family ? ' · ' : ''}Rules v${s.rulesVersion}`}
                    {s.resultSchemaVersion != null && ` · Schema v${s.resultSchemaVersion}`}
                  </div>
                )}
              </div>
              <RoundSettlement session={s} />
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