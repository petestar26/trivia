import { expect, it } from 'vitest';
import { createPreviewClock, PREVIEW_LENGTH_MS, PREVIEW_START_MS } from './preview-clock';

it('freezes the football timeline while paused or offscreen and resumes without a jump', () => {
  const clock = createPreviewClock();
  clock.resume(100);
  expect(clock.frame(1100).elapsed).toBe(PREVIEW_START_MS + 1000);
  clock.pause(1100);
  expect(clock.frame(60_000).elapsed).toBe(PREVIEW_START_MS + 1000);
  clock.resume(60_000);
  clock.resume(60_500); // Repeated activation must not reset the origin.
  expect(clock.frame(61_000).elapsed).toBe(PREVIEW_START_MS + 2000);
});

it('covers the loop seam and never enters half-time or a full-time result', () => {
  const clock = createPreviewClock();
  clock.resume(0);
  expect(clock.frame(0).opacity).toBe(0);
  expect(clock.frame(PREVIEW_LENGTH_MS - 1).opacity).toBeLessThan(0.01);
  expect(clock.frame(PREVIEW_LENGTH_MS).opacity).toBe(0);
  expect(clock.frame(PREVIEW_LENGTH_MS + 650).opacity).toBe(1);
  for (let time = 0; time < 3_600_000; time += 137) {
    expect(clock.frame(time).elapsed).toBeGreaterThanOrEqual(PREVIEW_START_MS);
    expect(clock.frame(time).elapsed).toBeLessThan(28_000);
  }
});
