import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupSocialNav } from './group-social-nav';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), user: { id: 'member' } }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (v: { data: unknown }) => v.data }));
let client: QueryClient;
let activity: {
  serverTime: number;
  activeRound: typeof summary | null;
  latestResult: typeof summary | null;
};
const summary = {
  id: 'round',
  game: 'spin_win',
  currency: 'GAME_POINTS',
  entryAmount: 100,
  state: 'OPEN',
  closesAt: 2000,
  participants: 2,
  groupName: 'Friends',
};
beforeEach(() => {
  vi.clearAllMocks();
  activity = { serverTime: 1000, activeRound: summary, latestResult: null };
  mocks.get.mockImplementation(async (path: string) => ({
    data: path.endsWith('/activity')
      ? activity
      : {
          serverTime: 1000,
          round: {
            ...summary,
            state: activity.activeRound ? 'OPEN' : 'REFUNDED',
            entries: [],
            outcome: null,
            paidAt: activity.activeRound ? null : 2500,
          },
        },
  }));
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount() {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/messages/group']}>
        <GroupSocialNav groupId="group" />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('shows every group member the shared round link without placing an entry', async () => {
  mount();
  expect(await screen.findByRole('link', { name: 'Open full round' })).toHaveAttribute(
    'href',
    '/play-together/rounds/round'
  );
  expect(screen.getAllByText(/Watching is free/).length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Group sections')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Hide game' })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(mocks.get.mock.calls[0][0]).toBe('/play-together/groups/group/activity');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('replaces the active doorway with the saved result when the round settles', async () => {
  mount();
  await screen.findByRole('link', { name: 'Open full round' });
  activity = {
    serverTime: 3000,
    activeRound: null,
    latestResult: { ...summary, state: 'REFUNDED' },
  };
  await client.invalidateQueries();
  expect(await screen.findByRole('link', { name: 'View group result' })).toHaveAttribute(
    'href',
    '/play-together/rounds/round#group-results'
  );
  expect(await screen.findByText('Entries returned')).toBeVisible();
  fireEvent.click(screen.getByRole('link', { name: 'View group result' }));
  expect(mocks.post).not.toHaveBeenCalled();
});
it('hides stale activity when access or connection is lost', async () => {
  mount();
  await screen.findByRole('link', { name: 'Open full round' });
  mocks.get.mockRejectedValue(new Error('access unavailable'));
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: 'Open full round' })).not.toBeInTheDocument()
  );
  expect(screen.getByRole('link', { name: 'Open group games' })).toHaveAttribute(
    'href',
    '/groups/group/games'
  );
});

it('keeps a previous completed round compact on chat entry and opens it only on request', async () => {
  activity = {
    serverTime: 3000,
    activeRound: null,
    latestResult: { ...summary, state: 'REFUNDED' },
  };
  mount();
  const view = await screen.findByRole('button', { name: 'View result' });
  expect(view).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('Entries returned')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Watch live' })).not.toBeInTheDocument();
  fireEvent.click(view);
  expect(await screen.findByText('Entries returned')).toBeVisible();
  expect(mocks.post).not.toHaveBeenCalled();
});
