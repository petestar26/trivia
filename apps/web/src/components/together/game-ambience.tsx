import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { TogetherGame } from '@socialplay/shared';
import { GameArtwork } from '@/components/member/game-artwork';
import { SpinWinWheel } from '@/components/spin/spin-wheel';
import { KenoMachine } from '@/components/keno/draw-machine';
import { LuckySixMachine } from '@/components/lucky-six/draw-machine';
import { RouletteKenoWheel } from '@/components/roulette-keno/wheel';
import { DiceFace } from '@/components/dice/dice-face';
import { BlackjackCard } from '@/components/blackjack/table';
import { NumberBall } from '@/components/number-challenge/number-ball';
import '@/pages/games/keno.css';
import '@/pages/games/lucky-six.css';
import '@/pages/games/roulette-keno.css';
import '@/pages/games/dice-system.css';
import '@/pages/games/blackjack.css';
import '@/pages/games/number-challenge.css';
import './game-ambience.css';

// Decorative scenes have no round data, timers, wallet calls or result state.
// Offscreen/hidden pages stop their CSS motion; the same artwork remains visible.
function useVisibleMotion() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [foreground, setForeground] = useState(() => !document.hidden);
  useEffect(() => {
    const onVisibility = () => setForeground(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
            rootMargin: '40px',
          });
    if (ref.current) observer?.observe(ref.current);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return { ref, running: visible && foreground };
}

const previewPockets = Array.from({ length: 12 }, (_, i) => ({
  label: '',
  color: i % 2 ? '#111918' : '#b91f32',
}));

export function GameAmbience({ game, paused }: { game: TogetherGame; paused: boolean }) {
  const { ref, running } = useVisibleMotion();
  const sports = ['thunder_derby_3d', 'neon_hounds_3d', 'virtual_football_3d'].includes(game);
  return (
    <div
      ref={ref}
      className="tg-ambience"
      data-game={game}
      data-running={running && !paused}
      aria-hidden="true"
    >
      <div className="tg-ambience-halo" />
      <div className="tg-ambience-grid" />
      <div className="tg-ambience-piece">
        {game === 'spin_win' ? (
          <div className="tg-ambient-wheel">
            <SpinWinWheel rotation={0} segments={previewPockets} continuous />
          </div>
        ) : game === 'turbo_keno' ? (
          <KenoMachine number={null} running />
        ) : game === 'lucky_six' ? (
          <LuckySixMachine latest={null} drawing />
        ) : game === 'roulette_keno' ? (
          <RouletteKenoWheel latest={null} drawing />
        ) : game === 'dice' ? (
          <div className="tg-ambient-dice">
            <DiceFace value={5} />
            <DiceFace value={3} />
          </div>
        ) : game === 'blackjack' ? (
          <div className="tg-ambient-cards">
            <BlackjackCard value={0} index={0} />
            <BlackjackCard value={22} index={1} />
            <BlackjackCard index={2} />
          </div>
        ) : game === 'number_challenge' ? (
          <NumberBall target={null} />
        ) : game === 'sky_crash' ? (
          <div className="tg-ambient-sky">
            <i />
            <img src="/images/sky-crash/jet-v1.webp" alt="" decoding="async" />
          </div>
        ) : (
          <div className={'tg-ambient-art ' + (sports ? 'is-sport' : 'is-crash')}>
            <GameArtwork kind={game} hero practiceAvailable />
            <span className="tg-ambient-sweep" />
          </div>
        )}
      </div>
      <div className="tg-ambience-spark tg-ambience-spark-one" />
      <div className="tg-ambience-spark tg-ambience-spark-two" />
    </div>
  );
}

/** Illustrated players, deliberately not live members or an occupancy count. */
export function CommunityAmbience({
  variant,
  paused,
}: {
  variant: 'room' | 'friends';
  paused: boolean;
}) {
  const { ref, running } = useVisibleMotion();
  return (
    <div
      ref={ref}
      className="tg-community-art"
      data-variant={variant}
      data-running={running && !paused}
      aria-hidden="true"
    >
      <div className="tg-community-orbit" />
      <div className="tg-community-table">
        <span />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div className="tg-community-player" style={{ '--person': i } as CSSProperties} key={i}>
          <span className="tg-community-head" />
          <span className="tg-community-body" />
          <i className="tg-community-chip" />
        </div>
      ))}
      <div className="tg-community-bubble">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
