import { clubById, type PublicGoal, type VfFixtureView } from '@socialplay/shared';
import { ClubBadge } from './club-badge';
import { formatOdds } from '@/lib/football/format';
import { quoteFor } from '@/lib/football/slip';
import type { DisplayFixture } from '@/lib/football/reveal';

const STATUS_TEXT: Record<DisplayFixture['status'], string> = {
  SCHEDULED: 'Kick-off soon',
  FIRST_HALF: 'First half',
  HALFTIME: 'Half-time',
  SECOND_HALF: 'Second half',
  FULL_TIME: 'Full time',
};

export function scoreText(display: DisplayFixture) {
  const s = display.fullTime ?? display.score;
  return s ? `${s.home}–${s.away}` : 'v';
}

/** Compact fixture card: teams, released score and the three full-time prices. */
export function Scorecard({
  fixture,
  display,
  selected,
  picked,
  onSelect,
}: {
  fixture: VfFixtureView;
  display: DisplayFixture;
  selected: boolean;
  picked: number;
  onSelect: () => void;
}) {
  const home = clubById(fixture.homeClub);
  const away = clubById(fixture.awayClub);
  const prices = ['FT:1', 'FT:X', 'FT:2'].map(
    (id) => quoteFor(fixture.params, id)?.oddsCents ?? null
  );
  return (
    <button
      type="button"
      className="vf-card"
      aria-pressed={selected}
      onClick={onSelect}
      aria-label={`${home.name} ${scoreText(display) === 'v' ? 'versus' : scoreText(display)} ${away.name}. ${STATUS_TEXT[display.status]}${picked ? `. ${picked} selection${picked === 1 ? '' : 's'} on your slip` : ''}`}
    >
      <span className="vf-card-team">
        <ClubBadge club={home.id} size={22} />
        <b>{home.code}</b>
      </span>
      <span
        className="vf-card-score"
        data-live={display.status === 'FIRST_HALF' || display.status === 'SECOND_HALF'}
      >
        {scoreText(display)}
      </span>
      <span className="vf-card-team vf-card-team--away">
        <b>{away.code}</b>
        <ClubBadge club={away.id} size={22} />
      </span>
      <span className="vf-card-meta">
        {display.status === 'SCHEDULED' ? (
          <span className="vf-card-prices" aria-hidden="true">
            {prices.map((p, i) => (
              <i key={i}>{formatOdds(p)}</i>
            ))}
          </span>
        ) : (
          <span>{display.minute}</span>
        )}
        {picked > 0 && <em className="vf-card-picks">{picked}</em>}
      </span>
    </button>
  );
}

/** The big scoreboard: used over the 3D view and as the heart of the 2D fallback. */
export function Scoreboard({
  fixture,
  display,
  week,
}: {
  fixture: VfFixtureView;
  display: DisplayFixture;
  week: string;
}) {
  const home = clubById(fixture.homeClub);
  const away = clubById(fixture.awayClub);
  return (
    <div className="vf-board" role="group" aria-label={`Scoreboard, ${week}`}>
      <span className="vf-board-team">
        <ClubBadge club={home.id} size={30} />
        <b>{home.name}</b>
      </span>
      <span
        className="vf-board-score"
        aria-live="polite"
        aria-atomic="true"
        data-scoring={display.scoring}
      >
        <span className="sr-only">
          {display.fullTime ? 'Full time. ' : ''}
          {home.name} {display.score?.home ?? 0}, {away.name} {display.score?.away ?? 0}
        </span>
        <span aria-hidden="true">
          {display.score ? `${display.score.home} – ${display.score.away}` : 'v'}
        </span>
      </span>
      <span className="vf-board-team vf-board-team--away">
        <b>{away.name}</b>
        <ClubBadge club={away.id} size={30} />
      </span>
      <span className="vf-board-clock">
        {display.status === 'SCHEDULED' ? 'Pre-match' : display.minute}
      </span>
    </div>
  );
}

function GoalLine({ goal, fixture }: { goal: PublicGoal; fixture: VfFixtureView }) {
  const club = clubById(goal.side === 'H' ? fixture.homeClub : fixture.awayClub);
  return (
    <li>
      <span className="vf-goal-min">{goal.minute}&apos;</span>
      <ClubBadge club={club.id} size={18} />
      <span>Goal · {club.name}</span>
    </li>
  );
}

/** Text match centre: complete without the 3D view, announces only revealed goals. */
export function MatchCentre({
  fixture,
  display,
  week,
}: {
  fixture: VfFixtureView;
  display: DisplayFixture;
  week: string;
}) {
  return (
    <section className="vf-centre" aria-label="Match centre">
      <Scoreboard fixture={fixture} display={display} week={week} />
      <p className="vf-centre-status">{STATUS_TEXT[display.status]}</p>
      {display.events.length ? (
        <ol className="vf-goals" aria-label="Goals">
          {display.events.map((g) => (
            <GoalLine key={g.n} goal={g} fixture={fixture} />
          ))}
        </ol>
      ) : (
        <p className="vf-centre-empty">
          {display.status === 'SCHEDULED' ? 'No goals yet.' : 'No goals so far.'}
        </p>
      )}
    </section>
  );
}
