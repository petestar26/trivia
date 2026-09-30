import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledPracticeSnapshot } from '@socialplay/shared';
import { SpinWinScheduledPage } from './spin-win-scheduled';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: mocks, unwrapData: (r: { data: unknown }) => r.data }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'alice' } }) }));
const clients: QueryClient[] = [];
function snapshot(): ScheduledPracticeSnapshot {
  return {
    streamId: 'spin-win-practice-v1',
    mode: 'PRACTICE',
    coinsAccepted: false,
    enabled: true,
    serverTime: 10000,
    nextOpensAt: 65000,
    rounds: [
      {
        id: 'spin-win-practice-v1:0',
        sequence: '0',
        opensAt: 5000,
        closesAt: 50000,
        revealEndsAt: 60000,
        endsAt: 65000,
        state: 'OPEN',
        outcome: null,
        ticket: null,
      },
    ],
  };
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <SpinWinScheduledPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ data: snapshot() });
  mocks.post.mockResolvedValue({ data: { isReplay: false } });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
});
describe('shared scheduled practice', () => {
  it('does not draw locally or offer Coin play, and waits for server-opened rounds', async () => {
    mocks.get.mockResolvedValue({ data: { ...snapshot(), enabled: false, rounds: [] } });
    mount();
    await screen.findByText('Paused');
    expect(screen.getByText(/No Coins, deposits, fees/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Spin' })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('locks a ticket to the specific server round and does not double-submit', async () => {
    mount();
    const red = await screen.findByRole('button', { name: 'Select Red' });
    await waitFor(() => expect(red).toBeEnabled());
    fireEvent.click(red);
    fireEvent.click(screen.getByRole('button', { name: 'Join this practice round' }));
    await screen.findByRole('button', { name: 'Ticket locked' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/games/scheduled/spin-win/tickets', {
      roundId: 'spin-win-practice-v1:0',
      bets: [{ marketId: 'red', amount: 40 }],
    });
    expect(red).toBeDisabled();
  });
  it('recovers an accepted ticket and published return on refresh', async () => {
    const data = snapshot();
    data.serverTime = 55000;
    data.rounds[0] = {
      ...data.rounds[0],
      state: 'DRAWN',
      outcome: 0,
      ticket: {
        bets: [{ marketId: 'number:0', amount: 40 }],
        acceptedAt: '2026-09-30T00:00:00Z',
        stake: 40,
        payout: 1332,
      },
    };
    mocks.get.mockResolvedValue({ data });
    mount();
    await screen.findByText(/Practice return 1332/);
    expect(screen.getByRole('button', { name: 'Ticket locked' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('retries the exact ticket after an uncertain response', async () => {
    mocks.post.mockRejectedValueOnce(new Error('network interrupted'));
    mount();
    const red = await screen.findByRole('button', { name: 'Select Red' });
    await waitFor(() => expect(red).toBeEnabled());
    fireEvent.click(red);
    fireEvent.click(screen.getByRole('button', { name: 'Join this practice round' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry same ticket' }));
    await screen.findByRole('button', { name: 'Ticket locked' });
    expect(mocks.post.mock.calls[1]).toEqual(mocks.post.mock.calls[0]);
  });
  it('keeps entries disabled when the connection cannot be verified', async () => {
    mocks.get.mockRejectedValue(new Error('offline'));
    mount();
    await screen.findByText('Reconnecting');
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
  });
  it('stops entry at the displayed cutoff without waiting for another poll', async () => {
    const data = snapshot();
    data.rounds[0].closesAt = 10100;
    mocks.get.mockResolvedValue({ data });
    mount();
    await screen.findByText(/Entry is closed/);
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
