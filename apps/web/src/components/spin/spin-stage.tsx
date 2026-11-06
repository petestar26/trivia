import { GameRoundSummary } from '@/components/games/game-round-summary';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { SpinWinWheel } from './spin-wheel';
import { SpinInsights } from './spin-insights';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

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
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <section className="spin-stage mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <Link to="/games" className="text-primary-600 dark:text-primary-400">
          {translateUi('← Games')}
        </Link>
        <Link to="/groups" className="text-primary-600 dark:text-primary-400">
          {translateUi('PVP · play in a group →')}
        </Link>
      </div>
      <GameRoundSummary
        game="Spin Win"
        label={translateUi('Latest number')}
        value={number ?? 'Awaiting draw'}
        detail={
          <span role="status" aria-live="polite">
            {typeof status === 'string' ? translateUi(status) : status}
          </span>
        }
        clock={mode === 'scheduled' ? balance : undefined}
      />
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
              {translateUi('Salem Bet originals')}
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              {translateUi('Spin Win')}
            </h1>
          </div>
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-widest text-emerald-100/60">
              {mode === 'coins'
                ? translateUi('Coin balance')
                : mode === 'solo'
                  ? translateUi('Practice balance')
                  : translateUi('System table · one-minute rounds')}
            </p>
            <div className="mt-1 font-semibold text-[#ffe2a1]">
              {mode === 'scheduled'
                ? translateUi('Free practice · ETB')
                : (balance ?? translateUi('One server result for every player'))}
            </div>
          </div>
        </header>
        <p className="border-b border-[#d6b475]/15 bg-black/10 px-5 py-2.5 text-xs text-emerald-100/75 sm:px-7">
          {mode === 'solo'
            ? translateUi('Practice mode · No cash is spent or won. Credits reset when you leave.')
            : mode === 'scheduled'
              ? translateUi(
                  'Practice only · No deposits, fees or redeemable prizes. Each confirmed ticket is locked to its round.'
                )
              : translateUi(
                  'Coin mode · Server settlement · Confirm pending rounds before entering again.'
                )}
        </p>
        <div className="grid items-center gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_230px]">
          <div className="min-w-0">
            <SpinWinWheel rotation={rotation} number={number} spinning={spinning} />
          </div>
          <SpinInsights outcomes={outcomes} />
        </div>
        <div className="border-t border-[#d6b475]/20 bg-black/15 p-4 sm:p-6">{children}</div>
      </div>
    </section>
  );
}
