import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TogetherGameEvent } from '@socialplay/shared';
import SharedFootballScene from './shared-football-scene';

const engine = vi.hoisted(() => ({
  setMatch: vi.fn(),
  setReduced: vi.fn(),
  start: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@/components/football/engine/engine', () => ({ createEngine: () => engine }));

const props = {
  roundId: 'shared-football',
  events: [] as TogetherGameEvent[],
  match: 0,
  elapsed: 10000,
  duration: 90000,
  complete: false,
  label: 'Match 1',
  fallback: <p>Scoreboard</p>,
  quality: 'low' as const,
  reduced: true,
};
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

it('updates the shared clock without requesting extra reduced-motion match renders', () => {
  const view = render(<SharedFootballScene {...props} />);
  engine.setMatch.mockClear();
  for (let elapsed = 10200; elapsed <= 14000; elapsed += 200)
    view.rerender(<SharedFootballScene {...props} events={[]} elapsed={elapsed} />);
  expect(engine.setMatch).not.toHaveBeenCalled();
  expect(engine.start).toHaveBeenCalledTimes(1);
});

it('forwards newly released scores and the final result, but keeps equivalent polls stable', () => {
  const view = render(<SharedFootballScene {...props} />);
  const events: TogetherGameEvent[] = [
    { kind: 'football', atMs: 20000, match: 0, minute: 20, home: 1, away: 0 },
  ];
  engine.setMatch.mockClear();
  view.rerender(<SharedFootballScene {...props} events={events} elapsed={21000} />);
  expect(engine.setMatch).toHaveBeenCalledTimes(1);
  expect(engine.setMatch.mock.lastCall?.[0]).toMatchObject({
    goals: [{ n: 1, side: 'H' }],
    fullTime: null,
  });
  view.rerender(
    <SharedFootballScene {...props} events={events.map((e) => ({ ...e }))} elapsed={22000} />
  );
  expect(engine.setMatch).toHaveBeenCalledTimes(1);
  view.rerender(<SharedFootballScene {...props} events={events} elapsed={90000} complete />);
  expect(engine.setMatch).toHaveBeenCalledTimes(2);
  expect(engine.setMatch.mock.lastCall?.[0]).toMatchObject({ fullTime: { home: 1, away: 0 } });
});
