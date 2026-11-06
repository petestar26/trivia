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
  sessionStorage.clear();
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
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
    expect(screen.getByRole('button', { name: 'Bet 1 confirmed' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: 'Bet 1 confirmed' })).toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
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
    expect(screen.getByText(/No deposits, fees or redeemable prizes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Spin' })).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('locks a ticket to the specific server round and does not double-submit', async () => {
    mount();
    const red = await screen.findByRole('button', { name: 'Select Red' });
    await waitFor(() => expect(red).toBeEnabled());
    fireEvent.click(red);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
    await screen.findByRole('button', { name: 'Bet 1 confirmed' });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      '/games/scheduled/spin-win/tickets',
      {
        roundId: 'spin-win-practice-v1:0',
        slot: 1,
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
    await screen.findByText(/Practice return 1,332/);
    expect(screen.getByRole('button', { name: 'Bet 1 confirmed' })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('retries the exact ticket after an uncertain response', async () => {
    mocks.post.mockRejectedValueOnce(new Error('network interrupted'));
    mount();
    const red = await screen.findByRole('button', { name: 'Select Red' });
    await waitFor(() => expect(red).toBeEnabled());
    fireEvent.click(red);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry same ticket' }));
    await screen.findByRole('button', { name: 'Bet 1 confirmed' });
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

it('submits a typed practice stake and locks the field with its ticket', async () => {
  mount();
  const input = screen.getByRole('textbox', { name: 'Bet amount' });
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.change(input, { target: { value: '160' } });
  fireEvent.click(screen.getByRole('button', { name: 'Select Red' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalled());
  expect(mocks.post.mock.calls[0][1]).toEqual({
    roundId: 'spin-win-practice-v1:0',
    slot: 1,
    bets: [{ marketId: 'red', amount: 160 }],
  });
  expect(input).toBeDisabled();
});

const pendingKey = 'salem.spin.pending.v1.alice';
const modernSnapshot = () =>
  ({
    ...snapshot(),
    maxTickets: 10,
    rounds: snapshot().rounds.map((r) => ({ ...r, tickets: [] })),
  }) as ScheduledPracticeSnapshot;
const receipt = (slot: number, marketId = 'red', amount = 40, payout: number | null = null) => ({
  slot,
  bets: [{ marketId, amount }],
  acceptedAt: '2026-11-05T00:00:00Z',
  stake: amount,
  payout,
});

describe('independent Spin tickets', () => {
  beforeEach(() => mocks.get.mockResolvedValue({ data: modernSnapshot() }));
  it('keeps separate draft amounts, confirmed selections, and two receipts in one round', async () => {
    mount();
    const input = screen.getByRole('textbox', { name: 'Bet amount' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Red' }));
    fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select Black' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bet 1 Draft' }));
    expect(input).toHaveValue('80');
    expect(screen.getByRole('button', { name: 'Select Red' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Select Black' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
    await screen.findByRole('button', { name: 'Bet 1 confirmed' });
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select Red' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Bet 2 Draft' }));
    expect(input).toHaveValue('120');
    expect(screen.getByRole('button', { name: 'Select Black' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 2' }));
    await screen.findByRole('button', { name: 'Bet 2 confirmed' });
    expect(mocks.post.mock.calls.map((c) => c[1])).toEqual([
      { roundId: 'spin-win-practice-v1:0', slot: 1, bets: [{ marketId: 'red', amount: 80 }] },
      { roundId: 'spin-win-practice-v1:0', slot: 2, bets: [{ marketId: 'black', amount: 120 }] },
    ]);
    expect(screen.getByText('2 / 10 confirmed')).toBeInTheDocument();
    expect(sessionStorage.getItem(pendingKey)).toBeNull();
  });
  it('supports ten slots and stops offering additional bets at the limit', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select Red' })).toBeEnabled());
    for (let slot = 1; slot <= 10; slot++) {
      fireEvent.click(screen.getByRole('button', { name: 'Select Red' }));
      fireEvent.click(screen.getByRole('button', { name: `Confirm Bet ${slot}` }));
      await screen.findByRole('button', { name: `Bet ${slot} confirmed` });
      if (slot < 10) fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
    }
    expect(mocks.post).toHaveBeenCalledTimes(10);
    expect(screen.getByRole('button', { name: '+ Add bet' })).toBeDisabled();
    expect(screen.getByText('10 / 10 confirmed')).toBeInTheDocument();
  });
  it('defaults to one slot when an older server has not advertised multiple tickets', async () => {
    mocks.get.mockResolvedValue({ data: snapshot() });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select Red' })).toBeEnabled());
    expect(screen.getByRole('button', { name: '+ Add bet' })).toBeDisabled();
    expect(screen.getByText('0 / 1 confirmed')).toBeInTheDocument();
  });
  it('keeps an uncertain Bet 2 pending when Bet 1 is already saved, and retries only Bet 2', async () => {
    const entry = {
      roundId: 'spin-win-practice-v1:0',
      slot: 2,
      bets: [{ marketId: 'black', amount: 80 }],
    };
    sessionStorage.setItem(pendingKey, JSON.stringify(entry));
    const data = modernSnapshot();
    data.rounds[0].tickets = [receipt(1)];
    data.rounds[0].ticket = data.rounds[0].tickets[0];
    mocks.get.mockResolvedValue({ data });
    mocks.post.mockRejectedValueOnce(new Error('offline'));
    mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry same ticket' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: 'Select Black' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: '+ Add bet' })).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(pendingKey)!)).toEqual(entry);
    fireEvent.click(screen.getByRole('button', { name: 'Retry same ticket' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry same ticket' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry same ticket' }));
    await screen.findByRole('button', { name: 'Bet 2 confirmed' });
    expect(mocks.post.mock.calls.map((c) => c[1])).toEqual([entry, entry]);
  });
  it('recovers a persisted Bet 2 receipt on refresh without posting again', async () => {
    sessionStorage.setItem(
      pendingKey,
      JSON.stringify({
        roundId: 'spin-win-practice-v1:0',
        slot: 2,
        bets: [{ marketId: 'black', amount: 80 }],
      })
    );
    const data = modernSnapshot();
    data.rounds[0].tickets = [receipt(1), receipt(2, 'black', 80)];
    mocks.get.mockResolvedValue({ data });
    mount();
    await waitFor(() => expect(sessionStorage.getItem(pendingKey)).toBeNull());
    expect(mocks.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Bet 2 Confirmed' }));
    expect(screen.getByRole('button', { name: 'Select Black' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
  it('does not retry a newer multi-ticket request against a legacy server', async () => {
    sessionStorage.setItem(
      pendingKey,
      JSON.stringify({
        roundId: 'spin-win-practice-v1:0',
        slot: 2,
        bets: [{ marketId: 'black', amount: 80 }],
      })
    );
    mocks.get.mockResolvedValue({ data: snapshot() });
    mount();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry same ticket' })).toBeDisabled()
    );
    expect(mocks.post).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(pendingKey)).not.toBeNull();
  });
  it('blocks entry if pending storage is malformed or cannot be written', async () => {
    sessionStorage.setItem(pendingKey, '{bad');
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(/storage/);
    expect(screen.getByRole('button', { name: 'Select Red' })).toBeDisabled();
    cleanup();
    sessionStorage.clear();
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Select Red' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Select Red' }));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw Error('storage unavailable');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Bet 1' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not save/);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('shows each saved stake, selection and return against the same published result', async () => {
    const data = modernSnapshot();
    data.serverTime = 55000;
    data.rounds[0] = {
      ...data.rounds[0],
      state: 'DRAWN',
      outcome: 0,
      tickets: [receipt(1, 'red', 40, 0), receipt(2, 'number:0', 80, 2664)],
    };
    mocks.get.mockResolvedValue({ data });
    mount();
    await screen.findByText('Return 2,664 ETB');
    expect(screen.getByText('Return 0 ETB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Bet 2 Confirmed' }));
    expect(screen.getByRole('button', { name: 'Select 0' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByText('Practice return 2,664 ETB')).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('closes additional entry at cutoff and starts the next round with an empty Bet 1', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'Date', 'performance'],
    });
    const data = modernSnapshot();
    data.rounds[0].tickets = [receipt(1)];
    let baseTime = 48000;
    mocks.get.mockImplementation(async () => ({
      data: { ...data, serverTime: baseTime + performance.now() },
    }));
    const advance = async (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    mount();
    await advance(1);
    fireEvent.click(screen.getByRole('button', { name: '+ Add bet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select Black' }));
    expect(screen.getByRole('button', { name: 'Confirm Bet 2' })).toBeEnabled();
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Confirm Bet 2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '+ Add bet' })).toBeDisabled();
    data.rounds.unshift({
      ...data.rounds[0],
      id: 'spin-win-practice-v1:1',
      sequence: '1',
      opensAt: 65000,
      closesAt: 110000,
      revealEndsAt: 120000,
      endsAt: 125000,
      ticket: null,
      tickets: [],
    });
    baseTime = 65000;
    await advance(2000);
    expect(screen.getByRole('button', { name: 'Confirm Bet 1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Select Black' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Select Black' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.queryByRole('button', { name: 'Bet 2 Draft' })).not.toBeInTheDocument();
    expect(screen.getByText('0 / 10 confirmed')).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
