import { describe, expect, it } from 'vitest';
import {
  FIXTURE_ID,
  MATCHWEEK_ID,
  VF_CLUBS,
  VF_TIMING,
  clubById,
  colourDistance,
  cycleAt,
  cycleByIndex,
  cycleBySeasonWeek,
  fixtureId,
  keeperColour,
  matchKits,
  matchweekId,
  parseMatchweekId,
  phaseAt,
  scheduledWeek,
  seasonSchedule,
  VF_MIN_KIT_DISTANCE,
} from './index.js';

describe('five-minute server cycle', () => {
  const c = cycleByIndex(5);
  it('has exact boundaries 230 + 28 + 4 + 28 + 10 seconds', () => {
    expect(c.kickoffAt - c.opensAt).toBe(230_000);
    expect(c.halftimeAt - c.kickoffAt).toBe(28_000);
    expect(c.secondHalfAt - c.halftimeAt).toBe(4_000);
    expect(c.fullTimeAt - c.secondHalfAt).toBe(28_000);
    expect(c.endsAt - c.fullTimeAt).toBe(10_000);
    expect(c.endsAt - c.opensAt).toBe(300_000);
    expect(c.opensAt % 300_000).toBe(0);
  });

  it('classifies every exact boundary into the later phase', () => {
    expect(phaseAt(c, c.opensAt - 1)).toBe('BEFORE');
    expect(phaseAt(c, c.opensAt)).toBe('SELECTION');
    expect(phaseAt(c, c.kickoffAt - 1)).toBe('SELECTION');
    expect(phaseAt(c, c.kickoffAt)).toBe('FIRST_HALF');
    expect(phaseAt(c, c.halftimeAt - 1)).toBe('FIRST_HALF');
    expect(phaseAt(c, c.halftimeAt)).toBe('HALFTIME');
    expect(phaseAt(c, c.secondHalfAt - 1)).toBe('HALFTIME');
    expect(phaseAt(c, c.secondHalfAt)).toBe('SECOND_HALF');
    expect(phaseAt(c, c.fullTimeAt - 1)).toBe('SECOND_HALF');
    expect(phaseAt(c, c.fullTimeAt)).toBe('RESULTS');
    expect(phaseAt(c, c.endsAt - 1)).toBe('RESULTS');
    expect(phaseAt(c, c.endsAt)).toBe('AFTER');
  });

  it('maps time to season and matchweek across the week 38 to week 1 rollover', () => {
    expect(cycleAt(VF_TIMING.anchorMs - 1)).toBeNull();
    expect(cycleAt(VF_TIMING.anchorMs)).toMatchObject({ index: 0, seasonNo: 1, weekNo: 1 });
    const last = cycleByIndex(37);
    expect(last).toMatchObject({ seasonNo: 1, weekNo: 38 });
    const next = cycleAt(last.endsAt)!;
    expect(next).toMatchObject({ index: 38, seasonNo: 2, weekNo: 1, opensAt: last.endsAt });
    expect(cycleAt(last.endsAt - 1)).toMatchObject({ seasonNo: 1, weekNo: 38 });
    expect(cycleBySeasonWeek(2, 1)).toEqual(next);
    expect(() => cycleBySeasonWeek(1, 39)).toThrow();
    expect(() => cycleBySeasonWeek(0, 1)).toThrow();
  });

  it('builds stable ids that round-trip and reject malformed values', () => {
    expect(matchweekId(3, 7)).toBe('vf-s3-w07');
    expect(fixtureId('vf-s3-w07', 10)).toBe('vf-s3-w07-f10');
    expect(parseMatchweekId('vf-s12-w38')).toEqual({ seasonNo: 12, weekNo: 38 });
    for (const bad of ['vf-s0-w01', 'vf-s1-w00', 'vf-s1-w39', 'vf-s1-w1', 'x', ''])
      expect(MATCHWEEK_ID.test(bad)).toBe(false);
    expect(FIXTURE_ID.test('vf-s1-w01-f11')).toBe(false);
    expect(FIXTURE_ID.test('vf-s1-w01-f00')).toBe(false);
    expect(FIXTURE_ID.test('vf-s1-w01-f10')).toBe(true);
  });
});

describe('double round-robin season', () => {
  for (const season of [1, 2, 3, 17, 4096]) {
    it(`season ${season}: 38 weeks, 10 fixtures, every club once a week, every pair twice reversed`, () => {
      const weeks = seasonSchedule(season);
      expect(weeks).toHaveLength(38);
      const ordered = new Set<string>();
      for (const [w, fixtures] of weeks.entries()) {
        expect(fixtures).toHaveLength(10);
        expect(fixtures.map((f) => f.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const clubs = fixtures.flatMap((f) => [f.homeClub, f.awayClub]);
        expect(new Set(clubs).size).toBe(20);
        expect([...clubs].sort((a, b) => a - b)).toEqual(
          Array.from({ length: 20 }, (_, i) => i + 1)
        );
        for (const f of fixtures) {
          expect(f.homeClub).not.toBe(f.awayClub);
          const key = `${f.homeClub}-${f.awayClub}`;
          expect(ordered.has(key), `duplicate ${key} week ${w + 1}`).toBe(false);
          ordered.add(key);
        }
      }
      expect(ordered.size).toBe(380);
      for (let h = 1; h <= 20; h++)
        for (let a = 1; a <= 20; a++) if (h !== a) expect(ordered.has(`${h}-${a}`)).toBe(true);
      for (let w = 0; w < 19; w++) {
        const first = new Set(weeks[w].map((f) => `${f.homeClub}-${f.awayClub}`));
        const second = new Set(weeks[w + 19].map((f) => `${f.awayClub}-${f.homeClub}`));
        expect(second).toEqual(first);
      }
    });
  }

  it('is a pure deterministic function that differs between seasons', () => {
    expect(JSON.stringify(seasonSchedule(5))).toBe(JSON.stringify(seasonSchedule(5)));
    expect(JSON.stringify(scheduledWeek(1, 1))).not.toBe(JSON.stringify(scheduledWeek(2, 1)));
    expect(() => seasonSchedule(0)).toThrow();
    expect(() => scheduledWeek(1, 39)).toThrow();
  });

  it('keeps home and away runs short (no club plays more than 3 in a row at one venue)', () => {
    for (const season of [1, 2, 3, 9, 40]) {
      const weeks = seasonSchedule(season);
      for (const club of VF_CLUBS) {
        let run = 0;
        let last = '';
        let longest = 0;
        for (const week of weeks) {
          const f = week.find((x) => x.homeClub === club.id || x.awayClub === club.id)!;
          const venue = f.homeClub === club.id ? 'H' : 'A';
          run = venue === last ? run + 1 : 1;
          last = venue;
          longest = Math.max(longest, run);
        }
        expect(longest, `season ${season} club ${club.id}`).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('clubs and kits', () => {
  it('lists 20 unique original clubs in alphabetical order with public strength parameters', () => {
    expect(VF_CLUBS).toHaveLength(20);
    expect(new Set(VF_CLUBS.map((c) => c.code)).size).toBe(20);
    expect(new Set(VF_CLUBS.map((c) => c.name)).size).toBe(20);
    const names = VF_CLUBS.map((c) => c.name);
    expect([...names].sort()).toEqual(names);
    for (const c of VF_CLUBS) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
      expect(c.attack).toBeGreaterThanOrEqual(80);
      expect(c.defence).toBeLessThanOrEqual(120);
      expect(clubById(c.id)).toBe(c);
    }
    expect(() => clubById(21)).toThrow();
  });

  it('gives every fixture clearly distinct outfield kits and a distinct goalkeeper kit', () => {
    for (let h = 1; h <= 20; h++)
      for (let a = 1; a <= 20; a++) {
        if (h === a) continue;
        const kits = matchKits(h, a);
        expect(
          colourDistance(kits.home.primary, kits.away.primary),
          `${h} v ${a}`
        ).toBeGreaterThanOrEqual(VF_MIN_KIT_DISTANCE);
        const keeper = keeperColour(kits.home.primary, kits.away.primary);
        expect(colourDistance(keeper, kits.home.primary)).toBeGreaterThan(80);
        expect(colourDistance(keeper, kits.away.primary)).toBeGreaterThan(80);
      }
  });
});
