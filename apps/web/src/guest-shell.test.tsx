import type * as ApiModule from '@/lib/api';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const { auth, get, post, listGroups } = vi.hoisted(() => ({
  auth: {
    user: null as null | { id: string; username: string },
    isAuthenticated: false,
    isLoading: false,
    logout: vi.fn(),
  },
  get: vi.fn(),
  post: vi.fn(),
  listGroups: vi.fn(),
}));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  api: { get, post, listGroups },
}));
// Sentinels prove private route components are never mounted, rather than hiding their UI.
vi.mock('@/pages/play-together', () => ({ PlayTogetherPage: () => <p>Private shared lobby</p> }));
vi.mock('@/pages/groups', () => ({ GroupsPage: () => <p>Private groups</p> }));
vi.mock('@/pages/sports', () => ({ SportsPage: () => <p>Private sports lobby</p> }));
vi.mock('@/pages/casino', () => ({ CasinoPage: () => <p>Private casino lobby</p> }));
vi.mock('@/pages/sports-launch', () => ({ SportsLaunchPage: () => <p>Private sports launch</p> }));
vi.mock('@/pages/messages', () => ({ MessagesPage: () => <p>Private messages</p> }));
vi.mock('@/pages/group-invite-accept', () => ({
  GroupInviteAcceptPage: () => <p>Private invite</p>,
}));
vi.mock('@/components/notifications/notification-bell', () => ({
  NotificationBell: () => <p>Private notifications</p>,
}));

let navigate: ReturnType<typeof useNavigate>;
function Address() {
  const location = useLocation();
  navigate = useNavigate();
  return <div data-testid="address">{JSON.stringify(location)}</div>;
}
function setup(path: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = () => (
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <Address />
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const rendered = render(view());
  return { cache, container: rendered.container, refresh: () => rendered.rerender(view()) };
}
beforeEach(() => {
  auth.user = null;
  auth.isAuthenticated = false;
  auth.isLoading = false;
  vi.clearAllMocks();
  get.mockResolvedValue({ success: true, data: [] });
  post.mockResolvedValue({ success: true, data: {} });
  listGroups.mockResolvedValue({ success: true, data: [] });
});
afterEach(cleanup);

describe('guest member shell', () => {
  it.each([
    '/groups',
    '/messages',
    '/gifts',
    '/rewards',
    '/wallet',
    '/support',
    '/profile',
    '/casino',
  ])('keeps decorative motion separate from actions and private data at %s', (path) => {
    const { container } = setup(path);
    const artwork = container.querySelectorAll('.salem-guest-motion-art');
    expect(artwork).toHaveLength(path === '/casino' ? 4 : 1);
    artwork.forEach((element) => {
      expect(element).toHaveAttribute('aria-hidden', 'true');
      const picture = element.querySelector('img');
      expect(picture).toHaveAttribute('alt', '');
      expect(picture).toHaveAttribute('loading', 'lazy');
      expect(picture).toHaveAttribute('data-loaded', 'false');
      fireEvent.load(picture!);
      expect(picture).toHaveAttribute('data-loaded', 'true');
      expect(picture?.getAttribute('src')).toMatch(/^\/artwork\/guest-3d\/[a-z]+\.webp$/);
      expect(element.querySelector('button, a, input, [tabindex], [role="status"]')).toBeNull();
    });
    expect(post).not.toHaveBeenCalled();
    expect(listGroups).not.toHaveBeenCalled();
  });
  it.each([
    ['/sports/open?launch=1#session', 'Private sports launch'],
    ['/Sports/open', 'Private sports launch'],
    ['/%73ports/open', 'Private sports launch'],
    ['/CASINO?game=provider-secret', 'Private casino lobby'],
    ['/%63asino?game=provider-secret', 'Private casino lobby'],
    ['/casino?game=provider-secret', 'Private casino lobby'],
  ])('preserves %s while resolving an existing member session', (path, label) => {
    auth.isLoading = true;
    const mounted = setup(path);
    const address = JSON.parse(screen.getByTestId('address').textContent!);
    expect(address.pathname + address.search + address.hash).toBe(path);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    auth.isAuthenticated = true;
    auth.isLoading = false;
    auth.user = { id: 'member', username: 'Member' };
    mounted.refresh();
    expect(screen.getByText(label)).toBeInTheDocument();
    const restoredAddress = JSON.parse(screen.getByTestId('address').textContent!);
    expect(restoredAddress.pathname + restoredAddress.search + restoredAddress.hash).toBe(path);
  });
  it.each([
    ['/sports/open?launch=1', '/sports', 'Private sports lobby'],
    ['/Sports/open', '/sports', 'Private sports lobby'],
    ['/%73ports/open', '/sports', 'Private sports lobby'],
    ['/casino?game=provider-secret', '/casino', 'Private casino lobby'],
  ])('cannot replay %s with Back after authentication', async (path, destination, label) => {
    const mounted = setup(path);
    fireEvent.click(document.querySelector('.salem-guest-signin')!);
    expect(JSON.parse(screen.getByTestId('address').textContent!).pathname).toBe('/login');
    auth.isAuthenticated = true;
    auth.user = { id: 'member', username: 'Member' };
    await act(async () => {
      navigate(destination, { replace: true });
    });
    mounted.refresh();
    await act(async () => {
      navigate(-1);
    });
    expect(JSON.parse(screen.getByTestId('address').textContent!).pathname).toBe(destination);
    expect(JSON.parse(screen.getByTestId('address').textContent!).search).toBe('');
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Private sports launch')).not.toBeInTheDocument();
    expect(post.mock.calls.every(([path]) => path === '/member-rewards/activity')).toBe(true);
  });

  it.each(['/', '/dashboard', '/explore'])(
    'opens %s directly in the real shell with all normal menus',
    (path) => {
      setup(path);
      const nav = screen.getByRole('navigation', { name: 'Main navigation' });
      for (const name of [
        'Home',
        'Play together',
        'Casino',
        'Sports',
        'Groups',
        'Messages',
        'Wallet',
        'Gifts',
        'Rewards',
        'Support',
      ])
        expect(within(nav).getByRole('link', { name })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A little play.');
      expect(screen.getByRole('link', { name: 'Explore Spin' })).toHaveAttribute(
        'href',
        '/play-together?game=spin_win'
      );
      expect(screen.queryByText('Private notifications')).not.toBeInTheDocument();
      expect(screen.queryByText('Sign out')).not.toBeInTheDocument();
      expect(screen.queryByText('@')).not.toBeInTheDocument();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(listGroups).not.toHaveBeenCalled();
    }
  );
  it.each([
    '/casino?game=provider-secret',
    '/sports',
    '/sports/open',
    '/groups',
    '/groups/invite/secret?accept=1',
    '/messages',
    '/messages/private-room',
    '/wallet',
    '/wallet/withdraw',
    '/gifts',
    '/rewards',
    '/profile',
    '/support',
    '/challenges',
    '/competitions',
    '/games/spin-win',
    '/games/history',
    '/play-together/rounds/private-round',
  ])('keeps %s in a safe, data-free preview without redirecting', (path) => {
    setup(path);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('address')).not.toHaveTextContent('"pathname":"/login"');
    expect(
      screen.queryAllByText(
        /^Private (shared lobby|groups|sports launch|messages|invite|notifications)$/
      )
    ).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(listGroups).not.toHaveBeenCalled();
  });
  it('returns keyboard focus to the menu button when the mobile navigation closes', async () => {
    setup('/dashboard');
    const opener = screen.getByRole('button', { name: 'Open navigation menu' });
    opener.focus();
    fireEvent.click(opener);
    const drawer = await screen.findByRole('dialog', { name: 'Main navigation' });
    fireEvent.keyDown(drawer, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it('shows neither guest sign-in nor member controls while the session probe is pending', () => {
    auth.isLoading = true;
    setup('/dashboard');
    const header = screen.getByRole('banner');
    expect(within(header).queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(within(header).queryByRole('link', { name: 'Create account' })).toBeNull();
    expect(within(header).queryByRole('link', { name: 'Open your wallet' })).toBeNull();
    expect(screen.queryByText('Make yourself at home.')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });
  it('closes a sign-in prompt opened during the probe once the session confirms a member', async () => {
    auth.isLoading = true;
    const { refresh } = setup('/wallet');
    fireEvent.click(screen.getByRole('button', { name: 'Open wallet' }));
    await screen.findByRole('dialog');
    auth.isLoading = false;
    auth.isAuthenticated = true;
    auth.user = { id: 'member', username: 'member' };
    act(() => refresh());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('keeps browsing available during a slow session probe', () => {
    auth.isLoading = true;
    setup('/sports');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Every match.');
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it('lets visitors search games, inspect a game, and cancel the protected action without losing their place', async () => {
    setup('/');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search games' }), {
      target: { value: 'dice' },
    });
    expect(screen.getByRole('link', { name: 'Explore Dice' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Explore Football' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Explore Dice' }));
    expect(screen.getByRole('heading', { name: 'Dice', level: 2 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Find a room' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep browsing' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('address')).toHaveTextContent('?game=dice');
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      navigate(-1);
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('A little play.');
  });
  it('strips action-bearing deep links before sign-in', () => {
    setup('/sports/open?token=secret#launch');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to open sports' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Sign in' }));
    const address = JSON.parse(screen.getByTestId('address').textContent!);
    expect(address.pathname).toBe('/login');
    expect(address.state.from).toEqual({ pathname: '/sports', search: '', hash: '' });
    expect(post).not.toHaveBeenCalled();
  });
  it('preserves the normal signed-in route and notification controls', async () => {
    auth.isAuthenticated = true;
    auth.user = { id: 'member', username: 'Member' };
    setup('/play-together');
    expect(screen.getByText('Private shared lobby')).toBeInTheDocument();
    expect(screen.getByText('Private notifications')).toBeInTheDocument();
    expect(screen.getByText('Sign out')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument();
  });
});
