import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface SpinResult {
  name: string;
  multiplier: number;
  index: number;
}

interface SpinPlayResult {
  rewardAmount: number;
  isWin: boolean;
  result: SpinResult;
  newBalance: number;
}

const SEGMENTS = ['LOSE', 'SMALL_WIN', 'MEDIUM_WIN', 'LARGE_WIN', 'JACKPOT'];

export function LuckySpinPage() {
  const [bet, setBet] = useState(50);
  const [spinning, setSpinning] = useState(false);
  const [lastResult, setLastResult] = useState<SpinResult | null>(null);
  const [serverBalance, setServerBalance] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data: games } = useQuery<{ data: { minBet: number; maxBet: number }[] }>({
    queryKey: ['games'],
    queryFn: async () => api.get('/games'),
  });
  const game = games?.data?.find((g) => g.key === 'lucky_spin');

  const playMutation = useMutation({
    mutationFn: async (betAmount: number) => {
      const res = await api.post<SpinPlayResult>('/games/lucky_spin/play', { betAmount });
      return res.data;
    },
    onSuccess: (data) => {
      setLastResult(data.result);
      setServerBalance(data.newBalance);
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
    },
    onError: () => setSpinning(false),
  });

  const minBet = game?.minBet ?? 10;
  const maxBet = game?.maxBet ?? 500;

  const spin = () => {
    setSpinning(true);
    setLastResult(null);
    playMutation.mutate(bet, {
      onSettled: () => setSpinning(false),
    });
  };

  const multiplierColor: Record<string, string> = {
    LOSE: 'text-red-600 dark:text-red-400',
    SMALL_WIN: 'text-green-600 dark:text-green-400',
    MEDIUM_WIN: 'text-green-600 dark:text-green-400',
    LARGE_WIN: 'text-emerald-600 dark:text-emerald-400',
    JACKPOT: 'text-amber-600 dark:text-amber-400',
  };

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Lucky Spin</h1>
        <p className="text-gray-600 dark:text-gray-400">
          Spin the wheel and win up to 10x your bet!
        </p>
      </div>

      {/* Wheel */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <div className="relative w-56 h-56 mx-auto">
          <div
            className={`w-full h-full rounded-full bg-gradient-to-br from-primary-500 via-purple-500 to-pink-500 flex items-center justify-center text-6xl ${
              spinning ? 'animate-spin' : ''
            }`}
            style={{ animationDuration: '1.5s' }}
          >
            🎡
          </div>
        </div>

        {/* Segments legend */}
        <div className="mt-4 grid grid-cols-3 gap-2">
          {SEGMENTS.map((seg) => (
            <div
              key={seg}
              className={`text-center text-xs font-medium p-1.5 rounded ${
                lastResult?.name === seg
                  ? 'bg-primary-100 dark:bg-primary-900/40 ring-2 ring-primary-500'
                  : 'bg-gray-100 dark:bg-gray-700'
              }`}
            >
              {seg.replace('_', ' ').toLowerCase()}
            </div>
          ))}
        </div>
      </div>

      {/* Bet controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6">
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Bet amount</label>
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
            onClick={spin}
            disabled={spinning || playMutation.isPending}
            className="px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50"
          >
            {spinning ? 'Spinning…' : 'Spin'}
          </button>
        </div>
        <div className="mt-2 text-xs text-gray-500">Min {minBet} · Max {maxBet} GP</div>

        {playMutation.isError && (
          <div className="mt-4 text-sm text-red-600 dark:text-red-400">
            {(playMutation.error as Error)?.message || 'Something went wrong'}
          </div>
        )}
      </div>

      {/* Result */}
      {lastResult && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 text-center">
          <div className={`text-lg font-bold ${multiplierColor[lastResult.name] ?? ''}`}>
            {lastResult.name === 'LOSE'
              ? 'No luck this time'
              : `${lastResult.name.replace('_', ' ').toLowerCase()} — ${lastResult.multiplier}x`}
          </div>
          {playMutation.data?.rewardAmount ? (
            <div className="mt-1 text-green-600 dark:text-green-400 font-semibold">
              +{playMutation.data.rewardAmount} GP
            </div>
          ) : null}
          {serverBalance !== null && (
            <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Balance: <span className="font-semibold text-primary-600 dark:text-primary-400">{serverBalance} GP</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
