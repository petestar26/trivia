import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SpinWinWheel } from './spin-wheel';
import { SpinInsights } from './spin-insights';
export function SpinStage({
  mode,
  rotation,
  number,
  spinning,
  outcomes,
  status,
  balance,
  children,
}: {
  mode: 'solo' | 'scheduled' | 'coins';
  rotation: number;
  number?: number | null;
  spinning?: boolean;
  outcomes: readonly number[];
  status: ReactNode;
  balance?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link to="/casino" className="text-primary-600 dark:text-primary-400">
          ← Casino
        </Link>
        <nav
          aria-label="Spin mode"
          className="flex gap-1 rounded-full border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-900"
        >
          {[
            ['solo', '/games/spin-win', 'Solo practice'],
            ['scheduled', '/games/spin-win/live', 'Shared practice'],
            ['coins', '/games/spin-win/play', 'Coins'],
          ].map(([key, to, label]) => (
            <Link
              key={key}
              to={to}
              aria-current={mode === key ? 'page' : undefined}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${mode === key ? 'bg-emerald-800 text-white' : 'text-gray-600 dark:text-gray-300'}`}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
      <div
        className="overflow-hidden rounded-[24px] border border-[#b99150]/60 bg-[#06382b] text-[#fff8e8] shadow-[0_20px_70px_rgba(0,0,0,.2)]"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 30% 20%,rgba(47,117,71,.6),transparent 65%),repeating-linear-gradient(45deg,rgba(255,255,255,.015) 0,rgba(255,255,255,.015) 1px,transparent 1px,transparent 4px)',
        }}
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#d6b475]/20 bg-black/15 px-5 py-4 sm:px-7">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[.3em] text-[#ecd19b]">
              PlayQube originals
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Spin Win</h1>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-widest text-emerald-100/60">
              {mode === 'coins'
                ? 'Coin balance'
                : mode === 'solo'
                  ? 'Practice balance'
                  : 'Shared practice table'}
            </p>
            <div className="mt-1 font-semibold text-[#ffe2a1]">
              {balance ?? 'One server result for every player'}
            </div>
          </div>
        </header>
        <p className="border-b border-[#d6b475]/15 bg-black/10 px-5 py-2.5 text-xs text-emerald-100/75 sm:px-7">
          {mode === 'solo'
            ? 'Practice mode · No Coins are spent or won. Credits reset when you leave.'
            : mode === 'scheduled'
              ? 'Practice only · No Coins, deposits, fees or redeemable prizes. Selections lock once per round.'
              : 'Coin mode · Server settlement · Confirm pending rounds before entering again.'}
        </p>
        <div className="grid items-center gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_230px]">
          <div className="min-w-0">
            <SpinWinWheel rotation={rotation} number={number} spinning={spinning} />
            <div
              role="status"
              aria-live="polite"
              className="mx-auto max-w-xl rounded-xl border border-[#e3c58d]/20 bg-black/25 px-4 py-3 text-center text-sm"
            >
              {status}
            </div>
          </div>
          <SpinInsights outcomes={outcomes} />
        </div>
        <div className="border-t border-[#d6b475]/20 bg-black/15 p-4 sm:p-6">{children}</div>
      </div>
    </section>
  );
}
