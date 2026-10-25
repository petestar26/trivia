export interface DerbyNumberAnchor {
  x: number;
  y: number;
}
export interface DerbyNumberBadge extends DerbyNumberAnchor {
  size: number;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const numberMargin = (width: number, height: number) => Math.min(8, width * 0.1, height * 0.1);

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
    margin = numberMargin(width, height),
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

/** Per-scene continuity. Every update treats all other existing badges as
 * obstacles, so the previous point is always a feasible candidate. Choosing the
 * nearest point to a bounded desired step cannot jump to a distant free region.
 * No layout state is shared between races, scenes or viewport sizes. */
export function createDerbyNumberLayout() {
  let previous:
    | { width: number; height: number; anchors: DerbyNumberAnchor[]; badges: DerbyNumberBadge[] }
    | undefined;
  return {
    reset() {
      previous = undefined;
    },
    update(anchors: readonly DerbyNumberAnchor[], width: number, height: number, dt = 1 / 30) {
      if (
        !previous ||
        previous.width !== width ||
        previous.height !== height ||
        previous.badges.length !== anchors.length ||
        dt <= 0
      ) {
        const badges = layoutDerbyNumbers(anchors, width, height);
        previous = {
          width,
          height,
          anchors: anchors.map((p) => ({ ...p })),
          badges: badges.map((p) => ({ ...p })),
        };
        return badges;
      }
      if (
        anchors.every(
          (p, i) =>
            Math.abs(p.x - previous!.anchors[i].x) < 1e-7 &&
            Math.abs(p.y - previous!.anchors[i].y) < 1e-7
        )
      )
        return previous.badges.map((p) => ({ ...p }));
      const size = previous.badges[0]?.size ?? 28,
        margin = numberMargin(width, height),
        left = margin + size / 2,
        right = width - left,
        top = margin + size / 2,
        bottom = height - top,
        pitch = size + 4,
        settle = 1 - Math.exp(-Math.min(dt, 0.25) * 4);
      const badges = previous.badges.map((p) => ({ ...p }));
      anchors.forEach((anchor, i) => {
        const prior = badges[i],
          oldAnchor = previous!.anchors[i];
        const dx = anchor.x - oldAnchor.x,
          dy = anchor.y - oldAnchor.y;
        const target = {
          x: clamp(anchor.x, left, right),
          y: clamp(anchor.y - size / 2 - 3, top, bottom),
        };
        let mx = dx + settle * (target.x - prior.x - dx),
          my = dy + settle * (target.y - prior.y - dy);
        // The prior point remains available; nearest-point movement is at most
        // twice the desired step. Include observed anchor travel in the limit.
        const limit = Math.max(1, Math.hypot(dx, dy) * 2 + 48 * Math.min(dt, 0.25)) / 2,
          distance = Math.hypot(mx, my);
        if (distance > limit) {
          mx *= limit / distance;
          my *= limit / distance;
        }
        const desired = {
          x: clamp(prior.x + mx, left, right),
          y: clamp(prior.y + my, top, bottom),
        };
        const others = badges.filter((_, j) => i !== j),
          xs = [desired.x, prior.x, left, right],
          ys = [desired.y, prior.y, top, bottom];
        for (const other of others) {
          xs.push(clamp(other.x - pitch, left, right), clamp(other.x + pitch, left, right));
          ys.push(clamp(other.y - pitch, top, bottom), clamp(other.y + pitch, top, bottom));
        }
        let best = { ...prior },
          bestScore = (prior.x - desired.x) ** 2 + (prior.y - desired.y) ** 2;
        for (const x of xs)
          for (const y of ys) {
            if (
              !others.every(
                (p) => Math.abs(x - p.x) >= pitch - 1e-7 || Math.abs(y - p.y) >= pitch - 1e-7
              )
            )
              continue;
            const score = (x - desired.x) ** 2 + (y - desired.y) ** 2;
            if (score < bestScore - 1e-10) {
              best = { x, y, size };
              bestScore = score;
            }
          }
        badges[i] = best;
      });
      previous = {
        width,
        height,
        anchors: anchors.map((p) => ({ ...p })),
        badges: badges.map((p) => ({ ...p })),
      };
      return badges;
    },
  };
}
