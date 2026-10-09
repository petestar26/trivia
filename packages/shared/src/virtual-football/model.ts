import {
  VF_BASE_GOALS_MILLI,
  VF_GOAL_LINES_OFFERED,
  VF_LIMITS,
  VF_MAX_GOALS,
  VF_MODEL_ID,
  VF_RETURN_PERCENT,
  VF_RULES_ID,
  VF_SMOOTHING,
} from './constants.js';
import { canonicalJson, sha256Hex } from './hash.js';

/* ---------------------------------------------------------------------------------------
 * vf3d-score-model-v1: one finite model that generates every official result AND prices
 * every selection. Nothing is drawn per market.
 *
 *  1. Full-time score (h, a) with h + a <= 6 has a positive integer weight W(h, a)
 *     (28 cells; see scoreWeights). The six-goal bound is a practice simplification.
 *  2. Each of the h + a goals is independently placed in the first half with probability
 *     1/2 (the 50/50 rule). So the half-time score is (h1, a1) with weight C(h,h1)C(a,a1)/2^n.
 *  3. Inside each half the scoring sides are in a uniformly random order.
 *  4. The first scorer is the first goal of the first non-empty half; "none" if 0-0.
 *     P(home first | h1, a1) = h1 / (h1 + a1) when the first half has goals.
 *  5. Goal minutes are strictly increasing within a half (see outcome.ts). Minutes do not
 *     affect any market, so pricing needs only (full time, half time, first scorer).
 *
 * All probabilities are exact rationals over one integer denominator (BigInt).
 * ------------------------------------------------------------------------------------- */

export type Side = 'H' | 'A';
export type FirstScorer = 'H' | 'A' | 'N';

export interface FixtureParams {
  homeAttack: number;
  homeDefence: number;
  awayAttack: number;
  awayDefence: number;
}

export interface Outcome {
  ftHome: number;
  ftAway: number;
  htHome: number;
  htAway: number;
  first: FirstScorer;
}

const roundDiv = (numerator: number, denominator: number) =>
  Math.floor((2 * numerator + denominator) / (2 * denominator));

/** Expected goals in thousandths from the public team-strength parameters. */
export function expectedGoalsMilli(p: FixtureParams) {
  for (const value of [p.homeAttack, p.homeDefence, p.awayAttack, p.awayDefence])
    if (!Number.isInteger(value) || value < 50 || value > 200)
      throw new RangeError('Team strength parameter out of range');
  return {
    home: roundDiv(VF_BASE_GOALS_MILLI.home * p.homeAttack, p.awayDefence),
    away: roundDiv(VF_BASE_GOALS_MILLI.away * p.awayAttack, p.homeDefence),
  };
}

const FACT = [1n, 1n, 2n, 6n, 24n, 120n, 720n];
const choose = (n: number, r: number) => FACT[n] / (FACT[r] * FACT[n - r]);

export interface ScoreCell {
  h: number;
  a: number;
  weight: bigint;
}

/**
 * W(h, a) = SMOOTHING * P(h, a) + sum(P) where P(h, a) = lh^h/h! * la^a/a! * 720^2 is an
 * integer-scaled independent-Poisson weight. The common e^-(lh+la) factor cancels, and the
 * additive sum(P) term gives every cell probability >= 1/(SMOOTHING + 28) so the longest
 * exact-score price stays below the documented maximum.
 */
export function scoreWeights(p: FixtureParams): ScoreCell[] {
  const { home, away } = expectedGoalsMilli(p);
  const lh = BigInt(home);
  const la = BigInt(away);
  const raw: ScoreCell[] = [];
  let sum = 0n;
  for (let h = 0; h <= VF_MAX_GOALS; h++)
    for (let a = 0; a <= VF_MAX_GOALS - h; a++) {
      // lambda is in thousandths, so lambda^k/k! needs 1000^(6-n) to put every cell on one scale.
      const weight =
        lh ** BigInt(h) *
        la ** BigInt(a) *
        1000n ** BigInt(VF_MAX_GOALS - h - a) *
        (720n / FACT[h]) *
        (720n / FACT[a]);
      raw.push({ h, a, weight });
      sum += weight;
    }
  return raw.map((cell) => ({ ...cell, weight: VF_SMOOTHING * cell.weight + sum }));
}

export interface Atom {
  ftHome: number;
  ftAway: number;
  htHome: number;
  htAway: number;
  first: FirstScorer;
  weight: bigint;
}
export interface Distribution {
  atoms: Atom[];
  /** Sum of all atom weights. Probability of an atom is weight / denominator. */
  denominator: bigint;
}

/** Common denominator multiplier: 2^6 half assignments * lcm(1..6) first-scorer weights. */
const SPLIT_UNITS = 64n;
const FIRST_UNITS = 60n;

export function buildDistribution(p: FixtureParams): Distribution {
  const cells = scoreWeights(p);
  const atoms: Atom[] = [];
  let total = 0n;
  for (const cell of cells) {
    total += cell.weight;
    const n = cell.h + cell.a;
    for (let h1 = 0; h1 <= cell.h; h1++)
      for (let a1 = 0; a1 <= cell.a; a1++) {
        const split =
          choose(cell.h, h1) * choose(cell.a, a1) * 2n ** BigInt(VF_MAX_GOALS - n);
        const n1 = h1 + a1;
        const h2 = cell.h - h1;
        const a2 = cell.a - a1;
        const n2 = h2 + a2;
        const options: Array<[FirstScorer, bigint]> =
          n === 0
            ? [['N', FIRST_UNITS]]
            : n1 > 0
              ? [
                  ['H', (FIRST_UNITS / BigInt(n1)) * BigInt(h1)],
                  ['A', (FIRST_UNITS / BigInt(n1)) * BigInt(a1)],
                ]
              : [
                  ['H', (FIRST_UNITS / BigInt(n2)) * BigInt(h2)],
                  ['A', (FIRST_UNITS / BigInt(n2)) * BigInt(a2)],
                ];
        for (const [first, units] of options)
          if (units > 0n)
            atoms.push({
              ftHome: cell.h,
              ftAway: cell.a,
              htHome: h1,
              htAway: a1,
              first,
              weight: cell.weight * split * units,
            });
      }
  }
  return { atoms, denominator: total * SPLIT_UNITS * FIRST_UNITS };
}

/* ------------------------------------------------------------------------------------- *
 * Selections
 * ------------------------------------------------------------------------------------- */
export type ThreeWay = '1' | 'X' | '2';
export type MarketKey =
  | 'FT'
  | 'HT'
  | 'HTFT'
  | 'DC'
  | 'OU'
  | 'BTTS_FT'
  | 'BTTS_HT'
  | 'TG_H'
  | 'TG_A'
  | 'TOU_H'
  | 'TOU_A'
  | 'OE'
  | 'TOT'
  | 'SCORE'
  | 'FIRST'
  | 'FT_BTTS'
  | 'FT_OU'
  | 'EH_M1'
  | 'EH_P1';

export interface TeamNames {
  home: string;
  away: string;
}
export interface Selection {
  /** Canonical typed identifier, e.g. FT:1, OU:2.5:O, HTFT:X/2, SCORE:2-1, EH:-1:X. */
  id: string;
  market: MarketKey;
  /** Compact button text. */
  short: string;
  label: (names: TeamNames) => string;
  test: (o: Outcome) => boolean;
}

export interface MarketInfo {
  key: MarketKey;
  group: string;
  title: string;
  rule: string;
}

export const VF_MARKETS: readonly MarketInfo[] = Object.freeze([
  { key: 'FT', group: 'Main', title: 'Full-time result', rule: '1 = home win, X = draw, 2 = away win after 90 minutes.' },
  { key: 'HT', group: 'Main', title: 'Half-time result', rule: 'Who leads at half-time. Settled at full time once the match is official.' },
  { key: 'HTFT', group: 'Main', title: 'Half-time / full-time', rule: 'Both the half-time and full-time results must match, in order. Nine combinations.' },
  { key: 'DC', group: 'Main', title: 'Double chance', rule: '1X = home win or draw, 12 = either team wins, X2 = draw or away win.' },
  { key: 'OU', group: 'Goals', title: 'Match goals over/under', rule: 'Total goals in the match against the displayed half-goal line. No pushes are possible.' },
  { key: 'BTTS_FT', group: 'Goals', title: 'Both teams to score (full time)', rule: 'Goal = both teams score at least once in the match. No goal = at least one team does not score. Goal/no-goal and yes/no labels are the same market.' },
  { key: 'BTTS_HT', group: 'Goals', title: 'Both teams to score (first half)', rule: 'Both teams score at least once before half-time. Settled at full time.' },
  { key: 'TG_H', group: 'Team', title: 'Home team goal / no goal', rule: 'Whether the home team scores at least once in the match.' },
  { key: 'TG_A', group: 'Team', title: 'Away team goal / no goal', rule: 'Whether the away team scores at least once in the match.' },
  { key: 'TOU_H', group: 'Team', title: 'Home team goals over/under 1.5', rule: 'Goals scored by the home team: over 1.5 means two or more.' },
  { key: 'TOU_A', group: 'Team', title: 'Away team goals over/under 1.5', rule: 'Goals scored by the away team: over 1.5 means two or more.' },
  { key: 'OE', group: 'Goals', title: 'Total goals odd/even', rule: 'Whether the match total is odd or even. 0 goals is even.' },
  { key: 'TOT', group: 'Exact', title: 'Exact total goals', rule: 'The exact number of goals in the match, 0 to 6. The model has no match above six goals.' },
  { key: 'SCORE', group: 'Exact', title: 'Exact final score', rule: 'The exact full-time score. All 28 scores with six or fewer goals are listed; the model has no other result.' },
  { key: 'FIRST', group: 'Goals', title: 'First goal', rule: 'Which team scores first, or none for 0-0.' },
  { key: 'FT_BTTS', group: 'Combined', title: 'Result and both teams to score', rule: 'The full-time result and the both-teams-to-score outcome must both be correct.' },
  { key: 'FT_OU', group: 'Combined', title: 'Result and over/under 2.5', rule: 'The full-time result and the 2.5-goal line must both be correct.' },
  { key: 'EH_M1', group: 'Handicap', title: 'European handicap: home (-1)', rule: 'European three-way handicap. The displayed handicap of -1 is added to the HOME team score, then the adjusted score decides 1 / X / 2. Home must win by two or more for 1; a one-goal home win is the handicap draw X; a home draw or defeat is 2. There is no push, void or refund.' },
  { key: 'EH_P1', group: 'Handicap', title: 'European handicap: home (+1)', rule: 'European three-way handicap. The displayed handicap of +1 is added to the HOME team score, then the adjusted score decides 1 / X / 2. A home win or draw is 1; an away win by exactly one goal is the handicap draw X; away by two or more is 2. There is no push, void or refund.' },
]);

const R3: ThreeWay[] = ['1', 'X', '2'];
const result = (home: number, away: number): ThreeWay => (home > away ? '1' : home === away ? 'X' : '2');
const ft = (o: Outcome) => result(o.ftHome, o.ftAway);
const ht = (o: Outcome) => result(o.htHome, o.htAway);
const total = (o: Outcome) => o.ftHome + o.ftAway;
const lineText = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}`;
const resultLabel = (r: ThreeWay, n: TeamNames) => (r === '1' ? n.home : r === '2' ? n.away : 'Draw');
const resultWords = (r: ThreeWay, n: TeamNames) =>
  r === '1' ? `${n.home} win` : r === '2' ? `${n.away} win` : 'Draw';

function build(): Selection[] {
  const list: Selection[] = [];
  const add = (s: Selection) => list.push(s);
  for (const r of R3)
    add({ id: `FT:${r}`, market: 'FT', short: r, label: (n) => `Full time: ${resultWords(r, n)}`, test: (o) => ft(o) === r });
  for (const r of R3)
    add({ id: `HT:${r}`, market: 'HT', short: r, label: (n) => `Half time: ${resultWords(r, n)}`, test: (o) => ht(o) === r });
  for (const a of R3)
    for (const b of R3)
      add({
        id: `HTFT:${a}/${b}`,
        market: 'HTFT',
        short: `${a}/${b}`,
        label: (n) => `Half time ${resultLabel(a, n)} / full time ${resultLabel(b, n)}`,
        test: (o) => ht(o) === a && ft(o) === b,
      });
  add({ id: 'DC:1X', market: 'DC', short: '1X', label: (n) => `Double chance: ${n.home} or draw`, test: (o) => o.ftHome >= o.ftAway });
  add({ id: 'DC:12', market: 'DC', short: '12', label: (n) => `Double chance: ${n.home} or ${n.away}`, test: (o) => o.ftHome !== o.ftAway });
  add({ id: 'DC:X2', market: 'DC', short: 'X2', label: (n) => `Double chance: draw or ${n.away}`, test: (o) => o.ftHome <= o.ftAway });
  for (const line of VF_GOAL_LINES_OFFERED)
    for (const side of ['O', 'U'] as const)
      add({
        id: `OU:${lineText(line)}:${side}`,
        market: 'OU',
        short: `${side === 'O' ? 'Over' : 'Under'} ${lineText(line)}`,
        label: () => `Match goals ${side === 'O' ? 'over' : 'under'} ${lineText(line)}`,
        test: (o) => (side === 'O' ? total(o) * 10 > line : total(o) * 10 < line),
      });
  for (const half of ['FT', 'HT'] as const)
    for (const yes of [true, false])
      add({
        id: `BTTS:${half}:${yes ? 'Y' : 'N'}`,
        market: half === 'FT' ? 'BTTS_FT' : 'BTTS_HT',
        short: yes ? 'Goal' : 'No goal',
        label: () => `${half === 'FT' ? 'Both teams to score' : 'Both teams to score in first half'}: ${yes ? 'goal (yes)' : 'no goal (no)'}`,
        test: (o) => {
          const both = half === 'FT' ? o.ftHome > 0 && o.ftAway > 0 : o.htHome > 0 && o.htAway > 0;
          return both === yes;
        },
      });
  for (const team of ['H', 'A'] as const)
    for (const yes of [true, false])
      add({
        id: `TG:${team}:${yes ? 'Y' : 'N'}`,
        market: team === 'H' ? 'TG_H' : 'TG_A',
        short: yes ? 'Goal' : 'No goal',
        label: (n) => `${team === 'H' ? n.home : n.away} ${yes ? 'to score' : 'not to score'}`,
        test: (o) => ((team === 'H' ? o.ftHome : o.ftAway) > 0) === yes,
      });
  for (const team of ['H', 'A'] as const)
    for (const side of ['O', 'U'] as const)
      add({
        id: `TOU:${team}:1.5:${side}`,
        market: team === 'H' ? 'TOU_H' : 'TOU_A',
        short: `${side === 'O' ? 'Over' : 'Under'} 1.5`,
        label: (n) => `${team === 'H' ? n.home : n.away} goals ${side === 'O' ? 'over' : 'under'} 1.5`,
        test: (o) => {
          const goals = team === 'H' ? o.ftHome : o.ftAway;
          return side === 'O' ? goals >= 2 : goals <= 1;
        },
      });
  add({ id: 'OE:O', market: 'OE', short: 'Odd', label: () => 'Total goals odd', test: (o) => total(o) % 2 === 1 });
  add({ id: 'OE:E', market: 'OE', short: 'Even', label: () => 'Total goals even', test: (o) => total(o) % 2 === 0 });
  for (let n = 0; n <= VF_MAX_GOALS; n++)
    add({ id: `TOT:${n}`, market: 'TOT', short: String(n), label: () => `Exactly ${n} goal${n === 1 ? '' : 's'}`, test: (o) => total(o) === n });
  for (let h = 0; h <= VF_MAX_GOALS; h++)
    for (let a = 0; a <= VF_MAX_GOALS - h; a++)
      add({ id: `SCORE:${h}-${a}`, market: 'SCORE', short: `${h}-${a}`, label: (n) => `Final score ${n.home} ${h}-${a} ${n.away}`, test: (o) => o.ftHome === h && o.ftAway === a });
  add({ id: 'FIRST:H', market: 'FIRST', short: '1', label: (n) => `${n.home} score first`, test: (o) => o.first === 'H' });
  add({ id: 'FIRST:N', market: 'FIRST', short: 'None', label: () => 'No goal (0-0)', test: (o) => o.first === 'N' });
  add({ id: 'FIRST:A', market: 'FIRST', short: '2', label: (n) => `${n.away} score first`, test: (o) => o.first === 'A' });
  for (const r of R3)
    for (const yes of [true, false])
      add({
        id: `FTBTTS:${r}:${yes ? 'Y' : 'N'}`,
        market: 'FT_BTTS',
        short: `${r} & ${yes ? 'Goal' : 'No goal'}`,
        label: (n) => `${resultWords(r, n)} and ${yes ? 'both teams score' : 'not both teams score'}`,
        test: (o) => ft(o) === r && (o.ftHome > 0 && o.ftAway > 0) === yes,
      });
  for (const r of R3)
    for (const side of ['O', 'U'] as const)
      add({
        id: `FTOU:${r}:2.5:${side}`,
        market: 'FT_OU',
        short: `${r} & ${side === 'O' ? 'Over' : 'Under'}`,
        label: (n) => `${resultWords(r, n)} and ${side === 'O' ? 'over' : 'under'} 2.5 goals`,
        test: (o) => ft(o) === r && (side === 'O' ? total(o) >= 3 : total(o) <= 2),
      });
  for (const line of [-1, 1] as const)
    for (const r of R3)
      add({
        id: `EH:${line > 0 ? '+1' : '-1'}:${r}`,
        market: line < 0 ? 'EH_M1' : 'EH_P1',
        short: r,
        label: (n) =>
          `${n.home} (${line > 0 ? '+1' : '-1'}) handicap: ${r === 'X' ? 'handicap draw' : r === '1' ? `${n.home} cover` : `${n.away} cover`}`,
        test: (o) => result(o.ftHome + line, o.ftAway) === r,
      });
  return list;
}

export const VF_SELECTIONS: readonly Selection[] = Object.freeze(build());
const BY_ID = new Map(VF_SELECTIONS.map((s) => [s.id, s]));

/** Strict typed-ID lookup. Aliases, case changes, padding and unknown lines are rejected. */
export function parseSelection(id: unknown): Selection | null {
  return typeof id === 'string' ? (BY_ID.get(id) ?? null) : null;
}
export const selectionsOf = (market: MarketKey) => VF_SELECTIONS.filter((s) => s.market === market);

export function selectionWins(id: string, outcome: Outcome) {
  const selection = parseSelection(id);
  if (!selection) throw new RangeError('Unknown selection');
  return selection.test(outcome);
}

/* ------------------------------------------------------------------------------------- *
 * Pricing
 * ------------------------------------------------------------------------------------- */
export type Unavailable = 'IMPOSSIBLE' | 'BELOW_MINIMUM' | 'ABOVE_MAXIMUM';
export interface Price {
  id: string;
  /** Exact probability = numerator / denominator. */
  numerator: bigint;
  denominator: bigint;
  /** Fixed gross odds in hundredths (stake included). Null when unavailable. */
  oddsCents: number | null;
  unavailable: Unavailable | null;
}

/** floor(RETURN_PERCENT / probability) in hundredths, in exact integer arithmetic. */
export function oddsCentsFor(numerator: bigint, denominator: bigint): bigint {
  if (numerator <= 0n) throw new RangeError('Zero-probability selections have no price');
  return (BigInt(VF_RETURN_PERCENT) * denominator) / numerator;
}

export function priceAtoms(dist: Distribution, selections: readonly Selection[] = VF_SELECTIONS): Price[] {
  return selections.map((selection) => {
    let numerator = 0n;
    for (const atom of dist.atoms) if (selection.test(atom)) numerator += atom.weight;
    if (numerator === 0n)
      return { id: selection.id, numerator, denominator: dist.denominator, oddsCents: null, unavailable: 'IMPOSSIBLE' as const };
    const odds = oddsCentsFor(numerator, dist.denominator);
    if (odds < BigInt(VF_LIMITS.minOddsCents))
      return { id: selection.id, numerator, denominator: dist.denominator, oddsCents: null, unavailable: 'BELOW_MINIMUM' as const };
    if (odds > BigInt(VF_LIMITS.maxOddsCents))
      return { id: selection.id, numerator, denominator: dist.denominator, oddsCents: null, unavailable: 'ABOVE_MAXIMUM' as const };
    return { id: selection.id, numerator, denominator: dist.denominator, oddsCents: Number(odds), unavailable: null };
  });
}

export interface FixtureOffer {
  prices: Price[];
  byId: Map<string, Price>;
  /** SHA-256 over rules, model, parameters and every offered price. Stored with the fixture. */
  digest: string;
}

const offerCache = new Map<string, FixtureOffer>();
export function fixtureOffer(params: FixtureParams): FixtureOffer {
  const key = `${params.homeAttack}:${params.homeDefence}:${params.awayAttack}:${params.awayDefence}`;
  const cached = offerCache.get(key);
  if (cached) return cached;
  const prices = priceAtoms(buildDistribution(params));
  const offer: FixtureOffer = {
    prices,
    byId: new Map(prices.map((p) => [p.id, p])),
    digest: sha256Hex(
      canonicalJson({
        rules: VF_RULES_ID,
        model: VF_MODEL_ID,
        params,
        prices: prices.map((p) => [p.id, p.oddsCents ?? 0]),
      })
    ),
  };
  if (offerCache.size > 600) offerCache.clear();
  offerCache.set(key, offer);
  return offer;
}

export function offeredOdds(params: FixtureParams, selectionId: string): number | null {
  return fixtureOffer(params).byId.get(selectionId)?.oddsCents ?? null;
}

/** Exact rational probability of each full-time score, for rules display and tests. */
export function probabilityOf(dist: Distribution, test: (o: Outcome) => boolean) {
  let numerator = 0n;
  for (const atom of dist.atoms) if (test(atom)) numerator += atom.weight;
  return { numerator, denominator: dist.denominator };
}
