import { VF_DOMAIN, VF_TIMING } from './constants.js';
import { sha256Bytes } from './hash.js';

const T = VF_TIMING;

export type CyclePhase = 'SELECTION' | 'FIRST_HALF' | 'HALFTIME' | 'SECOND_HALF' | 'RESULTS';

export interface Cycle {
  index: number;
  seasonNo: number;
  weekNo: number;
  opensAt: number;
  kickoffAt: number;
  halftimeAt: number;
  secondHalfAt: number;
  fullTimeAt: number;
  endsAt: number;
}

/** Timestamps are server milliseconds. The browser clock is never an authority. */
export function cycleByIndex(index: number): Cycle {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Cycle index out of range');
  const opensAt = T.anchorMs + index * T.cycleMs;
  const kickoffAt = opensAt + T.selectionMs;
  return {
    index,
    seasonNo: Math.floor(index / T.weeksPerSeason) + 1,
    weekNo: (index % T.weeksPerSeason) + 1,
    opensAt,
    kickoffAt,
    halftimeAt: kickoffAt + T.firstHalfMs,
    secondHalfAt: kickoffAt + T.firstHalfMs + T.halftimeMs,
    fullTimeAt: kickoffAt + T.matchMs,
    endsAt: opensAt + T.cycleMs,
  };
}

/** The cycle that contains `ms`, or null before the first season anchor. */
export function cycleAt(ms: number): Cycle | null {
  if (ms < T.anchorMs) return null;
  return cycleByIndex(Math.floor((ms - T.anchorMs) / T.cycleMs));
}

export function cycleBySeasonWeek(seasonNo: number, weekNo: number): Cycle {
  if (!Number.isInteger(seasonNo) || seasonNo < 1) throw new RangeError('Season out of range');
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > T.weeksPerSeason)
    throw new RangeError('Matchweek out of range');
  return cycleByIndex((seasonNo - 1) * T.weeksPerSeason + weekNo - 1);
}

export function phaseAt(cycle: Cycle, ms: number): CyclePhase | 'BEFORE' | 'AFTER' {
  if (ms < cycle.opensAt) return 'BEFORE';
  if (ms < cycle.kickoffAt) return 'SELECTION';
  if (ms < cycle.halftimeAt) return 'FIRST_HALF';
  if (ms < cycle.secondHalfAt) return 'HALFTIME';
  if (ms < cycle.fullTimeAt) return 'SECOND_HALF';
  if (ms < cycle.endsAt) return 'RESULTS';
  return 'AFTER';
}

export const matchweekId = (seasonNo: number, weekNo: number) =>
  `vf-s${seasonNo}-w${String(weekNo).padStart(2, '0')}`;
export const fixtureId = (matchweekIdValue: string, slot: number) =>
  `${matchweekIdValue}-f${String(slot).padStart(2, '0')}`;
export const MATCHWEEK_ID = /^vf-s[1-9]\d{0,5}-w(0[1-9]|[1-2]\d|3[0-8])$/;
export const FIXTURE_ID = /^vf-s[1-9]\d{0,5}-w(0[1-9]|[1-2]\d|3[0-8])-f(0[1-9]|10)$/;

export function parseMatchweekId(id: string) {
  if (!MATCHWEEK_ID.test(id)) return null;
  const [, season, week] = /^vf-s(\d+)-w(\d+)$/.exec(id)!;
  return { seasonNo: Number(season), weekNo: Number(week) };
}

export interface ScheduledFixture {
  slot: number;
  homeClub: number;
  awayClub: number;
}

/** Public, unbiased integer in [0, n) from a SHA-256 stream. Not a secrecy mechanism. */
function publicBelow(label: string, counter: { n: number }, bound: number) {
  const limit = Math.floor(0x100000000 / bound) * bound;
  for (;;) {
    const value = new DataView(
      sha256Bytes(`${VF_DOMAIN}|schedule|${label}|${counter.n++}`).buffer
    ).getUint32(0);
    if (value < limit) return value % bound;
  }
}

/**
 * Deterministic double round-robin for one season (vf3d-schedule-v1):
 *  1. shuffle clubs 1..20 with a public hash-driven Fisher-Yates keyed by the season number;
 *  2. circle method gives weeks 1-19 (every club exactly once per week, every pair once);
 *  3. weeks 20-38 repeat weeks 1-19 with home and away reversed;
 *  4. fixtures inside a week are ordered by a public hash so slot 1 varies.
 * The result is a pure function of the season number, so it can be recomputed anywhere.
 */
const scheduleCache = new Map<number, ScheduledFixture[][]>();
export function seasonSchedule(seasonNo: number): ScheduledFixture[][] {
  if (!Number.isInteger(seasonNo) || seasonNo < 1) throw new RangeError('Season out of range');
  const cached = scheduleCache.get(seasonNo);
  if (cached) return cached;
  const counter = { n: 0 };
  const clubs = Array.from({ length: T.clubCount }, (_, i) => i + 1);
  for (let i = clubs.length - 1; i > 0; i--) {
    const j = publicBelow(`shuffle|${seasonNo}`, counter, i + 1);
    [clubs[i], clubs[j]] = [clubs[j], clubs[i]];
  }
  const rotating = clubs.slice(0, T.clubCount - 1);
  const fixed = clubs[T.clubCount - 1];
  const first: Array<Array<[number, number]>> = [];
  for (let round = 0; round < T.clubCount - 1; round++) {
    const ring = rotating.map((_, i) => rotating[(i + round) % rotating.length]);
    const arrangement = [fixed, ...ring];
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < T.fixturesPerWeek; i++) {
      const a = arrangement[i];
      const b = arrangement[T.clubCount - 1 - i];
      // Alternating by round (not by pair index) keeps every club's venue run short.
      pairs.push(round % 2 === 0 ? [a, b] : [b, a]);
    }
    first.push(pairs);
  }
  const weeks = [
    ...first,
    ...first.map((pairs) => pairs.map(([h, a]): [number, number] => [a, h])),
  ];
  const result = weeks.map((pairs, weekIndex) =>
    pairs
      .map(([homeClub, awayClub]) => ({
        homeClub,
        awayClub,
        order: Array.from(
          sha256Bytes(`${VF_DOMAIN}|slot|${seasonNo}|${weekIndex + 1}|${homeClub}|${awayClub}`)
        )
          .slice(0, 6)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      }))
      .sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0))
      .map((fixture, i) => ({
        slot: i + 1,
        homeClub: fixture.homeClub,
        awayClub: fixture.awayClub,
      }))
  );
  if (scheduleCache.size > 8) scheduleCache.clear();
  scheduleCache.set(seasonNo, result);
  return result;
}

export function scheduledWeek(seasonNo: number, weekNo: number): ScheduledFixture[] {
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > T.weeksPerSeason)
    throw new RangeError('Matchweek out of range');
  return seasonSchedule(seasonNo)[weekNo - 1];
}
