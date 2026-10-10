import { CONTACT_FRACTION, STRIDE_SECONDS } from './gallop';

/** Advance the gait from displayed travel, never wall-clock time or future race data. */
export function createStrideClock() {
  let seconds = 0;
  // During stance the hoof sweeps 1.04 units backwards. Match it to world travel.
  const strideDistance = 1.04 / CONTACT_FRACTION;
  return (distance: number, moving: boolean) => {
    // Round resets use a new clock. Ignore malformed/unreasonable travel, but
    // retain normal slow-frame travel: the old one-unit cutoff froze the gait.
    if (moving && Number.isFinite(distance) && distance > 0 && distance < 20)
      seconds += (distance / strideDistance) * STRIDE_SECONDS;
    return seconds;
  };
}
