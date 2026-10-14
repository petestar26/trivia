import { Component, type ReactNode } from 'react';
import './scene-load-boundary.css';

/** A lazy import can fail before the renderer's own boundary has mounted. */
export class SceneLoadBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="game-scene-recovery" role="status">
        {this.props.fallback}
        <p>
          The 3D view could not load. Results remain available.{' '}
          <button type="button" onClick={() => window.location.reload()}>
            Reload game view
          </button>
        </p>
      </div>
    ) : (
      this.props.children
    );
  }
}
