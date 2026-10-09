import { describe, expect, it } from 'vitest';
import {
  VF_CLUBS,
  VF_GOAL_GRID,
  VF_TIMING,
  buildDistribution,
  canonicalJson,
  fixtureCommitment,
  fixtureOffer,
  fixtureSeed,
  generateTimeline,
  liveFixture,
  matchweekCommitment,
  minuteOf,
  outcomeOfGoals,
  parseSelection,
  priceAtoms,
  randBelow,
  sha256Hex,
  timelineProblems,
  verifyMatchweek,
  type FixtureParams,
  type Goal,
} from './index.js';

const params: FixtureParams = { homeAttack: 112, homeDefence: 92, awayAttack: 94, awayDefence: 96 };
const seedOf = (i: number) => sha256Hex(`test-seed-${i}`);

describe('seeded timeline generation', () => {
  it('is deterministic per seed and domain-separated per fixture', () => {
    const a = generateTimeline(seedOf(1), params);
    expect(generateTimeline(seedOf(1), params)).toEqual(a);
    const mw = seedOf(99);
    const s1 = fixtureSeed('vf-s1-w01', 'vf-s1-w01-f01', mw);
    const s2 = fixtureSeed('vf-s1-w01', 'vf-s1-w01-f02', mw);
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(mw);
    expect(fixtureCommitment('vf-s1-w01-f01', s1, 'd')).not.toBe(
      fixtureCommitment('vf-s1-w01-f02', s1, 'd')
    );
    expect(() => generateTimeline('not-hex', params)).toThrow();
  });

  it('uses unbiased rejection sampling, including bounds wider than 64 bits', () => {
    let calls = 0;
    const counts = [0, 0, 0];
    const stream = { word: () => (calls++ * 1_103_515_245 + 12_345) >>> 0 };
    for (let i = 0; i < 3000; i++) counts[Number(randBelow(stream, 3n))]++;
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(120);
    const big = 2n ** 100n + 12_345n;
    const s = { word: () => (calls++ * 2_654_435_761) >>> 0 };
    for (let i = 0; i < 50; i++) expect(randBelow(s, big) < big).toBe(true);
    expect(() => randBelow(s, 0n)).toThrow();
    // A word that falls in the rejected tail must be skipped, never reduced modulo n.
    const words = [0xffffffff, 0xfffffffe, 5];
    expect(randBelow({ word: () => words.shift()! }, 3n)).toBe(5n % 3n);
  });

  it('always produces a coherent chronology and consistent derived results', () => {
    let zeroZero = 0;
    let maxGoals = 0;
    for (let i = 0; i < 4000; i++) {
      const t = generateTimeline(seedOf(i), params);
      expect(timelineProblems(t.goals), `seed ${i}`).toEqual([]);
      const derived = outcomeOfGoals(t.goals);
      expect({ ...derived }).toEqual({
        ftHome: t.ftHome,
        ftAway: t.ftAway,
        htHome: t.htHome,
        htAway: t.htAway,
        first: t.first,
      });
      expect(t.htHome).toBeLessThanOrEqual(t.ftHome);
      expect(t.htAway).toBeLessThanOrEqual(t.ftAway);
      expect(t.goals).toHaveLength(t.ftHome + t.ftAway);
      expect(t.goals.filter((g) => g.half === 1)).toHaveLength(t.htHome + t.htAway);
      for (const g of t.goals) {
        if (g.half === 1) {
          expect(g.atMs).toBeGreaterThanOrEqual(1500);
          expect(g.atMs).toBeLessThanOrEqual(26_500);
        } else {
          expect(g.atMs).toBeGreaterThanOrEqual(33_500);
          expect(g.atMs).toBeLessThanOrEqual(58_500);
        }
        expect(g.atMs).toBeLessThan(VF_TIMING.matchMs);
      }
      if (t.goals.length === 0) {
        expect(t.first).toBe('N');
        zeroZero++;
      } else expect(t.first).toBe(t.goals[0].side);
      maxGoals = Math.max(maxGoals, t.goals.length);
    }
    expect(zeroZero).toBeGreaterThan(0);
    expect(maxGoals).toBeLessThanOrEqual(6);
  });

  it('can place six goals in one half with the 4-second spacing and edge slots', () => {
    const tl = (n: number, half: 1 | 2): Goal[] => {
      const base = half === 1 ? 0 : VF_GOAL_GRID.secondHalfStartMs;
      return Array.from({ length: n }, (_, i) => ({
        n: i + 1,
        side: 'H' as const,
        half,
        atMs: base + 1500 + i * 4000 + (i === n - 1 ? 25_000 - (n - 1) * 4000 : 0),
      }));
    };
    expect(timelineProblems(tl(6, 1))).toEqual([]);
    expect(timelineProblems(tl(6, 2).map((g) => ({ ...g, n: g.n })))).toEqual([]);
    expect(
      timelineProblems([
        { n: 1, side: 'H', half: 1, atMs: 26_500 },
        { n: 2, side: 'A', half: 2, atMs: 33_500 },
      ])
    ).toEqual([]);
    expect(timelineProblems([{ n: 1, side: 'H', half: 1, atMs: 27_000 }])).not.toEqual([]);
    expect(timelineProblems([{ n: 1, side: 'H', half: 1, atMs: 1000 }])).not.toEqual([]);
    expect(
      timelineProblems([
        { n: 1, side: 'H', half: 1, atMs: 5000 },
        { n: 2, side: 'A', half: 1, atMs: 8500 },
      ])
    ).not.toEqual([]);
    expect(
      timelineProblems([
        { n: 1, side: 'H', half: 1, atMs: 5000 },
        { n: 2, side: 'A', half: 1, atMs: 5000 },
      ])
    ).not.toEqual([]);
  });

  it('matches the enumerated model probabilities statistically (deterministic seeds, 5 sigma)', () => {
    const N = 6000;
    const dist = buildDistribution(params);
    const price = new Map(
      priceAtoms(dist).map((p) => [p.id, Number((p.numerator * 1_000_000n) / p.denominator) / 1e6])
    );
    const tally = new Map<string, number>();
    const sel = [
      'FT:1',
      'FT:X',
      'FT:2',
      'HT:1',
      'HT:X',
      'HTFT:2/1',
      'FIRST:H',
      'FIRST:A',
      'FIRST:N',
      'BTTS:FT:Y',
      'BTTS:HT:Y',
      'OU:2.5:O',
      'TOT:0',
      'TOT:4',
      'SCORE:1-1',
      'SCORE:2-0',
      'OE:O',
      'EH:-1:X',
    ];
    const tests = sel.map((id) => [id, parseSelection(id)!.test] as const);
    for (let i = 0; i < N; i++) {
      const t = generateTimeline(sha256Hex(`stat-${i}`), params);
      for (const [id, test] of tests) if (test(t)) tally.set(id, (tally.get(id) ?? 0) + 1);
    }
    for (const id of sel) {
      const p = price.get(id)!;
      const observed = (tally.get(id) ?? 0) / N;
      const sigma = Math.sqrt((p * (1 - p)) / N);
      expect(Math.abs(observed - p), `${id}: observed ${observed} model ${p}`).toBeLessThan(
        5 * sigma + 1e-9
      );
    }
  }, 60_000);
});

describe('elapsed-only public view', () => {
  const goals: Goal[] = [
    { n: 1, side: 'H', half: 1, atMs: 1500 },
    { n: 2, side: 'A', half: 1, atMs: 26_500 },
    { n: 3, side: 'H', half: 2, atMs: 33_500 },
    { n: 4, side: 'H', half: 2, atMs: 58_500 },
  ];

  it('releases a goal exactly when its time arrives, at every boundary', () => {
    expect(liveFixture(goals, -1)).toMatchObject({ status: 'SCHEDULED', score: null, events: [] });
    expect(liveFixture(goals, 0)).toMatchObject({
      status: 'FIRST_HALF',
      score: { home: 0, away: 0 },
      halfTime: null,
    });
    expect(liveFixture(goals, 1499).events).toHaveLength(0);
    expect(liveFixture(goals, 1500).events).toHaveLength(1);
    expect(liveFixture(goals, 26_499).score).toEqual({ home: 1, away: 0 });
    expect(liveFixture(goals, 26_500).score).toEqual({ home: 1, away: 1 });
    expect(liveFixture(goals, 27_999)).toMatchObject({ status: 'FIRST_HALF', halfTime: null });
    expect(liveFixture(goals, 28_000)).toMatchObject({
      status: 'HALFTIME',
      halfTime: { home: 1, away: 1 },
      fullTime: null,
    });
    expect(liveFixture(goals, 31_999)).toMatchObject({ status: 'HALFTIME' });
    expect(liveFixture(goals, 32_000)).toMatchObject({
      status: 'SECOND_HALF',
      halfTime: { home: 1, away: 1 },
    });
    expect(liveFixture(goals, 33_499).events).toHaveLength(2);
    expect(liveFixture(goals, 33_500).events).toHaveLength(3);
    expect(liveFixture(goals, 59_999)).toMatchObject({
      status: 'SECOND_HALF',
      fullTime: null,
      score: { home: 3, away: 1 },
    });
    expect(liveFixture(goals, 60_000)).toMatchObject({
      status: 'FULL_TIME',
      fullTime: { home: 3, away: 1 },
    });
    expect(liveFixture(goals, 10_000_000).elapsedMs).toBe(60_000);
  });

  it('never depends on goals that have not yet happened (non-interference)', () => {
    for (let i = 0; i < 300; i++) {
      const a = generateTimeline(seedOf(i), params);
      const elapsed = (i * 1973) % 62_000;
      const future = a.goals.filter((g) => g.atMs > elapsed);
      // Replace every unreleased goal with a different unreleased script; a viewer cannot tell.
      const altered = a.goals.map((g) =>
        g.atMs > elapsed
          ? { ...g, side: (g.side === 'H' ? 'A' : 'H') as 'H' | 'A', atMs: g.atMs + 500 }
          : g
      );
      const viewA = canonicalJson(liveFixture(a.goals, elapsed));
      const viewB = canonicalJson(liveFixture(altered, elapsed));
      expect(viewA).toBe(viewB);
      const text = JSON.stringify(liveFixture(a.goals, elapsed));
      for (const g of future) expect(text).not.toContain(`"atMs":${g.atMs}`);
      expect(text).not.toMatch(/seed|script|commitment/i);
    }
  });

  it('shows the same elapsed state to a late joiner as to a continuous viewer', () => {
    const t = generateTimeline(seedOf(7), params);
    const continuous = [0, 5000, 20_000, 40_000].map((e) => liveFixture(t.goals, e));
    const late = liveFixture(t.goals, 40_000);
    expect(late).toEqual(continuous[3]);
    expect(late.events.map((e) => e.n)).toEqual(
      t.goals.filter((g) => g.atMs <= 40_000).map((g) => g.n)
    );
  });

  it('maps match offsets to football minutes', () => {
    expect(minuteOf(0)).toBe(1);
    expect(minuteOf(27_999)).toBe(45);
    expect(minuteOf(30_000)).toBe(45);
    expect(minuteOf(32_000)).toBe(46);
    expect(minuteOf(59_999)).toBe(90);
    expect(minuteOf(1500)).toBe(3);
  });
});

describe('commitments and verification', () => {
  const build = () => {
    const matchweek = 'vf-s1-w01';
    const seed = seedOf(123);
    const fixtures = [1, 2, 3].map((slot) => {
      const id = `${matchweek}-f0${slot}`;
      const p: FixtureParams = {
        homeAttack: VF_CLUBS[slot].attack,
        homeDefence: VF_CLUBS[slot].defence,
        awayAttack: VF_CLUBS[slot + 5].attack,
        awayDefence: VF_CLUBS[slot + 5].defence,
      };
      const s = fixtureSeed(matchweek, id, seed);
      return {
        id,
        slot,
        params: p,
        commitment: fixtureCommitment(id, s, fixtureOffer(p).digest),
        goals: generateTimeline(s, p).goals,
      };
    });
    return {
      matchweekId: matchweek,
      seed,
      commitment: matchweekCommitment(
        matchweek,
        fixtures.map((f) => f.commitment)
      ),
      fixtures,
    };
  };

  it('verifies an honest reveal and detects any tampering', () => {
    const honest = build();
    expect(verifyMatchweek(honest)).toEqual({ ok: true, problems: [] });
    const wrongSeed = { ...honest, seed: seedOf(124) };
    expect(verifyMatchweek(wrongSeed).ok).toBe(false);
    const edited = build();
    edited.fixtures[1].goals = [
      ...edited.fixtures[1].goals,
      { n: 99, side: 'H', half: 1, atMs: 5000 },
    ];
    expect(verifyMatchweek(edited).problems.join()).toMatch(/do not match/);
    const swapped = build();
    swapped.fixtures[0].params = { ...swapped.fixtures[0].params, homeAttack: 130 };
    expect(verifyMatchweek(swapped).ok).toBe(false);
    expect(verifyMatchweek({ ...honest, commitment: sha256Hex('x') }).problems).toContain(
      'matchweek commitment mismatch'
    );
  });

  it('commits to the fixture identity and model version', () => {
    const s = seedOf(5);
    expect(fixtureCommitment('vf-s1-w01-f01', s, 'd')).not.toBe(
      fixtureCommitment('vf-s1-w01-f02', s, 'd')
    );
    expect(fixtureCommitment('vf-s1-w01-f01', s, 'd')).not.toBe(
      fixtureCommitment('vf-s1-w01-f01', s, 'e')
    );
    expect(fixtureCommitment('vf-s1-w01-f01', s, 'd')).toMatch(/^[a-f0-9]{64}$/);
    expect(matchweekCommitment('vf-s1-w01', ['a'])).not.toBe(
      matchweekCommitment('vf-s1-w02', ['a'])
    );
  });
});
