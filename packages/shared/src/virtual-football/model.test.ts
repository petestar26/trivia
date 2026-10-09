import { describe, expect, it } from 'vitest';
import {
  VF_CLUBS,
  VF_LIMITS,
  VF_MARKETS,
  VF_RETURN_PERCENT,
  VF_RULES_DIGEST,
  VF_RULES_ID,
  VF_SELECTIONS,
  buildDistribution,
  expectedGoalsMilli,
  fixtureOffer,
  parseSelection,
  priceAtoms,
  probabilityOf,
  scoreWeights,
  selectionsOf,
  type Distribution,
  type FixtureParams,
  type MarketKey,
  type Outcome,
} from './index.js';

const paramsOf = (home: number, away: number): FixtureParams => ({
  homeAttack: VF_CLUBS[home - 1].attack,
  homeDefence: VF_CLUBS[home - 1].defence,
  awayAttack: VF_CLUBS[away - 1].attack,
  awayDefence: VF_CLUBS[away - 1].defence,
});
const SAMPLE: Array<[number, number]> = [[1, 17], [17, 1], [9, 5], [5, 9], [12, 20], [3, 4], [18, 2]];

describe('finite score model', () => {
  it('has exactly 28 positive-weight scores with at most six goals, for every fixture', () => {
    for (let h = 1; h <= 20; h++)
      for (let a = 1; a <= 20; a++) {
        if (h === a) continue;
        const cells = scoreWeights(paramsOf(h, a));
        expect(cells).toHaveLength(28);
        expect(cells.every((c) => c.weight > 0n && c.h + c.a <= 6)).toBe(true);
        expect(new Set(cells.map((c) => `${c.h}-${c.a}`)).size).toBe(28);
      }
  });

  it('keeps expected goals in a believable band and ordered by strength', () => {
    const strong = expectedGoalsMilli(paramsOf(1, 17));
    const weak = expectedGoalsMilli(paramsOf(17, 1));
    expect(strong.home).toBeGreaterThan(weak.home);
    for (const g of [strong.home, strong.away, weak.home, weak.away]) {
      expect(g).toBeGreaterThan(400);
      expect(g).toBeLessThan(3000);
    }
    expect(() => expectedGoalsMilli({ ...paramsOf(1, 2), homeAttack: 5 })).toThrow();
  });

  it('enumerates atoms that sum to the common denominator with half time never above full time', () => {
    for (const [h, a] of SAMPLE) {
      const dist = buildDistribution(paramsOf(h, a));
      expect(dist.atoms.reduce((s, x) => s + x.weight, 0n)).toBe(dist.denominator);
      for (const atom of dist.atoms) {
        expect(atom.weight > 0n).toBe(true);
        expect(atom.htHome).toBeLessThanOrEqual(atom.ftHome);
        expect(atom.htAway).toBeLessThanOrEqual(atom.ftAway);
        expect(atom.ftHome + atom.ftAway).toBeLessThanOrEqual(6);
        if (atom.ftHome + atom.ftAway === 0) expect(atom.first).toBe('N');
        else expect(atom.first).not.toBe('N');
      }
      const keys = dist.atoms.map((x) => `${x.ftHome}-${x.ftAway}/${x.htHome}-${x.htAway}/${x.first}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('applies the documented 50/50 half rule and first-scorer rule exactly', () => {
    const dist = buildDistribution(paramsOf(1, 2));
    const total = (test: (o: Outcome) => boolean) => probabilityOf(dist, test);
    const full = total((o) => o.ftHome === 2 && o.ftAway === 0);
    // 2-0: halves split 2-0 / 1-1 / 0-2 with binomial weights 1:2:1.
    const split = (h1: number) => total((o) => o.ftHome === 2 && o.ftAway === 0 && o.htHome === h1);
    expect(split(0).numerator * 4n).toBe(full.numerator);
    expect(split(1).numerator * 2n).toBe(full.numerator);
    expect(split(2).numerator * 4n).toBe(full.numerator);
    // 1-1: both sides first is symmetric when HT is 1-1 only via ordering; check P(first=H | 1-1) = 1/2.
    const draw = total((o) => o.ftHome === 1 && o.ftAway === 1);
    const homeFirst = total((o) => o.ftHome === 1 && o.ftAway === 1 && o.first === 'H');
    expect(homeFirst.numerator * 2n).toBe(draw.numerator);
    // 2-1, first-half 1-1 means the first scorer is 1/2 H; HT 2-0 means H for certain.
    const cell = total((o) => o.ftHome === 2 && o.ftAway === 1 && o.htHome === 1 && o.htAway === 1);
    const cellHome = total((o) => o.ftHome === 2 && o.ftAway === 1 && o.htHome === 1 && o.htAway === 1 && o.first === 'H');
    expect(cellHome.numerator * 2n).toBe(cell.numerator);
    expect(total((o) => o.htHome === 2 && o.htAway === 0 && o.first === 'A').numerator).toBe(0n);
  });
});

describe('selection catalog', () => {
  it('lists 94 unique typed identifiers across 19 market keys', () => {
    expect(VF_SELECTIONS).toHaveLength(94);
    expect(new Set(VF_SELECTIONS.map((s) => s.id)).size).toBe(94);
    const keys = new Set(VF_SELECTIONS.map((s) => s.market));
    expect(keys.size).toBe(19);
    expect(VF_MARKETS.map((m) => m.key).sort()).toEqual([...keys].sort());
    const counts: Partial<Record<MarketKey, number>> = {};
    for (const s of VF_SELECTIONS) counts[s.market] = (counts[s.market] ?? 0) + 1;
    expect(counts).toMatchObject({ FT: 3, HT: 3, HTFT: 9, DC: 3, OU: 6, BTTS_FT: 2, BTTS_HT: 2, TG_H: 2, TG_A: 2, TOU_H: 2, TOU_A: 2, OE: 2, TOT: 7, SCORE: 28, FIRST: 3, FT_BTTS: 6, FT_OU: 6, EH_M1: 3, EH_P1: 3 });
  });

  it('parses canonical ids only: no aliases, case changes, padding or unknown lines', () => {
    for (const s of VF_SELECTIONS) expect(parseSelection(s.id)).toBe(s);
    for (const bad of ['ft:1', 'FT:1 ', ' FT:1', 'FT:H', 'GGNG:FT:GG', 'BTTS:FT:YES', 'OU:4.5:O', 'OU:0.5:U', 'OU:2.50:O', 'SCORE:7-0', 'SCORE:4-3', 'TOT:7', 'EH:0:1', 'EH:-2:X', '', 'FT:1;DROP', 42, null, undefined, {}])
      expect(parseSelection(bad)).toBeNull();
  });

  it('treats synonymous full-time both-teams-to-score labels as one market', () => {
    expect(selectionsOf('BTTS_FT').map((s) => s.id)).toEqual(['BTTS:FT:Y', 'BTTS:FT:N']);
    expect(selectionsOf('BTTS_FT').map((s) => s.short)).toEqual(['Goal', 'No goal']);
    expect(VF_MARKETS.filter((m) => m.key === 'BTTS_FT')).toHaveLength(1);
    expect(VF_MARKETS.find((m) => m.key === 'BTTS_FT')!.rule).toMatch(/Goal\/no-goal and yes\/no labels are the same market/);
  });

  it('settles the European three-way handicap by adding the signed handicap to the home score', () => {
    const o = (h: number, a: number): Outcome => ({ ftHome: h, ftAway: a, htHome: 0, htAway: 0, first: 'N' });
    const win = (id: string, h: number, a: number) => parseSelection(id)!.test(o(h, a));
    // Home -1: needs a margin of 2+ for 1; exactly one goal is the handicap draw X.
    expect([win('EH:-1:1', 3, 1), win('EH:-1:X', 3, 1), win('EH:-1:2', 3, 1)]).toEqual([true, false, false]);
    expect([win('EH:-1:1', 2, 1), win('EH:-1:X', 2, 1), win('EH:-1:2', 2, 1)]).toEqual([false, true, false]);
    expect([win('EH:-1:1', 1, 1), win('EH:-1:X', 1, 1), win('EH:-1:2', 1, 1)]).toEqual([false, false, true]);
    expect([win('EH:-1:1', 0, 2), win('EH:-1:X', 0, 2), win('EH:-1:2', 0, 2)]).toEqual([false, false, true]);
    // Home +1: home win or draw is 1; away by exactly one is X; away by 2+ is 2.
    expect([win('EH:+1:1', 0, 0), win('EH:+1:X', 0, 0), win('EH:+1:2', 0, 0)]).toEqual([true, false, false]);
    expect([win('EH:+1:1', 1, 2), win('EH:+1:X', 1, 2), win('EH:+1:2', 1, 2)]).toEqual([false, true, false]);
    expect([win('EH:+1:1', 0, 2), win('EH:+1:X', 0, 2), win('EH:+1:2', 0, 2)]).toEqual([false, false, true]);
  });

  it('every partition market has exactly one winner for every possible outcome', () => {
    const outcomes: Outcome[] = [];
    for (let fh = 0; fh <= 6; fh++)
      for (let fa = 0; fa <= 6 - fh; fa++)
        for (let hh = 0; hh <= fh; hh++)
          for (let ha = 0; ha <= fa; ha++)
            for (const first of ['H', 'A', 'N'] as const) {
              const n = fh + fa;
              const consistent = n === 0 ? first === 'N' : first !== 'N';
              const feasible = first === 'H' ? (hh > 0 || (hh + ha === 0 && fh > 0)) : first === 'A' ? (ha > 0 || (hh + ha === 0 && fa > 0)) : true;
              if (consistent && feasible) outcomes.push({ ftHome: fh, ftAway: fa, htHome: hh, htAway: ha, first });
            }
    // The independently enumerated feasible outcomes are exactly the model's atoms.
    const atomKeys = buildDistribution(paramsOf(1, 2)).atoms.map(
      (a) => `${a.ftHome}-${a.ftAway}/${a.htHome}-${a.htAway}/${a.first}`
    );
    const outcomeKeys = outcomes.map((o) => `${o.ftHome}-${o.ftAway}/${o.htHome}-${o.htAway}/${o.first}`);
    expect(outcomes).toHaveLength(295);
    expect(new Set(outcomeKeys)).toEqual(new Set(atomKeys));
    const partitions: Array<[MarketKey, string[]]> = [
      ['FT', selectionsOf('FT').map((s) => s.id)],
      ['HT', selectionsOf('HT').map((s) => s.id)],
      ['HTFT', selectionsOf('HTFT').map((s) => s.id)],
      ['BTTS_FT', selectionsOf('BTTS_FT').map((s) => s.id)],
      ['BTTS_HT', selectionsOf('BTTS_HT').map((s) => s.id)],
      ['TG_H', selectionsOf('TG_H').map((s) => s.id)],
      ['TG_A', selectionsOf('TG_A').map((s) => s.id)],
      ['TOU_H', selectionsOf('TOU_H').map((s) => s.id)],
      ['TOU_A', selectionsOf('TOU_A').map((s) => s.id)],
      ['OE', selectionsOf('OE').map((s) => s.id)],
      ['TOT', selectionsOf('TOT').map((s) => s.id)],
      ['SCORE', selectionsOf('SCORE').map((s) => s.id)],
      ['FIRST', selectionsOf('FIRST').map((s) => s.id)],
      ['FT_BTTS', selectionsOf('FT_BTTS').map((s) => s.id)],
      ['FT_OU', selectionsOf('FT_OU').map((s) => s.id)],
      ['EH_M1', selectionsOf('EH_M1').map((s) => s.id)],
      ['EH_P1', selectionsOf('EH_P1').map((s) => s.id)],
    ];
    for (const line of ['1.5', '2.5', '3.5'])
      partitions.push([`OU` as MarketKey, [`OU:${line}:O`, `OU:${line}:U`]]);
    for (const [market, ids] of partitions)
      for (const o of outcomes) {
        const winners = ids.filter((id) => parseSelection(id)!.test(o));
        expect(winners, `${market} ${JSON.stringify(o)}`).toHaveLength(1);
      }
    // Double chance: every outcome is covered by exactly two of the three options.
    for (const o of outcomes)
      expect(selectionsOf('DC').filter((s) => s.test(o))).toHaveLength(2);
  });
});

describe('probabilities and fixed odds', () => {
  const partitionIds = (market: MarketKey) => selectionsOf(market).map((s) => s.id);
  const groups: string[][] = [
    ...(['FT', 'HT', 'HTFT', 'BTTS_FT', 'BTTS_HT', 'TG_H', 'TG_A', 'TOU_H', 'TOU_A', 'OE', 'TOT', 'SCORE', 'FIRST', 'FT_BTTS', 'FT_OU', 'EH_M1', 'EH_P1'] as MarketKey[]).map(partitionIds),
    ...['1.5', '2.5', '3.5'].map((l) => [`OU:${l}:O`, `OU:${l}:U`]),
  ];

  it('sums to exactly one over every complete market, using the same enumeration', () => {
    for (const [h, a] of SAMPLE) {
      const dist = buildDistribution(paramsOf(h, a));
      const raw = priceAtoms(dist);
      const by = new Map(raw.map((p) => [p.id, p]));
      for (const group of groups) {
        const sum = group.reduce((s, id) => s + by.get(id)!.numerator, 0n);
        expect(sum).toBe(dist.denominator);
      }
      const dc = selectionsOf('DC').reduce((s, x) => s + by.get(x.id)!.numerator, 0n);
      expect(dc).toBe(2n * dist.denominator);
    }
  });

  it('rounds odds down so exact expected return never exceeds the return factor and loses under 1%-points of rounding', () => {
    for (const [h, a] of SAMPLE) {
      const offer = fixtureOffer(paramsOf(h, a));
      for (const p of offer.prices) {
        if (p.oddsCents === null) continue;
        const odds = BigInt(p.oddsCents);
        // p * odds / 100 <= 0.90 and p * (odds + 1) / 100 > 0.90 in exact integers.
        expect(p.numerator * odds * 100n).toBeLessThanOrEqual(BigInt(VF_RETURN_PERCENT) * p.denominator * 100n);
        expect(p.numerator * (odds + 1n) * 100n).toBeGreaterThan(BigInt(VF_RETURN_PERCENT) * p.denominator * 100n);
        expect(p.oddsCents).toBeGreaterThanOrEqual(VF_LIMITS.minOddsCents);
        expect(p.oddsCents).toBeLessThanOrEqual(VF_LIMITS.maxOddsCents);
      }
    }
  });

  it('prices every one of the 28 exact scores below the odds ceiling for all 380 fixtures', () => {
    let longest = 0;
    for (let h = 1; h <= 20; h++)
      for (let a = 1; a <= 20; a++) {
        if (h === a) continue;
        const offer = fixtureOffer(paramsOf(h, a));
        const scores = selectionsOf('SCORE').map((s) => offer.byId.get(s.id)!);
        expect(scores.every((p) => p.oddsCents !== null)).toBe(true);
        longest = Math.max(longest, ...scores.map((p) => p.oddsCents!));
        // Every full market with a price must also be priced from the same atoms.
        for (const id of ['FT:1', 'FT:X', 'FT:2', 'HT:X', 'FIRST:N', 'TOT:0'])
          expect(offer.byId.get(id)!.oddsCents).not.toBeNull();
      }
    expect(longest).toBeLessThanOrEqual(VF_LIMITS.maxOddsCents);
    expect(longest).toBeGreaterThan(50_000);
  });

  it('makes impossible or out-of-range selections unavailable instead of inventing odds', () => {
    const only00: Distribution = {
      atoms: [{ ftHome: 0, ftAway: 0, htHome: 0, htAway: 0, first: 'N', weight: 1n }],
      denominator: 1n,
    };
    const prices = new Map(priceAtoms(only00).map((p) => [p.id, p]));
    expect(prices.get('SCORE:1-0')).toMatchObject({ oddsCents: null, unavailable: 'IMPOSSIBLE' });
    expect(prices.get('FIRST:H')).toMatchObject({ oddsCents: null, unavailable: 'IMPOSSIBLE' });
    expect(prices.get('FT:X')).toMatchObject({ oddsCents: null, unavailable: 'BELOW_MINIMUM' });
    const longshot: Distribution = {
      atoms: [
        { ftHome: 0, ftAway: 0, htHome: 0, htAway: 0, first: 'N', weight: 1n },
        { ftHome: 6, ftAway: 0, htHome: 3, htAway: 0, first: 'H', weight: 100_000n },
      ],
      denominator: 100_001n,
    };
    const rare = new Map(priceAtoms(longshot).map((p) => [p.id, p])).get('SCORE:0-0')!;
    expect(rare).toMatchObject({ oddsCents: null, unavailable: 'ABOVE_MAXIMUM' });
  });

  it('is deterministic and the offer digest binds parameters and every price', () => {
    const a = fixtureOffer(paramsOf(1, 2));
    expect(fixtureOffer(paramsOf(1, 2)).digest).toBe(a.digest);
    expect(fixtureOffer(paramsOf(2, 1)).digest).not.toBe(a.digest);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('compounding per-leg return factors lowers a multiple expected return below either leg', () => {
    const one = fixtureOffer(paramsOf(3, 4));
    const two = fixtureOffer(paramsOf(7, 8));
    const p1 = one.byId.get('FT:1')!;
    const p2 = two.byId.get('FT:X')!;
    const o1 = BigInt(p1.oddsCents!);
    const o2 = BigInt(p2.oddsCents!);
    // Independent fixtures: P(both) = p1 * p2. Expected return per credit = p1*p2*o1*o2/10000.
    const num = p1.numerator * p2.numerator * o1 * o2;
    const den = p1.denominator * p2.denominator * 10_000n;
    expect(num * 100n).toBeLessThanOrEqual(81n * den); // <= 0.9^2
    expect(num * 100n).toBeLessThan(90n * den); // strictly below a single's 90%
  });
});

describe('golden contracts', () => {
  it('pins the rules digest and one complete price table so model changes need a new rules id', () => {
    // Changing any limit, timing, club strength, return factor or price MUST also bump
    // VF_RULES_ID / VF_MODEL_ID; update these constants in the same commit as the new id.
    expect(VF_RULES_ID).toBe('virtual-football-3d-practice-v1');
    expect(VF_RULES_DIGEST).toBe('67bd743ef33a41393de29363bdb4e5bea0c8d294d6f33b16e42dc3d6356455cd');
    expect(fixtureOffer(paramsOf(1, 2)).digest).toBe(
      'c1207fd275b0e69516e1248c20ca7e7398e729a056adfbb38098befa9ee8e246'
    );
  });
});
