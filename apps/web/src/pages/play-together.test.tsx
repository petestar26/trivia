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
