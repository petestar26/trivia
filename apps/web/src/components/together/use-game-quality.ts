import { useEffect, useState } from 'react';
import { qualityFromFrames, type GameQuality, type RenderQuality } from './game-art-direction';

export function useGameQuality(reduced: boolean) {
  const [quality, setQuality] = useState<GameQuality>(() => {
    try {
      const saved = localStorage.getItem('salem-game-quality');
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
        setAutomatic(measured);
        if (measured === 'low') return;
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
      localStorage.setItem('salem-game-quality', value);
    } catch {
      /* Optional. */
    }
  };
  return { quality, choose, tier: reduced ? 'low' : quality === 'auto' ? automatic : quality };
}
