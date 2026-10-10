import { describe, it, expect } from 'vitest';
import {
  VF_CLUBS as MODEL,
  colourDistance,
  VF_MIN_KIT_DISTANCE,
  kitSeparation,
  VF_MIN_PATTERN_DISTANCE,
} from '@socialplay/shared';
import { VF_CLUBS, clubById, matchKits } from './clubs';
describe('club presentation', () => {
  it('uses twenty distinct club identities without changing simulation inputs', () => {
    expect(VF_CLUBS).toHaveLength(20);
    expect(new Set(VF_CLUBS.map((c) => c.name)).size).toBe(20);
    expect(clubById(1).name).toBe('Arsenal');
    expect(clubById(20).name).toBe('Tottenham Hotspur');
    VF_CLUBS.forEach((c, i) => {
      expect([c.id, c.attack, c.defence]).toEqual([MODEL[i].id, MODEL[i].attack, MODEL[i].defence]);
    });
    expect(MODEL[0].code).toBe('ASM');
    expect(() => clubById(21)).toThrow();
  });
  it('keeps every home/away pairing distinguishable', () => {
    for (const h of VF_CLUBS)
      for (const a of VF_CLUBS)
        if (h.id !== a.id) {
          const k = matchKits(h.id, a.id);
          expect(colourDistance(k.home.primary, k.away.primary)).toBeGreaterThanOrEqual(
            VF_MIN_KIT_DISTANCE
          );
          expect(kitSeparation(k.home, k.away)).toBeGreaterThanOrEqual(VF_MIN_PATTERN_DISTANCE);
        }
  });
});
