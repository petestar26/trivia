import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import FootballScene from './football-scene';
import type { EngineOptions, MatchInput } from './engine/engine';

const created = vi.hoisted(() => ({
  engines: [] as Array<{
    options: EngineOptions;
    engine: { setMatch: Mock; setReduced: Mock; start: Mock; stop: Mock; dispose: Mock };
  }>,
  failNext: null as null | Error,
  setMatchThrows: false,
}));
vi.mock('./engine/engine', () => ({
  createEngine: (options: EngineOptions) => {
    if (created.failNext) {
      const error = created.failNext;
      created.failNext = null;
      throw error;
    }
    const engine = {
      setMatch: vi.fn(() => {
        if (created.setMatchThrows) throw new Error('boom');
      }),
      setReduced: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      dispose: vi.fn(),
    };
    created.engines.push({ options, engine });
    return engine;
  },
}));

const match: MatchInput = {
  matchKey: 'vf-s1-w05-f01',
  homeClub: 1,
  awayClub: 2,
  goals: [],
  fullTime: null,
};
const props = {
  match,
  getElapsed: () => 1000,
  reduced: false,
  label: '3D view',
  fallback: <p>Text match centre</p>,
};

beforeEach(() => {
  created.engines.length = 0;
  created.failNext = null;
  created.setMatchThrows = false;
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('FootballScene lifecycle', () => {
  it('starts one engine with the released match and disposes it on unmount', () => {
    const { unmount } = render(<FootballScene {...props} />);
    expect(created.engines).toHaveLength(1);
    const { engine } = created.engines[0];
    expect(engine.setMatch).toHaveBeenCalledWith(match);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Text match centre')).toBeNull();
    unmount();
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('forwards match and reduced-motion changes without rebuilding the renderer', () => {
    const { rerender } = render(<FootballScene {...props} />);
    const next = { ...match, matchKey: 'vf-s1-w05-f02' };
    rerender(<FootballScene {...props} match={next} reduced />);
    expect(created.engines).toHaveLength(1);
    expect(created.engines[0].engine.setMatch).toHaveBeenLastCalledWith(next);
    expect(created.engines[0].engine.setReduced).toHaveBeenLastCalledWith(true);
  });

  it('falls back to the text match centre when WebGL is unavailable, with no retry loop', () => {
    created.failNext = new Error('WebGL not supported');
    render(<FootballScene {...props} />);
    expect(screen.getByText('Text match centre')).toBeInTheDocument();
    expect(screen.getByText(/3D view is not available on this device/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry 3D view' })).toBeNull();
    act(() => void vi.advanceTimersByTime(30_000));
    expect(created.engines).toHaveLength(0);
  });

  it('shows the fallback on context loss, then rebuilds every GPU resource after the grace period', () => {
    render(<FootballScene {...props} />);
    const first = created.engines[0];
    act(() => first.options.onContextLost?.());
    expect(first.engine.dispose).toHaveBeenCalled();
    expect(screen.getByText('Text match centre')).toBeInTheDocument();
    expect(screen.getByText(/restoring/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(4100));
    expect(created.engines).toHaveLength(2);
    expect(screen.queryByText('Text match centre')).toBeNull();
    expect(created.engines[1].engine.start).toHaveBeenCalled();
  });

  it('stops rebuilding automatically after repeated losses and lets the member retry', () => {
    render(<FootballScene {...props} />);
    for (let i = 0; i < 4; i++) {
      const latest = created.engines[created.engines.length - 1];
      act(() => latest.options.onContextLost?.());
      act(() => void vi.advanceTimersByTime(4100));
    }
    const built = created.engines.length;
    expect(built).toBe(4); // initial + three automatic rebuilds
    expect(screen.getByText('Text match centre')).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(60_000));
    expect(created.engines).toHaveLength(built);
    fireEvent.click(screen.getByRole('button', { name: 'Retry 3D view' }));
    expect(created.engines).toHaveLength(built + 1);
    expect(screen.queryByText('Text match centre')).toBeNull();
  });

  it('contains a render-time failure and offers the text match centre with a retry', () => {
    created.setMatchThrows = true;
    // React logs the contained error in development; the assertion is the fallback.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<FootballScene {...props} />);
    expect(screen.getByText('Text match centre')).toBeInTheDocument();
    expect(screen.getByText(/The 3D view stopped/)).toBeInTheDocument();
    created.setMatchThrows = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry 3D view' }));
    expect(screen.queryByText('Text match centre')).toBeNull();
  });

  it('flashes the camera-cut overlay only when motion is allowed', () => {
    const { rerender, container } = render(<FootballScene {...props} />);
    const host = screen.getByTestId('football-scene');
    act(() => void host.dispatchEvent(new CustomEvent('football-cut')));
    expect(container.querySelector('.vf-scene-cut')).toHaveClass('is-on');
    act(() => void vi.advanceTimersByTime(300));
    expect(container.querySelector('.vf-scene-cut')).not.toHaveClass('is-on');
    rerender(<FootballScene {...props} reduced />);
    act(() => void host.dispatchEvent(new CustomEvent('football-cut')));
    expect(container.querySelector('.vf-scene-cut')).not.toHaveClass('is-on');
  });
});
