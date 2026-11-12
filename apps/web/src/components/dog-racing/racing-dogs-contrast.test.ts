import { describe, expect, it } from 'vitest';
import { RACING_DOGS } from '@socialplay/shared';
import { contrastRatio } from '@/components/derby/runner-identity';

// The 3D course draws each dog's number in `ink` on `color`: trap faces (track.ts),
// course-map dots (race-scene.tsx) and jacket numbers (greyhound.ts). The numbers
// are small, so each pair must reach WCAG AA for normal text.
const AA = 4.5;

describe('RACING_DOGS number ink', () => {
  it.each(RACING_DOGS.map((dog, i) => ({ ...dog, number: i + 1 })))(
    '#$number $name: $ink on $color reaches 4.5:1',
    ({ color, ink }) => {
      expect(contrastRatio(color, ink)).toBeGreaterThanOrEqual(AA);
    }
  );

  it('covers all eight dogs and keeps their colours', () => {
    expect(RACING_DOGS.map((dog) => dog.color)).toEqual([
      '#d84448',
      '#377cce',
      '#f1ede2',
      '#292e35',
      '#e9c24f',
      '#378e70',
      '#d779a2',
      '#e88e49',
    ]);
  });
});
