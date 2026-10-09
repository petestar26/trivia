/** Interpolate only between positions already published by the server. Never extrapolate. */
export function createRaceMotion(initial: number[]) {
  let from = [...initial],
    to = [...initial],
    started = 0;
  const at = (now: number) => {
    const t = Math.max(0, Math.min(1, (now - started) / 2000));
    return to.map((target, i) => from[i] + (target - from[i]) * t);
  };
  return (now: number, positions: number[], snap: boolean) => {
    if (snap) {
      from = [...positions];
      to = [...positions];
      started = now;
      return [...positions];
    }
    const current = at(now);
    if (positions.some((position, i) => position !== to[i])) {
      from = current;
      to = [...positions];
      started = now;
    }
    return current;
  };
}
