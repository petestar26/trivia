import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared practice under delayed or interrupted transport', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    mocks.get.mockImplementation(async () => ({
      data: { ...snapshot(), serverTime: 10000 + performance.now() },
    }));
  });
  async function advance(ms = 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  async function enter() {
    mount();
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Select Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join this practice round' }));
    await advance();
  }
  it('does not offer entry when a delayed response crosses its server cutoff', async () => {
    let deliver!: (value: { data: ScheduledPracticeSnapshot }) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        })
    );
    const data = snapshot();
    data.rounds[0].closesAt = 10700;
    mount();
    await advance(800);
    await act(async () => {
      deliver({ data });
    });
    await advance();
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    expect(screen.queryByText(/entry closes/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('does not treat a six-second-old response as fresh on receipt', async () => {
    let deliver!: (value: { data: ScheduledPracticeSnapshot }) => void;
    mocks.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        })
    );
    mount();
    await advance(6000);
    await act(async () => {
      deliver({ data: snapshot() });
    });
    await advance();
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
  });
  it('rejects uncertain timing, then recovers from a fast sample without using the device clock', async () => {
    let deliver!: (value: { data: ScheduledPracticeSnapshot }) => void;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        })
    );
    mount();
    await advance(1500);
    await act(async () => {
      deliver({ data: snapshot() });
    });
    await advance();
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeEnabled();
    vi.setSystemTime(new Date('2036-01-01T00:00:00Z'));
    await advance(250);
    expect(screen.getByText('37s · entry closes')).toBeInTheDocument();
  });
  it('bounds a hanging confirmation and retries the identical round and selections', async () => {
    mocks.post.mockImplementationOnce(() => new Promise(() => {}));
    await enter();
    expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled();
    await advance(8000);
    const retry = screen.getByRole('button', { name: 'Retry same ticket' });
    expect(retry).toBeEnabled();
    const first = mocks.post.mock.calls[0];
    expect(first[3].signal.aborted).toBe(true);
    fireEvent.click(retry);
    await advance();
    expect(mocks.post.mock.calls[1].slice(0, 3)).toEqual(first.slice(0, 3));
    expect(screen.getByRole('button', { name: 'Ticket locked' })).toBeDisabled();
  });
  it('reconciles a saved ticket through polling while its POST response is held', async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    await enter();
    const data = snapshot();
    data.serverTime = 12000;
    data.rounds[0].ticket = {
      bets: [{ marketId: 'red', amount: 40 }],
      acceptedAt: '2026-10-03T00:00:00Z',
      stake: 40,
      payout: null,
    };
    mocks.get.mockResolvedValue({ data });
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Ticket locked' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Confirming…' })).not.toBeInTheDocument();
    expect(mocks.post.mock.calls[0][3].signal.aborted).toBe(true);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('ignores a late response from a reconciled attempt while a new round is confirming', async () => {
    let deliverOld!: (value: { data: unknown }) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliverOld = resolve;
        })
    );
    await enter();
    const data = snapshot();
    data.serverTime = 65000;
    const oldRound = {
      ...data.rounds[0],
      state: 'DRAWN' as const,
      outcome: 1,
      ticket: {
        bets: [{ marketId: 'red', amount: 40 }],
        acceptedAt: '2026-10-03T00:00:00Z',
        stake: 40,
        payout: 74,
      },
    };
    data.rounds = [
      {
        ...data.rounds[0],
        id: 'spin-win-practice-v1:1',
        sequence: '1',
        opensAt: 65000,
        closesAt: 110000,
        revealEndsAt: 120000,
        endsAt: 125000,
      },
      oldRound,
    ];
    mocks.get.mockResolvedValue({ data });
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeEnabled();
    mocks.post.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Select Red' }));
    fireEvent.click(screen.getByRole('button', { name: 'Join this practice round' }));
    await act(async () => {
      deliverOld({ data: { isReplay: false } });
    });
    await advance();
    expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled();
    expect(mocks.post.mock.calls[1][1].roundId).toBe('spin-win-practice-v1:1');
    expect(mocks.post.mock.calls[1][3].signal.aborted).toBe(false);
    await advance(8000);
    expect(screen.getByRole('button', { name: 'Retry same ticket' })).toBeEnabled();
  });
  it('cancels the outstanding request when leaving the table', async () => {
    mocks.post.mockImplementation(() => new Promise(() => {}));
    await enter();
    const signal = mocks.post.mock.calls[0][3].signal;
    expect(signal.aborted).toBe(false);
    cleanup();
    expect(signal.aborted).toBe(true);
    await advance(8000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
});
describe('shared scheduled practice', () => {
  it('stops polling on an invalid session and provides a sign-in path', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mocks.get.mockRejectedValue(
      new Error(JSON.stringify({ status: 401, message: 'Invalid token' }))
    );
    mount();
    expect(await screen.findByRole('link', { name: 'Sign in again' })).toHaveAttribute(
      'href',
      '/login'
    );
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument();
  });
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
    expect(mocks.post).toHaveBeenCalledWith(
      '/games/scheduled/spin-win/tickets',
      {
        roundId: 'spin-win-practice-v1:0',
        bets: [{ marketId: 'red', amount: 40 }],
      },
      undefined,
      { signal: expect.any(AbortSignal) }
    );
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
    expect(mocks.post.mock.calls[1].slice(0, 3)).toEqual(mocks.post.mock.calls[0].slice(0, 3));
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

it('submits a typed practice stake and locks the field with its ticket',async()=>{
  mount();
  const input=screen.getByRole('textbox',{name:'Bet amount'});
  await waitFor(()=>expect(input).toBeEnabled());
  fireEvent.change(input,{target:{value:'160'}});
  fireEvent.click(screen.getByRole('button',{name:'Select Red'}));
  fireEvent.click(screen.getByRole('button',{name:'Join this practice round'}));
  await waitFor(()=>expect(mocks.post).toHaveBeenCalled());
  expect(mocks.post.mock.calls[0][1]).toEqual({roundId:'spin-win-practice-v1:0',bets:[{marketId:'red',amount:160}]});
  expect(input).toBeDisabled();
});
