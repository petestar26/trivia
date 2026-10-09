import { VF_DOMAIN, VF_MODEL_ID, VF_RULES_DIGEST, VF_RULES_ID, VF_TIMING } from './constants.js';
import { canonicalJson, sha256Bytes, sha256Hex } from './hash.js';
import {
  fixtureOffer,
  scoreWeights,
  type FirstScorer,
  type FixtureParams,
  type Outcome,
  type Side,
} from './model.js';

/** One goal. `atMs` is milliseconds after kickoff on the server's match clock. */
export interface Goal {
  n: number;
  side: Side;
  half: 1 | 2;
  atMs: number;
}

/** Goal minutes sit on a 500 ms grid, at least 1.5 s from each half boundary. */
export const VF_GOAL_GRID = Object.freeze({
  slotMs: 500,
  firstSlotOffsetMs: 1500,
  usableSlots: 51,
  /** Consecutive goals in one half are at least gapSlots * slotMs = 4 s apart. */
  gapSlots: 8,
  secondHalfStartMs: VF_TIMING.firstHalfMs + VF_TIMING.halftimeMs,
});

/* ------------------------------------------------------------------------------------- *
 * Seeds, commitments and domain separation
 * ------------------------------------------------------------------------------------- */
export const HEX64 = /^[a-f0-9]{64}$/;

/** Independent stream per fixture: the matchweek seed is never used directly. */
export function fixtureSeed(matchweek: string, fixture: string, matchweekSeed: string) {
  return sha256Hex(`${VF_DOMAIN}|fixture-seed|${matchweek}|${fixture}|${matchweekSeed}`);
}
/**
 * Binds the fixture identity, model version, the public strength parameters and offered
 * prices (via the offer digest) and the private seed. Published before admission opens.
 */
export function fixtureCommitment(fixture: string, seed: string, offerDigest: string) {
  return sha256Hex(
    `${VF_DOMAIN}|fixture-commitment|${VF_MODEL_ID}|${fixture}|${offerDigest}|${seed}`
  );
}
export function matchweekCommitment(matchweek: string, fixtureCommitments: string[]) {
  return sha256Hex(
    canonicalJson({
      domain: `${VF_DOMAIN}|matchweek-commitment`,
      rules: VF_RULES_ID,
      rulesDigest: VF_RULES_DIGEST,
      model: VF_MODEL_ID,
      matchweek,
      fixtures: fixtureCommitments,
    })
  );
}

interface Stream {
  word(): number;
}
function stream(seed: string, label: string): Stream {
  let counter = 0;
  return {
    word() {
      const digest = sha256Bytes(`${VF_DOMAIN}|stream|${seed}|${label}|${counter++}`);
      return new DataView(digest.buffer, digest.byteOffset).getUint32(0);
    },
  };
}

/** Unbiased integer in [0, n) by rejection sampling over whole 32-bit words. */
export function randBelow(s: Stream, n: bigint): bigint {
  if (n <= 0n) throw new RangeError('Bound must be positive');
  if (n === 1n) return 0n;
  let words = 1;
  while (2n ** BigInt(32 * words) < n) words++;
  const space = 2n ** BigInt(32 * words);
  const limit = (space / n) * n;
  for (;;) {
    let value = 0n;
    for (let i = 0; i < words; i++) value = (value << 32n) | BigInt(s.word());
    if (value < limit) return value % n;
  }
}

/** Uniform k-subset of {0..m-1} by Floyd's algorithm. */
function subset(s: Stream, m: number, k: number) {
  const chosen = new Set<number>();
  for (let j = m - k; j < m; j++) {
    const t = Number(randBelow(s, BigInt(j + 1)));
    chosen.add(chosen.has(t) ? j : t);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** Strictly increasing goal times for one half, at least gapSlots apart. */
function halfTimes(s: Stream, goals: number, offsetMs: number) {
  if (goals === 0) return [];
  const { slotMs, firstSlotOffsetMs, usableSlots, gapSlots } = VF_GOAL_GRID;
  const m = usableSlots - (goals - 1) * (gapSlots - 1);
  return subset(s, m, goals).map(
    (slot, i) => offsetMs + firstSlotOffsetMs + (slot + i * (gapSlots - 1)) * slotMs
  );
}

export interface Timeline extends Outcome {
  goals: Goal[];
}

export function outcomeOfGoals(goals: Goal[]): Outcome {
  const count = (side: Side, half?: 1 | 2) =>
    goals.filter((g) => g.side === side && (half === undefined || g.half === half)).length;
  const ordered = [...goals].sort((a, b) => a.atMs - b.atMs);
  return {
    ftHome: count('H'),
    ftAway: count('A'),
    htHome: count('H', 1),
    htAway: count('A', 1),
    first: (ordered[0]?.side ?? 'N') as FirstScorer,
  };
}

/**
 * Generates the whole official fixture from one 256-bit fixture seed (vf3d-score-model-v1):
 * weighted full-time score, fair half assignment per goal, uniform order inside each half,
 * strictly increasing goal times. Every market is derived from this one timeline.
 */
export function generateTimeline(seed: string, params: FixtureParams): Timeline {
  if (!HEX64.test(seed)) throw new RangeError('Seed must be 64 lowercase hex characters');
  const cells = scoreWeights(params);
  const total = cells.reduce((sum, cell) => sum + cell.weight, 0n);
  let pick = randBelow(stream(seed, 'score'), total);
  let cell = cells[cells.length - 1];
  for (const candidate of cells) {
    if (pick < candidate.weight) {
      cell = candidate;
      break;
    }
    pick -= candidate.weight;
  }
  const sides: Side[] = [...Array<Side>(cell.h).fill('H'), ...Array<Side>(cell.a).fill('A')];
  const halfStream = stream(seed, 'half');
  const halves = sides.map((): 1 | 2 => (randBelow(halfStream, 2n) === 0n ? 1 : 2));
  const goals: Goal[] = [];
  for (const half of [1, 2] as const) {
    const order = sides.filter((_, i) => halves[i] === half);
    const shuffle = stream(seed, `order${half}`);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Number(randBelow(shuffle, BigInt(i + 1)));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const times = halfTimes(
      stream(seed, `time${half}`),
      order.length,
      half === 1 ? 0 : VF_GOAL_GRID.secondHalfStartMs
    );
    order.forEach((side, i) => goals.push({ n: 0, side, half, atMs: times[i] }));
  }
  goals.sort((a, b) => a.atMs - b.atMs);
  goals.forEach((goal, i) => (goal.n = i + 1));
  return { ...outcomeOfGoals(goals), goals };
}

/** Structural validity of a goal list, independent of any seed. */
export function timelineProblems(goals: Goal[]): string[] {
  const problems: string[] = [];
  const { slotMs, firstSlotOffsetMs, usableSlots, gapSlots, secondHalfStartMs } = VF_GOAL_GRID;
  if (goals.length > 6) problems.push('more than six goals');
  for (const half of [1, 2] as const) {
    const base = half === 1 ? 0 : secondHalfStartMs;
    const times = goals.filter((g) => g.half === half).map((g) => g.atMs);
    times.forEach((t, i) => {
      const slot = (t - base - firstSlotOffsetMs) / slotMs;
      if (!Number.isInteger(slot) || slot < 0 || slot >= usableSlots) problems.push(`half ${half} goal off grid`);
      if (i > 0 && t - times[i - 1] < gapSlots * slotMs) problems.push(`half ${half} goals too close`);
    });
  }
  goals.forEach((g, i) => {
    if (g.n !== i + 1) problems.push('goal numbers must be consecutive');
    if (i > 0 && g.atMs <= goals[i - 1].atMs) problems.push('goal times must strictly increase');
  });
  return problems;
}

/* ------------------------------------------------------------------------------------- *
 * Public (elapsed-only) view. The server builds snapshots exclusively with these helpers.
 * ------------------------------------------------------------------------------------- */
export interface PublicGoal {
  n: number;
  side: Side;
  half: 1 | 2;
  atMs: number;
  minute: number;
}
export interface Score {
  home: number;
  away: number;
}
export interface LiveFixture {
  status: 'SCHEDULED' | 'FIRST_HALF' | 'HALFTIME' | 'SECOND_HALF' | 'FULL_TIME';
  elapsedMs: number;
  /** Null until kickoff. */
  score: Score | null;
  halfTime: Score | null;
  fullTime: Score | null;
  events: PublicGoal[];
}

/** Football minute (1..45 first half, 46..90 second half) of a match-clock offset. */
export function minuteOf(atMs: number) {
  const { firstHalfMs, halftimeMs, secondHalfMs } = VF_TIMING;
  if (atMs < firstHalfMs + halftimeMs)
    return Math.min(45, Math.floor((Math.max(0, atMs) * 45) / firstHalfMs) + 1);
  return Math.min(
    90,
    45 + Math.floor((Math.min(atMs - firstHalfMs - halftimeMs, secondHalfMs) * 45) / secondHalfMs) + 1
  );
}

/** Everything a viewer may know at `elapsedMs`: elapsed goals only, never the rest. */
export function liveFixture(goals: Goal[], elapsedMs: number): LiveFixture {
  const { firstHalfMs, halftimeMs, matchMs } = VF_TIMING;
  if (elapsedMs < 0)
    return { status: 'SCHEDULED', elapsedMs: 0, score: null, halfTime: null, fullTime: null, events: [] };
  const clamped = Math.min(elapsedMs, matchMs);
  const released = goals.filter((g) => g.atMs <= clamped);
  const events: PublicGoal[] = released.map((g) => ({
    n: g.n,
    side: g.side,
    half: g.half,
    atMs: g.atMs,
    minute: minuteOf(g.atMs),
  }));
  const tally = (list: Goal[]): Score => ({
    home: list.filter((g) => g.side === 'H').length,
    away: list.filter((g) => g.side === 'A').length,
  });
  const status: LiveFixture['status'] =
    elapsedMs >= matchMs
      ? 'FULL_TIME'
      : elapsedMs >= firstHalfMs + halftimeMs
        ? 'SECOND_HALF'
        : elapsedMs >= firstHalfMs
          ? 'HALFTIME'
          : 'FIRST_HALF';
  return {
    status,
    elapsedMs: clamped,
    score: tally(released),
    halfTime: elapsedMs >= firstHalfMs ? tally(released.filter((g) => g.half === 1)) : null,
    fullTime: elapsedMs >= matchMs ? tally(released) : null,
    events,
  };
}

/* ------------------------------------------------------------------------------------- *
 * Deterministic verification of revealed results
 * ------------------------------------------------------------------------------------- */
export interface RevealedFixture {
  id: string;
  slot: number;
  params: FixtureParams;
  commitment: string;
  goals: Goal[];
}
export function verifyMatchweek(input: {
  matchweekId: string;
  seed: string;
  commitment: string;
  fixtures: RevealedFixture[];
}) {
  const problems: string[] = [];
  const commitments: string[] = [];
  for (const fixture of [...input.fixtures].sort((a, b) => a.slot - b.slot)) {
    const seed = fixtureSeed(input.matchweekId, fixture.id, input.seed);
    const commitment = fixtureCommitment(fixture.id, seed, fixtureOffer(fixture.params).digest);
    commitments.push(commitment);
    if (commitment !== fixture.commitment) problems.push(`${fixture.id}: fixture commitment mismatch`);
    const expected = generateTimeline(seed, fixture.params);
    if (canonicalJson(expected.goals) !== canonicalJson(fixture.goals))
      problems.push(`${fixture.id}: official goals do not match the committed seed`);
  }
  if (matchweekCommitment(input.matchweekId, commitments) !== input.commitment)
    problems.push('matchweek commitment mismatch');
  return { ok: problems.length === 0, problems };
}
