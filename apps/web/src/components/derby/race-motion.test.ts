import { describe, expect, it } from 'vitest';
import { createRaceMotion } from './race-motion';
describe('server position presentation', () => {
  it('joins a race at its published position, not at the start line', () => {
    expect(createRaceMotion([0.5, 0.48])(100, [0.5, 0.48], false)).toEqual([0.5, 0.48]);
  });
  it('advances evenly between updates instead of rushing then standing still', () => {
    const move = createRaceMotion([0]);
    move(0, [0.1], false);
    expect(move(500, [0.1], false)[0]).toBeCloseTo(0.025);
    expect(move(1000, [0.1], false)[0]).toBeCloseTo(0.05);
    expect(move(1500, [0.1], false)[0]).toBeCloseTo(0.075);
    expect(move(2000, [0.2], false)[0]).toBeCloseTo(0.1);
    expect(move(2500, [0.2], false)[0]).toBeCloseTo(0.125);
  });
  it('stops at the last known location on missing updates', () => {
    const move = createRaceMotion([0.2, 0.3]);
    move(0, [0.3, 0.4], false);
    expect(move(6000, [0.3, 0.4], false)).toEqual([0.3, 0.4]);
  });
  it('retargets from the displayed position with no teleport on an early update', () => {
    const move = createRaceMotion([0]);
    move(0, [0.1], false);
    expect(move(1000, [0.2], false)[0]).toBeCloseTo(0.05);
    expect(move(2000, [0.2], false)[0]).toBeCloseTo(0.125);
  });
  it('shows exact official positions when stopped or reduced motion is selected', () => {
    const move = createRaceMotion([0]);
    move(0, [0.5], false);
    expect(move(200, [1], true)).toEqual([1]);
    expect(move(500, [1], false)).toEqual([1]);
  });
});
