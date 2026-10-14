import { expect, it } from 'vitest';
import { broadcastFov } from './broadcast-fov';
it('widens phone coverage without widening an existing desktop shot or extreme portrait distortion', () => {
  expect(broadcastFov(31, 16 / 9)).toBeCloseTo(31);
  expect(broadcastFov(31, 390 / 600)).toBeGreaterThan(45);
  expect(broadcastFov(38, 390 / 600)).toBeLessThanOrEqual(70);
  expect(broadcastFov(31, 844 / 280)).toBeCloseTo(31);
});
