import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MotionShelf } from './motion-shelf';
function mount(reduced = false) {
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  render(
    <MotionShelf label="Games" count={3} allowGrid>
      <a href="/one">One</a>
      <a href="/two">Two</a>
      <a href="/three">Three</a>
    </MotionShelf>
  );
  const region = screen.getByRole('region', { name: 'Games' });
  Object.defineProperties(region, { clientWidth: { value: 280 }, scrollWidth: { value: 900 } });
  const scroll = vi.fn();
  Object.defineProperty(region, 'scrollTo', { value: scroll });
  Object.defineProperty(region, 'scrollBy', { value: vi.fn() });
  return { region, scroll };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('member carousel motion', () => {
  it('advances automatically and stops for pause, hover, keyboard focus and grid view', () => {
    vi.useFakeTimers();
    const { region, scroll } = mount();
    act(() => vi.advanceTimersByTime(5500));
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(region.parentElement!);
    act(() => vi.advanceTimersByTime(5500));
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(region.parentElement!);
    fireEvent.focus(screen.getByRole('link', { name: 'One' }));
    act(() => vi.advanceTimersByTime(5500));
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.blur(screen.getByRole('link', { name: 'One' }), { relatedTarget: null });
    fireEvent.click(screen.getByRole('button', { name: 'Pause Games motion' }));
    act(() => vi.advanceTimersByTime(5500));
    expect(scroll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Resume Games motion' }));
    act(() => vi.advanceTimersByTime(5500));
    expect(scroll).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show all games' }));
    act(() => vi.advanceTimersByTime(5500));
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it('does not autoplay for reduced motion, and manual navigation uses instant scrolling', () => {
    vi.useFakeTimers();
    const { region, scroll } = mount(true);
    act(() => vi.advanceTimersByTime(16500));
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next Games' }));
    expect(region.scrollBy).toHaveBeenCalledWith({ left: 224, behavior: 'auto' });
    expect(screen.getByRole('button', { name: 'Resume Games motion' })).toBeDisabled();
  });
});
