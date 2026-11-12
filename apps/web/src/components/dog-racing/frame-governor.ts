/**
 * Adaptive rendering governor for the race scene, fed only with measured intervals
 * between frames the scene actually rendered. It never guesses capability from the
 * screen, core count or memory.
 *
 * - Dynamic resolution first: under sustained overload the drawing-buffer scale steps
 *   down (no scene rebuild, no visual pop); with sustained headroom it steps back up.
 * - Separate overload and headroom thresholds plus a settling period after every change
 *   give hysteresis. After each overload the next step up waits longer (15 s, 30 s, …
 *   up to 4 min), so a device sitting at the threshold does not keep probing upward.
 * - Only when the scene is still overloaded at the lowest scale for two consecutive
 *   windows does it ask the page for a lower tier. It never asks for a higher tier: the
 *   player can always choose one, and an automatic climb back would oscillate.
 */
export type GovernorDecision = { scale?: number; tier?: 'down' };

export type GovernorOptions = {
  /** Intended interval between rendered frames, e.g. 33.3 ms for 30 fps. */
  targetMs: number;
  minScale?: number;
  /** Ignore samples for this long after any change or resume. */
  settleMs?: number;
};

const OVERLOAD = 1.45; // p75 above 1.45× target (48 ms at 30 fps) is overload
const HEADROOM = 1.15; // p90 below 1.15× target is comfortable
const PAUSE_MS = 1000; // a gap this long is a pause (hidden tab, scroll, debugger)

export function createFrameGovernor({
  targetMs,
  minScale = 0.6,
  settleMs = 1500,
}: GovernorOptions) {
  let scale = 1,
    settleUntil = -Infinity,
    windowStart = -Infinity,
    overloadedAtFloor = 0,
    comfortable = 0,
    overloads = 0,
    climbAfter = -Infinity;
  const samples: number[] = [];
  const percentile = (sorted: number[], p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  function settle(now: number) {
    samples.length = 0;
    settleUntil = now + settleMs;
    windowStart = -Infinity;
  }

  return {
    get scale() {
      return scale;
    },
    /** Start over after a resume, resize, quality or round change. Keeps the scale. */
    reset(now: number) {
      settle(now);
      overloadedAtFloor = 0;
      comfortable = 0;
    },
    sample(intervalMs: number, now: number): GovernorDecision | null {
      if (!(intervalMs > 0) || intervalMs >= PAUSE_MS) {
        settle(now);
        return null;
      }
      if (now < settleUntil) return null;
      if (windowStart === -Infinity) windowStart = now;
      samples.push(intervalMs);
      if (samples.length < 20 || now - windowStart < 1000) return null;
      const sorted = [...samples].sort((a, b) => a - b);
      samples.length = 0;
      windowStart = now;
      if (percentile(sorted, 0.75) > targetMs * OVERLOAD) {
        comfortable = 0;
        if (scale > minScale + 1e-6) {
          scale = Math.max(minScale, scale * 0.8);
          climbAfter = now + 15000 * 2 ** Math.min(4, overloads++);
          settle(now);
          return { scale };
        }
        if (++overloadedAtFloor >= 2) {
          overloadedAtFloor = 0;
          settle(now);
          return { tier: 'down' };
        }
        return null;
      }
      overloadedAtFloor = 0;
      if (percentile(sorted, 0.9) < targetMs * HEADROOM) {
        if (++comfortable >= 3 && scale < 1 && now >= climbAfter) {
          comfortable = 0;
          scale = Math.min(1, scale * 1.12);
          settle(now);
          return { scale };
        }
      } else comfortable = 0;
      return null;
    },
  };
}
export type FrameGovernor = ReturnType<typeof createFrameGovernor>;
