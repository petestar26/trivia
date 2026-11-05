import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  TOGETHER_RULES_ID,
  TOGETHER_FEE_POLICY,
  togetherTermsHash,
  type TogetherSnapshot,
} from '@socialplay/shared';
import { PlayTogetherPage } from './play-together';
const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'Abebe' } }),
}));
vi.mock('@/components/groups/group-social-nav', () => ({ GroupSocialNav: () => null }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: m,
}));
let data: TogetherSnapshot, client: QueryClient;
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  data = {
    serverTime: Date.now(),
    workerReady: true,
    admissionsEnabled: true,
    cashAvailable: false,
    settings: {
      version: 1,
      feeBps: 700,
      minEntry: 100,
      maxEntry: 100000,
      enabledGames: ['spin_win'],
      practiceEnabled: true,
      cashEnabled: false,
      publicRoomsEnabled: false,
    },
    balances: { cashAvailable: 0, cashReserved: 0, pointsAvailable: 10000, pointsReserved: 0 },
    round: {
      id: 'round-1',
      groupId: null,
      creatorId: null,
      groupName: null,
      game: 'spin_win',
      currency: 'GAME_POINTS',
      entryAmount: 1000,
      feeBps: 700,
      settingsVersion: 1,
      minPlayers: 2,
      maxPlayers: 20,
      closesAt: Date.now() + 120000,
      rulesId: TOGETHER_RULES_ID,
      feePolicy: TOGETHER_FEE_POLICY,
      seedCommitment: 'ab'.repeat(32),
      beaconRound: 1,
      state: 'OPEN',
      termsHash: '',
      rosterHash: null,
      entries: [],
      outcome: null,
      ranking: [],
      settlement: null,
      voidReason: null,
      proof: null,
      recoveryDeadline: Date.now() + 720000,
      paidAt: null,
    },
  };
  data.round.termsHash = togetherTermsHash(data.round);
  m.get.mockImplementation(async () => ({ success: true, data: structuredClone(data) }));
  m.post.mockResolvedValue({ success: true, data: { accepted: true, entryId: 'entry-1' } });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount() {
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/play-together/rounds/round-1']}>
        <Routes>
          <Route path="/play-together/rounds/:roundId" element={<PlayTogetherPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it('opening a round never charges anyone and shows consent and loss before confirming', async () => {
  mount();
  const button = await screen.findByRole('button', { name: 'Confirm 1,000 points entry' });
  expect(button).toBeEnabled();
  expect(screen.getByText('Maximum you can lose')).toBeInTheDocument();
  expect(m.post).not.toHaveBeenCalled();
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
  expect(m.post.mock.calls[0][1]).toMatchObject({ termsHash: data.round.termsHash, selection: [] });
});
it('keeps real-wallet zero and disables a cash confirmation', async () => {
  data.round.currency = 'ETB';
  data.round.termsHash = togetherTermsHash(data.round);
  mount();
  expect(await screen.findByRole('button', { name: 'Confirm 10.00 Birr entry' })).toBeDisabled();
  expect(screen.getAllByText('0.00 Birr').length).toBeGreaterThan(0);
  expect(m.post).not.toHaveBeenCalled();
});
it('reuses the exact persisted receipt after an unknown network response and page reload', async () => {
  const pending = {
    requestId: '12345678-1234-4234-8234-123456789abc',
    termsHash: data.round.termsHash,
    selection: [],
  };
  sessionStorage.setItem('together-entry:me:round-1', JSON.stringify(pending));
  mount();
  const retry = await screen.findByRole('button', { name: 'Check the same confirmation' });
  expect(screen.getByRole('button', { name: 'Confirm 1,000 points entry' })).toBeDisabled();
  fireEvent.click(retry);
  await waitFor(() => expect(m.post).toHaveBeenCalledTimes(1));
  expect(m.post.mock.calls[0][1]).toEqual(pending);
});
it('keeps the original commitment and blocks changed financial terms on refresh', async () => {
  mount();
  await screen.findByRole('button', { name: 'Confirm 1,000 points entry' });
  const saved = data.round.termsHash;
  await waitFor(() => expect(sessionStorage.getItem('together-terms:me:round-1')).toBe(saved));
  data.round.entryAmount = 2000;
  data.round.termsHash = togetherTermsHash(data.round);
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm 2,000 points entry' })).toBeDisabled()
  );
  expect(sessionStorage.getItem('together-terms:me:round-1')).toBe(saved);
  expect(screen.getByRole('alert')).toHaveTextContent('differs from its saved terms');
});
it('pauses entry controls on lost server connection without discarding accepted data', async () => {
  mount();
  await screen.findByRole('button', { name: 'Confirm 1,000 points entry' });
  m.get.mockRejectedValue(Error('offline'));
  await client.invalidateQueries();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Confirm 1,000 points entry' })).toBeDisabled()
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Reconnecting');
});

it('offers free watching and copies the canonical shared link without confirming an entry', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  mount();
  await screen.findByRole('button', { name: 'Copy round link' });
  expect(screen.getByText(/You’re watching. No entry has been charged/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Copy round link' }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith(window.location.origin + '/play-together/rounds/round-1')
  );
  expect(m.post).not.toHaveBeenCalled();
});
it('shows a completed group result to a spectator without offering a late entry', async () => {
  data.round.state = 'REFUNDED';
  data.round.paidAt = Date.now() - 20000;
  data.round.voidReason = 'NOT_ENOUGH_PLAYERS';
  mount();
  expect(await screen.findByRole('heading', { name: 'Group result and payouts' })).toBeVisible();
  expect(screen.getByText(/You’re watching. No entry has been charged/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /Confirm .* entry/ })).not.toBeInTheDocument();
  expect(m.post).not.toHaveBeenCalled();
});
it('puts the current round and saved result before the game catalogue for group members', async () => {
  m.get.mockResolvedValue({
    success: true,
    data: {
      ...data,
      group: { id: 'group-1', name: 'Friends', ownerId: 'owner', status: 'ACTIVE' },
      groups: [],
      legacyPending: false,
      rounds: [
        {
          id: 'current',
          groupId: 'group-1',
          groupName: 'Friends',
          game: 'spin_win',
          currency: 'GAME_POINTS',
          entryAmount: 1000,
          participants: 2,
          state: 'OPEN',
          closesAt: Date.now() + 120000,
          feeBps: 700,
        },
        {
          id: 'previous',
          groupId: 'group-1',
          groupName: 'Friends',
          game: 'spin_win',
          currency: 'GAME_POINTS',
          entryAmount: 1000,
          participants: 2,
          state: 'PAID',
          closesAt: Date.now() - 120000,
          feeBps: 700,
        },
      ],
    },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/groups/group-1/games']}>
        <Routes>
          <Route path="/groups/:id/games" element={<PlayTogetherPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const doorway = await screen.findByRole('region', { name: 'Your group rounds' });
  expect(screen.getByRole('link', { name: /Watch or join round/ })).toHaveAttribute(
    'href',
    '/play-together/rounds/current'
  );
  expect(screen.getByRole('link', { name: /View group result/ })).toHaveAttribute(
    'href',
    '/play-together/rounds/previous#group-results'
  );
  const catalogue = screen.getByText('Choose a game and read the rules').closest('details')!;
  expect(
    doorway.compareDocumentPosition(catalogue) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(catalogue).not.toHaveAttribute('open');
  expect(m.post).not.toHaveBeenCalled();
});
