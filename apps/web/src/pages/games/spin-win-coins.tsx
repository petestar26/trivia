import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { parseSpinBets, SPIN_MARKETS, SPIN_WHEEL } from '@socialplay/shared';
import type { SpinBet } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import type { GameCatalogEntry, GamePlayResult } from '@/lib/api';
import { useDurablePlay } from '@/hooks/use-durable-play';
import { useCasino } from '@/components/casino/CasinoProvider';
import { CasinoShell } from '@/components/casino/CasinoShell';
import { SpinWinWheel } from './spin-win';

interface SpinRound extends GamePlayResult {
  result: {
    number: number;
    colour: string;
    stake: number;
    payout: number;
    net: number;
    lines: Array<SpinBet & { payout: number }>;
  };
}
function errorText(error: unknown) {
  if (!(error instanceof Error)) return 'Unable to confirm this round.';
  try {
    const parsed = JSON.parse(error.message) as { message?: string };
    return parsed.message ?? 'Unable to confirm this round.';
  } catch {
    return 'Connection interrupted. Confirm the pending round before placing another bet.';
  }
}

/** Financial play uses stored server responses only. Practice has a separate route. */
export function SpinWinCoinsPage() {
  const { coinsBalance, refetchBalance } = useCasino();
  const client = useQueryClient();
  const [bets, setBets] = useState<SpinBet[]>([]);
  const [chip, setChip] = useState(10);
  const [round, setRound] = useState<SpinRound | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const {
    data: catalog,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['games'],
    queryFn: async () => unwrapData(await api.get<GameCatalogEntry[]>('/games'), 'Games response'),
  });
  const game = catalog?.find((entry) => entry.key === 'spin_win');
  const available =
    game?.catalogStatus === 'AVAILABLE' &&
    game.isActive &&
    game.mode === 'WAGER' &&
    game.wagerCurrency === 'COINS' &&
    game.rewardCurrency === 'COINS' &&
    !!game.currentRulesVersion;
  const durable = useDurablePlay<SpinRound>(
    'spin_win',
    {
      onSettled: (result, isReplay) => {
        setRound(result);
        setReplayed(isReplay);
        setBets([]);
        const index = SPIN_WHEEL.indexOf(result.result.number as (typeof SPIN_WHEEL)[number]);
        if (index >= 0) {
          const target = (360 - (index * 360) / 37) % 360;
          setRotation((value) => value + 720 + ((target - (value % 360) + 360) % 360));
        }
        refetchBalance();
        void client.invalidateQueries({ queryKey: ['game-history'] });
      },
    },
    { autoResume: false }
  );
  const locked = durable.mutation.isPending || !!durable.pending;
  const total = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const validTotal =
    !!game && total >= game.minBet && total <= game.maxBet && total <= coinsBalance;
  const add = (marketId: string) => {
    if (!available || locked || !game || total + chip > Math.min(game.maxBet, coinsBalance)) return;
    setBets((items) =>
      items.some((b) => b.marketId === marketId)
        ? items.map((b) => (b.marketId === marketId ? { ...b, amount: b.amount + chip } : b))
        : [...items, { marketId, amount: chip }]
    );
  };
  const submit = () => {
    if (!available || locked || !validTotal) return;
    durable.play({ betAmount: total, bets: parseSpinBets(bets) });
  };
  return (
    <CasinoShell
      gameKey="spin_win"
      gameName="Spin Win · Coins"
      rulesVersion={game?.currentRulesVersion}
      loading={isLoading}
    >
      <Link to="/games/spin-win" className="text-sm text-primary-600">
        Switch to practice · no Coins
      </Link>
      {isError && <p role="alert">Cannot load game availability. New wagers are disabled.</p>}
      {!available && !isLoading && (
        <p role="status">
          Coin play is not available.
          {durable.pending && ' You can still confirm a previously submitted round below.'}
        </p>
      )}
      <SpinWinWheel rotation={rotation} />
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Select your bets. All bets share one server-generated number. Total returns include winning
        stakes; zero loses every group bet.
      </p>
      <fieldset disabled={!available || locked} className="space-y-3 disabled:opacity-50">
        <legend className="font-semibold">Coin bets</legend>
        <div className="flex gap-2" role="group" aria-label="Coin chip value">
          {[1, 5, 10, 25, 100].map((amount) => (
            <button
              key={amount}
              type="button"
              aria-pressed={chip === amount}
              onClick={() => setChip(amount)}
              className="rounded-full border px-3 py-2 aria-pressed:bg-amber-200 aria-pressed:text-slate-900"
            >
              {amount}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {SPIN_MARKETS.map((market) => {
            const amount = bets.find((bet) => bet.marketId === market.id)?.amount;
            return (
              <button
                type="button"
                key={market.id}
                onClick={() => add(market.id)}
                aria-label={`Bet on ${market.label}`}
                aria-pressed={!!amount}
                className="rounded-lg border p-2 text-sm aria-pressed:border-amber-500 focus-visible:ring-2 focus-visible:ring-primary-500"
              >
                <span>{market.label}</span>
                <span className="block text-xs">
                  {amount ? `${amount} Coins · ` : ''}
                  {market.grossMultiplier}× total return
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={!bets.length}
          onClick={() => setBets([])}
          className="rounded-lg border px-4 py-2"
        >
          Clear bets
        </button>
      </fieldset>
      <p>
        Total bet: <strong>{total} Coins</strong>
        {game ? ` · Range ${game.minBet}–${game.maxBet}` : ''}
      </p>
      <button
        type="button"
        disabled={!available || locked || !validTotal}
        onClick={submit}
        className="w-full rounded-xl bg-primary-600 p-3 font-semibold text-white disabled:opacity-40"
      >
        Place Coin bets
      </button>
      {durable.pending && (
        <div className="rounded-xl border border-amber-400 p-4">
          <p>A round is awaiting confirmation. Your ticket is locked to prevent a second wager.</p>
          <button
            type="button"
            disabled={durable.mutation.isPending}
            onClick={() => durable.play(durable.pending!.body)}
            className="mt-3 rounded-lg border px-4 py-2"
          >
            {durable.mutation.isPending ? 'Confirming round…' : 'Confirm pending round'}
          </button>
        </div>
      )}
      {durable.storageError && <p role="alert">{durable.storageError}</p>}
      {durable.mutation.isError && <p role="alert">{errorText(durable.mutation.error)}</p>}
      {round && (
        <div role="status" className="rounded-xl border p-4">
          <p className="text-xl font-bold">
            {round.result.number} · {round.result.colour}
          </p>
          <p>
            Return: {round.rewardAmount} Coins · Settled balance: {round.newBalance} Coins
          </p>
          <p className="text-xs">
            Rules v{round.rulesVersion} ·{' '}
            {replayed ? 'Replayed round — no new wager.' : 'Round settled.'}
          </p>
        </div>
      )}
    </CasinoShell>
  );
}
