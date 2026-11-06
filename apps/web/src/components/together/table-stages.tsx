import {
  bjCard,
  bjTotal,
  type TogetherEntryView,
  type TogetherGameEvent,
} from '@socialplay/shared';
import { useTogetherText } from '@/lib/i18n/together-text';

const pips: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
function Die({ value, phase, rolling }: { value?: number; phase: number; rolling: boolean }) {
  const front = value ?? 1;
  const side = [1, 2, 3].find((n) => n !== front && 7 - n !== front)!;
  const top = [1, 2, 3].find((n) => n !== front && 7 - n !== front && n !== side)!;
  const faces = [front, 7 - front, side, 7 - side, top, 7 - top];
  return (
    <div className="tg-die-shadow">
      <div
        className="tg-die"
        style={{
          transform: value
            ? 'rotateX(-12deg) rotateY(18deg)'
            : `rotateX(${phase * 0.31}deg) rotateY(${phase * 0.23}deg) rotateZ(18deg)`,
        }}
        aria-hidden="true"
      >
        {faces.map((n, i) => (
          <span className={'tg-die-face face-' + i} key={i}>
            {Array.from({ length: 9 }, (_, p) => (
              <i key={p} data-pip={pips[n].includes(p)} style={{ opacity: rolling ? 0.8 : 1 }} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}
export function DiceStage({
  entries,
  events,
  elapsed,
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
  return (
    <div className="tg-dice-room">
      <div className="tg-dice-tray">
        <div className="tg-tray-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="tg-dice-players">
          {entries.map((entry, i) => {
            const roll = events.find(
              (e): e is Extract<TogetherGameEvent, { kind: 'dice' }> =>
                e.kind === 'dice' && e.entryId === entry.id
            );
            return (
              <article key={entry.id} className="tg-dice-player" data-released={!!roll}>
                <header>
                  <b>{num(i + 1)}</b>
                  <span>{entry.username}</span>
                </header>
                <div className="tg-dice-pair">
                  {[0, 1].map((n) => (
                    <Die
                      key={n}
                      value={roll?.values[n]}
                      phase={reduced ? 0 : elapsed + i * 211 + n * 390}
                      rolling={running && !roll}
                    />
                  ))}
                </div>
                <strong aria-live="polite">
                  {roll ? num(roll.values[0] + roll.values[1]) : '—'}
                </strong>
                <small>
                  {roll
                    ? t('{first} + {second} = {total}', {
                        first: roll.values[0],
                        second: roll.values[1],
                        total: roll.values[0] + roll.values[1],
                      })
                    : t('Revealing dice…')}
                </small>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
function Suit({ suit }: { suit: string }) {
  const path =
    suit === '♥'
      ? 'M12 21C4 15 0 9 3 5C6 1 10 3 12 6C14 3 18 1 21 5C24 9 20 15 12 21Z'
      : suit === '♦'
        ? 'M12 1L22 12L12 23L2 12Z'
        : suit === '♠'
          ? 'M12 1C10 5 0 10 2 16C3 21 9 21 11 17L9 23H15L13 17C16 21 22 21 23 16C24 11 16 5 12 1Z'
          : 'M12 1C5 1 5 9 9 10C1 6-2 16 4 19C7 21 10 18 11 16L9 23H15L13 16C17 23 26 18 23 12C22 8 18 8 15 10C20 5 17 1 12 1Z';
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} fill="currentColor" />
    </svg>
  );
}
export function PlayingCard({ card, age = 1000 }: { card: number | null; age?: number }) {
  if (card === null)
    return (
      <span className="tg-playing-card is-back" aria-hidden="true">
        <i />
        <i />
      </span>
    );
  const c = bjCard(card);
  return (
    <span
      className={'tg-playing-card ' + (c.red ? 'is-red' : '')}
      style={{ animationDelay: `-${Math.min(600, age)}ms` }}
      aria-label={c.rank + ' ' + c.suit}
    >
      <span className="tg-card-corner">
        {c.rank}
        <Suit suit={c.suit} />
      </span>
      <span className="tg-card-art">
        <Suit suit={c.suit} />
        {['J', 'Q', 'K'].includes(c.rank) && <b>{c.rank}</b>}
      </span>
      <span className="tg-card-corner is-bottom">
        {c.rank}
        <Suit suit={c.suit} />
      </span>
    </span>
  );
}
export function BlackjackStage({
  events,
  elapsed,
}: {
  events: TogetherGameEvent[];
  elapsed: number;
}) {
  const { t, num } = useTogetherText();
  return (
    <div className="tg-blackjack-room">
      <div className="tg-blackjack-table">
        <div className="tg-card-shoe" aria-hidden="true">
          <PlayingCard card={null} />
        </div>
        <div className="tg-table-brand" aria-hidden="true">
          <span>SALEM</span>
          <i />
          <i />
          <i />
        </div>
        <div className="tg-table-hands">
          {[0, 1, 2, 3, 4, 5, 6].map((hand) => {
            const event = events
                .filter(
                  (e): e is Extract<TogetherGameEvent, { kind: 'hand' }> =>
                    e.kind === 'hand' && e.hand === hand
                )
                .at(-1),
              cards = event?.cards ?? [];
            return (
              <article key={hand} className={'tg-table-hand hand-' + hand}>
                <header>
                  {hand === 0 ? t('Dealer') : t('Hand {number}', { number: num(hand) })}
                </header>
                <div
                  className="tg-hand-cards"
                  dir="ltr"
                  style={{ maxWidth: (cards.length || 2) * 26 + 24 }}
                >
                  {cards.length ? (
                    cards.map((card, i) => (
                      <PlayingCard
                        card={card}
                        key={i}
                        age={i === cards.length - 1 ? elapsed - (event?.atMs ?? 0) : 1000}
                      />
                    ))
                  ) : (
                    <>
                      <PlayingCard card={null} />
                      <PlayingCard card={null} />
                    </>
                  )}
                </div>
                <strong aria-live="polite">{cards.length ? num(bjTotal(cards).total) : '—'}</strong>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
export function NumberStage({
  target,
  entries,
  elapsed,
  reduced,
}: {
  target: number | null;
  entries: TogetherEntryView[];
  elapsed: number;
  reduced: boolean;
}) {
  const { t, num } = useTogetherText();
  const digits = String(target ?? 0)
    .padStart(3, '0')
    .split('');
  return (
    <div className="tg-number-vault">
      <div
        className="tg-vault-orbit"
        aria-hidden="true"
        style={{ transform: `rotate(${reduced ? 0 : elapsed / 200}deg)` }}
      />
      <div className="tg-number-device">
        <div className="tg-device-status">
          <i />
          {target === null ? t('Selection sealed') : t('Official result')}
        </div>
        <div className="tg-odometer" aria-hidden="true">
          {digits.map((d, i) => (
            <div className="tg-number-drum" key={i}>
              <span className="tg-drum-previous">
                {target === null ? '—' : num((Number(d) + 9) % 10)}
              </span>
              <strong>{target === null ? '—' : num(Number(d))}</strong>
              <span className="tg-drum-next">
                {target === null ? '—' : num((Number(d) + 1) % 10)}
              </span>
              <i
                style={{
                  transform: `translateY(${target === null && !reduced ? Math.sin(elapsed / (180 + i * 40)) * 40 : 0}px)`,
                }}
              />
            </div>
          ))}
        </div>
        <p aria-live="polite">
          {target === null ? t('Revealing the shared target…') : num(target)}
        </p>
        <div className="tg-vault-meter" aria-hidden="true">
          {Array.from({ length: 24 }, (_, i) => (
            <i
              key={i}
              style={{
                opacity: reduced ? 0.5 : 0.2 + 0.8 * Math.max(0, Math.sin(elapsed / 500 - i / 3)),
              }}
            />
          ))}
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
