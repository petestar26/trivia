import { RACING_DOGS } from '@socialplay/shared';
import { runnerLook } from '@/components/derby/runner-identity';

/**
 * The cloth colour and number ink each runner wears on its own 3D course, so the group
 * race-order strip and the 2D broadcast match the badges, silks and jackets on screen.
 * Presentation only: indexed by runner number, never by position, odds or result.
 */
export function raceRunnerColors(dogs: boolean, index: number) {
  const i = ((index % 8) + 8) % 8;
  if (dogs) return { color: RACING_DOGS[i].color, ink: RACING_DOGS[i].ink };
  const look = runnerLook(i);
  return { color: look.cloth, ink: look.ink };
}
