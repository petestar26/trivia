import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface DiceResult {
  die1: number;
  die2: number;
  sum: number;
  threshold: number;
}

interface DicePlayResult {
  sessionId: string;
  gameKey: string;
  betAmount: number;
  rewardAmount: number;
  isWin: boolean;
  result: DiceResult;
  completedAt: string;
}

function DiceFace({ value }: { value: number }) {
  const pips: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  return (
    <div className="w-20 h-20 bg-white dark:bg-gray-700 rounded-lg border-2 border-gray-300 dark:border-gray-600 shadow grid grid-cols-3 grid-rows-3 p-2">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="flex items-center justify-center">
          {pips[value]?.includes(i) ? (
            <div className="w-3 h-3 rounded-full bg-gray-900 dark:bg-white"></div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function DiceGamePage() {
  const [bet, setBet] = useState(50);
  const [lastResult, setLastResult] = useState<DiceResult | null>(null);
  const queryClient = useQueryClient();

  const { data: games } = useQuery<{ data: { minBet: number; maxBet: number }[] }>({
    queryKey: ['games'],
    queryFn: async () => api.get('/games'),
  });
  const game = games?.data?.find((g) => g.key === 'dice');

  const playMutation = useMutation({
    mutationFn: async (betAmount: number) => {
      const res = await api.post<DicePlayResult>('/games/dice/play', { betAmount });
      return res.data;
    },
    onSuccess: (data) => {
      setLastResult(data.result);
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
  });

  const minBet = game?.minBet ?? 5;
  const maxBet = game?.maxBet ?? 1000;

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Dice</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Roll the dice. Sum of {7} or higher doubles your bet!
        </p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Bet amount (Game Points)
        </label>
        <div className="flex gap-3 mt-2">
          <input
            type="number"
            min={minBet}
            max={maxBet}
            value={bet}
            onChange={(e) => setBet(parseInt(e.target.value, 10) || 0)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-600 p-3"
          />
          <button
            onClick={() => playMutation.mutate(bet)}
            disabled={playMutation.isPending}
            className="px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50"
          >
            {playMutation.isPending ? 'Rolling…' : 'Roll'}
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-500">
          Min {minBet} · Max {maxBet} GP
        </div>

        {playMutation.isError && (
          <div className="mt-4 text-sm text-red-600 dark:text-red-400">
            {(playMutation.error as Error)?.message || 'Something went wrong'}
          </div>
        )}
      </div>

      {(lastResult || playMutation.isPending) && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 text-center">
          {playMutation.isPending ? (
            <div className="text-4xl animate-spin inline-block">🎲</div>
          ) : lastResult ? (
            <>
              <div className="flex justify-center gap-4 mb-4">
                <DiceFace value={lastResult.die1} />
                <DiceFace value={lastResult.die2} />
              </div>
              <div className="text-3xl font-bold text-gray-900 dark:text-white">Sum: {lastResult.sum}</div>
              <div
                className={`mt-2 text-lg font-semibold ${
                  lastResult.sum >= lastResult.threshold
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {lastResult.sum >= lastResult.threshold ? 'You won! 🎉' : 'Better luck next time'}
              </div>
              {playMutation.data && playMutation.data.rewardAmount > 0 && (
                <div className="mt-1 text-green-600 dark:text-green-400">
                  +{playMutation.data.rewardAmount} GP
                </div>
              )}
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
