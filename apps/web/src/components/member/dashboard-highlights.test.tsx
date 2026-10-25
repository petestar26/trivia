import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberGame } from '@/lib/member-game-catalog';
import { DashboardHighlights } from './dashboard-highlights';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  api: { get },
}));

function game(key: string, practiceAvailable = true): MemberGame {
  return {
    id: key,
    key,
    name: key,
    description: null,
    type: key,
    mode: 'WAGER',
    family: 'INSTANT',
    catalogStatus: 'COMING_SOON',
    wagerCurrency: 'COINS',
    rewardCurrency: 'COINS',
    currentRulesVersion: null,
    minBet: 0,
    maxBet: 0,
    isActive: false,
    practiceAvailable,
  };
}
function ticket(index = 1, payout = 100) {
  return {
    player: `Player ${String(index).padStart(10, '0')}`,
    roundId: `round-${index}`,
    stake: 50,
    payout,
    paidCents: 200,
  };
}
const feed = (tickets = [ticket()]) => ({ success: true, data: { period: '24h', tickets } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
type Props = Parameters<typeof DashboardHighlights>[0];
function mount(overrides: Partial<Props> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  clients.push(client);
  const props: Props = {
    userId: 'member-one',
    games: [game('sky_crash'), game('crash_point')],
    catalogState: 'ready',
    ...overrides,
  };
  const view = (next: Props) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DashboardHighlights {...next} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  const result = render(view(props));
  return {
    client,
    props,
    rerender: (next: Partial<Props>) => result.rerender(view({ ...props, ...next })),
  };
}

beforeEach(() => {
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  get.mockResolvedValue(feed());
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('dashboard confirmed practice-return board', () => {
  it('shows the ten highest individual returns with explicit period, stake and alias meanings', async () => {
    get.mockResolvedValue(
      feed(Array.from({ length: 12 }, (_, index) => ticket(index + 1, (index + 1) * 100)))
    );
    mount();
    const table = await screen.findByRole('table', {
      name: /Sky Crash: highest confirmed ticket returns/,
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(10);
    expect(within(rows[0]).getByRole('rowheader')).toHaveTextContent('Player 0000000012');
    expect(within(rows[9]).getByRole('rowheader')).toHaveTextContent('Player 0000000003');
    expect(within(rows[0]).getByText('01')).toBeInTheDocument();
    expect(within(rows[9]).getByText('10')).toBeInTheDocument();
    expect(screen.queryByText('Player 0000000002')).not.toBeInTheDocument();
    expect(within(rows[0]).getByText('+1,150 net · 50 stake')).toBeInTheDocument();
    expect(within(rows[0]).getByText('2.00×')).toBeInTheDocument();
    expect(screen.getByText('Last 24 hours')).toBeInTheDocument();
    expect(
      screen.getByText(/refreshed every minute while this page is visible/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Practice credits · no cash value. Returns include stake. Aliases identify tickets, not unique players./
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/Last received:/)).toHaveTextContent('(device time)');
  });

  it('does not show the outgoing game’s rows while the selected game is still loading', async () => {
    const pending = deferred<ReturnType<typeof feed>>();
    get.mockImplementation((path: string) =>
      path.includes('crash-point') ? pending.promise : Promise.resolve(feed())
    );
    mount();
    await screen.findByRole('table');
    const crash = screen.getByRole('button', { name: 'Crash Point' });
    crash.focus();
    fireEvent.click(crash);
    expect(crash).toHaveAttribute('aria-pressed', 'true');
    expect(crash).toHaveFocus();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
    expect(screen.getByText('Loading confirmed returns…')).toBeInTheDocument();
    await act(async () => pending.resolve(feed([ticket(22)])));
    expect(await screen.findByRole('table', { name: /Crash Point: highest/ })).toBeInTheDocument();
    expect(screen.getByText('Player 0000000022')).toBeInTheDocument();
    expect(get.mock.calls[1][0]).toBe('/games/crash-point/leaderboard');
    expect(get.mock.calls[1][2].signal).toBeInstanceOf(AbortSignal);
  });

  it('retains Sky Crash opt-in and retired-game protections before requesting results', async () => {
    const retired = { ...game('crash_point'), catalogStatus: 'RETIRED' };
    mount({ games: [game('sky_crash', false), retired] });
    expect(
      screen.getByText('No supported practice results are available yet.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Results game' })).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('only requests the eligible supported game, never an unknown game', async () => {
    mount({ games: [game('sky_crash', false), game('crash_point'), game('future_game')] });
    expect(await screen.findByRole('table', { name: /Crash Point: highest/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sky Crash' })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toBe('/games/crash-point/leaderboard');
  });

  it('does not request results while signed out or while catalog admission is pending', () => {
    const { rerender } = mount({ userId: undefined });
    expect(screen.getByText('Sign in to view the results board.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh top returns' })).toBeDisabled();
    rerender({ userId: 'member-one', catalogState: 'loading' });
    expect(screen.getByText('Loading confirmed returns…')).toBeInTheDocument();
    rerender({ userId: 'member-one', catalogState: 'error' });
    expect(
      screen.getByText('Load the game collection to check available results.')
    ).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps loading, empty, unavailable and malformed responses distinct without fictional rows', async () => {
    const pending = deferred<ReturnType<typeof feed>>();
    get.mockReturnValue(pending.promise);
    mount();
    expect(screen.getByText('Loading confirmed returns…')).toBeInTheDocument();
    await act(async () => pending.resolve(feed([])));
    expect(
      await screen.findByText('No confirmed returns for Sky Crash in the last 24 hours.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    get.mockResolvedValue({ success: true, data: { period: 'minute', tickets: [ticket()] } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh top returns' }));
    expect(
      await screen.findByText('Results unavailable. Refresh to try again.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText(/Last received:/)).not.toBeInTheDocument();
  });

  it('hides cached rankings after a failed refresh and restores only a newly confirmed response', async () => {
    mount();
    await screen.findByRole('table');
    get.mockRejectedValue(new Error('Offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh top returns' }));
    expect(
      await screen.findByText('Results unavailable. Refresh to try again.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
    expect(screen.queryByText(/Last received:/)).not.toBeInTheDocument();
    get.mockResolvedValue(feed([ticket(44)]));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh top returns' }));
    expect(await screen.findByText('Player 0000000044')).toBeInTheDocument();
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
  });

  it('separates account caches rather than displaying the previous account’s ranked response', async () => {
    const nextAccount = deferred<ReturnType<typeof feed>>();
    const { client, rerender } = mount();
    await screen.findByRole('table');
    get.mockReturnValue(nextAccount.promise);
    rerender({ userId: 'member-two' });
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await act(async () => nextAccount.resolve(feed([ticket(99)])));
    expect(await screen.findByText('Player 0000000099')).toBeInTheDocument();
    expect(
      client.getQueriesData({
        queryKey: ['dashboard-top-returns', 'member-one', 'sky_crash', '0:true'],
      })
    ).toHaveLength(1);
    expect(
      client.getQueriesData({
        queryKey: ['dashboard-top-returns', 'member-two', 'sky_crash', '0:true'],
      })
    ).toHaveLength(1);
  });

  it('refreshes once per minute in the foreground and stops interval reads when unfocused', async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(get).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(get).toHaveBeenCalledTimes(2);
    act(() => focusManager.setFocused(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(get).toHaveBeenCalledTimes(2);
    act(() => focusManager.setFocused(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('keeps an offline first read paused, with no fabricated results or request', () => {
    onlineManager.setOnline(false);
    mount();
    expect(
      screen.getByText("You're offline. Rankings are hidden until a connection is restored.")
    ).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  it('immediately hides cached rankings and their receipt time when the connection goes offline', async () => {
    mount();
    await screen.findByRole('table');
    expect(screen.getByText(/Last received:/)).toBeInTheDocument();
    act(() => onlineManager.setOnline(false));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
    expect(screen.queryByText(/Last received:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh top returns' })).toBeDisabled();
    expect(
      screen.getByText("You're offline. Rankings are hidden until a connection is restored.")
    ).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(feed([ticket(55)]));
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByText('Player 0000000055')).toBeInTheDocument();
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
  });

  it('presents jackpot as unlaunched and links only to existing personal results and reward routes', () => {
    mount({ games: [] });
    const jackpot = screen.getByRole('region', { name: 'The Jackpot' });
    expect(within(jackpot).getByText('Not launched')).toBeInTheDocument();
    expect(
      within(jackpot).getByText(/There is no active prize pool or paid entry./)
    ).toBeInTheDocument();
    expect(within(jackpot).queryByRole('button')).not.toBeInTheDocument();
    expect(within(jackpot).queryByRole('link')).not.toBeInTheDocument();
    const activity = screen.getByRole('navigation', { name: 'Your activity' });
    expect(within(activity).getByRole('link', { name: /Your results/ })).toHaveAttribute(
      'href',
      '/games/history'
    );
    expect(within(activity).getByRole('link', { name: /Rewards & progress/ })).toHaveAttribute(
      'href',
      '/rewards'
    );
    expect(get).not.toHaveBeenCalled();
  });
});

it('independent: reconnect keeps previously hidden rows hidden until fresh response', async () => {
  mount();
  await screen.findByRole('table');
  act(() => onlineManager.setOnline(false));
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
  const pending = deferred<ReturnType<typeof feed>>();
  get.mockReturnValue(pending.promise);
  act(() => onlineManager.setOnline(true));
  await act(async () => {
    await Promise.resolve();
  });
  expect(get).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.queryByText(/Last received:/)).not.toBeInTheDocument();
  await act(async () => pending.resolve(feed([ticket(77)])));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText('Player 0000000077')).toBeInTheDocument();
});

it.each(['sky_crash', 'crash_point'])(
  'does not reuse %s success through offline unmount/remount with the same cache',
  async (key) => {
    const { client, props } = mount({ games: [game(key)] });
    await screen.findByRole('table');
    cleanup();
    act(() => onlineManager.setOnline(false));
    const pending = deferred<ReturnType<typeof feed>>();
    get.mockReturnValue(pending.promise);
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <DashboardHighlights {...props} />
        </QueryClientProvider>
      </MemoryRouter>
    );
    act(() => onlineManager.setOnline(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText(/Last received:/)).toBeNull();
    await act(async () => pending.resolve(feed([ticket(66)])));
    expect(await screen.findByText('Player 0000000066')).toBeInTheDocument();
    expect(screen.queryByText('Player 0000000001')).not.toBeInTheDocument();
  }
);
it('keeps old rows hidden after a remounted reconnect fails', async () => {
  const { client, props } = mount();
  await screen.findByRole('table');
  cleanup();
  act(() => onlineManager.setOnline(false));
  let reject!: (error: Error) => void;
  get.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    })
  );
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DashboardHighlights {...props} />
      </QueryClientProvider>
    </MemoryRouter>
  );
  act(() => onlineManager.setOnline(true));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByRole('table')).toBeNull();
  await act(async () => reject(new Error('failed')));
  expect(await screen.findByText('Results unavailable. Refresh to try again.')).toBeInTheDocument();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText(/Last received:/)).toBeNull();
});
