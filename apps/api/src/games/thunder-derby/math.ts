import { createHash } from 'node:crypto';
import { DERBY_RULES, type DerbyField } from '@socialplay/shared';
export function derbyCommitment(id: string, seed: string) {
  return createHash('sha256').update(`${DERBY_RULES.id}:${id}:${seed}`).digest('hex');
}
/** Fisher-Yates with rejection sampling. Every finish permutation has equal probability. */
export function derbyOrder(seed: string, field: DerbyField) {
  const order = Array.from({ length: field }, (_, i) => i + 1);
  let counter = 0;
  for (let i = field - 1; i > 0; i--) {
    const size = i + 1,
      limit = Math.floor(0x100000000 / size) * size;
    let value: number;
    do {
      value = createHash('sha256')
        .update(`${DERBY_RULES.id}:${seed}:${counter++}`)
        .digest()
        .readUInt32BE(0);
    } while (value >= limit);
    const j = value % size;
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
/** Only present progress is public during the race. Final order and seed remain private. */
export function derbyPositions(order: number[], elapsed: number, seed: string) {
  const t = Math.max(0, Math.min(1, elapsed / DERBY_RULES.raceMs));
  const frame = Math.floor(Math.max(0, elapsed) / 1500),
    fraction = (Math.max(0, elapsed) % 1500) / 1500;
  const smooth = fraction * fraction * (3 - 2 * fraction);
  return Array.from({ length: order.length }, (_, i) => {
    const rank = order.indexOf(i + 1);
    // Independent private motion noise prevents an early position from being an
    // algebraic encoding of the final rank. Only present positions are published.
    const noise = (step: number) =>
      createHash('sha256').update(`${seed}:motion:${i}:${step}`).digest().readUInt32BE(0) /
        0xffffffff -
      0.5;
    const stride =
      (noise(frame) * (1 - smooth) + noise(frame + 1) * smooth) * Math.sin(t * Math.PI) * 0.012;
    const surge = Math.pow(t, 12) * rank * 0.006;
    return Math.max(0, Math.min(1.06, t * 1.06 - surge + stride));
  });
}
