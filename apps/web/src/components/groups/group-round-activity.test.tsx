import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GroupSocialNav } from './group-social-nav';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), user: { id: 'member' } }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (v: { data: unknown }) => v.data }));
let client: QueryClient;
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
  mocks.get.mockResolvedValue({
    data: { serverTime: 1000, activeRound: summary, latestResult: null },
  });
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
  expect(await screen.findByRole('link', { name: 'Watch or join round' })).toHaveAttribute(
    'href',
    '/play-together/rounds/round'
  );
  expect(screen.getByText(/Watching is free/)).toBeVisible();
  expect(mocks.get.mock.calls[0][0]).toBe('/play-together/groups/group/activity');
  expect(mocks.post).not.toHaveBeenCalled();
});
it('replaces the active doorway with the saved result when the round settles', async () => {
  mount();
  await screen.findByRole('link', { name: 'Watch or join round' });
  mocks.get.mockResolvedValue({
    data: { serverTime: 3000, activeRound: null, latestResult: { ...summary, state: 'PAID' } },
  });
  await client.invalidateQueries();
  expect(await screen.findByRole('link', { name: 'View group result' })).toHaveAttribute(
    'href',
    '/play-together/rounds/round#group-results'
  );
  expect(screen.queryByRole('link', { name: 'Watch or join round' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('link', { name: 'View group result' }));
  expect(mocks.post).not.toHaveBeenCalled();
});
it('hides stale activity when access or connection is lost', async () => {
  mount();
  await screen.findByRole('link', { name: 'Watch or join round' });
  mocks.get.mockRejectedValue(new Error('access unavailable'));
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: 'Watch or join round' })).not.toBeInTheDocument()
  );
  expect(screen.getByRole('link', { name: 'Open group games' })).toHaveAttribute(
    'href',
    '/groups/group/games'
  );
});
