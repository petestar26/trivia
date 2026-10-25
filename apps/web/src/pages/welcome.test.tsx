import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WelcomePage, ExplorePage } from './welcome';
import { ProtectedRoute } from '@/components/auth/protected-route';
import { App } from '@/App';
import { Sidebar } from '@/components/layout/sidebar';
const { auth } = vi.hoisted(() => ({ auth: { isAuthenticated: false, isLoading: false } }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => auth }));
function LoginTarget() {
  const location = useLocation();
  return <p>Sign in to continue to {location.state?.from?.pathname}</p>;
}
function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<WelcomePage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/login" element={<LoginTarget />} />
        <Route path="/dashboard" element={<p>Member dashboard</p>} />
        <Route element={<ProtectedRoute />}>
          <Route path="/groups" element={<p>Private groups</p>} />
          <Route path="/games/dice" element={<p>Game entry</p>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
beforeEach(() => {
  auth.isAuthenticated = false;
  auth.isLoading = false;
});
afterEach(cleanup);
it.each(['/', '/explore'])(
  'actual app route %s remains public while the session probe is loading',
  (path) => {
    auth.isLoading = true;
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    );
    expect(screen.getByRole('navigation', { name: 'Account' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
  }
);
it('opens with a welcome scene, not a credential form, and lets guests browse', () => {
  mount();
  expect(screen.getByRole('heading', { name: /A world of play/ })).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'Enter the lounge' }));
  expect(screen.getByRole('heading', { name: 'The game collection' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Create account/ })).toHaveAttribute('href', '/register');
});
it('provides an explicit pause and resume control for decorative motion', () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Pause animation' }));
  expect(screen.getByRole('button', { name: 'Resume animation' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(document.querySelector('.pq-welcome')).toHaveClass('is-paused');
  fireEvent.click(screen.getByRole('button', { name: 'Resume animation' }));
  expect(document.querySelector('.pq-welcome')).not.toHaveClass('is-paused');
});
it('keeps optional Sky Crash assets gated while describing public discovery honestly', () => {
  mount('/explore');
  expect(document.body.innerHTML).not.toContain('/images/sky-crash/');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(
    screen.getByText(/Sign in to check availability and join a game or group/)
  ).toBeInTheDocument();
  expect(screen.queryByText('Private groups')).not.toBeInTheDocument();
});
it.each([
  ['Free practice Dice', '/games/dice'],
  ['Find a group', '/groups'],
])('requires authentication for %s and preserves the selected destination', (name, destination) => {
  mount('/explore');
  const link =
    name === 'Find a group'
      ? screen.getByRole('link', { name })
      : screen.getByRole('link', { name: /Dice Sign in to check availability/ });
  fireEvent.click(link);
  expect(screen.getByText('Sign in to continue to ' + destination)).toBeInTheDocument();
  expect(screen.queryByText('Game entry')).not.toBeInTheDocument();
  expect(screen.queryByText('Private groups')).not.toBeInTheDocument();
});
it('takes authenticated visitors directly to the member dashboard', () => {
  auth.isAuthenticated = true;
  mount();
  expect(screen.getByText('Member dashboard')).toBeInTheDocument();
});
it('keeps the member Home destination and current-page state aligned', () => {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar />
    </MemoryRouter>
  );
  expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'href',
    '/dashboard'
  );
  expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'page'
  );
});
it('offers the member lounge instead of signup prompts when an authenticated member browses', () => {
  auth.isAuthenticated = true;
  mount('/explore');
  expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Create account/ })).not.toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /Open your lounge/ })).toHaveLength(2);
  expect(screen.getByRole('link', { name: /Dice Check availability/ })).toHaveAttribute(
    'href',
    '/games/dice'
  );
  expect(screen.getByRole('link', { name: 'Find a group' })).toHaveAttribute('href', '/groups');
});
