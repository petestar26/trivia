import { SPIN90_MARKETS, spinColour } from '@socialplay/shared';
export function SpinInsights({ outcomes }: { outcomes: readonly number[] }) {
  const recent = outcomes.slice(0, 12);
  const count = (test: (n: number) => boolean) => recent.filter(test).length;
  const stats = [
    ['Red', count((n) => spinColour(n) === 'red')],
    ['Black', count((n) => spinColour(n) === 'black')],
    ['Zero', count((n) => n === 0)],
  ] as const;
  return (
    <aside
      className="grid gap-3 sm:grid-cols-2 lg:block lg:space-y-3"
      aria-label="Spin history and statistics"
    >
      <div className="rounded-xl border border-[#c7a05a]/30 bg-black/30 p-3">
        <h2 className="text-xs font-bold uppercase tracking-[.18em] text-[#efd39b]">Pay table</h2>
        <div className="mt-2 space-y-1 text-xs">
          {[
            ['Colour / parity', 'red'],
            ['Sector', 'sector:0'],
            ['Dozen', 'dozen:0'],
            ['Number', 'number:0'],
          ].map(([label, id]) => (
            <div key={id} className="flex justify-between border-b border-white/10 py-2">
              <span className="text-emerald-100/70">{label}</span>
              <strong>{SPIN90_MARKETS.find((m) => m.id === id)!.grossMultiplier}×</strong>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-emerald-100/50">
          Total returns include stake · 90% RTP
        </p>
      </div>
      <div className="rounded-xl border border-[#c7a05a]/30 bg-black/30 p-3">
        <h2 className="text-xs font-bold uppercase tracking-[.18em] text-[#efd39b]">
          Recent results
        </h2>
        {recent.length ? (
          <div className="mt-3 grid grid-cols-6 gap-1.5">
            {recent.map((n, i) => (
              <span
                key={i}
                aria-label={`${n} ${spinColour(n)}`}
                className={`flex h-8 items-center justify-center rounded font-bold ${n === 0 ? 'bg-emerald-700' : spinColour(n) === 'red' ? 'bg-rose-700' : 'bg-[#1b2623]'}`}
              >
                {n}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-xs text-emerald-100/50">
            Results will appear after a completed round.
          </p>
        )}
        <p className="mt-2 text-[10px] text-emerald-100/50">
          Last {recent.length} completed rounds
        </p>
      </div>
      <div className="rounded-xl border border-[#c7a05a]/30 bg-black/30 p-3">
        <h2 className="text-xs font-bold uppercase tracking-[.18em] text-[#efd39b]">Statistics</h2>
        <div className="mt-3 flex gap-2">
          {stats.map(([label, value]) => (
            <div key={label} className="flex-1 rounded bg-white/5 p-2 text-center">
              <p className="text-[10px] text-emerald-100/60">{label}</p>
              <strong className="text-lg">{recent.length ? value : '—'}</strong>
            </div>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1 text-center text-[10px]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded bg-white/5 p-2">
              <p className="text-emerald-100/60">
                {i * 12 + 1}–{i * 12 + 12}
              </p>
              <strong>
                {recent.length ? count((n) => n >= i * 12 + 1 && n <= i * 12 + 12) : '—'}
              </strong>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
