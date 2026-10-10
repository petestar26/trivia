import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useExpandedArena } from './use-expanded-arena';
import './game-arena.css';

/** Viewport-filling display without native fullscreen or a canvas-remounting portal. */
export function GameArena({
  title,
  children,
  className = '',
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = useCallback(() => setExpanded(false), []);
  useExpandedArena(expanded, panel, toggle, close);
  return (
    <div
      ref={panel}
      className={`game-arena ${className}${expanded ? ' game-arena--expanded' : ''}`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? `${title} expanded view` : undefined}
      aria-describedby={expanded ? `${id}-help` : undefined}
    >
      <div className="game-arena__toolbar">
        <span>{title}</span>
        <button
          ref={toggle}
          type="button"
          className="game-arena__toggle"
          aria-label={`${expanded ? 'Minimize' : 'Expand'} ${title} view`}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? (
            <Minimize2 size={18} aria-hidden="true" />
          ) : (
            <Maximize2 size={18} aria-hidden="true" />
          )}
          {expanded ? 'Minimize view' : 'Expand view'}
        </button>
      </div>
      <span id={`${id}-help`} className="sr-only">
        Expanded viewing display. Minimize the view or press Escape to return to your selections.
      </span>
      <div className="game-arena__body" id={id}>
        {children}
      </div>
    </div>
  );
}
