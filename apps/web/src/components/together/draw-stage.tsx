import type { CSSProperties } from 'react';
import {
  LS_COLORS,
  lsColor,
  rkColor,
  togetherGame,
  type TogetherGame,
  type TogetherGameEvent,
} from '@socialplay/shared';
import { KenoMachine } from '@/components/keno/draw-machine';
import { LuckySixMachine } from '@/components/lucky-six/draw-machine';
import { RouletteKenoWheel } from '@/components/roulette-keno/wheel';
import { useTogetherText } from '@/lib/i18n/together-text';
import '@/pages/games/keno.css';
import '@/pages/games/lucky-six.css';
import '@/pages/games/roulette-keno.css';

type Ball = Extract<TogetherGameEvent, { kind: 'ball' }>;
/** The single-player machines and ticket colours, fed only released shared balls. */
export function DrawStage({
  game,
  balls,
  picks,
  reduced,
  running,
}: {
  game: TogetherGame;
  balls: Ball[];
  picks: number[];
  elapsed: number;
  reduced: boolean;
  running: boolean;
}) {
  const { t, num } = useTogetherText();
  const rule = togetherGame(game),
    drawn = balls.map((b) => b.value),
    latest = drawn.at(-1) ?? null;
  const lucky = game === 'lucky_six',
    roulette = game === 'roulette_keno';
  const prefix = lucky ? 'ls' : roulette ? 'rk' : 'keno',
    count = lucky ? 35 : roulette ? 18 : 20;
  const board = (
    <div
      className={`${prefix}-board original-number-board`}
      role="group"
      aria-label={t('Your choice')}
    >
      {Array.from({ length: rule.max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          disabled
          aria-pressed={picks.includes(n)}
          className={[
            prefix === 'keno' ? 'keno-number' : '',
            picks.includes(n) ? (prefix === 'keno' ? 'is-selected' : 'selected') : '',
            drawn.includes(n) ? (prefix === 'keno' ? 'is-drawn' : 'drawn') : '',
            drawn.includes(n) && picks.includes(n) ? (prefix === 'keno' ? 'is-hit' : 'hit') : '',
            latest === n ? 'is-latest' : '',
            roulette ? rkColor(n).toLowerCase() : '',
          ].join(' ')}
          style={lucky ? ({ '--ball': LS_COLORS[lsColor(n)].hex } as CSSProperties) : undefined}
        >
          {num(n)}
        </button>
      ))}
    </div>
  );
  const rail = (
    <ol
      className={prefix === 'keno' ? 'original-keno-balls' : `${prefix}-balls`}
      aria-label={t('Drawn balls')}
    >
      {Array.from({ length: count }, (_, i) => {
        const n = drawn[i];
        return (
          <li
            key={i}
            className={`${n ? 'released' : ''} ${lucky && i < 5 ? 'preball' : ''} ${n && roulette ? rkColor(n).toLowerCase() : ''} ${n && picks.includes(n) ? 'match' : ''}`}
            style={
              n && lucky ? ({ '--ball': LS_COLORS[lsColor(n)].hex } as CSSProperties) : undefined
            }
          >
            {n ? num(n) : '·'}
          </li>
        );
      })}
    </ol>
  );
  if (!lucky && !roulette)
    return (
      <div className="keno-game keno-system original-draw" data-original-scene="turbo-keno">
        <div className="keno-stage">
          <div className="keno-layout">
            <div className="keno-board-panel">
              <div className="keno-draw-heading">
                <h2>{t('Drawn balls')}</h2>
                <span>
                  {num(drawn.length)} / {num(count)}
                </span>
              </div>
              {board}
              {rail}
            </div>
            <aside className="keno-machine-panel">
              <div className="keno-machine-title">
                <span>{t('SERVER BALL REVEAL')}</span>
                <strong>{t('Drawn balls')}</strong>
              </div>
              <KenoMachine number={latest} running={running && !reduced} />
            </aside>
          </div>
        </div>
      </div>
    );
  return (
    <div
      className={`${prefix}-page original-draw`}
      data-original-scene={lucky ? 'lucky-six' : 'roulette-keno'}
    >
      <div className={`${prefix}-table`}>
        <section className={`${prefix}-studio`}>
          <div className={`${prefix}-studio-heading`}>
            <span className={`${prefix}-dot`} />
            {t(running ? 'Drawing now' : 'Drawn balls')}
            <span className={`${prefix}-countdown`}>
              {num(drawn.length)} / {num(count)}
            </span>
          </div>
          {lucky ? (
            <LuckySixMachine latest={latest} drawing={running && !reduced} />
          ) : (
            <RouletteKenoWheel latest={latest} drawing={running && !reduced} />
          )}
          <div className={`${prefix}-draw-results`}>{rail}</div>
        </section>
        <section className={`${prefix}-play original-draw-ticket`}>
          <h3>{t('Your choice')}</h3>
          {board}
        </section>
      </div>
    </div>
  );
}
