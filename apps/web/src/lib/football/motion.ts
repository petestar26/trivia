import { useEffect, useState } from 'react';

/** OS reduced-motion preference with an explicit in-page override. */
export function useReducedMotion(): [boolean, (override: boolean | null) => void, boolean | null] {
  const [system, setSystem] = useState(false);
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSystem(!!media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  return [override ?? system, setOverride, override];
}
