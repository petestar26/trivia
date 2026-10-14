import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { FlightScene } from './flight-scene';
afterEach(cleanup);
it('keeps departure tied to server reveal, freezes decorative loops offline and resets for a new round', () => {
  const view = render(<FlightScene elapsed={8000} flying connected departed={false} />);
  expect(screen.queryByTestId('sky-crash-impact')).toBeNull();
  expect(view.container.firstChild).toHaveClass('is-moving');
  const position = view.container.querySelector('.sky-flight-plane')!.getAttribute('style');
  view.rerender(<FlightScene elapsed={30000} flying connected={false} departed={false} />);
  expect(view.container.firstChild).not.toHaveClass('is-moving');
  expect(view.container.querySelector('.sky-flight-plane')!.getAttribute('style')).toBe(position);
  expect(screen.queryByTestId('sky-crash-impact')).toBeNull();
  view.rerender(<FlightScene elapsed={30000} flying={false} connected departed />);
  expect(screen.getByTestId('sky-crash-impact')).toBeInTheDocument();
  view.rerender(
    <FlightScene key="next-round" elapsed={0} flying={false} connected departed={false} />
  );
  expect(screen.queryByTestId('sky-crash-impact')).toBeNull();
  expect(view.container.firstChild).toHaveAttribute('data-climb', 'runway');
});
it('retains an original vector aircraft when the bitmap cannot load', () => {
  const view = render(<FlightScene elapsed={0} flying={false} connected departed={false} />);
  fireEvent.error(view.container.querySelector('image')!);
  expect(screen.getByTestId('sky-aircraft-fallback')).toBeInTheDocument();
  expect(view.container.querySelector('image')).toBeNull();
});
it('keeps the aircraft still under reduced motion while the multiplier clock advances', () => {
  const original = window.matchMedia;
  window.matchMedia = () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  try {
    const view = render(<FlightScene elapsed={1000} flying connected departed={false} />);
    const plane = view.container.querySelector('.sky-flight-plane')!;
    const position = plane.getAttribute('style');
    view.rerender(<FlightScene elapsed={15000} flying connected departed={false} />);
    expect(plane.getAttribute('style')).toBe(position);
  } finally {
    window.matchMedia = original;
  }
});
