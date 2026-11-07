import type { CSSProperties } from 'react';
import { bjCard, bjTotal, bjResult } from '@socialplay/shared';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

export function BlackjackCard({ value, index }: { value?: number; index: number }) {
  const { t: translateUi } = useInterfaceLanguage();

  const c = value === undefined ? null : bjCard(value);
  return (
    <span
      className={`bj-card ${c?.red ? 'bj-red' : ''} ${!c ? 'bj-card-back' : ''}`}
      style={{ '--card-index': index } as CSSProperties}
      aria-label={c ? `${c.rank} ${c.suit}` : translateUi('Waiting for card')}
    >
      {c ? (
        <>
          <span className="bj-card-corner">
            {c.rank}
            <i>{c.suit}</i>
          </span>
          <span className="bj-card-pip">{c.suit}</span>
          <span className="bj-card-corner bj-card-bottom">
            {c.rank}
            <i>{c.suit}</i>
          </span>
        </>
      ) : (
        <span>♠</span>
      )}
    </span>
  );
}

/** The original table, shared by solo and group presentation. No wallet or outcome effects. */
export function BlackjackTable({
  hands,
  complete,
  selectedSeat,
  onSelect,
  disabled = false,
}: {
  hands: readonly (readonly number[])[];
  complete: boolean;
  selectedSeat?: number;
  onSelect?: (seat: number) => void;
  disabled?: boolean;
}) {
  const { t: translateUi } = useInterfaceLanguage();
  return (
    <div className="bj-felt">
      <div className="bj-table-inscription" aria-hidden="true">
        <span>{translateUi('SALEM')}</span>
        <strong>{translateUi('BLACKJACK')}</strong>
        <small>{translateUi('ALL HANDS STAND ON 17')}</small>
        <div>♦ ───── ♠ ───── ♥</div>
      </div>
      <div className="bj-hands">
        {[0, 1, 2, 3, 4, 5, 6].map((s) => {
          const cards = hands[s] ?? [],
            v = bjTotal(cards),
            result = s && complete ? bjResult(cards, hands[0] ?? []) : null;
          return (
            <button
              key={s}
              type="button"
              className={`bj-hand bj-hand-${s} ${s === selectedSeat ? 'selected' : ''} ${result ? `bj-result-${result.toLowerCase()}` : ''}`}
              aria-label={`${s === 0 ? translateUi('Dealer') : translateUi('Seat {s}', { s })}, ${cards.length ? translateUi('{amount} points', { amount: v.total }) : translateUi('waiting')}`}
              aria-pressed={s === selectedSeat}
              onClick={() => onSelect?.(s)}
              disabled={disabled || !onSelect}
            >
              <span className="bj-seat-name">
                {s === 0 ? translateUi('Dealer') : translateUi('Seat {s}', { s: s })}
                <b>
                  {cards.length
                    ? v.blackjack
                      ? translateUi('BJ')
                      : v.bust
                        ? translateUi('BUST')
                        : v.total
                    : '—'}
                </b>
              </span>
              <span
                className="bj-card-row"
                dir="ltr"
                data-long-hand={cards.length > 3}
                style={
                  {
                    '--cards': Math.max(2, cards.length),
                    width: cards.length > 3 ? '100%' : cards.length === 1 ? 'var(--cw)' : undefined,
                  } as CSSProperties
                }
              >
                {(cards.length ? cards : [undefined, undefined]).map((c, i) => (
                  <BlackjackCard key={`${s}-${i}-${c}`} value={c} index={i} />
                ))}
              </span>
              <span className={`bj-hand-status ${result ? 'settled' : ''}`}>
                {result
                  ? result === 'WIN'
                    ? translateUi('Wins')
                    : result === 'DRAW'
                      ? translateUi('Draw')
                      : translateUi('Loses')
                  : s === 0
                    ? translateUi('Stand on all 17s')
                    : v.blackjack
                      ? translateUi('Natural blackjack')
                      : v.bust
                        ? translateUi('Bust')
                        : v.total >= 17
                          ? translateUi('Standing')
                          : cards.length
                            ? translateUi('In play')
                            : translateUi('Waiting')}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
