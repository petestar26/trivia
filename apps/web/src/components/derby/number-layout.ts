export interface DerbyNumberAnchor {
  x: number;
  y: number;
}
export interface DerbyNumberBadge extends DerbyNumberAnchor {
  size: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Presentation only: retain every runner ID and its projected anchor. A badge
 * can move a few pixels with a leader; the horse and published position cannot.
 * The nearest free rectangle keeps tightly packed fields readable without rank
 * sorting, hidden runners, tiny distant numbers or per-frame texture creation. */
export function layoutDerbyNumbers(
  anchors: readonly DerbyNumberAnchor[],
  width: number,
  height: number
): DerbyNumberBadge[] {
  if (!anchors.length || width <= 0 || height <= 0) return [];
  const size = Math.min(28, width / 4, height / 3),
    margin = Math.min(8, width * 0.1, height * 0.1),
    gap = 4,
    pitch = size + gap,
    left = margin + size / 2,
    right = width - left,
    top = margin + size / 2,
    bottom = height - top;
  const result: DerbyNumberBadge[] = [];
  const targets = anchors.map((anchor) => ({
    x: clamp(Number.isFinite(anchor.x) ? anchor.x : width / 2, left, right),
    // Prefer a clear position above the rider rather than covering its body.
    y: clamp((Number.isFinite(anchor.y) ? anchor.y : height / 2) - size / 2 - 3, top, bottom),
  }));
  const available = (x: number, y: number) =>
    result.every(
      (other) => Math.abs(x - other.x) >= pitch - 1e-7 || Math.abs(y - other.y) >= pitch - 1e-7
    );
  for (const target of targets) {
    const xs = [target.x, left, right],
      ys = [target.y, top, bottom];
    for (const prior of result) {
      xs.push(clamp(prior.x - pitch, left, right), clamp(prior.x + pitch, left, right));
      ys.push(clamp(prior.y - pitch, top, bottom), clamp(prior.y + pitch, top, bottom));
    }
    let best: DerbyNumberBadge | undefined,
      bestScore = Infinity;
    // Rectangle boundaries give the closest valid point in each free region.
    // Source order is stable runner ID, never current or future finishing order.
    for (const x of xs)
      for (const y of ys) {
        if (!available(x, y)) continue;
        const score =
          (x - target.x) ** 2 + (y - target.y) ** 2 + Math.max(0, y - target.y) ** 2 * 2;
        if (score < bestScore - 1e-7) {
          best = { x, y, size };
          bestScore = score;
        }
      }
    if (!best) {
      // A regular grid is a deterministic last resort at unusually short
      // canvas sizes. Reflow all badges, preserving IDs and visible leaders.
      const slots: DerbyNumberAnchor[] = [];
      for (let y = top; y <= bottom + 1e-7; y += pitch)
        for (let x = left; x <= right + 1e-7; x += pitch) slots.push({ x, y });
      return targets.map((point) => {
        let chosen = 0,
          distance = Infinity;
        slots.forEach((slot, i) => {
          const d = (point.x - slot.x) ** 2 + (point.y - slot.y) ** 2;
          if (d < distance) {
            chosen = i;
            distance = d;
          }
        });
        const slot = slots.splice(chosen, 1)[0] ?? point;
        return { ...slot, size };
      });
    }
    result.push(best);
  }
  return result;
}
