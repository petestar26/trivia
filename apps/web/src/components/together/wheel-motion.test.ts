import { expect, it } from 'vitest';
import { stepWheel, wheelTarget } from './wheel-motion';

const frame = {
  progress: 0.71,
  winner: null,
  count: 8,
  clock: 14200,
  duration: 20000,
  reduced: false,
};

it('keeps the displayed angle on the first disclosed-result frame, even after a delayed packet', () => {
  const spinning = stepWheel(null, frame);
  const disclosed = stepWheel(spinning, { ...frame, progress: 1, winner: 5, clock: 23000 });
  expect(disclosed.angle).toBe(spinning.angle);
  expect(disclosed.started).toBe(23000);
  expect(disclosed.to).toBeGreaterThan(disclosed.from + 359);
});

it('moves forward smoothly and stops on every possible winning segment without a snap', () => {
  for (let count = 2; count <= 20; count++) {
    for (let winner = 0; winner < count; winner++) {
      let state = stepWheel(null, { ...frame, count });
      state = stepWheel(state, { ...frame, count, winner, clock: 20000, progress: 1 });
      for (let ms = 30; ms <= 2400; ms += 30) {
        const next = stepWheel(state, { ...frame, count, winner, clock: 20000 + ms, progress: 1 });
        expect(next.angle).toBeGreaterThanOrEqual(state.angle - 1e-8);
        expect(next.angle - state.angle).toBeLessThan(14);
        state = next;
      }
      expect(state.angle % 360).toBeCloseTo(wheelTarget(winner, count));
      expect(stepWheel(state, { ...frame, count, winner, clock: 40000 }).angle).toBe(state.angle);
    }
  }
});

it('holds its angle while the official result is unavailable and never guesses a winner', () => {
  const atDeadline = stepWheel(null, { ...frame, progress: 1 });
  const late = stepWheel(atDeadline, { ...frame, progress: 1, clock: 40000 });
  expect(late.angle).toBe(atDeadline.angle);
  expect(late.winner).toBeNull();
});

it('opens an already completed round at its official result without replaying it', () => {
  const completed = stepWheel(null, { ...frame, winner: 3, progress: 1 });
  expect(completed.angle).toBe(wheelTarget(3, 8));
  expect(completed.from).toBe(completed.to);
});

it('keeps reduced-motion output still before disclosure and shows only the disclosed result', () => {
  const hidden = stepWheel(null, { ...frame, reduced: true });
  expect(hidden.angle).toBe(0);
  expect(hidden.winner).toBeNull();
  expect(stepWheel(hidden, { ...frame, reduced: true, winner: 2 }).angle).toBe(wheelTarget(2, 8));
});
