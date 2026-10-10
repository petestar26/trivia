import { describe, expect, it } from 'vitest';
import { createRaceMotion } from './race-motion';
describe('server position presentation', () => {
  it('joins a race at its published position, not at the start line', () => {
    expect(createRaceMotion([0.5, 0.48])(100, [0.5, 0.48], false)).toEqual([0.5, 0.48]);
  });
  it('keeps moving across a delayed polling interval without a two-second hard stop', () => {
    const move = createRaceMotion([0]);
    let previous = 0;
    for (let time = 0; time <= 3400; time += 50) {
      const current = move(time, [10], false)[0];
      if (time > 0) expect(current).toBeGreaterThan(previous);
      expect(current).toBeLessThanOrEqual(10);
      previous = current;
    }
  });
  it('does not extrapolate missing updates or move backwards on old samples', () => {
    const move = createRaceMotion([2, 3]);
    let current = [2, 3];
    for (let time = 0; time <= 20000; time += 50) current = move(time, [3, 4], false);
    expect(current[0]).toBeCloseTo(3);
    expect(current[1]).toBeCloseTo(4);
    expect(move(20100, [2, 3], false)).toEqual(current);
  });
  it('preserves velocity across a fresh target instead of restarting or teleporting', () => {
    const move = createRaceMotion([0]);
    let previous = 0,
      step = 0;
    for (let time = 0; time <= 1950; time += 50) {
      const current = move(time, [10], false)[0];
      step = current - previous;
      previous = current;
    }
    const next = move(2000, [20], false)[0];
    expect(next).toBeGreaterThan(previous);
    expect(next - previous).toBeLessThan(step + 0.2);
  });
  it('bounds catch-up after a suspended tab and ignores malformed positions', () => {
    const move = createRaceMotion([0]);
    move(0, [100], false);
    const next = move(60000, [100], false)[0];
    expect(next).toBeLessThan(20);
    expect(Number.isFinite(move(60050, [NaN], false)[0])).toBe(true);
  });
  it('shows exact official positions when stopped or reduced motion is selected', () => {
    const move = createRaceMotion([0]);
    move(0, [0.5], false);
    expect(move(200, [1], true)).toEqual([1]);
    expect(move(500, [1], false)).toEqual([1]);
  });
});
