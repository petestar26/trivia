import { RACING_DOGS } from '@socialplay/shared';
import { contrastRatio, runnerLook } from '@/components/derby/runner-identity';

/** Presentation only: the colour that identifies a numbered runner, and legible ink for its number. */
export type RaceRunnerColor = { color: string; ink: string };

/** WCAG AA for normal-size text; the strip and 2D numbers are small. */
export const MIN_INK_CONTRAST = 4.5;

/** The course's own ink when it reaches AA, otherwise the higher-contrast of black and white (always ≥ 4.58:1). */
function legibleInk(color: string, ink: string) {
  if (contrastRatio(color, ink) >= MIN_INK_CONTRAST) return ink;
  return contrastRatio(color, '#000000') >= contrastRatio(color, '#ffffff') ? '#000000' : '#ffffff';
}

// Same sources as the 3D courses: the Derby saddle cloths, silks and badges use
// runnerLook (DERBY_HORSES colour, inkFor ink); the dog jackets, trap faces and
// map dots use RACING_DOGS. Each game keeps its own palette.
const HORSES: readonly RaceRunnerColor[] = Array.from({ length: 8 }, (_, i) => {
  const look = runnerLook(i);
  return { color: look.cloth, ink: legibleInk(look.cloth, look.ink) };
});
const DOGS: readonly RaceRunnerColor[] = RACING_DOGS.map((dog) => ({
  color: dog.color,
  ink: legibleInk(dog.color, dog.ink),
}));

/** Colours for group race runner `index` (0-based), matching the 3D course for that game. */
export function raceRunnerColor(dogs: boolean, index: number): RaceRunnerColor {
  const palette = dogs ? DOGS : HORSES;
  return palette[((index % palette.length) + palette.length) % palette.length];
}
