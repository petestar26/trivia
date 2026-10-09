import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { GameArtwork } from './game-artwork';
afterEach(cleanup);
it.each([undefined, false])(
  'does not emit optional asset URLs when practice availability is %s',
  (practiceAvailable) => {
    const { container } = render(
      <GameArtwork kind="sky_crash" practiceAvailable={practiceAvailable} />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('/images/sky-crash/');
  }
);
it('only emits compact art on opt-in and removes it when disabled', () => {
  const { container, rerender } = render(<GameArtwork kind="sky_crash" practiceAvailable />);
  expect(container.querySelector('img')).toHaveAttribute('src', '/images/sky-crash/aircraft.webp');
  expect(container.querySelector('img')).toHaveAttribute('loading', 'lazy');
  expect((container.firstElementChild as HTMLElement).style.backgroundImage).toContain(
    '/images/sky-crash/alpine-dawn.webp'
  );
  rerender(<GameArtwork kind="sky_crash" practiceAvailable={false} />);
  expect(container.innerHTML).not.toContain('/images/sky-crash/');
});
