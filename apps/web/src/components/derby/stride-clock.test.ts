import { describe, it, expect } from 'vitest';
import { createStrideClock } from './stride-clock';
import { gallopPose } from './gallop';

describe('travel driven stride', () => {
  it('holds each planted hoof in world space as the horse moves', () => {
    const clock = createStrideClock();
    let x = 0;
    let previous = gallopPose(0, 0, true);
    for (let i = 0; i < 1600; i++) {
      const distance = 0.012 + (i % 7) * 0.001;
      const pose = gallopPose(clock(distance, true), 0, true);
      pose.feet.forEach((foot, leg) => {
        if (foot.contact && previous.feet[leg].contact)
          expect(x + distance + foot.x).toBeCloseTo(x + previous.feet[leg].x, 7);
      });
      x += distance;
      previous = pose;
    }
  });
  it('retains the same gait phase across slow frames', () => {
    const slow = createStrideClock(),
      fast = createStrideClock();
    const expected = Array.from({ length: 20 }, () => fast(0.1, true)).at(-1);
    expect(slow(2, true)).toBeCloseTo(expected!);
  });
  it('does not animate resets, pauses, jumps or invalid samples', () => {
    const clock = createStrideClock();
    const before = clock(0.1, true);
    for (const d of [-2, 0, 100, NaN, Infinity]) expect(clock(d, true)).toBe(before);
    expect(clock(0.2, false)).toBe(before);
  });
});
