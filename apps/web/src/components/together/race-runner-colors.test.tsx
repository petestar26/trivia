import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DERBY_HORSES,
  RACING_DOGS,
  TOGETHER_FEE_POLICY,
  TOGETHER_RULES_ID,
  type TogetherGame,
  type TogetherRoundView,
} from '@socialplay/shared';
import { contrastRatio, runnerLook } from '@/components/derby/runner-identity';
import { MIN_INK_CONTRAST, raceRunnerColor } from './race-runner-colors';
import { RaceBroadcast2D } from './lightweight-sports';
import { TogetherLiveGame } from './together-live-game';

vi.mock('./shared-race-scene', () => ({ default: () => <div>3D course</div> }));
afterEach(cleanup);

/** The colour and number ink each 3D course draws for runner `i`. */
const scene = {
  // Derby saddle cloths, silks and number badges.
  horses: (i: number) => ({ color: runnerLook(i).cloth, ink: runnerLook(i).ink }),
  // Dog jackets, trap faces and course-map dots.
  dogs: (i: number) => ({ color: RACING_DOGS[i].color, ink: RACING_DOGS[i].ink }),
};
const games = [
  { name: 'Horse Racing', game: 'thunder_derby_3d', dogs: false, scene: scene.horses },
  { name: 'Dog Racing', game: 'neon_hounds_3d', dogs: true, scene: scene.dogs },
] as const;
const positions = [0.42, 0.47, 0.39, 0.51, 0.44, 0.36, 0.49, 0.4];

function round(game: TogetherGame): TogetherRoundView {
  return {
    id: 'race',
    groupId: 'group',
    creatorId: 'me',
    groupName: 'Friends',
    game,
    currency: 'GAME_POINTS',
    entryAmount: 1000,
    feeBps: 700,
    settingsVersion: 1,
    minPlayers: 2,
    maxPlayers: 20,
    closesAt: 1000,
    rulesId: TOGETHER_RULES_ID,
    feePolicy: TOGETHER_FEE_POLICY,
    seedCommitment: 'ab'.repeat(32),
    beaconRound: 1,
    state: 'DRAWN',
    termsHash: 'cd'.repeat(32),
    rosterHash: 'ef'.repeat(32),
    entries: [],
    outcome: null,
    ranking: [],
    settlement: null,
    voidReason: null,
    proof: null,
    recoveryDeadline: 90000,
    paidAt: null,
    presentation: {
      version: 2,
      startsAt: 10000,
      finishesAt: 50000,
      observedAt: 25000,
      resultAvailable: false,
      events: [{ atMs: 15000, kind: 'race', positions }],
    },
  };
}

describe.each(games)('group $name runner colours', ({ game, dogs, scene }) => {
  it('uses the 3D course colours with AA ink for every runner', () => {
    for (let i = 0; i < 8; i++) {
      const runner = raceRunnerColor(dogs, i);
      expect(runner.color).toBe(scene(i).color);
      expect(contrastRatio(runner.color, runner.ink)).toBeGreaterThanOrEqual(MIN_INK_CONTRAST);
      // The course's own ink is kept wherever it is already legible.
      if (contrastRatio(scene(i).color, scene(i).ink) >= MIN_INK_CONTRAST)
        expect(runner.ink).toBe(scene(i).ink);
    }
    if (!dogs)
      DERBY_HORSES.forEach((h, i) => expect(raceRunnerColor(false, i).color).toBe(h.color));
  });

  it('draws numbers in the same ink as the 3D course (the black/white fallback is only a guard)', () => {
    for (let i = 0; i < 8; i++) expect(raceRunnerColor(dogs, i)).toEqual(scene(i));
  });

  it('colours the race-order strip by runner number, not by place', async () => {
    const { container } = render(
      <TogetherLiveGame round={round(game)} userId="me" serverNow={25000} finalResult={null} />
    );
    // The strip sits under the (lazy) 3D course.
    await screen.findByText('3D course');
    const badges = [...container.querySelectorAll('.tg-race-order b')];
    expect(badges).toHaveLength(8);
    // Listed in race order, so place and runner number differ.
    expect(badges.map((b) => b.textContent)).toEqual(['4', '7', '2', '5', '1', '8', '3', '6']);
    for (const badge of badges) {
      const { color, ink } = raceRunnerColor(dogs, Number(badge.textContent) - 1);
      expect(badge).toHaveStyle({ backgroundColor: color, color: ink });
    }
  });

  it('colours the 2D fallback runners the same way', () => {
    const { container } = render(
      <RaceBroadcast2D positions={positions} dogs={dogs} elapsed={14000} reduced />
    );
    const runners = [...container.querySelectorAll('svg > g[transform]')];
    expect(runners).toHaveLength(8);
    runners.forEach((g, i) => {
      const { color, ink } = scene(i);
      expect(g.querySelector('rect')).toHaveAttribute('fill', color);
      expect(g.querySelector('text')).toHaveTextContent(String(i + 1));
      expect(g.querySelector('text')).toHaveAttribute('fill', raceRunnerColor(dogs, i).ink);
      // Jacket or silks and cap carry the same colour as the number plate.
      expect(g.querySelectorAll(`path[fill="${color}"]`).length).toBeGreaterThan(0);
      if (contrastRatio(color, ink) >= MIN_INK_CONTRAST)
        expect(g.querySelector('text')).toHaveAttribute('fill', ink);
    });
  });
});
