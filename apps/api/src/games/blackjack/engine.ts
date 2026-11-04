import { randomInt } from 'node:crypto';
import { bjTotal, bjCategory, bjResult, bjKey, BJ_MARKETS } from '@socialplay/shared';
export type PickIndex = (max: number) => number;
const fresh = () => Array.from({ length: 312 }, (_, i) => i);
/** Only released cards are persisted. No later cards or future outcomes exist in a round yet. */
export function advanceHands(
  previous: number[][],
  stage: number,
  pick: PickIndex = randomInt
): number[][] {
  const hands = previous.map((h) => [...h]);
  const used = new Set(hands.flat());
  const pool = fresh().filter((c) => !used.has(c));
  const take = () => {
    if (!pool.length) throw Error('Shoe exhausted');
    const i = pick(pool.length),
      c = pool[i];
    pool[i] = pool[pool.length - 1];
    pool.pop();
    return c;
  };
  if (stage <= 1) for (const h of hands) h.push(take());
  else if (stage === 2)
    for (const h of hands) {
      if (bjTotal(h).total < 17) h.push(take());
    }
  else for (const h of hands) while (bjTotal(h).total < 17) h.push(take());
  return hands;
}
/** Prices estimate only the public state, never the next actual draw. Stored at each stage. */
export function priceHands(
  hands: number[][],
  stage: number,
  samples = 6000,
  pick: PickIndex = randomInt
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < samples; i++) {
    let final = hands;
    for (let next = stage + 1; next <= 3; next++) final = advanceHands(final, next, pick);
    for (let seat = 0; seat < 7; seat++) {
      const point = bjKey(seat, bjCategory(final[seat]));
      counts[point] = (counts[point] ?? 0) + 1;
      if (seat) {
        const outcome = bjKey(seat, bjResult(final[seat], final[0]));
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
    }
  }
  const quotes: Record<string, number> = {};
  for (let seat = 0; seat < 7; seat++)
    for (const market of BJ_MARKETS) {
      const key = bjKey(seat, market),
        n = counts[key] ?? 0;
      // Resolved and unobserved outcomes are closed. Approximate practice prices, not a promised RTP.
      const odds = n > 0 && n < samples ? Math.min(20000, Math.floor((92 * samples) / n)) : 0;
      if (odds >= 101) quotes[key] = odds;
    }
  return quotes;
}
