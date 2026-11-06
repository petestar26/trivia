import { expect, it } from 'vitest';
import { TOGETHER_GAMES } from '@socialplay/shared';
import { GAME_ART_DIRECTION, qualityFromFrames } from './game-art-direction';

it('gives every supported game its own visual identity', () => {
  expect(Object.keys(GAME_ART_DIRECTION).sort()).toEqual(TOGETHER_GAMES.map((g) => g.key).sort());
  expect(new Set(Object.values(GAME_ART_DIRECTION).map((a) => a.skin)).size).toBe(12);
});

it('retains a rich balanced scene until sustained slow rendering has actually been measured', () => {
  expect(qualityFromFrames([])).toBe('balanced');
  expect(qualityFromFrames(Array(11).fill(80))).toBe('balanced');
  expect(qualityFromFrames([...Array(150).fill(16.7), ...Array(30).fill(80)])).toBe('balanced');
  expect(qualityFromFrames(Array(180).fill(33.3))).toBe('balanced');
  expect(qualityFromFrames(Array(180).fill(60))).toBe('low');
  expect(qualityFromFrames(Array(20).fill(300))).toBe('low');
  expect(qualityFromFrames(Array(180).fill(5000))).toBe('balanced');
});
