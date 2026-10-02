import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  parseSpin90Bets as parseSpinBets,
  SPIN90_MARKETS as SPIN_MARKETS,
  SPIN90_RULES_ID,
  SPIN_WHEEL,
} from '@socialplay/shared';
import type { SpinBet } from '@socialplay/shared';
import { api, unwrapData } from '@/lib/api';
import type { GameCatalogEntry, GamePlayResult } from '@/lib/api';
import { useDurablePlay } from '@/hooks/use-durable-play';
import { useCasino } from '@/components/casino/CasinoProvider';
import { SpinStage } from '@/components/spin/spin-stage';

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
  const { coinsBalance, refetchBalance, walletError, walletLoading } = useCasino();
  const client = useQueryClient();
  const [bets, setBets] = useState<SpinBet[]>([]);
  const [chip, setChip] = useState(40);
  const [round, setRound] = useState<SpinRound | null>(null);
  const [replayed, setReplayed] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [animating, setAnimating] = useState(false);
  const [history, setHistory] = useState<number[]>([]);
  const [message, setMessage] = useState('Choose a chip, then select your markets.');
  const [undo, setUndo] = useState<SpinBet[][]>([]);
  const [previous, setPrevious] = useState<SpinBet[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
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
    !!game.currentRulesVersion &&
    game.currentRulesId === SPIN90_RULES_ID;
  const durable = useDurablePlay<SpinRound>(
    'spin_win',
    {
      onSettled: (result, isReplay) => {
        setRound(result);
        setReplayed(isReplay);
        setBets([]);
        setUndo([]);
        if (!isReplay) {
          setHistory((items) => [result.result.number, ...items].slice(0, 12));
          setPrevious(result.result.lines.map(({ marketId, amount }) => ({ marketId, amount })));
          setAnimating(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setAnimating(false), 1850);
        }
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
  const locked = durable.mutation.isPending || !!durable.pending || animating;
  const total = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const validTotal =
    !!game &&
    !walletError &&
    !walletLoading &&
    total >= game.minBet &&
    total <= game.maxBet &&
    total <= coinsBalance;
  const add = (marketId: string) => {
    if (!available || locked || !game || walletError || walletLoading) return;
    if (total + chip > Math.min(game.maxBet, coinsBalance)) {
      setMessage('This chip exceeds your balance or the round limit.');
      return;
    }
    setUndo((items) => [...items.slice(-99), bets]);
    setMessage('Selection added. Review your ticket before submitting.');
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
  const resultMessage = round
    ? `Return: ${round.rewardAmount} Coins · Settled balance: ${round.newBalance} Coins · ${replayed ? 'Replayed round — no new wager.' : 'Round settled.'}`
    : message;
  return (
    <SpinStage
      mode="coins"
      rotation={rotation}
      number={round?.result.number ?? null}
      spinning={animating}
      outcomes={history}
      status={
        durable.pending
          ? 'A round is awaiting confirmation. Your ticket is locked to prevent a second wager.'
          : animating
            ? 'Round confirmed · revealing result…'
            : resultMessage
      }
      balance={
        walletLoading
          ? 'Loading…'
          : walletError
            ? 'Unavailable'
            : `${coinsBalance.toLocaleString()} Coins`
      }
    >
      <div className="space-y-4">
        {isLoading && <p role="status">Loading game availability…</p>}
        {isError && <p role="alert">Cannot load game availability. New wagers are disabled.</p>}
        {walletError && <p role="alert">Cannot load your balance. New wagers are disabled.</p>}
        {!available && !isLoading && !isError && (
          <p>
            Coin play is not available.
            {durable.pending && ' You can still confirm a previously submitted round below.'}
          </p>
        )}
        <fieldset
          disabled={!available || locked || walletLoading || walletError}
          className="space-y-3 disabled:opacity-50"
        >
          <legend className="font-semibold">Coin bets</legend>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Coin chip value">
            {[40, 80, 120, 200, 400].map((amount) => (
              <button
                key={amount}
                type="button"
                aria-pressed={chip === amount}
                onClick={() => setChip(amount)}
                className="h-11 w-11 rounded-full border-2 border-dashed border-emerald-100/30 font-bold aria-pressed:bg-amber-200 aria-pressed:text-slate-900"
              >
                {amount}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {SPIN_MARKETS.map((market) => {
              const amount = bets.find((b) => b.marketId === market.id)?.amount;
              return (
                <button
                  type="button"
                  key={market.id}
                  onClick={() => add(market.id)}
                  aria-label={`Bet on ${market.label}`}
                  aria-pressed={!!amount}
                  className="min-h-12 rounded-lg border border-white/15 bg-black/20 p-2 text-sm aria-pressed:border-amber-300 aria-pressed:bg-amber-200/10 focus-visible:ring-2 focus-visible:ring-amber-200"
                >
                  <span>{market.label}</span>
                  <span className="block text-[10px] text-emerald-100/60">
                    {amount ? `${amount} Coins · ` : ''}
                    {market.grossMultiplier}×
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <button
              disabled={!undo.length}
              onClick={() => {
                setBets(undo[undo.length - 1]);
                setUndo((items) => items.slice(0, -1));
              }}
              className="rounded-lg border border-white/20 px-4 py-2 disabled:opacity-30"
            >
              Undo
            </button>
            <button
              type="button"
              disabled={!bets.length}
              onClick={() => {
                setUndo((items) => [...items, bets]);
                setBets([]);
              }}
              className="rounded-lg border border-white/20 px-4 py-2"
            >
              Clear bets
            </button>
            <button
              disabled={
                !previous.length ||
                previous.reduce((sum, b) => sum + b.amount, 0) >
                  Math.min(game?.maxBet ?? 0, coinsBalance)
              }
              onClick={() => {
                setUndo((items) => [...items, bets]);
                setBets(previous.map((b) => ({ ...b })));
              }}
              className="rounded-lg border border-white/20 px-4 py-2 disabled:opacity-30"
            >
              Rebet
            </button>
          </div>
        </fieldset>
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d6b475]/30 bg-[#07281f]/95 px-4 py-3 shadow-xl">
          <p>
            Total bet: <strong>{total} Coins</strong>
            {game
              ? ` · Range ${Math.ceil(game.minBet / 40) * 40}–${Math.floor(game.maxBet / 40) * 40}`
              : ''}
          </p>
          <button
            type="button"
            disabled={!available || locked || !validTotal}
            onClick={submit}
            className="rounded-xl bg-amber-200 px-6 py-3 font-bold text-slate-950 disabled:opacity-40"
          >
            Place Coin bets
          </button>
        </div>
        {durable.pending && (
          <button
            type="button"
            disabled={durable.mutation.isPending}
            onClick={() => durable.play(durable.pending!.body)}
            className="rounded-lg border border-amber-300 px-4 py-2"
          >
            {durable.mutation.isPending ? 'Confirming round…' : 'Confirm pending round'}
          </button>
        )}
        {durable.storageError && <p role="alert">{durable.storageError}</p>}
        {durable.mutation.isError && <p role="alert">{errorText(durable.mutation.error)}</p>}
        {round && <p className="text-xs text-emerald-100/60">Rules v{round.rulesVersion}</p>}
        <details className="rounded-xl border border-white/10 p-4 text-sm">
          <summary className="cursor-pointer font-semibold text-amber-100">Rules & payouts</summary>
          <div className="mt-3 space-y-2 text-emerald-100/70">
            <p>
              All bets share one server-generated number. Returns include winning stakes; zero loses
              every group bet. Selections use multiples of 40 Coins.
            </p>
            <p>
              90% theoretical player return; 10% expected house edge before costs. Individual
              results vary.
            </p>
            <Link to="/games/history" className="text-amber-200 underline">
              Your game history
            </Link>
          </div>
        </details>
      </div>
    </SpinStage>
  );
}
