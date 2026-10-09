import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { createEngine, type Engine, type MatchInput } from './engine/engine';

/**
 * Lazy 3D match view. Purely decorative: it renders only facts the server has already
 * released (elapsed goals, kick-off, half-time, full time) and never decides a result.
 * Any failure (no WebGL, context loss, a render error) falls back to the text match centre.
 */
export interface FootballSceneProps {
  match: MatchInput | null;
  /** Server-synchronised match clock in ms after kick-off. */
  getElapsed: () => number;
  reduced: boolean;
  /** Rendered instead of the canvas whenever 3D is unavailable. */
  fallback: ReactNode;
  label: string;
  onGoalMoment?: (n: number) => void;
}

type Problem = null | 'unsupported' | 'lost' | 'error';
const RESTORE_GRACE_MS = 4000;

class SceneBoundary extends Component<
  { onError: () => void; resetKey: number; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onError();
  }
  componentDidUpdate(prev: { resetKey: number }) {
    if (prev.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SceneCanvas({
  match,
  getElapsed,
  reduced,
  label,
  onGoalMoment,
  onProblem,
  onReady,
}: Omit<FootballSceneProps, 'fallback'> & {
  onProblem: (p: Exclude<Problem, null>) => void;
  onReady: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const live = useRef({ getElapsed, onGoalMoment, onProblem, onReady, match, reduced });
  live.current = { getElapsed, onGoalMoment, onProblem, onReady, match, reduced };
  const [cut, setCut] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let engine: Engine;
    try {
      engine = createEngine({
        host: element,
        getElapsed: () => live.current.getElapsed(),
        reduced: live.current.reduced,
        onGoalMoment: (n) => live.current.onGoalMoment?.(n),
        onContextLost: () => live.current.onProblem('lost'),
      });
    } catch {
      live.current.onProblem('unsupported');
      return;
    }
    engineRef.current = engine;
    if (live.current.match) engine.setMatch(live.current.match);
    engine.start();
    live.current.onReady();
    let timer = 0;
    const onCut = () => {
      if (live.current.reduced) return;
      setCut(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setCut(false), 260);
    };
    element.addEventListener('football-cut', onCut);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener('football-cut', onCut);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (match) engineRef.current?.setMatch(match);
  }, [match]);
  useEffect(() => {
    engineRef.current?.setReduced(reduced);
  }, [reduced]);

  return (
    <div className="vf-scene" ref={host} role="img" aria-label={label} data-testid="football-scene">
      <div className={`vf-scene-cut${cut ? ' is-on' : ''}`} aria-hidden="true" />
    </div>
  );
}

export default function FootballScene(props: FootballSceneProps) {
  const [problem, setProblem] = useState<Problem>(null);
  const [revision, setRevision] = useState(0);
  const timer = useRef(0);
  const { fallback, ...canvasProps } = props;

  // A lost context is given a short grace period; the text match centre covers the gap and,
  // if the browser never restores it, a retry rebuilds every GPU resource from scratch.
  const losses = useRef<number[]>([]);
  const report = useCallback((p: Exclude<Problem, null>) => {
    setProblem(p);
    window.clearTimeout(timer.current);
    if (p !== 'lost') return;
    // At most three automatic rebuilds a minute; after that a person has to ask for it.
    const now = Date.now();
    losses.current = [...losses.current.filter((t) => now - t < 60_000), now];
    if (losses.current.length > 3) return;
    timer.current = window.setTimeout(() => {
      setRevision((r) => r + 1);
      setProblem(null);
    }, RESTORE_GRACE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const retry = () => {
    setProblem(null);
    setRevision((r) => r + 1);
  };

  return (
    <div className="vf-stage-view" data-problem={problem ?? 'none'}>
      {problem === null && (
        <SceneBoundary key={revision} resetKey={revision} onError={() => report('error')}>
          <SceneCanvas
            key={revision}
            {...canvasProps}
            onProblem={report}
            onReady={() => undefined}
          />
        </SceneBoundary>
      )}
      {problem !== null && (
        <div className="vf-scene-fallback" role="status">
          {fallback}
          <p className="vf-scene-note">
            {problem === 'lost'
              ? 'The 3D view paused and is restoring. Results continue below.'
              : problem === 'unsupported'
                ? '3D view is not available on this device. Results continue below.'
                : 'The 3D view stopped. Results continue below.'}{' '}
            {problem !== 'unsupported' && (
              <button type="button" className="vf-link" onClick={retry}>
                Retry 3D view
              </button>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
