// A decorative loop, independent of match time, fixtures and wallet state.
// Keep it inside the renderer's first half, with a short fade at the loop seam.
export const PREVIEW_LENGTH_MS = 24_000;
export const PREVIEW_START_MS = 2_000;

export function createPreviewClock() {
  let elapsed = 0;
  let started: number | null = null;
  const total = (now: number) => elapsed + (started === null ? 0 : Math.max(0, now - started));
  return {
    resume(now: number) {
      if (started === null) started = now;
    },
    pause(now: number) {
      elapsed = total(now) % PREVIEW_LENGTH_MS;
      started = null;
    },
    frame(now: number) {
      const phase = total(now) % PREVIEW_LENGTH_MS;
      return {
        elapsed: PREVIEW_START_MS + phase,
        opacity: Math.min(1, phase / 650, (PREVIEW_LENGTH_MS - phase) / 650),
      };
    },
  };
}
