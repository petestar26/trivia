import { useState } from 'react';
import type { TogetherEntryView, TogetherGameEvent } from '@socialplay/shared';
import { DiceFace } from '@/components/dice/dice-face';
import { BlackjackTable } from '@/components/blackjack/table';
import { NumberBall } from '@/components/number-challenge/number-ball';
import { useTogetherText } from '@/lib/i18n/together-text';
import '@/pages/games/dice-system.css';
import '@/pages/games/blackjack.css';
import '@/pages/games/number-challenge.css';

export function DiceStage({
  entries,
  events,
  running,
  reduced,
}: {
  entries: TogetherEntryView[];
  events: TogetherGameEvent[];
  elapsed: number;
  running: boolean;
  reduced: boolean;
}) {
  const { t, num } = useTogetherText();
  const [selected, setSelected] = useState<string | null>(null);
  const active = entries.find((e) => e.id === selected) ?? entries[0];
  const rolls = events.filter(
    (e): e is Extract<TogetherGameEvent, { kind: 'dice' }> => e.kind === 'dice'
  );
  const roll = rolls.find((e) => e.entryId === active?.id),
    sum = roll ? roll.values[0] + roll.values[1] : null;
  return (
    <div className="original-dice-layout" data-original-scene="dice">
      <div className="system-dice-table">
        <div className="system-dice-round">
          <span className="system-dice-live">
            <i />
            {active?.username ?? t('Watching')}
          </span>
        </div>
        <div className={`system-dice-cup ${running && !roll && !reduced ? 'is-rolling' : ''}`}>
          <DiceFace value={roll?.values[0] ?? 3} hidden={!roll} />
          <DiceFace value={roll?.values[1] ?? 4} hidden={!roll} />
        </div>
        <div className="system-dice-result" role="status">
          <span>{t(sum === null ? 'Revealing dice…' : 'THE TOTAL IS')}</span>
          <strong>{sum === null ? '—' : num(sum)}</strong>
          <p>
            {roll
              ? t('{first} + {second} = {total}', {
                  first: roll.values[0],
                  second: roll.values[1],
                  total: sum!,
                })
              : t('Everyone sees the same round')}
          </p>
        </div>
        <div className="system-dice-track" aria-hidden="true">
          {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
            <span key={n} className={sum === n ? 'current' : ''}>
              {num(n)}
            </span>
          ))}
        </div>
      </div>
      <div className="original-dice-roster" role="group" aria-label={t('Confirmed participants')}>
        {entries.map((e, i) => {
          const result = rolls.find((r) => r.entryId === e.id);
          return (
            <button
              type="button"
              key={e.id}
              className="original-dice-player"
              aria-pressed={active?.id === e.id}
              onClick={() => setSelected(e.id)}
            >
              <b>{num(i + 1)}</b>
              <span>{e.username}</span>
              <strong>{result ? num(result.values[0] + result.values[1]) : '—'}</strong>
            </button>
          );
        })}
      </div>
    </div>
  );
}
export function BlackjackStage({
  events,
  complete = false,
}: {
  events: TogetherGameEvent[];
  elapsed: number;
  complete?: boolean;
}) {
  const hands = Array.from(
    { length: 7 },
    (_, hand) =>
      events
        .filter(
          (e): e is Extract<TogetherGameEvent, { kind: 'hand' }> =>
            e.kind === 'hand' && e.hand === hand
        )
        .at(-1)?.cards ?? []
  );
  return (
    <div className="bj-page original-blackjack" data-original-scene="blackjack">
      <section className="bj-arena">
        <BlackjackTable hands={hands} complete={complete} />
      </section>
    </div>
  );
}
export function NumberStage({
  target,
  entries,
  reduced,
}: {
  target: number | null;
  entries: TogetherEntryView[];
  elapsed: number;
  reduced: boolean;
}) {
  const { t, num } = useTogetherText();
  return (
    <div
      className={`number-game original-number ${reduced ? 'number-game--still' : ''}`}
      data-original-scene="number-challenge"
    >
      <div className="number-stage">
        <div className="number-stage-top">
          <span className="number-wordmark">
            N<span>º</span> {t('/ CHALLENGE')}
          </span>
          <span className="number-badge">1 — 100</span>
        </div>
        <p className="number-eyebrow">
          {t(target === null ? 'Selection sealed' : 'Official result')}
        </p>
        <NumberBall target={target} />
        <div className="number-result" role="status">
          <h2>{target === null ? t('Revealing the shared target…') : num(target)}</h2>
        </div>
      </div>
      <ol className="tg-guesses">
        {entries.map((e) => (
          <li key={e.id}>
            <span>{e.username}</span>
            <b>{e.selection?.[0] === undefined ? '—' : num(e.selection[0])}</b>
            {target !== null && e.selection && (
              <small>{t('Distance {number}', { number: Math.abs(e.selection[0] - target) })}</small>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
