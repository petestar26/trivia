import { expect, it } from 'vitest';
import { DERBY_HORSES } from '@socialplay/shared';
import { contrastRatio, inkFor, runnerLook } from './runner-identity';

it('gives all eight runners their interface colour with WCAG-legible number ink', () => {
  for (let i = 0; i < 8; i++) {
    const look = runnerLook(i);
    expect(look.number).toBe(i + 1);
    expect(look.cloth).toBe(DERBY_HORSES[i].color);
    expect(look.silks.body).toBe(DERBY_HORSES[i].color);
    expect(look.ink).toBe(inkFor(look.cloth));
    // Badges and saddle cloths: at least AA for large text, and AA normal text here.
    expect(contrastRatio(look.cloth, look.ink)).toBeGreaterThanOrEqual(4.5);
  }
});

it('keeps runners separable by pattern, cap and coat, not colour alone', () => {
  const looks = Array.from({ length: 8 }, (_, i) => runnerLook(i));
  expect(new Set(looks.map((l) => l.silks.pattern)).size).toBe(8);
  expect(new Set(looks.map((l) => `${l.silks.cap}/${l.silks.capPattern}`)).size).toBe(8);
  expect(new Set(looks.map((l) => l.coat.base)).size).toBe(8);
  // Six-runner fields use the first six identities unchanged.
  expect(runnerLook(5)).toEqual(looks[5]);
});

it('derives identity from the runner number only', () => {
  expect(runnerLook(9)).toEqual(runnerLook(1));
  expect(runnerLook(-1)).toEqual(runnerLook(7));
});
