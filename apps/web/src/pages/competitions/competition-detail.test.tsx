import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  defaultScheduler,
  focusManager,
  notifyManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Competition, CompetitionPhase } from '@/lib/api';

const getCompetitionForGroup = vi.fn();
const joinCompetition = vi.fn();
const playCompetition = vi.fn();
const finalizeCompetition = vi.fn();
const apiGet = vi.fn();
const toastMock = vi.fn();
const socket = { on: vi.fn(), off: vi.fn() };

vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    getCompetitionForGroup: (...a: unknown[]) => getCompetitionForGroup(...a),
    joinCompetition: (...a: unknown[]) => joinCompetition(...a),
    playCompetition: (...a: unknown[]) => playCompetition(...a),
    finalizeCompetition: (...a: unknown[]) => finalizeCompetition(...a),
  },
  unwrapData: (res: { data?: unknown }) => res.data,
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));
vi.mock('@/providers/socket-provider', () => ({
  useSocket: () => ({ socket: socket as never }),
}));

import { CompetitionDetailPage } from './detail';

const PAST_START = '2026-01-01T00:00:00.000Z';
const PAST_END = '2026-01-02T00:00:00.000Z';
const FUTURE_START = '2027-01-01T00:00:00.000Z';
const FUTURE_END = '2027-01-02T00:00:00.000Z';
const BOUNDARY_GRACE_MS = 250;
const MAX_TIMER_DELAY = 2_147_483_647;
const MAX_TIMER_SLICE = MAX_TIMER_DELAY - BOUNDARY_GRACE_MS;
const FAKE_NOW = Date.parse('2030-01-01T00:00:00.000Z');
let restoreTimerRecorder: (() => void) | undefined;

function recordWindowTimers() {
  const originalSetTimeout = window.setTimeout;
  const originalClearTimeout = window.clearTimeout;
  const scheduled: Array<{ timer: number; delay: number }> = [];
  const cleared: number[] = [];

  window.setTimeout = ((handler: TimerHandler, timeout?: number) => {
    const timer = originalSetTimeout(handler, timeout);
    scheduled.push({ timer, delay: Number(timeout ?? 0) });
    return timer;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((timer?: number) => {
    if (timer !== undefined) cleared.push(timer);
    originalClearTimeout(timer);
  }) as typeof window.clearTimeout;

  restoreTimerRecorder = () => {
    window.setTimeout = originalSetTimeout;
    window.clearTimeout = originalClearTimeout;
  };

  return { scheduled, cleared };
}

async function flushQueryUpdates() {
  await act(async () => {
    // A query result resolves in a microtask, then React Query schedules its
    // observer notification on a zero-delay timer. Drain both stages (twice,
    // because a refetch can enqueue the notification after the first pass).
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function makeCompetition(overrides: {
  id?: string;
  phase?: CompetitionPhase;
  status?: Competition['status'];
  startsAt?: string;
  endsAt?: string;
  isFull?: boolean;
  maxParticipants?: number | null;
  participantCount?: number;
  participants?: Competition['participants'];
  finalizedAt?: string | null;
  game?: Competition['game'];
  maxPlaysPerParticipant?: number | null;
}): Competition {
  return {
    id: 'c1',
    groupId: 'g1',
    game: overrides.game ?? { key: 'dice', name: 'Dice' },
    title: 'Detail Comp',
    description: null,
    status: overrides.status ?? 'SCHEDULED',
    isFull: overrides.isFull ?? false,
    participantCount: overrides.participantCount ?? 0,
    maxPlaysPerParticipant: overrides.maxPlaysPerParticipant === undefined
      ? 5
      : overrides.maxPlaysPerParticipant,
    entryAmount: 10,
    maxParticipants: overrides.maxParticipants ?? null,
    rewardGamePoints: 100,
    rewardCoins: 0,
    startsAt: overrides.startsAt ?? PAST_START,
    endsAt: overrides.endsAt ?? PAST_END,
    createdAt: '2026-01-01T00:00:00.000Z',
    finalizedAt: overrides.finalizedAt ?? null,
    participants: overrides.participants ?? [],
    // `phase` is only present when explicitly provided, so tests can simulate
    // the deployment-skew payload where the server does not send it yet.
    ...(overrides.phase !== undefined && { phase: overrides.phase }),
  } as Competition;
}

// Active observer for the ['wallet'] query so join-session wallet invalidation
// can be observed (a plain cache invalidation without any observer refetches
// nothing, which would make the test assert a non-event).
function WalletProbe() {
  useQuery({
    queryKey: ['wallet'],
    queryFn: async () => {
      const res = await apiGet('/wallet');
      return res.data;
    },
  });
  return null;
}

let memberRole = 'MEMBER';

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <WalletProbe />
      <MemoryRouter initialEntries={['/competitions/g1/c1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/competitions/:groupId/:competitionId" element={<CompetitionDetailPage />} />
      <Route path="*" element={null} />
    </Routes>,
    { wrapper },
  );
}

function walletCalls(): number {
  return apiGet.mock.calls.filter(([url]) => url === '/wallet').length;
}

beforeEach(() => {
  memberRole = 'MEMBER';
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/wallet') return { success: true, data: { balance: 100 } };
    return { success: true, data: { isMember: true, memberRole } };
  });
});

afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  restoreTimerRecorder?.();
  restoreTimerRecorder = undefined;
  notifyManager.setScheduler(defaultScheduler);
  vi.useRealTimers();
  getCompetitionForGroup.mockReset();
  joinCompetition.mockReset();
  playCompetition.mockReset();
  finalizeCompetition.mockReset();
  apiGet.mockReset();
  toastMock.mockReset();
  socket.on.mockReset();
  socket.off.mockReset();
});

describe('CompetitionDetailPage lifecycle phases', () => {
  it('UPCOMING shows no Join or Play', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'UPCOMING', startsAt: FUTURE_START, endsAt: FUTURE_END }),
    });

    renderPage();

    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText(/This competition starts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize/i })).not.toBeInTheDocument();
  });

  it('OPEN non-participant sees Join and no Play', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'OPEN', participants: [] }),
    });

    renderPage();

    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Join Competition/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();
  });

  it('persisted SCHEDULED + OPEN phase still offers Join (no ACTIVE status required)', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'OPEN', status: 'SCHEDULED', participants: [] }),
    });

    renderPage();

    expect(await screen.findByRole('button', { name: /Join Competition/ })).toBeInTheDocument();
  });

  it('OPEN participant sees Play and no Join', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'OPEN', participants: [{ userId: 'u1', score: 0, gamesPlayed: 0 }] }),
    });

    renderPage();

    expect(await screen.findByRole('button', { name: /Play a round/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
  });

  it('keeps Play available when the participant has four of five rounds recorded', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        maxPlaysPerParticipant: 5,
        participants: [{ userId: 'u1', score: 20, gamesPlayed: 4 }],
      }),
    });

    renderPage();

    expect(await screen.findByRole('button', { name: /Play a round/ })).toBeInTheDocument();
    expect(screen.queryByText('You have completed all 5 rounds.')).not.toBeInTheDocument();
  });

  it('hides Play and shows the server-provided round limit once it is reached', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        maxPlaysPerParticipant: 5,
        participants: [{ userId: 'u1', score: 25, gamesPlayed: 5 }],
      }),
    });

    renderPage();

    expect(await screen.findByText('You have completed all 5 rounds.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();
  });

  it('keeps Trivia playable beyond five recorded rounds when the API limit is null', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        game: { key: 'trivia', name: 'Trivia' },
        maxPlaysPerParticipant: null,
        participants: [{ userId: 'u1', score: 4000, gamesPlayed: 6 }],
      }),
    });

    renderPage();

    expect(await screen.findByRole('button', { name: /Play a round/ })).toBeInTheDocument();
    expect(screen.queryByText(/completed all .* rounds/i)).not.toBeInTheDocument();
  });

  it('replaces Play immediately after the final successful play refetches detail', async () => {
    let gamesPlayed = 4;
    getCompetitionForGroup.mockImplementation(async () => ({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        maxPlaysPerParticipant: 5,
        participants: [{ userId: 'u1', score: gamesPlayed * 5, gamesPlayed }],
      }),
    }));
    playCompetition.mockImplementation(async () => {
      gamesPlayed = 5;
      return { success: true, data: { score: 5, gamesPlayed } };
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Play a round/ }));

    expect(await screen.findByText('You have completed all 5 rounds.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(2);
  });

  it('refetches detail after a stale play is rejected at the server limit', async () => {
    let serverRejectedAtLimit = false;
    getCompetitionForGroup.mockImplementation(async () => ({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        maxPlaysPerParticipant: 5,
        participants: [{
          userId: 'u1',
          score: 25,
          gamesPlayed: serverRejectedAtLimit ? 5 : 4,
        }],
      }),
    }));
    playCompetition.mockImplementation(async () => {
      serverRejectedAtLimit = true;
      throw new Error(JSON.stringify({ message: 'You have reached the maximum of 5 plays for this competition' }));
    });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Play a round/ }));

    expect(await screen.findByText('You have completed all 5 rounds.')).toBeInTheDocument();
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(2);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Error',
      description: 'You have reached the maximum of 5 plays for this competition',
    }));
  });

  it('persisted SCHEDULED + OPEN phase still offers Play for a joined participant', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        status: 'SCHEDULED',
        participants: [{ userId: 'u1', score: 0, gamesPlayed: 0 }],
      }),
    });

    renderPage();

    expect(await screen.findByRole('button', { name: /Play a round/ })).toBeInTheDocument();
  });

  it('ENDED hides Join/Play and lets the manager finalize', async () => {
    memberRole = 'OWNER';
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'ENDED', participants: [{ userId: 'u1', score: 5, gamesPlayed: 1 }] }),
    });

    renderPage();

    expect(await screen.findByText('This competition has ended.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finalize & distribute rewards/ })).toBeInTheDocument();
  });

  it('ENDED member does not see Finalize', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'ENDED', participants: [{ userId: 'u1', score: 5, gamesPlayed: 1 }] }),
    });

    renderPage();

    expect(await screen.findByText('This competition has ended.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize/i })).not.toBeInTheDocument();
  });

  it('COMPLETED exposes no live actions', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        phase: 'COMPLETED',
        status: 'COMPLETED',
        finalizedAt: '2026-01-03T00:00:00.000Z',
        participants: [{ userId: 'u1', score: 10, gamesPlayed: 1 }],
      }),
    });

    renderPage();

    expect(await screen.findByText(/Final Results/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize/i })).not.toBeInTheDocument();
  });

  it('CANCELLED exposes no live actions', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'CANCELLED', status: 'CANCELLED' }),
    });

    renderPage();

    expect(await screen.findByText('This competition was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Finalize/i })).not.toBeInTheDocument();
  });

  it('refetches on focus even while the lifecycle query is fresh', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'COMPLETED', status: 'COMPLETED' }),
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });

    renderPage(client);
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(getCompetitionForGroup).toHaveBeenCalledTimes(2));
  });

  it('a full competition does not expose a usable Join', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'OPEN', isFull: true, maxParticipants: 5, participantCount: 5 }),
    });

    renderPage();

    expect(await screen.findByText('This competition is full.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join Competition/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
  });

  it('successful Join refetches detail and wallet, then immediately offers Play', async () => {
    let joined = false;
    getCompetitionForGroup.mockImplementation(async () => ({
      success: true,
      data: makeCompetition({
        phase: 'OPEN',
        participants: joined ? [{ userId: 'u1', score: 0, gamesPlayed: 0 }] : [],
      }),
    }));
    joinCompetition.mockResolvedValue({ success: true, data: { id: 'c1', status: 'SCHEDULED' } });
    joinCompetition.mockImplementation(async () => {
      joined = true;
      return { success: true, data: { id: 'c1', status: 'SCHEDULED' } };
    });

    renderPage();

    expect(await screen.findByRole('button', { name: /Join Competition/ })).toBeInTheDocument();
    const callsBeforeJoin = getCompetitionForGroup.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Join Competition/ }));

    // Play appears right after join without any page reload.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Play a round/ })).toBeInTheDocument();
    });

    // Both the detail query and the wallet query were invalidated/refetched.
    expect(getCompetitionForGroup.mock.calls.length).toBeGreaterThan(callsBeforeJoin);
    expect(walletCalls()).toBeGreaterThanOrEqual(2);
  });

  it('crosses BOTH server-phase boundaries UPCOMING → OPEN → ENDED on a single mount', async () => {
    // Regression: the boundary effect originally omitted `phase` from its deps,
    // so after the startsAt refetch flipped the phase to OPEN the effect never
    // re-ran — no endsAt timer was ever armed and ENDED was never reached. A
    // test that starts OPEN cannot catch that. This mounts exactly once in
    // UPCOMING state and expects the page to traverse the whole lifecycle with
    // no reload, remount, focus change, or socket event.
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    memberRole = 'OWNER';
    const startsAt = new Date(FAKE_NOW + 1_000).toISOString();
    const endsAt = new Date(FAKE_NOW + 3_000).toISOString();
    getCompetitionForGroup.mockImplementation(async () => {
      const now = Date.now();
      const start = new Date(startsAt).getTime();
      const end = new Date(endsAt).getTime();
      const phase: CompetitionPhase = now < start ? 'UPCOMING' : now <= end ? 'OPEN' : 'ENDED';
      return {
        success: true,
        data: makeCompetition({
          phase,
          status: 'SCHEDULED',
          startsAt,
          endsAt,
          participants: [{ userId: 'u1', score: 0, gamesPlayed: 0 }],
        }),
      };
    });

    renderPage();
    await flushQueryUpdates();

    // 1. UPCOMING: banner only, no Join/Play.
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();

    // 2. startsAt crossed: refetch → OPEN → existing participant sees Play.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000 + BOUNDARY_GRACE_MS);
    });
    await flushQueryUpdates();
    expect(screen.getByRole('button', { name: /Play a round/ })).toBeInTheDocument();

    // 3+4. endsAt crossed: second refetch → ENDED → Play disappears.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushQueryUpdates();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();

    // 5. Manager sees Finalize in the ENDED phase.
    expect(screen.getByRole('button', { name: /Finalize & distribute rewards/ })).toBeInTheDocument();
    expect(screen.getByText('This competition has ended.')).toBeInTheDocument();
  });

  it('normalizes identical phase-less responses and re-arms across both boundaries', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    memberRole = 'OWNER';
    const startsAt = new Date(FAKE_NOW + 1_000).toISOString();
    const endsAt = new Date(FAKE_NOW + 3_000).toISOString();
    const unchangedPayload = makeCompetition({
      status: 'SCHEDULED',
      startsAt,
      endsAt,
      participants: [{ userId: 'u1', score: 0, gamesPlayed: 0 }],
    });
    getCompetitionForGroup.mockResolvedValue({ success: true, data: unchangedPayload });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    renderPage(client);
    await flushQueryUpdates();

    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000 + BOUNDARY_GRACE_MS);
    });
    await flushQueryUpdates();

    expect(getCompetitionForGroup).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<Competition>(['competition', 'g1', 'c1'])?.phase).toBe('OPEN');
    expect(screen.getByRole('button', { name: /Play a round/ })).toBeInTheDocument();

    // The second request proves the OPEN phase rerendered and armed endsAt.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushQueryUpdates();

    expect(getCompetitionForGroup).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();
    expect(screen.getByText('This competition has ended.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finalize & distribute rewards/ })).toBeInTheDocument();
  });

  it('continues a far-future wait through its safe slice to the boundary', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const timers = recordWindowTimers();
    const startsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 10_000).toISOString();
    const endsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 70_000).toISOString();
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'UPCOMING', startsAt, endsAt }),
    });

    renderPage();
    await flushQueryUpdates();

    const initialSliceIndex = timers.scheduled.findIndex(({ delay }) => delay === MAX_TIMER_SLICE);
    expect(initialSliceIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_TIMER_SLICE);
    });
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(1);

    const startContinuationDelay = 10_000 + BOUNDARY_GRACE_MS;
    const continuationTimer = timers.scheduled
      .slice(initialSliceIndex + 1)
      .find(({ delay }) => delay === startContinuationDelay)?.timer;
    expect(continuationTimer).toBeDefined();
    expect(timers.scheduled.every(({ delay }) => delay <= MAX_TIMER_DELAY)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(startContinuationDelay);
    });
    await flushQueryUpdates();

    expect(getCompetitionForGroup).toHaveBeenCalledTimes(2);
  });

  it('cancels an active far-future continuation timer on cleanup', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const timers = recordWindowTimers();
    const startsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 10_000).toISOString();
    const endsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 70_000).toISOString();
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ phase: 'UPCOMING', startsAt, endsAt }),
    });

    const page = renderPage();
    await flushQueryUpdates();

    const initialSliceIndex = timers.scheduled.findIndex(({ delay }) => delay === MAX_TIMER_SLICE);
    expect(initialSliceIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_TIMER_SLICE);
    });
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(1);

    const continuationDelay = 10_000 + BOUNDARY_GRACE_MS;
    const continuationTimer = timers.scheduled
      .slice(initialSliceIndex + 1)
      .find(({ delay }) => delay === continuationDelay)?.timer;
    expect(continuationTimer).toBeDefined();

    page.unmount();

    expect(timers.cleared).toContain(continuationTimer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(continuationDelay);
    });
    expect(getCompetitionForGroup).toHaveBeenCalledTimes(1);
  });

  it.each(['ENDED', 'COMPLETED', 'CANCELLED'] as const)('does not arm a boundary timer for %s', async (phase) => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const timers = recordWindowTimers();
    const startsAt = new Date(FAKE_NOW + 10_000).toISOString();
    const endsAt = new Date(FAKE_NOW + 20_000).toISOString();
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        phase,
        status: phase === 'ENDED' ? 'SCHEDULED' : phase,
        startsAt,
        endsAt,
      }),
    });

    renderPage();
    await flushQueryUpdates();

    expect(timers.scheduled.some(({ delay }) => delay >= BOUNDARY_GRACE_MS)).toBe(false);
  });

  it('falls back to clock-derived OPEN when phase is absent (deployment skew)', async () => {
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({ status: 'SCHEDULED', startsAt, endsAt, participants: [] }),
    });

    renderPage();

    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Join Competition/ })).toBeInTheDocument();
  });

  it('falls back to clock-derived ENDED when phase is absent', async () => {
    const startsAt = new Date(Date.now() - 120_000).toISOString();
    const endsAt = new Date(Date.now() - 60_000).toISOString();
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        status: 'SCHEDULED',
        startsAt,
        endsAt,
        participants: [{ userId: 'u1', score: 5, gamesPlayed: 1 }],
      }),
    });

    renderPage();

    expect(await screen.findByText('This competition has ended.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();
  });

  it('terminal COMPLETED status overrides timestamps when phase is absent', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        status: 'COMPLETED',
        finalizedAt: '2026-01-03T00:00:00.000Z',
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
        participants: [{ userId: 'u1', score: 10, gamesPlayed: 1 }],
      }),
    });

    renderPage();

    // Even though startsAt/endsAt are still in the future, the persisted
    // COMPLETED status must win and render results — not an empty/upcoming view.
    expect(await screen.findByText(/Final Results/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
  });

  it('terminal CANCELLED status overrides timestamps when phase is absent', async () => {
    getCompetitionForGroup.mockResolvedValue({
      success: true,
      data: makeCompetition({
        status: 'CANCELLED',
        startsAt: FUTURE_START,
        endsAt: FUTURE_END,
      }),
    });

    renderPage();

    expect(await screen.findByText('This competition was cancelled.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play/i })).not.toBeInTheDocument();
  });
});
