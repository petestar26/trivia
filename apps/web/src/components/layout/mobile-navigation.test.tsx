import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, it, expect } from 'vitest';
import { MobileNavigation } from './mobile-navigation';
afterEach(cleanup);
it('provides five real destinations and marks the current section', () => {
  render(
    <MemoryRouter initialEntries={['/casino']}>
      <MobileNavigation />
    </MemoryRouter>
  );
  expect(screen.getAllByRole('link')).toHaveLength(5);
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
