import { createHash } from 'node:crypto';
/** Rejection sampling gives a uniform integer over 1..1e9, reproducible after reveal. */
export function skyCrashDraw(seed: string) {
  for (let counter = 0; ; counter++) {
    const n = createHash('sha256').update(`${seed}:${counter}`).digest().readUInt32BE(0);
    if (n < 4000000000) return (n % 1000000000) + 1;
  }
}
export function skyCrashOutcome(seed: string) {
  return Math.min(2001, Math.max(100, Math.ceil(90000000000 / skyCrashDraw(seed))));
}
export function skyCrashCommitment(id: string, seed: string) {
  return createHash('sha256').update(`${id}:${seed}`).digest('hex');
}
