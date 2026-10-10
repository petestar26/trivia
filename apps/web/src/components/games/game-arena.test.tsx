import { useEffect, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameArena } from './game-arena';

beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
});

describe('mounted game arena expansion', () => {
  it('fills the viewport without native fullscreen and preserves the canvas and child state', () => {
    const mounted = vi.fn();
    const disposed = vi.fn();
    const requestFullscreen = vi.fn().mockRejectedValue(new Error('Unsupported on this phone'));
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    function Scene() {
      const [value, setValue] = useState(0);
      useEffect(() => {
        mounted();
        return disposed;
      }, []);
      return (
        <>
          <canvas data-testid="canvas" />
          <button onClick={() => setValue(value + 1)}>Scene state {value}</button>
        </>
      );
    }
    const { unmount } = render(
      <GameArena title="Test game">
        <Scene />
      </GameArena>
    );
    const canvas = screen.getByTestId('canvas');
    const toggle = screen.getByRole('button', { name: 'Expand Test game view' });
    toggle.focus();
    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Test game expanded view' });
    expect(dialog).toHaveClass('game-arena--expanded');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Scene state 0' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Minimize Test game view' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('canvas')).toBe(canvas);
    expect(screen.getByRole('button', { name: 'Scene state 1' })).toBeInTheDocument();
    expect(toggle).toHaveFocus();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();
    expect(requestFullscreen).not.toHaveBeenCalled();
    unmount();
    expect(disposed).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  });

  it('isolates hidden controls, traps focus, and restores attributes and scrolling on Escape', () => {
    document.body.style.cssText =
      'position: relative; top: 3px; left: 4px; width: 95%; overflow: auto';
    document.documentElement.style.overflow = 'scroll';
    vi.spyOn(window, 'scrollX', 'get').mockReturnValue(41);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(120);
    const activate = vi.fn();
    render(
      <main>
        <button aria-hidden="false" onClick={activate}>
          Hidden ticket confirmation
        </button>
        <GameArena title="Race">
          <button>View option</button>
        </GameArena>
      </main>
    );
    const outside = screen.getByRole('button', { name: 'Hidden ticket confirmation' });
    const toggle = screen.getByRole('button', { name: 'Expand Race view' });
    toggle.focus();
    fireEvent.click(toggle);
    expect(outside).toHaveAttribute('inert');
    expect(outside).toHaveAttribute('aria-hidden', 'true');
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-120px');
    expect(document.body.style.left).toBe('-41px');
    fireEvent.click(outside);
    expect(activate).not.toHaveBeenCalled();
    outside.focus();
    expect(toggle).toHaveFocus();
    fireEvent.keyDown(toggle, { key: 'Tab', shiftKey: true });
    const last = screen.getByRole('button', { name: 'View option' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(toggle).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle).toHaveFocus();
    expect(outside).not.toHaveAttribute('inert');
    expect(outside).toHaveAttribute('aria-hidden', 'false');
    expect(document.body.style.position).toBe('relative');
    expect(document.body.style.top).toBe('3px');
    expect(document.body.style.left).toBe('4px');
    expect(document.body.style.width).toBe('95%');
    expect(document.body.style.overflow).toBe('auto');
    expect(document.documentElement.style.overflow).toBe('scroll');
    expect(window.scrollTo).toHaveBeenLastCalledWith(41, 120);
    fireEvent.click(outside);
    expect(activate).toHaveBeenCalledOnce();
  });

  it('isolates new background controls and releases the body lock on route teardown', async () => {
    const { rerender, unmount } = render(
      <main>
        <GameArena title="Race">
          <canvas />
        </GameArena>
        <div data-testid="background" />
      </main>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand Race view' }));
    rerender(
      <main>
        <GameArena title="Race">
          <canvas />
        </GameArena>
        <div data-testid="background" />
        <button data-testid="new">New ticket</button>
      </main>
    );
    const added = screen.getByTestId('new');
    await waitFor(() => expect(added).toHaveAttribute('inert'));
    const background = screen.getByTestId('background');
    unmount();
    expect(added).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('aria-hidden');
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(document.documentElement.style.overflow).toBe('');
  });
});
