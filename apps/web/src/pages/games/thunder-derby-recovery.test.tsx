import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ThunderDerbyPage } from './thunder-derby';
import { DERBY_RULES } from '@socialplay/shared';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'derby-member' } }) }));
vi.mock('@/components/derby/race-scene', () => ({ default: () => <div>Race fixture</div> }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: mocks,
}));
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  const now = Date.now();
  mocks.get.mockResolvedValue({
    success: true,
    data: {
      rulesId: DERBY_RULES.id,
      serverTime: now,
      balance: 1000,
      rounds: [
        {
          id: 'race-6',
          field: 6,
          opensAt: now - 1000,
          startsAt: now + 120000,
          finishesAt: now + 165000,
          endsAt: now + 180000,
          commitment: 'a'.repeat(64),
          positions: Array(6).fill(0),
          order: null,
          seed: null,
          ticket: null,
        },
      ],
    },
  });
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  sessionStorage.clear();
});
async function setup() {
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ThunderDerbyPage />
      </QueryClientProvider>
    </MemoryRouter>
  );
  await screen.findByRole('heading', { name: 'Pick your finish' });
}
async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Even' }));
  fireEvent.click(screen.getByRole('button', { name: /Review selection/ }));
  fireEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm practice selection' })
  );
}
it('retains an unresolved receipt and retries the identical payload', async () => {
  mocks.post
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ success: true, data: { accepted: true, isReplay: true } });
  await setup();
  await confirm();
  const retry = await screen.findByRole('button', { name: 'Check saved confirmation' });
  const payload = mocks.post.mock.calls[0][1];
  expect(JSON.parse(sessionStorage.getItem('playqube.derby.pending.derby-member')!)).toEqual(
    payload
  );
  fireEvent.click(retry);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(mocks.post.mock.calls[1][1]).toEqual(payload);
  await waitFor(() =>
    expect(sessionStorage.getItem('playqube.derby.pending.derby-member')).toBeNull()
  );
});
it('a definite closed-race response releases the pending receipt without resubmitting', async () => {
  mocks.post.mockRejectedValue(new Error(JSON.stringify({ status: 409 })));
  await setup();
  await confirm();
  await screen.findByText(/Selection was not accepted/);
  expect(sessionStorage.getItem('playqube.derby.pending.derby-member')).toBeNull();
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole('button', { name: 'Check saved confirmation' })
  ).not.toBeInTheDocument();
});
it('restores only this member’s unresolved selection without automatic submission', async () => {
  sessionStorage.setItem(
    'playqube.derby.pending.derby-member',
    JSON.stringify({
      roundId: 'old-race',
      field: 8,
      market: 'TRIFECTA',
      picks: [8, 2, 1],
      stake: 50,
    })
  );
  await setup();
  expect(screen.getByRole('button', { name: 'Check saved confirmation' })).toBeInTheDocument();
  expect(mocks.post).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /8 horses/ })).toBeDisabled();
});
