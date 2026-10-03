import { SpinStakeInput, parseSpinStake } from '@/components/spin/spin-stake-input';
import { useEffect, useRef, useState } from 'react';
import { SpinStage } from '@/components/spin/spin-stage';
import {
  SPIN90_MARKETS as SPIN_MARKETS,
  SPIN_WHEEL,
  settleSpin90Bets as settleSpinBets,
  spinColour,
} from '@socialplay/shared';
import type { SpinBet, SpinMarket } from '@socialplay/shared';

const COLOURS = { red: '#b83248', black: '#202d42', green: '#087f6f' };
const CHIPS = [40, 80, 120, 200, 400];
const INITIAL_BALANCE = 1000;
const MAX_ROUND = 480;
const SLICE = 360 / 37;
// Rejection sampling avoids modulo bias. This is practice-only randomness;
// any future Coin game must obtain its result from the server.
export function practiceNumber(): number {
  const bytes = new Uint32Array(1);
  const bound = Math.floor(2 ** 32 / 37) * 37;
  do {
    crypto.getRandomValues(bytes);
  } while (bytes[0] >= bound);
  return bytes[0] % 37;
}
export { SpinWinWheel } from '@/components/spin/spin-wheel';

export function SpinWinPage() {
  const [stakeText, setStakeText] = useState('40');
  const chip = parseSpinStake(stakeText, MAX_ROUND);
  const [bets, setBets] = useState<SpinBet[]>([]);
  const [undo, setUndo] = useState<SpinBet[][]>([]);
  const [previous, setPrevious] = useState<SpinBet[]>([]);
  const [balance, setBalance] = useState(INITIAL_BALANCE);
  const [rotation, setRotation] = useState(0);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<number[]>([]);
  const [message, setMessage] = useState('Enter a bet amount or choose a chip, then select numbers or markets.');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const locked = useRef(false);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  const total = bets.reduce((sum, bet) => sum + bet.amount, 0);
  const canSpin = !running && total > 0 && total <= balance;
  const replaceBets = (next: SpinBet[]) => {
    setUndo((items) => [...items.slice(-99), bets]);
    setBets(next);
  };
  const add = (market: SpinMarket) => {
    if (locked.current || !chip) return;
    if (total + chip > Math.min(balance, MAX_ROUND)) {
      setMessage('This chip exceeds your practice balance or the 480-credit round limit.');
      return;
    }
    const existing = bets.find((bet) => bet.marketId === market.id);
    replaceBets(
      existing
        ? bets.map((bet) =>
            bet.marketId === market.id ? { ...bet, amount: bet.amount + chip } : bet
          )
        : [...bets, { marketId: market.id, amount: chip }]
    );
    setMessage(`Added ${chip} practice credits to ${market.label}.`);
  };
  const spin = () => {
    if (locked.current || !canSpin) return;
    let result: ReturnType<typeof settleSpinBets>;
    try {
      result = settleSpinBets(bets, practiceNumber());
    } catch {
      setMessage('Practice spin is unavailable. Please try again.');
      return;
    }
    locked.current = true;
    setRunning(true);
    setPrevious(bets);
    setBalance((value) => value - total);
    const target =
      (360 - SPIN_WHEEL.indexOf(result.number as (typeof SPIN_WHEEL)[number]) * SLICE) % 360;
    setRotation((value) => value + 360 * 4 + ((target - (value % 360) + 360) % 360));
    setMessage('Bets closed · spinning…');
    timer.current = setTimeout(() => {
      setBalance((value) => value + result.payout);
      setHistory((items) => [result.number, ...items].slice(0, 12));
      setBets([]);
      setUndo([]);
      setRunning(false);
      locked.current = false;
      setMessage(
        `${result.number} ${result.colour} · Return ${result.payout} · Net ${result.net >= 0 ? '+' : ''}${result.net} practice credits.`
      );
    }, 1850);
  };
  const button = (market: SpinMarket, number = false) => {
    const amount = bets.find((bet) => bet.marketId === market.id)?.amount;
    return (
      <button
        key={market.id}
        type="button"
        disabled={running || !chip}
        onClick={() => add(market)}
        aria-label={`Bet on ${market.label}${number ? ` ${spinColour(market.numbers[0])}` : ''}`}
        aria-pressed={!!amount}
        className={`relative min-h-12 rounded-lg border px-2 py-2 text-sm font-semibold transition hover:brightness-125 focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-50 ${amount ? 'border-amber-200 ring-1 ring-amber-200' : 'border-white/15'}`}
        style={{
          backgroundColor: number
            ? COLOURS[spinColour(market.numbers[0])]
            : market.id === 'red'
              ? '#8e273b'
              : '#152d26',
        }}
      >
        {market.label}
        {amount ? (
          <span className="ml-1 inline-flex rounded-full bg-amber-200 px-1.5 text-xs font-bold text-slate-950">
            {amount}
          </span>
        ) : null}
      </button>
    );
  };
  return (
    <SpinStage
      mode="solo"
      rotation={rotation}
      number={history[0] ?? null}
      spinning={running}
      outcomes={history}
      status={message}
      balance={
        <>
          {balance.toLocaleString()} <span className="text-xs text-emerald-100/60">credits</span>
        </>
      }
    >
      <div className="space-y-4">
        <SpinStakeInput value={stakeText} onChange={setStakeText} maximum={MAX_ROUND} disabled={running} />
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chip value">
          <span className="mr-2 text-xs uppercase tracking-widest text-emerald-100/60">
            Choose a chip
          </span>
          {CHIPS.map((value) => (
            <button
              key={value}
              disabled={running}
              aria-pressed={chip === value}
              onClick={() => setStakeText(String(value))}
              className={`h-11 w-11 rounded-full border-2 border-dashed font-bold focus-visible:ring-2 focus-visible:ring-white ${chip === value ? 'border-amber-100 bg-amber-200 text-slate-950' : 'border-emerald-100/30 bg-black/20'}`}
            >
              {value}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Exact number bets"
          className="grid grid-cols-6 gap-1.5 sm:grid-cols-12"
        >
          <div className="col-span-full grid">{button(SPIN_MARKETS[0], true)}</div>
          {SPIN_MARKETS.slice(1, 37).map((m) => button(m, true))}
        </div>
        <div role="group" aria-label="Dozen bets" className="grid grid-cols-3 gap-2">
          {SPIN_MARKETS.filter((m) => m.id.startsWith('dozen')).map((m) => button(m))}
        </div>
        <div
          role="group"
          aria-label="Outside bets"
          className="grid grid-cols-3 gap-2 sm:grid-cols-6"
        >
          {SPIN_MARKETS.slice(-6).map((m) => button(m))}
        </div>
        <div
          role="group"
          aria-label="Sector bets"
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
        >
          {SPIN_MARKETS.filter((m) => m.id.startsWith('sector')).map((m) => button(m))}
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <button
            disabled={running || !undo.length}
            onClick={() => {
              setBets(undo[undo.length - 1]);
              setUndo((items) => items.slice(0, -1));
            }}
            className="rounded-lg border border-white/20 px-4 py-2 disabled:opacity-30"
          >
            Undo
          </button>
          <button
            disabled={running || !bets.length}
            onClick={() => replaceBets([])}
            className="rounded-lg border border-white/20 px-4 py-2 disabled:opacity-30"
          >
            Clear
          </button>
          <button
            disabled={
              running ||
              !previous.length ||
              previous.reduce((sum, b) => sum + b.amount, 0) > balance
            }
            onClick={() => replaceBets(previous.map((b) => ({ ...b })))}
            className="rounded-lg border border-white/20 px-4 py-2 disabled:opacity-30"
          >
            Rebet
          </button>
        </div>
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#d6b475]/30 bg-[#07281f]/95 px-4 py-3 shadow-xl">
          <div>
            <span className="text-xs uppercase tracking-wide text-emerald-100/60">Total bet</span>
            <p className="text-xl font-bold tabular-nums" data-testid="spin-total">
              {total} <span className="text-xs font-normal">practice credits</span>
            </p>
          </div>
          <button
            disabled={!canSpin}
            onClick={spin}
            className="rounded-xl bg-[#f0cf87] px-8 py-3 font-bold text-[#183629] hover:bg-amber-100 focus-visible:ring-4 focus-visible:ring-amber-400/40 disabled:opacity-40"
          >
            {running ? 'Spinning…' : 'Spin'}
          </button>
        </div>
        {balance < 40 && !running && (
          <button
            onClick={() => {
              setBalance(INITIAL_BALANCE);
              setBets([]);
              setUndo([]);
              setMessage('Practice credits reset.');
            }}
            className="text-sm text-amber-200 underline"
          >
            Reset practice credits
          </button>
        )}
        <details className="rounded-xl border border-white/10 p-4 text-sm">
          <summary className="cursor-pointer font-semibold text-[#efd39b]">Rules & payouts</summary>
          <div className="mt-3 space-y-2 text-emerald-100/70">
            <p>
              Each number 0–36 has the same chance. Zero wins only an exact-number selection on
              zero; all outside selections lose.
            </p>
            <p>
              Winning total returns: exact number 33.3×, six-number sector 5.55×, dozen 2.775×,
              outside market 1.85×. Total returns include stake.
            </p>
            <p>
              90% theoretical return over repeated play. Selections use multiples of 40; maximum 480
              practice credits per round. Practice credits are not redeemable.
            </p>
          </div>
        </details>
      </div>
    </SpinStage>
  );
}
