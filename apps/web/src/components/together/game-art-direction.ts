import type { TogetherGame } from '@socialplay/shared';

/** Presentation only. Never supplies a result, stake, deadline or settlement rule. */
export const GAME_ART_DIRECTION = {
  spin_win: { skin: 'wheel', stage: 'wheel', accent: '#f4be68' },
  turbo_keno: { skin: 'draw-studio', stage: 'draw', accent: '#68e6ed' },
  dice: { skin: 'dice-room', stage: 'dice', accent: '#ff9b79' },
  number_challenge: { skin: 'number-vault', stage: 'number', accent: '#b2a2ff' },
  roulette_keno: { skin: 'orbital-draw', stage: 'draw', accent: '#9eafff' },
  lucky_six: { skin: 'lottery', stage: 'draw', accent: '#edb4df' },
  thunder_derby_3d: { skin: 'race-day', stage: 'race', accent: '#ecd6b3' },
  neon_hounds_3d: { skin: 'night-track', stage: 'race', accent: '#74e8d6' },
  virtual_football_3d: { skin: 'stadium', stage: 'football', accent: '#83c9ff' },
  blackjack: { skin: 'card-room', stage: 'cards', accent: '#deb8ce' },
  sky_crash: { skin: 'aviation', stage: 'flight', accent: '#add8ee' },
  crash_point: { skin: 'mission', stage: 'flight', accent: '#bdde7a' },
} as const satisfies Record<TogetherGame, { skin: string; stage: string; accent: string }>;

export type GameQuality = 'auto' | 'high' | 'balanced' | 'low';
export type RenderQuality = Exclude<GameQuality, 'auto'>;

/** A sustained measured rendering delay, not a core-count or memory guess. */
export function qualityFromFrames(samples: number[]): RenderQuality {
  if (samples.length < 12) return 'balanced';
  const usable = samples.filter((n) => n > 0 && n < 2000).sort((a, b) => a - b);
  if (usable.length < 12) return 'balanced';
  return usable[Math.floor(usable.length * 0.75)] > 48 ? 'low' : 'balanced';
}
