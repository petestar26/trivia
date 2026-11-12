import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TogetherRoundView } from '@socialplay/shared';
import { TogetherLiveGame } from './together-live-game';

const scenes = vi.hoisted(() => ({
  derby: [] as Record<string, unknown>[],
  dogs: [] as Record<string, unknown>[],
  mounts: 0,
}));
vi.mock('@/components/derby/race-scene', async () => {
  const { useEffect } = await import('react');
  function DerbyCourse(props: Record<string, unknown>) {
    scenes.derby.push(props);
    useEffect(() => {
      scenes.mounts++;
    }, []);
    return <div>Derby course</div>;
  }
  return { default: DerbyCourse };
});
vi.mock('@/components/dog-racing/race-scene', async () => {
  const { useEffect } = await import('react');
  function DogCourse(props: Record<string, unknown>) {
    scenes.dogs.push(props);
    useEffect(() => {
      scenes.mounts++;
    }, []);
    return <div>Dog course</div>;
  }
  return { default: DogCourse };
});

const startsAt = 1_800_000_000_000;
function groupRace(game: 'thunder_derby_3d' | 'neon_hounds_3d') {
  return {
    id: 'group-race',
    game,
    state: 'DRAWN',
    currency: 'USD',
    entryAmount: 100,
    entries: [],
    settlement: null,
    outcome: null,
    paidAt: null,
    eventSequence: 2,
    presentation: {
      version: 2,
      startsAt,
      finishesAt: startsAt + 45_000,
      observedAt: startsAt + 20_000,
      resultAvailable: false,
      events: [
        { kind: 'race', atMs: 10_000, positions: [0.2, 0.21, 0.19, 0.22, 0.2, 0.18, 0.2, 0.19] },
        { kind: 'race', atMs: 20_000, positions: [0.41, 0.45, 0.4, 0.43, 0.39, 0.38, 0.44, 0.42] },
      ],
    },
  } as unknown as TogetherRoundView;
}

beforeEach(() => {
  scenes.derby.length = 0;
  scenes.dogs.length = 0;
  scenes.mounts = 0;
  localStorage.removeItem('salem-game-quality');
});
afterEach(() => {
  cleanup();
  localStorage.removeItem('salem-game-quality');
});

it.each([
  ['horse', 'thunder_derby_3d', 'Derby course', 'Aerial', 'aerial'],
  ['dog', 'neon_hounds_3d', 'Dog course', 'Follow race', 'chase'],
] as const)(
  'keeps the chosen %s camera when Automatic quality steps the group scene down',
  async (_, game, course, label, mode) => {
    const props = () => (game === 'thunder_derby_3d' ? scenes.derby : scenes.dogs).at(-1)!;
    render(
      <TogetherLiveGame
        round={groupRace(game)}
        userId="viewer"
        serverNow={startsAt + 20_000}
        finalResult={null}
      />
    );
    const cameras = within(await screen.findByRole('group', { name: 'Camera view' }));
    expect(props()).toMatchObject({ quality: 'balanced', adaptive: true, cameraMode: 'trackside' });
    fireEvent.click(cameras.getByRole('button', { name: label }));
    expect(props()).toMatchObject({ cameraMode: mode });
    const mountsBefore = scenes.mounts;
    // The scene reports sustained overload: the page drops a tier and remounts the course.
    act(() => (props().onSlow as () => void)());
    await screen.findByText(course);
    expect(scenes.mounts).toBeGreaterThan(mountsBefore);
    expect(props()).toMatchObject({ quality: 'low', cameraMode: mode });
    expect(
      within(screen.getByRole('group', { name: 'Camera view' })).getByRole('button', {
        name: label,
      })
    ).toHaveAttribute('aria-pressed', 'true');
  }
);
