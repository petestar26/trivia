import { Brain, Sparkles } from 'lucide-react';

/** Decorative only: these illustrations never represent a live game outcome. */
export function GameArtwork({ kind, hero = false }: { kind: string; hero?: boolean }) {
  return (
    <div
      className={`qube-art qube-art--${kind} ${hero ? 'qube-art--hero' : ''}`}
      aria-hidden="true"
    >
      <div className="qube-art-orbit" />
      {kind === 'dice' ? (
        <div className="qube-dice-scene">
          <div className="qube-die">
            <div className="qube-die-front">
              {[0, 1, 2, 3, 4].map((n) => (
                <i key={n} />
              ))}
            </div>
            <div className="qube-die-top">
              <i />
              <i />
              <i />
            </div>
            <div className="qube-die-side">
              <i />
              <i />
            </div>
          </div>
        </div>
      ) : kind === 'spin_win' ? (
        <div className="qube-wheel">
          <div className="qube-wheel-hub">
            <Sparkles size={28} />
          </div>
          <i className="qube-wheel-pointer" />
        </div>
      ) : kind === 'turbo_keno' ? (
        <div className="qube-balls">
          <span>08</span>
          <span>24</span>
          <span>36</span>
        </div>
      ) : (
        <div className="qube-art-symbol">
          <Brain size={70} strokeWidth={1.3} />
        </div>
      )}
      <div className="qube-art-platform" />
    </div>
  );
}
