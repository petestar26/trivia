/** Buffered, velocity-continuous interpolation of published positions. Never extrapolates. */
export function createRaceMotion(initial: number[]) {
  let from = [...initial],
    to = [...initial];
  let velocity = initial.map(() => 0);
  let elapsed = 0,
    duration = 3.5;
  let last: number | undefined, publishedAt: number | undefined;
  return (now: number, positions: number[], snap: boolean) => {
    if (snap) {
      from = [...positions];
      to = [...positions];
      velocity.fill(0);
      elapsed = 0;
      last = now;
      publishedAt = undefined;
      return [...positions];
    }
    // Cap suspended-tab catch-up, while ordinary low frame rates retain their travel.
    elapsed = Math.min(
      duration,
      elapsed + (last === undefined ? 0 : Math.max(0, Math.min(0.25, (now - last) / 1000)))
    );
    last = now;
    const t = elapsed / duration;
    const speeds: number[] = [];
    const current = to.map((target, i) => {
      const distance = target - from[i],
        slope = distance / duration;
      // A monotone cubic joins the previous speed to this segment's average speed.
      // The extra 1.5s buffer covers normal two-second polling jitter without idling.
      const tangent = velocity[i] * duration;
      speeds[i] =
        elapsed === duration
          ? 0
          : ((6 * t * t - 6 * t) * from[i] +
              (-6 * t * t + 6 * t) * target +
              (3 * t * t - 4 * t + 1) * tangent +
              (3 * t * t - 2 * t) * distance) /
            duration;
      return Math.max(
        from[i],
        Math.min(
          target,
          (2 * t * t * t - 3 * t * t + 1) * from[i] +
            (-2 * t * t * t + 3 * t * t) * target +
            (t * t * t - 2 * t * t + t) * tangent +
            (t * t * t - t * t) * slope * duration
        )
      );
    });
    const next = positions.map((position, i) =>
      Number.isFinite(position) ? Math.max(to[i], position) : to[i]
    );
    if (next.some((position, i) => position !== to[i])) {
      duration =
        publishedAt === undefined
          ? 3.5
          : Math.max(3.5, Math.min(5, (now - publishedAt) / 1000 + 1));
      publishedAt = now;
      from = current;
      to = next;
      elapsed = 0;
      velocity = speeds.map((speed, i) =>
        Math.max(0, Math.min(speed, (3 * (to[i] - from[i])) / duration))
      );
    }
    return current;
  };
}
