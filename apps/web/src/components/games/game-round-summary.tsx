import type { ReactNode } from 'react';
import './game-round-summary.css';

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
  return (
    <section className="game-round-summary" aria-label={`${game} round overview`}>
      <div className="game-round-summary__outcome">
        <span>{label}</span>
        <strong>{value}</strong>
        {detail && <small>{detail}</small>}
      </div>
      {clock && <div className="game-round-summary__clock">{clock}</div>}
    </section>
  );
}
