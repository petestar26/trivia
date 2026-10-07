import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, LayoutGrid, Rows3 } from 'lucide-react';

export function MotionShelf({
  label,
  children,
  count,
  allowGrid = false,
}: {
  label: string;
  children: ReactNode;
  count: number;
  allowGrid?: boolean;
}) {
  const shelf = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [grid, setGrid] = useState(false);
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query?.matches ?? false);
    const visibility = () => setVisible(!document.hidden);
    query?.addEventListener('change', change);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      query?.removeEventListener('change', change);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    if (paused || hovered || focused || grid || reduced || !visible || count < 2) return;
    const timer = window.setInterval(() => {
      const el = shelf.current;
      if (!el || el.scrollWidth <= el.clientWidth) return;
      const next =
        el.scrollLeft + (el.firstElementChild?.getBoundingClientRect().width ?? 280) + 18;
      el.scrollTo({
        left: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 ? 0 : next,
        behavior: 'smooth',
      });
    }, 5500);
    return () => window.clearInterval(timer);
  }, [paused, hovered, focused, grid, reduced, visible, count]);
  function move(direction: number) {
    setPaused(true);
    shelf.current?.scrollBy({
      left: direction * (shelf.current.clientWidth * 0.8),
      behavior: reduced ? 'auto' : 'smooth',
    });
  }
  return (
    <div
      className={`ruby-shelf ${paused || reduced || grid ? 'is-motion-paused' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="ruby-shelf-controls">
        {allowGrid && (
          <button type="button" aria-pressed={grid} onClick={() => setGrid(!grid)}>
            {grid ? <Rows3 size={16} /> : <LayoutGrid size={16} />}{' '}
            {grid ? 'Carousel view' : `Show all ${label.toLowerCase()}`}
          </button>
        )}
        {!grid && (
          <>
            <button type="button" onClick={() => move(-1)} aria-label={`Previous ${label}`}>
              <ChevronLeft size={19} />
            </button>
            <button type="button" onClick={() => move(1)} aria-label={`Next ${label}`}>
              <ChevronRight size={19} />
            </button>
            <button
              type="button"
              onClick={() => setPaused(!paused)}
              disabled={reduced || count < 2}
              aria-label={`${paused || reduced ? 'Resume' : 'Pause'} ${label} motion`}
            >
              {paused || reduced ? <Play size={15} /> : <Pause size={15} />}
              {reduced ? 'Motion off' : paused ? 'Play' : 'Pause'}
            </button>
          </>
        )}
      </div>
      <div
        ref={shelf}
        className={`ruby-shelf-track ${grid ? 'is-grid' : ''}`}
        role="region"
        aria-label={label}
        tabIndex={0}
        onPointerDown={() => setPaused(true)}
      >
        {children}
      </div>
    </div>
  );
}
