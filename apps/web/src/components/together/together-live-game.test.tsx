import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DERBY_HORSES, RACING_DOGS, type TogetherRoundView } from '@socialplay/shared';
import { TogetherLiveGame } from './together-live-game';
import { RaceBroadcast2D } from './lightweight-sports';
import { raceRunnerColors } from './race-runners';
import { contrastRatio, runnerLook } from '@/components/derby/runner-identity';

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
vi.mock('@/components/dog-racing/race-scene', () => ({
  default: (props: Record<string, unknown>) => {
    scenes.dogs.push(props);
    return <div>Dog course</div>;
  },
}));

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
function hex(rgb: string) {
  return (
    '#' +
    rgb
      .match(/\d+/g)!
      .slice(0, 3)
      .map((v) => Number(v).toString(16).padStart(2, '0'))
      .join('')
  );
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

it('keeps the chosen horse camera when Automatic quality steps the group scene down', async () => {
  render(
    <TogetherLiveGame
      round={groupRace('thunder_derby_3d')}
      userId="viewer"
      serverNow={startsAt + 20_000}
      finalResult={null}
    />
  );
  const cameras = within(await screen.findByRole('group', { name: 'Camera view' }));
  expect(scenes.derby.at(-1)).toMatchObject({ quality: 'balanced', adaptive: true });
  fireEvent.click(cameras.getByRole('button', { name: 'Aerial' }));
  expect(scenes.derby.at(-1)).toMatchObject({ cameraMode: 'aerial' });
  const mountsBefore = scenes.mounts;
  // The scene reports sustained overload: the page drops a tier and remounts the course.
  act(() => (scenes.derby.at(-1)!.onSlow as () => void)());
  await screen.findByText('Derby course');
  expect(scenes.mounts).toBeGreaterThan(mountsBefore);
  expect(scenes.derby.at(-1)).toMatchObject({ quality: 'low', cameraMode: 'aerial' });
  expect(
    within(screen.getByRole('group', { name: 'Camera view' })).getByRole('button', {
      name: 'Aerial',
    })
  ).toHaveAttribute('aria-pressed', 'true');
});

it('colours the group race-order strip like the runners on each 3D course', async () => {
  for (const game of ['thunder_derby_3d', 'neon_hounds_3d'] as const) {
    render(
      <TogetherLiveGame
        round={groupRace(game)}
        userId="viewer"
        serverNow={startsAt + 20_000}
        finalResult={null}
      />
    );
    await screen.findByRole('group', { name: 'Camera view' });
    const badges = [...document.querySelectorAll<HTMLElement>('.tg-race-order b')];
    expect(badges).toHaveLength(8);
    for (const badge of badges) {
      const runner = Number(badge.textContent) - 1;
      const palette = game === 'thunder_derby_3d' ? DERBY_HORSES : RACING_DOGS;
      expect(hex(badge.style.background)).toBe(palette[runner].color.toLowerCase());
      expect(hex(badge.style.color)).toBe(
        raceRunnerColors(game !== 'thunder_derby_3d', runner).ink
      );
    }
    cleanup();
  }
});

it('uses the same runner colours and number ink in the 2D race broadcast', () => {
  for (const dogs of [false, true]) {
    const { container } = render(
      <RaceBroadcast2D positions={Array(8).fill(0.5)} dogs={dogs} elapsed={1000} reduced />
    );
    const cloths = [...container.querySelectorAll('rect[stroke="#fff8"]')];
    const numbers = cloths.map((r) => r.nextElementSibling!);
    expect(cloths).toHaveLength(8);
    cloths.forEach((cloth, i) => {
      expect(cloth.getAttribute('fill')).toBe(raceRunnerColors(dogs, i).color);
      expect(numbers[i].getAttribute('fill')).toBe(raceRunnerColors(dogs, i).ink);
      expect(numbers[i].textContent).toBe(String(i + 1));
    });
    cleanup();
  }
});

it('matches each course’s own palette, by runner number only', () => {
  for (let i = 0; i < 8; i++) {
    const horse = raceRunnerColors(false, i);
    expect(horse).toEqual({ color: runnerLook(i).cloth, ink: runnerLook(i).ink });
    expect(horse.color).toBe(DERBY_HORSES[i].color);
    expect(contrastRatio(horse.color, horse.ink)).toBeGreaterThanOrEqual(4.5);
    expect(raceRunnerColors(true, i)).toEqual({
      color: RACING_DOGS[i].color,
      ink: RACING_DOGS[i].ink,
    });
  }
});
