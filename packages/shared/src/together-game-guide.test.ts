import { describe, expect, it } from 'vitest';
import { TOGETHER_GAMES, TOGETHER_FOOTBALL_FIXTURES } from './play-together.js';
import { scoreWeights } from './virtual-football/model.js';
import {
  TOGETHER_FOOTBALL_CHANCES,
  TOGETHER_GAME_GUIDES,
  togetherCrashSurvivalPercent,
  togetherGameGuide,
} from './together-game-guide.js';

describe('published group game guidance', () => {
  it('covers every supported game without introducing an unsupported mode', () => {
    expect(Object.keys(TOGETHER_GAME_GUIDES).sort()).toEqual(
      TOGETHER_GAMES.map((g) => g.key).sort()
    );
    for (const game of TOGETHER_GAMES) {
      const guide = togetherGameGuide(game.key);
      expect(guide.mechanics.length).toBeGreaterThanOrEqual(2);
      expect(guide.selectionLabel).toBeTruthy();
      expect(guide.tieRule).toBeTruthy();
      expect(guide.choiceNote).toBeTruthy();
      if (guide.predictionLabels) {
        expect(guide.predictionLabels).toHaveLength(game.picks);
        expect(guide.choices?.map((choice) => choice.value)).toEqual([0, 1, 2]);
      }
    }
  });

  it('discloses the actual football model rather than suggesting equal outcome probabilities', () => {
    expect(TOGETHER_FOOTBALL_CHANCES).toHaveLength(3);
    for (const [index, params] of TOGETHER_FOOTBALL_FIXTURES.entries()) {
      const cells = scoreWeights(params);
      const total = Number(cells.reduce((sum, cell) => sum + cell.weight, 0n));
      const exact = [
        cells.filter((c) => c.h > c.a),
        cells.filter((c) => c.h === c.a),
        cells.filter((c) => c.h < c.a),
      ].map((group) => (100 * Number(group.reduce((sum, c) => sum + c.weight, 0n))) / total);
      const published = TOGETHER_FOOTBALL_CHANCES[index];
      for (const [i, chance] of [published.home, published.draw, published.away].entries())
        expect(Math.abs(chance - exact[i])).toBeLessThanOrEqual(0.05);
    }
    expect(TOGETHER_FOOTBALL_CHANCES[0].home).toBeGreaterThan(TOGETHER_FOOTBALL_CHANCES[0].away);
    expect(TOGETHER_FOOTBALL_CHANCES[1].away).toBeGreaterThan(TOGETHER_FOOTBALL_CHANCES[1].home);
    expect(togetherGameGuide('virtual_football_3d').fixtureNotes).toHaveLength(3);
  });

  it.each([101, 102, 199, 200, 500, 1000, 2000])(
    'matches exhaustive published crash sampling for target %i, including equality and cap',
    (target) => {
      let survived = 0;
      for (let u = 1; u <= 1_000_000; u++)
        if (Math.min(2001, Math.floor(100_000_000 / u)) > target) survived++;
      expect(togetherCrashSurvivalPercent(target)).toBe(survived / 10_000);
    }
  );

  it('rejects an incomplete or out-of-range target instead of displaying misleading odds', () => {
    for (const target of [NaN, Infinity, 0, 100, 101.5, 2001])
      expect(() => togetherCrashSurvivalPercent(target)).toThrow(RangeError);
  });
});
