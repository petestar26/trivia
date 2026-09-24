import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrapData } from '@/lib/api';
import type { GameCatalogEntry, GamePlayResult } from '@/lib/api';
import { useDurablePlay } from '@/hooks/use-durable-play';
import { useCasino } from '@/components/casino/CasinoProvider';
import { CasinoShell } from '@/components/casino/CasinoShell';
import { CasinoRendererSlot } from '@/components/casino/CasinoRendererSlot';

type NumResult = {
  guess: number;
  target: number;
  away: number;
  correct: boolean;
};

interface NumPlayResult extends GamePlayResult {
  result: NumResult;
}

function parsePlayError(error: unknown): string {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as { message?: string };
      if (parsed?.message) return parsed.message;
    } catch {
      // not JSON
    }
    return error.message;
  }
  return 'Something went wrong';
}

export function NumberChallengePage() {
  const { phase, setPhase, refetchBalance } = useCasino();
  const [bet, setBet] = useState(50);
  const [guess, setGuess] = useState(50);
  const [lastResult, setLastResult] = useState<NumResult | null>(null);
  const [serverBalance, setServerBalance] = useState<number | null>(null);
  const [isReplay, setIsReplay] = useState(false);
  const queryClient = useQueryClient();

  const { data: games } = useQuery<GameCatalogEntry[]>({
    queryKey: ['games'],
    queryFn: async () => unwrapData(await api.get<GameCatalogEntry[]>('/games'), 'Games response'),
  });
  const game = games?.find((g) => g.key === 'number_challenge');

  // One idempotency key per round, stored with the exact request before the
  // first send; see useDurablePlay and dice.tsx.
  const { play, pendingDiffersFrom, mutation: playMutation } = useDurablePlay<NumPlayResult>('number_challenge', {
    onStart: () => setPhase('RUNNING'),
    onSettled: (round, replayed) => {
      setLastResult(round.result);
      setServerBalance(round.newBalance);
      setIsReplay(replayed);
      setPhase(round.isWin ? 'RESULT' : 'SETTLED');
      refetchBalance();
      queryClient.invalidateQueries({ queryKey: ['game-history'] });
    },
    onFailed: () => setPhase('BETTING_OPEN'),
  });

  const minBet = game?.minBet ?? 10;
  const maxBet = game?.maxBet ?? 200;

  const submit = () => play({ betAmount: bet, guess });
  const confirmingEarlierRound = pendingDiffersFrom({ betAmount: bet, guess });

  return (
    <CasinoShell
      gameKey="number_challenge"
      gameName="Number Challenge"
      rulesVersion={game?.currentRulesVersion}
      phase={phase}
    >
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 space-y-4">
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Bet amount (Coins)</label>
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
        <div className="text-xs text-gray-500">Min {minBet} · Max {maxBet} Coins</div>

        {confirmingEarlierRound && (
          <div className="text-sm text-amber-700 dark:text-amber-400">
            Your previous guess has not been confirmed yet. Submitting confirms that guess first; your new bet and guess apply to the next round.
          </div>
        )}

        {playMutation.isError && (
          <div className="text-sm text-red-600 dark:text-red-400">
            {parsePlayError(playMutation.error)}
          </div>
        )}
      </div>

      {lastResult && (
        <CasinoRendererSlot gameKey="number_challenge" gameName="Number Challenge" className="text-center">
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
          {playMutation.data?.data.rewardAmount ? (
            <div className="mt-2 text-green-600 dark:text-green-400 font-semibold">
              +{playMutation.data.data.rewardAmount} Coins
            </div>
          ) : null}
          {serverBalance !== null && (
            <div className="mt-2 text-sm text-gray-500 dark:text-gray-400">
              Balance: <span className="font-semibold text-primary-600 dark:text-primary-400">{serverBalance} Coins</span>
            </div>
          )}
          {isReplay && (
            <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              Replayed round — no new wager.
            </div>
          )}
        </CasinoRendererSlot>
      )}
    </CasinoShell>
  );
}