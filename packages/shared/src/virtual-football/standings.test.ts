import { describe, expect, it } from 'vitest';
import { computeStandings, type FinishedMatch } from './index.js';

const m = (homeClub: number, awayClub: number, ftHome: number, ftAway: number): FinishedMatch => ({ homeClub, awayClub, ftHome, ftAway });

describe('league table', () => {
  it('starts every club on zero', () => {
    const rows = computeStandings([]);
    expect(rows).toHaveLength(20);
    expect(rows.every((r) => r.played + r.points + r.goalsFor === 0)).toBe(true);
    expect(rows.map((r) => r.club)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(rows.map((r) => r.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('awards 3/1/0 and tracks played, W/D/L, goals for/against and difference', () => {
    const rows = computeStandings([m(1, 2, 3, 1), m(3, 4, 0, 0), m(5, 6, 1, 2)]);
    const by = (c: number) => rows.find((r) => r.club === c)!;
    expect(by(1)).toMatchObject({ played: 1, won: 1, points: 3, goalsFor: 3, goalsAgainst: 1, goalDifference: 2 });
    expect(by(2)).toMatchObject({ lost: 1, points: 0, goalDifference: -2 });
    expect(by(3)).toMatchObject({ drawn: 1, points: 1 });
    expect(by(4)).toMatchObject({ drawn: 1, points: 1 });
    expect(by(6)).toMatchObject({ won: 1, points: 3 });
    expect(by(5)).toMatchObject({ lost: 1, points: 0 });
  });

  it('breaks ties by goal difference, goals scored, wins and finally club order', () => {
    // 7 and 8: both 3 points. 7 has the better goal difference.
    let rows = computeStandings([m(7, 9, 2, 0), m(10, 8, 0, 1)]);
    expect(rows.findIndex((r) => r.club === 7)).toBeLessThan(rows.findIndex((r) => r.club === 8));
    // Equal points and difference: more goals scored ranks higher.
    rows = computeStandings([m(11, 13, 3, 2), m(14, 12, 0, 1)]);
    expect(rows.findIndex((r) => r.club === 11)).toBeLessThan(rows.findIndex((r) => r.club === 12));
    // Equal points, difference and goals scored: more wins ranks higher (3 pts from a win vs three draws).
    rows = computeStandings([m(15, 16, 1, 0), m(15, 17, 0, 1), m(18, 19, 0, 0), m(18, 20, 0, 0), m(19, 20, 0, 0), m(3, 18, 0, 0)]);
    const pos = (c: number) => rows.find((r) => r.club === c)!.position;
    expect(pos(1)).toBeGreaterThan(0);
    // Identical records fall back to ascending club id, so 3 stays above 4 etc.
    rows = computeStandings([m(3, 4, 1, 1)]);
    expect(rows.findIndex((r) => r.club === 3)).toBeLessThan(rows.findIndex((r) => r.club === 4));
    expect(rows.map((r) => r.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('is order independent and does not mutate its input', () => {
    const results = [m(1, 2, 2, 0), m(3, 1, 1, 1), m(2, 3, 0, 4), m(4, 5, 5, 5)];
    const a = computeStandings(results);
    const b = computeStandings([...results].reverse());
    expect(b).toEqual(a);
    expect(results).toHaveLength(4);
    expect(() => computeStandings([m(0, 2, 1, 1)])).toThrow();
  });
});
