import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SPIN_MARKETS, SPIN_WHEEL, settleSpinBets, spinColour } from '@socialplay/shared';
import type { SpinBet, SpinMarket } from '@socialplay/shared';

const COLOURS = { red: '#b83248', black: '#202d42', green: '#087f6f' };
const CHIPS = [1, 5, 10, 25, 100];
const INITIAL_BALANCE = 1000;
const MAX_ROUND = 500;
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
export function SpinWinWheel({ rotation }: { rotation: number }) {
  return (
    <div className="relative mx-auto w-full max-w-[360px] py-5">
      <span
        className="absolute left-1/2 top-1 z-10 -translate-x-1/2 text-4xl text-amber-200 drop-shadow-lg"
        aria-hidden="true"
      >
        ▼
      </span>
      <svg
        viewBox="0 0 400 400"
        role="img"
        aria-label="Single-zero wheel with numbers 0 to 36"
        className="w-full overflow-visible drop-shadow-2xl"
      >
        <circle cx="200" cy="200" r="198" fill="#b99051" />
        <circle cx="200" cy="200" r="190" fill="#111b2d" />
        <g
          style={{ transform: `rotate(${rotation}deg)`, transformOrigin: '200px 200px' }}
          className="transition-transform duration-[1800ms] ease-out motion-reduce:transition-none"
        >
          {SPIN_WHEEL.map((number, index) => {
            const angle = ((index * SLICE - SLICE / 2 - 90) * Math.PI) / 180;
            const end = angle + (SLICE * Math.PI) / 180;
            const x = (a: number) => 200 + 184 * Math.cos(a);
            const y = (a: number) => 200 + 184 * Math.sin(a);
            return (
              <g key={number}>
                <path
                  d={`M200 200 L${x(angle)} ${y(angle)} A184 184 0 0 1 ${x(end)} ${y(end)} Z`}
                  fill={COLOURS[spinColour(number)]}
                  stroke="#cfb47b"
                  strokeWidth="0.6"
                />
                <text
                  x="200"
                  y="38"
                  textAnchor="middle"
                  fill="white"
                  fontSize="13"
                  fontWeight="700"
                  transform={`rotate(${index * SLICE} 200 200)`}
                >
                  {number}
                </text>
              </g>
            );
          })}
        </g>
        <circle cx="200" cy="200" r="126" fill="#121d31" stroke="#b99051" strokeWidth="3" />
        <circle cx="200" cy="200" r="116" fill="none" stroke="#b99051" strokeOpacity="0.25" />
        <text
          x="200"
          y="195"
          textAnchor="middle"
          fill="#f4dbab"
          fontSize="29"
          fontWeight="800"
          letterSpacing="3"
        >
          SPIN WIN
        </text>
        <text x="200" y="220" textAnchor="middle" fill="#98a8c2" fontSize="10" letterSpacing="3">
          SINGLE ZERO · 37 POCKETS
        </text>
      </svg>
    </div>
  );
}

export function SpinWinPage() {
  const [chip, setChip] = useState(10);
  const [bets, setBets] = useState<SpinBet[]>([]);
  const [undo, setUndo] = useState<SpinBet[][]>([]);
  const [previous, setPrevious] = useState<SpinBet[]>([]);
  const [balance, setBalance] = useState(INITIAL_BALANCE);
  const [rotation, setRotation] = useState(0);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<number[]>([]);
  const [message, setMessage] = useState('Choose a chip, then select numbers or markets.');
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
    if (locked.current) return;
    if (total + chip > Math.min(balance, MAX_ROUND)) {
      setMessage('This chip exceeds your practice balance or the 500-credit round limit.');
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
        disabled={running}
        onClick={() => add(market)}
        aria-label={`Bet on ${market.label}${number ? ` ${spinColour(market.numbers[0])}` : ''}`}
        aria-pressed={!!amount}
        className={`relative min-h-12 rounded-lg border px-2 py-2 text-sm font-semibold transition hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-50 ${amount ? 'border-amber-200 ring-1 ring-amber-200' : 'border-white/15'}`}
        style={{
          backgroundColor: number
            ? COLOURS[spinColour(market.numbers[0])]
            : market.id === 'red'
              ? '#8e273b'
              : '#19283e',
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
    <section className="mx-auto max-w-7xl space-y-4">
      <Link to="/casino" className="text-sm text-primary-600 dark:text-primary-400">
        ← Casino
      </Link>
      <div className="overflow-hidden rounded-3xl border border-slate-700 bg-[#0b1424] text-white shadow-xl">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 px-5 py-5 sm:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-200">PlayQube originals</p>
            <h1 className="mt-1 text-3xl font-bold">Spin Win</h1>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-wide text-slate-400">Practice balance</p>
            <p className="text-2xl font-bold tabular-nums text-amber-200">
              {balance.toLocaleString()} <span className="text-xs text-slate-400">credits</span>
            </p>
          </div>
        </header>
        <div className="border-b border-amber-200/10 bg-amber-200/5 px-5 py-3 text-sm text-amber-100 sm:px-8">
          Practice mode · No Coins are spent or won. Credits reset when you leave.
        </div>
        <div className="grid gap-6 p-4 sm:p-6 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.2fr)]">
          <div className="space-y-4">
            <SpinWinWheel rotation={rotation} />
            <div
              role="status"
              aria-live="polite"
              className="min-h-16 rounded-xl border border-white/10 bg-white/5 p-4 text-center text-sm text-slate-200"
            >
              {message}
            </div>
            <div>
              <h2 className="mb-3 text-xs uppercase tracking-widest text-slate-400">
                Recent practice results
              </h2>
              <div className="flex flex-wrap gap-2">
                {history.length ? (
                  history.map((n, i) => (
                    <span
                      key={i}
                      className="flex h-9 w-9 items-center justify-center rounded-lg text-sm font-bold"
                      style={{ background: COLOURS[spinColour(n)] }}
                      aria-label={`${n} ${spinColour(n)}`}
                    >
                      {n}
                    </span>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">Your results will appear here.</p>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chip value">
              <span className="mr-2 text-xs uppercase tracking-widest text-slate-400">Chips</span>
              {CHIPS.map((value) => (
                <button
                  key={value}
                  disabled={running}
                  aria-pressed={chip === value}
                  onClick={() => setChip(value)}
                  className={`h-11 w-11 rounded-full border-2 border-dashed font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${chip === value ? 'border-amber-100 bg-amber-200 text-slate-950' : 'border-slate-500 bg-slate-800 text-slate-200'}`}
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
                className="rounded-lg border border-white/15 px-4 py-2 disabled:opacity-30"
              >
                Undo
              </button>
              <button
                disabled={running || !bets.length}
                onClick={() => replaceBets([])}
                className="rounded-lg border border-white/15 px-4 py-2 disabled:opacity-30"
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
                className="rounded-lg border border-white/15 px-4 py-2 disabled:opacity-30"
              >
                Rebet
              </button>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-white/5 px-4 py-3">
              <div>
                <span className="text-xs uppercase tracking-wide text-slate-400">Total bet</span>
                <p className="text-xl font-bold tabular-nums" data-testid="spin-total">
                  {total}{' '}
                  <span className="text-xs font-normal text-slate-400">practice credits</span>
                </p>
              </div>
              <button
                disabled={!canSpin}
                onClick={spin}
                className="rounded-xl bg-amber-200 px-8 py-3 font-bold text-slate-950 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {running ? 'Spinning…' : 'Spin'}
              </button>
            </div>
            {balance === 0 && !running && (
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
          </div>
        </div>
        <details className="border-t border-white/10 p-5 sm:px-8">
          <summary className="cursor-pointer font-semibold text-amber-100">Rules & payouts</summary>
          <div className="mt-4 space-y-3 text-sm text-slate-300">
            <p>
              Each number 0–36 has the same chance. Zero wins only an exact-number bet on 0. There
              is no half-stake return on outside bets.
            </p>
            <table className="w-full max-w-xl text-left">
              <thead>
                <tr>
                  <th className="py-2">Market</th>
                  <th>Profit odds</th>
                  <th>Total return</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Exact number', '35:1', '36×'],
                  ['Sector A–F (6 numbers)', '5:1', '6×'],
                  ['Dozen (12 numbers)', '2:1', '3×'],
                  ['Colour / odd-even / low-high', '1:1', '2×'],
                ].map((row) => (
                  <tr key={row[0]}>
                    {row.map((cell) => (
                      <td className="border-t border-white/10 py-2" key={cell}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              Total return includes the winning stake. All winning bets on a spin are added
              together. Round limit: 500 practice credits. Theoretical return: 97.30%; individual
              results vary.
            </p>
            <p>
              Practice results are generated locally and have no cash or Coin value. Live rounds and
              jackpots are not enabled.
            </p>
          </div>
        </details>
      </div>
    </section>
  );
}
