import type { ReactNode } from 'react';
import './game-round-summary.css';
import { useLanguage as useInterfaceLanguage } from '@/providers/language-provider';

/** Keep the released outcome and round clock visible while using the controls. */
export function GameRoundSummary({
  game,
  label,
  value,
  detail,
  clock,
}: {
  game: string;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  clock?: ReactNode;
}) {
  const { t: translateUi } = useInterfaceLanguage();

  return (
    <section
      className="game-round-summary"
      aria-label={translateUi('{game} round overview', { game: translateUi(game) })}
    >
      <div className="game-round-summary__outcome">
        <span>{translateUi(label)}</span>
        <strong>{typeof value === 'string' ? translateUi(value) : value}</strong>
        {detail && <small>{typeof detail === 'string' ? translateUi(detail) : detail}</small>}
      </div>
      {clock && (
        <div className="game-round-summary__clock">
          {typeof clock === 'string' ? translateUi(clock) : clock}
        </div>
      )}
    </section>
  );
}
