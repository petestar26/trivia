import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock('@/components/layout/layout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { Layout: Outlet };
});
vi.mock('@/pages/games', () => ({
  GamesPage: ({ mode }: { mode?: string }) => <p>Our games: {mode ?? 'all modes'}</p>,
}));
vi.mock('@/pages/casino', () => ({ CasinoPage: () => <p>Provider casino</p> }));

function Location() {
  return <output aria-label="Current address">{useLocation().pathname}</output>;
}
afterEach(cleanup);

it('routes Games to our full catalogue without a BONUS-only override', () => {
  render(
    <MemoryRouter initialEntries={['/games']}>
      <App />
    </MemoryRouter>
  );
  expect(screen.getByText('Our games: all modes')).toBeInTheDocument();
  expect(screen.queryByText('Provider casino')).not.toBeInTheDocument();
});
it('keeps a direct Trivia visit on its coming soon page without starting practice', () => {
  render(
    <MemoryRouter initialEntries={['/games/trivia']}>
      <App />
    </MemoryRouter>
  );
  expect(screen.getByRole('heading', { name: 'Trivia' })).toBeInTheDocument();
  expect(screen.getByText('Coming soon')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Back to games' })).toHaveAttribute('href', '/games');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it.each(['/casino', '/games/provider-demos'])(
  'routes %s to the provider Casino destination',
  async (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <Location />
        <App />
      </MemoryRouter>
    );
    expect(await screen.findByText('Provider casino')).toBeInTheDocument();
    expect(screen.getByLabelText('Current address')).toHaveTextContent('/casino');
    expect(screen.queryByText('Our games: all modes')).not.toBeInTheDocument();
  }
);
