import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, it, expect } from 'vitest';
import { MobileNavigation } from './mobile-navigation';
afterEach(cleanup);
it('provides six real destinations including sports and marks the current section', () => {
  render(
    <MemoryRouter initialEntries={['/casino']}>
      <MobileNavigation />
    </MemoryRouter>
  );
  expect(screen.getAllByRole('link')).toHaveLength(6);
  expect(screen.getByRole('link', { name: 'Sports' })).toHaveAttribute('href', '/sports');
  expect(screen.getByRole('link', { name: 'Casino' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Wallet' })).toHaveAttribute('href', '/wallet');
});
it.each(['/games/sky-crash', '/messages', '/messages/group'])(
  'leaves game and chat controls unobstructed at %s',
  (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <MobileNavigation />
      </MemoryRouter>
    );
    expect(screen.queryByRole('navigation')).toBeNull();
  }
);

it('marks the shared game lobby as the group-play destination', () => {
  render(
    <MemoryRouter initialEntries={['/play-together?game=dice']}>
      <MobileNavigation />
    </MemoryRouter>
  );
  expect(screen.getByRole('link', { name: 'Play together' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  expect(screen.getByRole('link', { name: 'Play together' })).toHaveAttribute(
    'href',
    '/play-together'
  );
});

it.each(['/', '/explore'])('marks Home active for guest entry %s', (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <MobileNavigation guest />
    </MemoryRouter>
  );
  expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
});
it.each(['/games/sky-crash', '/messages', '/messages/group'])(
  'keeps guest preview navigation visible at %s',
  (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <MobileNavigation guest />
      </MemoryRouter>
    );
    expect(screen.getByRole('navigation', { name: 'Quick navigation' })).toBeInTheDocument();
  }
);
