import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface NumResult {
  guess: number;
  target: number;
  away: number;
  correct: boolean;
}

interface NumPlayResult {
  rewardAmount: number;
  isWin: boolean;
  result: NumResult;
  newBalance: number;
}

export function NumberChallengePage() {
  const [bet, setBet] = useState(50);
  const [guess, setGuess] = useState(50);
  const [lastResult, setLastResult] = useState<NumResult | null>(null);
  const [serverBalance, setServerBalance] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const { data: games } = useQuery<{ data: { minBet: number; maxBet: number }[] }>({
    queryKey: ['games'],
    queryFn: async () => api.get('/games'),
  });
  const game = games?.data?.find((g) => g.key === 'number_challenge');

  const playMutation = useMutation({
    mutationFn: async (payload: { betAmount: number; guess: number }) => {
      const res = await api.post<NumPlayResult>('/games/number_challenge/play', payload);
      return res.data;
    },
    onSuccess: (data) => {
      setLastResult(data.result);
      setServerBalance(data.newBalance);
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      queryClient.invalidateQueries({ queryKey: ['game-history'] });
    },
  });

  const minBet = game?.minBet ?? 10;
  const maxBet = game?.maxBet ?? 200;

  const submit = () => {
    playMutation.mutate({ betAmount: bet, guess });
  };

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Number Challenge</h1>
        <p className="text-gray-600 dark:text-gray-400">Guess a number between 1 and 100.</p>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Bet amount</label>
          <input
            type="number"
            min={minBet}
            max={maxBet}
            value={bet}
            onChange={(e) => setBet(parseInt(e.target.value, 10) || 0)}
            className="w-full mt-1 rounded-lg border border-gray-300 dark:border-gray-600 p-3"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Your guess (1–100)</label>
          <input
            type="number"
            min={1}
            max={100}
            value={guess}
            onChange={(e) => setGuess(parseInt(e.target.value, 10) || 1)}
            className="w-full mt-1 rounded-lg border border-gray-300 dark:border-gray-600 p-3"
          />
        </div>

        <button
          onClick={submit}
          disabled={playMutation.isPending}
          className="w-full px-6 py-3 bg-primary-600 text-white rounded-lg font-semibold hover:bg-primary-700 disabled:opacity-50"
        >
          {playMutation.isPending ? 'Checking…' : 'Submit Guess'}
        </button>
        <div className="text-xs text-gray-500">Min {minBet} · Max {maxBet} GP</div>

        {playMutation.isError && (
          <div className="text-sm text-red-600 dark:text-red-400">
            {(playMutation.error as Error)?.message || 'Something went wrong'}
          </div>
        )}
      </div>

      {lastResult && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 text-center">
          {lastResult.correct ? (
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">🎯 Exact hit!</div>
          ) : lastResult.away <= 5 ? (
            <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
              So close! Off by {lastResult.away}
            </div>
          ) : (
            <div className="text-xl font-bold text-gray-700 dark:text-gray-300">
              Off by {lastResult.away}
            </div>
          )}
          <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            The number was {lastResult.target}
          </div>
          {playMutation.data?.rewardAmount ? (
            <div className="mt-2 text-green-600 dark:text-green-400 font-semibold">
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
