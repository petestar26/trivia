import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { BroadcastCaption } from './match-centre';
import { displayFixture, GOAL_REVEAL_MS } from '@/lib/football/reveal';
import { buildWeek, weekView } from '@/test/football-fixtures';
import { cycleBySeasonWeek } from '@socialplay/shared';
afterEach(cleanup);
it('does not announce a goal or full time ahead of the shared delayed display', () => {
  const week = weekView(buildWeek(1, 5), cycleBySeasonWeek(1, 5).fullTimeAt + 10000);
  const fixture = week.fixtures.find((f) => f.live.events.length)!;
  const goal = fixture.live.events[0];
  const view = render(
    <BroadcastCaption fixture={fixture} display={displayFixture(fixture.live, goal.atMs + 100)} />
  );
  expect(screen.getByLabelText('Match broadcast status')).not.toHaveTextContent(`${goal.minute}′`);
  expect(screen.queryByText('FULL TIME')).toBeNull();
  view.rerender(
    <BroadcastCaption
      fixture={fixture}
      display={displayFixture(fixture.live, goal.atMs + GOAL_REVEAL_MS)}
    />
  );
  expect(screen.getByLabelText('Match broadcast status')).toHaveTextContent(`${goal.minute}′`);
  view.rerender(
    <BroadcastCaption fixture={fixture} display={displayFixture(fixture.live, 70000)} />
  );
  expect(screen.getByText('FULL TIME')).toBeInTheDocument();
});
