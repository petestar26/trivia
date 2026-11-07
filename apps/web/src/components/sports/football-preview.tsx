import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import type { Engine } from '@/components/football/engine/engine';
import { useLanguage } from '@/providers/language-provider';
import { createPreviewClock } from './preview-clock';
import './football-preview.css';

/** An illustrated football preview. It has no fixtures, score, market or wallet access. */
export function FootballPreview() {
  const { t } = useLanguage();
  const wrapper = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const clock = useRef(createPreviewClock());
  const [visible, setVisible] = useState(false);
  const [foreground, setForeground] = useState(() => !document.hidden);
  const [paused, setPaused] = useState(
    () =>
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
  );
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = visible && foreground && !paused && !failed;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setPaused(media.matches);
    const onVisibility = () => setForeground(!document.hidden);
    media.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
            threshold: 0.05,
          });
    if (wrapper.current) observer?.observe(wrapper.current);
    if (!observer) setVisible(true);
    return () => {
      observer?.disconnect();
      media.removeEventListener('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const showStill = useCallback(() => {
    engine.current?.dispose();
    engine.current = null;
    setReady(false);
    setFailed(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!active) {
      clock.current.pause(performance.now());
      engine.current?.stop();
      return;
    }
    const start = async () => {
      if (!engine.current) {
        // The detailed player rigs are loaded only when this card is visible and playing.
        const { createEngine } = await import('@/components/football/engine/engine');
        if (cancelled || !host.current) return;
        const compact = window.matchMedia('(max-width: 700px)').matches;
        const scene = createEngine({
          host: host.current,
          maxFps: compact ? 24 : 30,
          maxPixelRatio: compact ? 1 : 1.25,
          shadows: !compact,
          getElapsed: () => {
            const frame = clock.current.frame(performance.now());
            host.current?.style.setProperty('--football-preview-opacity', String(frame.opacity));
            return frame.elapsed;
          },
          onContextLost: showStill,
          onRenderError: showStill,
        });
        engine.current = scene;
        scene.setMatch({
          matchKey: 'salem-sports-football-preview-v1',
          homeClub: 1,
          awayClub: 2,
          goals: [],
          fullTime: null,
        });
        setReady(true);
      }
      clock.current.resume(performance.now());
      engine.current.start();
    };
    void start().catch(() => {
      if (!cancelled) showStill();
    });
    return () => {
      cancelled = true;
      clock.current.pause(performance.now());
      engine.current?.stop();
    };
  }, [active, showStill]);

  useEffect(
    () => () => {
      engine.current?.dispose();
      engine.current = null;
    },
    []
  );

  const state = failed ? 'still' : ready ? (active ? 'playing' : 'paused') : 'poster';
  return (
    <div className="sports-football" ref={wrapper} data-state={state}>
      <div className="sports-football-picture" aria-hidden="true">
        <img src="/art/ruby-grand/football-stadium.webp" alt="" loading="lazy" decoding="async" />
        <div className="sports-football-canvas" ref={host} />
        <div className="sports-football-vignette" />
      </div>
      <div className="sports-football-controls">
        <span className="sports-football-label">{t('Football preview')}</span>
        <button
          type="button"
          aria-pressed={failed ? undefined : paused}
          onClick={() => {
            if (failed) {
              setFailed(false);
              setPaused(false);
            } else setPaused((value) => !value);
          }}
        >
          {failed ? <RotateCcw size={14} /> : paused ? <Play size={14} /> : <Pause size={14} />}
          {t(failed ? 'Try again' : paused ? 'Resume animation' : 'Pause animation')}
        </button>
      </div>
      <p className="sports-football-caption">{t('ONE WALLET. A WORLD OF SPORT.')}</p>
    </div>
  );
}
