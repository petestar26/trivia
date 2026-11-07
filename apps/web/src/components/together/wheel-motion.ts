export interface WheelMotion {
  angle: number;
  winner: number | null;
  from: number;
  to: number;
  started: number;
}
const mod = (n: number) => ((n % 360) + 360) % 360;
export const wheelTarget = (winner: number, count: number) =>
  mod((-(winner + 0.5) * 360) / Math.max(1, count));

/** The stopping flourish starts only AFTER disclosure. No future winner is needed.
 * Its clock affects artwork only; official result and settlement are never delayed.
 * The release frame keeps the last displayed angle, including after late packets. */
export function stepWheel(
  old: WheelMotion | null,
  input: {
    progress: number;
    winner: number | null;
    count: number;
    clock: number;
    duration: number;
    reduced: boolean;
  }
): WheelMotion {
  const { winner, clock, count } = input;
  if (input.reduced || (!old && winner !== null)) {
    const angle = winner === null ? 0 : wheelTarget(winner, count);
    return { angle, winner, from: angle, to: angle, started: clock - 2400 };
  }
  if (winner === null) {
    const angle = Math.max(old?.angle ?? 0, input.progress * 2160);
    return { angle, winner, from: angle, to: angle, started: clock };
  }
  if (old!.winner === null) {
    const from = old!.angle;
    return {
      angle: from,
      winner,
      from,
      to: from + 360 + mod(wheelTarget(winner, count) - from),
      started: clock,
    };
  }
  const s = old!,
    t = Math.min(1, Math.max(0, (clock - s.started) / 2400));
  const velocity = (2160 / Math.max(1, input.duration)) * 2400;
  // Cubic Hermite: matching entry velocity, zero exit velocity, forward-only arc.
  const angle =
    (2 * t ** 3 - 3 * t ** 2 + 1) * s.from +
    (t ** 3 - 2 * t ** 2 + t) * velocity +
    (-2 * t ** 3 + 3 * t ** 2) * s.to;
  return { ...s, angle: t === 1 ? s.to : angle };
}
