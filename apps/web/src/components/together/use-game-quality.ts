import { useCallback, useEffect, useState } from 'react';
import { qualityFromFrames, type GameQuality, type RenderQuality } from './game-art-direction';

const STORAGE_KEY = 'salem-game-quality';

/**
 * The player's graphics choice plus the automatic tier. Automatic only ever steps down
 * within a session (from measured frame delivery, here or reported by a scene), so it
 * never oscillates; an explicit choice is always respected and persisted.
 */
export function useGameQuality(reduced: boolean) {
  const [quality, setQuality] = useState<GameQuality>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (['auto', 'high', 'balanced', 'low'].includes(saved ?? '')) return saved as GameQuality;
    } catch {
      /* Storage is optional. */
    }
    return 'auto';
  });
  const [automatic, setAutomatic] = useState<RenderQuality>('balanced');
  useEffect(() => {
    if (quality !== 'auto' || reduced || automatic === 'low') return;
    let id = 0,
      previous = 0,
      started = 0;
    const samples: number[] = [];
    const measure = (now: number) => {
      if (document.visibilityState === 'visible' && previous) samples.push(now - previous);
      else {
        samples.length = 0;
        started = now;
      }
      previous = now;
      if (samples.length >= 120 || (samples.length >= 12 && now - started >= 4000)) {
        const measured = qualityFromFrames(samples);
        if (measured === 'low') {
          setAutomatic('low');
          return;
        }
        // Continue after assets load; a fast loading screen says little about the scene.
        samples.length = 0;
        started = now;
      }
      id = requestAnimationFrame(measure);
    };
    id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [quality, reduced, automatic]);
  const choose = (value: GameQuality) => {
    setQuality(value);
    if (value === 'auto') setAutomatic('balanced');
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* Optional. */
    }
  };
  /** A scene measured sustained overload at its lowest resolution: one tier down (Auto only). */
  const degrade = useCallback(() => {
    if (quality !== 'auto') return;
    setAutomatic((tier) => (tier === 'high' ? 'balanced' : 'low'));
  }, [quality]);
  const tier: RenderQuality = reduced ? 'low' : quality === 'auto' ? automatic : quality;
  return { quality, choose, tier, degrade, adaptive: quality === 'auto' && !reduced };
}
