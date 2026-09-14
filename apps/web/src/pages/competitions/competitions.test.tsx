import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  defaultScheduler,
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Competition, CompetitionPhase } from '@/lib/api';

const listCompetitionsForGroup = vi.fn();
const createCompetition = vi.fn();
const apiGet = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listCompetitionsForGroup: (...a: unknown[]) => listCompetitionsForGroup(...a),
    createCompetition: (...a: unknown[]) => createCompetition(...a),
    get: (...a: unknown[]) => apiGet(...a),
  },
  unwrapData: (res: { data?: unknown }) => res.data,
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));

import { GroupCompetitionsPage } from './index';

function makeCompetition(overrides: {
  id: string;
  phase?: CompetitionPhase;
  startsAt: string;
  endsAt: string;
  status?: Competition['status'];
  isFull?: boolean;
}): Competition {
  return {
    id: overrides.id,
    groupId: 'g1',
    game: { key: 'dice', name: 'Dice' },
    title: `Competition ${overrides.id}`,
    description: null,
    status: overrides.status ?? 'SCHEDULED',
    isFull: overrides.isFull ?? false,
    participantCount: 0,
    entryAmount: 0,
    maxParticipants: null,
    rewardGamePoints: 10,
    rewardCoins: 0,
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    createdAt: '2026-01-01T00:00:00.000Z',
    // `phase` is only present when explicitly provided, so tests can simulate
    // the deployment-skew payload where the server does not send it yet.
    ...(overrides.phase !== undefined && { phase: overrides.phase }),
  } as Competition;
}

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

afterEach(() => {
  cleanup();
  restoreTimerRecorder?.();
  restoreTimerRecorder = undefined;
  notifyManager.setScheduler(defaultScheduler);
  vi.useRealTimers();
  listCompetitionsForGroup.mockReset();
  createCompetition.mockReset();
  apiGet.mockReset();
  toastMock.mockReset();
});

/** Marker rendered at the real detail route so a successful create's navigate() is observable. */
function DetailRouteMarker() {
  const { groupId, competitionId } = useParams<{ groupId: string; competitionId: string }>();
  return <div data-testid="detail-marker">detail:{groupId}/{competitionId}</div>;
}

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/competitions/g1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/competitions/:groupId" element={<GroupCompetitionsPage />} />
      <Route path="/competitions/:groupId/:competitionId" element={<DetailRouteMarker />} />
      <Route path="*" element={null} />
    </Routes>,
    { wrapper },
  );
}


describe('GroupCompetitionsPage lifecycle phases', () => {
  it('UPCOMING shows no Join or Play affordance', async () => {
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [
        makeCompetition({
          id: 'c-upcoming',
          phase: 'UPCOMING',
          startsAt: FUTURE_START,
          endsAt: FUTURE_END,
          status: 'SCHEDULED',
        }),
      ],
    });

    renderPage();

    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
    // Navigation-only card action; it must not invite pre-start joining/play.
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.queryByText(/Join/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Play/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/View \/ Join/i)).not.toBeInTheDocument();
  });

  it('keeps a supplied OPEN phase authoritative over status and expired timestamps', async () => {
    // Both timestamps are expired, but the supplied server phase remains the
    // authority. Persisted SCHEDULED/ACTIVE status does not replace it.
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [
        makeCompetition({
          id: 'c-open',
          phase: 'OPEN',
          status: 'SCHEDULED',
          startsAt: PAST_START,
          endsAt: PAST_END,
        }),
        makeCompetition({
          id: 'c-active-open',
          phase: 'OPEN',
          status: 'ACTIVE',
          startsAt: PAST_START,
          endsAt: PAST_END,
        }),
      ],
    });

    renderPage();

    expect(await screen.findAllByText('Open')).toHaveLength(2);
    expect(screen.queryByText('Scheduled')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'View' })).toHaveLength(2);
  });

  it('ENDED shows the Ended badge with a results-only action', async () => {
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [
        makeCompetition({
          id: 'c-ended',
          phase: 'ENDED',
          status: 'SCHEDULED',
          startsAt: PAST_START,
          endsAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    });

    renderPage();

    expect(await screen.findByText('Ended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View results' })).toBeInTheDocument();
  });

  it('COMPLETED and CANCELLED expose no live actions', async () => {
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [
        makeCompetition({
          id: 'c-completed',
          phase: 'COMPLETED',
          status: 'COMPLETED',
          startsAt: PAST_START,
          endsAt: PAST_END,
        }),
        makeCompetition({
          id: 'c-cancelled',
          phase: 'CANCELLED',
          status: 'CANCELLED',
          startsAt: FUTURE_START,
          endsAt: FUTURE_END,
        }),
      ],
    });

    renderPage();

    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'View results' })).toHaveLength(2);
    expect(screen.queryByText(/Join/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Play/i)).not.toBeInTheDocument();
  });

  it('refetches on remount even while the lifecycle query is fresh', async () => {
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [makeCompetition({
        id: 'c-remount',
        phase: 'COMPLETED',
        status: 'COMPLETED',
        startsAt: PAST_START,
        endsAt: PAST_END,
      })],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });

    const firstMount = renderPage(client);
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(1);

    firstMount.unmount();
    renderPage(client);

    await waitFor(() => expect(listCompetitionsForGroup).toHaveBeenCalledTimes(2));
  });

  it('a full competition is flagged Full on the card', async () => {
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [
        makeCompetition({
          id: 'c-full',
          phase: 'OPEN',
          isFull: true,
          startsAt: PAST_START,
          endsAt: PAST_END,
        }),
      ],
    });

    renderPage();

    expect(await screen.findByText('Full')).toBeInTheDocument();
  });

  it('normalizes identical phase-less responses across UPCOMING → OPEN → ENDED without remounting', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const startsAt = new Date(FAKE_NOW + 1_000).toISOString();
    const endsAt = new Date(FAKE_NOW + 3_000).toISOString();
    const unchangedPayload = makeCompetition({
      id: 'c-boundary',
      status: 'SCHEDULED',
      startsAt,
      endsAt,
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [unchangedPayload] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    renderPage(client);
    await flushQueryUpdates();

    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000 + BOUNDARY_GRACE_MS);
    });
    await flushQueryUpdates();
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<Competition[]>(['competitions', 'g1'])?.[0]?.phase).toBe('OPEN');
    expect(screen.getByText('Open')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await flushQueryUpdates();
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Ended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View results' })).toBeInTheDocument();
  });

  it('continues a far-future wait through its safe slice to the boundary', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const timers = recordWindowTimers();
    const startsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 10_000).toISOString();
    const endsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 70_000).toISOString();
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [makeCompetition({ id: 'c-far-future', phase: 'UPCOMING', startsAt, endsAt })],
    });

    renderPage();
    await flushQueryUpdates();

    const initialSliceIndex = timers.scheduled.findIndex(({ delay }) => delay === MAX_TIMER_SLICE);
    expect(initialSliceIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_TIMER_SLICE);
    });
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(1);

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

    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(2);
  });

  it('cancels an active far-future continuation timer on cleanup', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const timers = recordWindowTimers();
    const startsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 10_000).toISOString();
    const endsAt = new Date(FAKE_NOW + MAX_TIMER_SLICE + 70_000).toISOString();
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [makeCompetition({ id: 'c-far-future', phase: 'UPCOMING', startsAt, endsAt })],
    });

    const page = renderPage();
    await flushQueryUpdates();

    const initialSliceIndex = timers.scheduled.findIndex(({ delay }) => delay === MAX_TIMER_SLICE);
    expect(initialSliceIndex).toBeGreaterThanOrEqual(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MAX_TIMER_SLICE);
    });
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(1);

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
    expect(listCompetitionsForGroup).toHaveBeenCalledTimes(1);
  });

  it('falls back to clock-derived OPEN when phase is absent', async () => {
    const startsAt = new Date(Date.now() - 60_000).toISOString();
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [makeCompetition({ id: 'c-no-phase-open', status: 'SCHEDULED', startsAt, endsAt })],
    });

    renderPage();

    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('terminal COMPLETED and CANCELLED statuses override future timestamps when phase is absent', async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    vi.setSystemTime(FAKE_NOW);
    const timers = recordWindowTimers();
    const startsAt = new Date(FAKE_NOW + 10_000).toISOString();
    const endsAt = new Date(FAKE_NOW + 20_000).toISOString();
    listCompetitionsForGroup.mockResolvedValue({
      success: true,
      data: [
        makeCompetition({
          id: 'c-no-phase-completed',
          status: 'COMPLETED',
          startsAt,
          endsAt,
        }),
        makeCompetition({
          id: 'c-no-phase-cancelled',
          status: 'CANCELLED',
          startsAt,
          endsAt,
        }),
      ],
    });

    renderPage();
    await flushQueryUpdates();

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    // Terminal status is authoritative even though the timestamps are future.
    expect(screen.queryByText('Upcoming')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'View results' })).toHaveLength(2);
    expect(timers.scheduled.some(({ delay }) => delay >= BOUNDARY_GRACE_MS)).toBe(false);
  });
});

describe('GroupCompetitionsPage — self-service competition creation', () => {
  const ACTIVE_GAMES = [
    { key: 'dice', name: 'Dice' },
    { key: 'trivia', name: 'Trivia' },
  ];

  function mockMembershipWithGames(
    memberRole: 'OWNER' | 'ADMIN' | 'MODERATOR' | 'MEMBER' | undefined,
    games: { key: string; name: string }[] = ACTIVE_GAMES,
  ) {
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return { success: true, data: { isMember: true, memberRole } };
      if (url === '/games') return { success: true, data: games };
      throw new Error(`unexpected api.get(${url})`);
    });
  }

  async function openForm() {
    fireEvent.click(await screen.findByRole('button', { name: 'Create competition' }));
    // The toggle button is replaced by the form's own submit button of the
    // same name, so this always resolves the (now sole) button in the DOM.
    return screen.findByRole('button', { name: 'Create competition' });
  }

  it('shows Create competition to an OWNER', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByRole('button', { name: 'Create competition' })).toBeInTheDocument();
  });

  it('shows Create competition to an ADMIN', async () => {
    mockMembershipWithGames('ADMIN');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByRole('button', { name: 'Create competition' })).toBeInTheDocument();
  });

  it.each(['MEMBER', 'MODERATOR'] as const)('never shows Create competition to a %s', async (role) => {
    mockMembershipWithGames(role);
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    renderPage(client);

    // Wait for the membership query itself to settle (not just for some
    // other element to appear) before asserting absence, so this can't pass
    // vacuously by checking before `canCreate` has even been derived.
    await waitFor(() => expect(client.getQueryState(['group', 'g1'])?.status).toBe('success'));
    await screen.findByText('No competitions in this group yet.');
    expect(screen.queryByRole('button', { name: 'Create competition' })).not.toBeInTheDocument();
  });

  it('loads the active game catalog from GET /games into the game selector', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    const select = screen.getByLabelText('Game') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
        'Select a game…',
        'Dice',
        'Trivia',
      ]);
    });
    expect(apiGet).toHaveBeenCalledWith('/games');
  });

  it('submits a complete payload with local-to-ISO conversion, invalidates the list, and navigates to the new competition', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockResolvedValue({
      success: true,
      data: { id: 'new-comp-1', groupId: 'g1', title: 'Weekend Cup' },
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'trivia' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Weekend Cup');
    await userEvent.type(screen.getByLabelText(/Description/), 'Friendly weekend trivia');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Entry amount (GP)'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText(/Max participants/), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Winner reward (GP)'), { target: { value: '100' } });
    fireEvent.change(screen.getByLabelText('Winner reward (Coins)'), { target: { value: '5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));
    expect(createCompetition).toHaveBeenCalledWith({
      groupId: 'g1',
      gameKey: 'trivia',
      title: 'Weekend Cup',
      description: 'Friendly weekend trivia',
      // Literal expected ISO strings (not `new Date(local).toISOString()` —
      // the same expression the component itself uses) so a regression that
      // treats the `datetime-local` value as UTC would actually fail this
      // assertion. The suite runs pinned to America/New_York (vitest.config.ts
      // `test.env.TZ`), where 2026-06-01 is EDT (UTC-4): 10:00/12:00 local
      // -> 14:00/16:00 UTC.
      startsAt: '2026-06-01T14:00:00.000Z',
      endsAt: '2026-06-01T16:00:00.000Z',
      entryAmount: 25,
      maxParticipants: 8,
      rewardGamePoints: 100,
      rewardCoins: 5,
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['competitions', 'g1'] }))
    );
    // Rewards are escrow-debited from the creator at creation time, so the
    // wallet caches must refresh alongside the competition list.
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
    expect(toastMock).toHaveBeenCalledWith({ title: 'Competition created' });
    expect(await screen.findByTestId('detail-marker')).toHaveTextContent('detail:g1/new-comp-1');
  });

  it('defaults entry amount and both rewards to zero, and omits optional fields, when left untouched', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockResolvedValue({ success: true, data: { id: 'new-comp-2' } });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Free Dice Night');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));
    expect(createCompetition).toHaveBeenCalledWith(
      expect.objectContaining({
        entryAmount: 0,
        rewardGamePoints: 0,
        rewardCoins: 0,
        maxParticipants: undefined,
        description: undefined,
      }),
    );
  });

  it('rejects submission with no game selected', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    await userEvent.type(screen.getByLabelText('Title'), 'No Game Picked');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Choose a game.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects submission with a blank title', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Title is required.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects an end time that is not after the start time', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Backwards Time');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('End time must be after start time.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects a max participants value below 2', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Tiny Cap');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText(/Max participants/), { target: { value: '1' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Max participants must be blank or an integer of 2 or more.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects a non-integer entry amount', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Fractional Entry');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Entry amount (GP)'), { target: { value: '2.5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Entry amount must be a non-negative whole number.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects a negative reward value', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Negative Reward');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Winner reward (GP)'), { target: { value: '-10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Game Point reward must be a non-negative whole number.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('displays the server error and does not navigate when creation fails', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockRejectedValue(
      new Error(JSON.stringify({ status: 400, message: 'This game is currently unavailable' })),
    );

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Broken Comp');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('This game is currently unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-marker')).not.toBeInTheDocument();
    // Entered values are preserved so the manager can correct and resubmit.
    expect(screen.getByLabelText('Title')).toHaveValue('Broken Comp');
  });

  it('disables the submit button while a request is in flight, preventing duplicate submission', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    let resolveCreate!: (value: { success: true; data: { id: string } }) => void;
    createCompetition.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; }),
    );

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Slow Comp');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));
    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));

    const pendingButton = screen.getByRole('button', { name: 'Creating…' });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(createCompetition).toHaveBeenCalledTimes(1);

    resolveCreate({ success: true, data: { id: 'slow-1' } });
    await waitFor(() => expect(screen.getByTestId('detail-marker')).toBeInTheDocument());
    expect(createCompetition).toHaveBeenCalledTimes(1);
  });

  it('a same-tick duplicate form submission produces exactly one request', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockImplementation(() => new Promise(() => {})); // never resolves

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Race Cup');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    // Dispatch the submit event directly, twice, rather than clicking the
    // submit button once and relying on its `disabled` attribute — this
    // exercises the `if (createMutation.isPending) return;` guard itself,
    // which a click-only test can never reach a second time.
    const form = screen.getByRole('form', { name: 'Create competition' });
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));
  });

  it('shows a generic message and preserves entered values on a network failure', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    // A network failure or CORS/offline error never reaches JSON.parse —
    // this is not the JSON-error-body path covered above.
    createCompetition.mockRejectedValue(new TypeError('Failed to fetch'));

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Offline Cup');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Failed to create competition')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-marker')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('Offline Cup');
  });

  it('closes the form, warns via toast, and does not navigate when the server responds success with no competition id', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockResolvedValue({ success: true, data: {} });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Incomplete Response Cup');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    // Never claims the normal success toast, and never navigates — we can't
    // confirm the competition was actually created or find its id.
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({
        title: 'Competition status unknown',
        description: "We couldn't confirm the competition was created. Check the competition list before trying again.",
        variant: 'destructive',
      }),
    );
    expect(toastMock).not.toHaveBeenCalledWith({ title: 'Competition created' });
    expect(screen.queryByTestId('detail-marker')).not.toBeInTheDocument();

    // The form closes/resets rather than staying open with the entered
    // values — there is no retained payload left to accidentally resubmit.
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
    expect(screen.queryByText('Incomplete Response Cup')).not.toBeInTheDocument();

    // The competition (and any prize escrow debit) is already committed
    // server-side despite the incomplete response body, so the list and
    // wallet caches are still refreshed rather than left stale.
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['competitions', 'g1'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));

    // Nothing left in this render can trigger a second create request: the
    // toggle (freshly reopenable) only starts a blank form, not a resubmit.
    expect(createCompetition).toHaveBeenCalledTimes(1);
    const toggle = await screen.findByRole('button', { name: 'Create competition' });
    fireEvent.click(toggle);
    await screen.findByLabelText('Title');
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(createCompetition).toHaveBeenCalledTimes(1);
  });

  it('rejects an entry amount above the Postgres Int32 ceiling', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Overflow Entry');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Entry amount (GP)'), { target: { value: '3000000000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Entry amount must be 2,147,483,647 or less.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects a max participants value above the Postgres Int32 ceiling', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Overflow Max');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText(/Max participants/), { target: { value: '3000000000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Max participants must be 2,147,483,647 or fewer.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects a Game Point reward above the server cap', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Overflow Reward GP');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Winner reward (GP)'), { target: { value: '1000001' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Game Point reward must be 1,000,000 or less.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects a Coin reward above the server cap', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Overflow Reward Coins');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Winner reward (Coins)'), { target: { value: '1000001' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Coin reward must be 1,000,000 or less.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it.each(['2e', '-', 'abc'])(
    'rejects malformed max participants input %s instead of silently treating it as unlimited',
    async (badValue) => {
      mockMembershipWithGames('OWNER');
      listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

      renderPage();
      await openForm();

      fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
      await userEvent.type(screen.getByLabelText('Title'), 'Malformed Max');
      fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
      fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
      // The field is type="text" (not type="number"), so this literal string
      // reaches the component's onChange exactly as typed, proving the
      // validation genuinely rejects it rather than a native number-input
      // sanitizing it to "" (which would read as blank = "unlimited").
      fireEvent.change(screen.getByLabelText(/Max participants/), { target: { value: badValue } });

      fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

      expect(await screen.findByText('Max participants must be blank or an integer of 2 or more.')).toBeInTheDocument();
      expect(createCompetition).not.toHaveBeenCalled();
    },
  );

  it('uses type="text" + inputMode="numeric" (not type="number") for max participants', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    const maxInput = screen.getByLabelText(/Max participants/);
    // A native type="number" input silently sanitizes malformed text like
    // "2e" or "-" to "" before the component ever sees it (badInput), which
    // would read as blank = "unlimited" — this is the actual mechanism the
    // malformed-input tests above depend on to be meaningful.
    expect(maxInput).toHaveAttribute('type', 'text');
    expect(maxInput).toHaveAttribute('inputmode', 'numeric');
  });

  it('accepts entry amount and max participants exactly at the Postgres Int32 ceiling (2,147,483,647)', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockResolvedValue({ success: true, data: { id: 'at-cap-1' } });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'At The Ceiling');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Entry amount (GP)'), { target: { value: '2147483647' } });
    fireEvent.change(screen.getByLabelText(/Max participants/), { target: { value: '2147483647' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));
    expect(createCompetition).toHaveBeenCalledWith(
      expect.objectContaining({ entryAmount: 2_147_483_647, maxParticipants: 2_147_483_647 }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('accepts each reward exactly at the server cap (1,000,000)', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockResolvedValue({ success: true, data: { id: 'at-cap-2' } });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'At The Reward Ceiling');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });
    fireEvent.change(screen.getByLabelText('Winner reward (GP)'), { target: { value: '1000000' } });
    fireEvent.change(screen.getByLabelText('Winner reward (Coins)'), { target: { value: '1000000' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));
    expect(createCompetition).toHaveBeenCalledWith(
      expect.objectContaining({ rewardGamePoints: 1_000_000, rewardCoins: 1_000_000 }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('GroupCompetitionsPage — active game catalog states', () => {
  const OWNER_MEMBERSHIP = { success: true, data: { isMember: true, memberRole: 'OWNER' as const } };

  async function openForm() {
    fireEvent.click(await screen.findByRole('button', { name: 'Create competition' }));
    return screen.findByRole('button', { name: 'Create competition' });
  }

  it('shows a loading state, disables the game selector while the catalog is loading, and focuses Title instead of the disabled select', async () => {
    let resolveGames!: (v: { success: true; data: { key: string; name: string }[] }) => void;
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') return new Promise((resolve) => { resolveGames = resolve; });
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    expect(await screen.findByText('Loading games…')).toBeInTheDocument();
    expect(screen.getByLabelText('Game')).toBeDisabled();
    // Focusing a disabled control is a silent no-op — Title is the fallback.
    expect(screen.getByLabelText('Title')).toHaveFocus();

    resolveGames({ success: true, data: [{ key: 'dice', name: 'Dice' }] });
    await waitFor(() => expect(screen.queryByText('Loading games…')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Game')).not.toBeDisabled();
  });

  it('shows an accessible error with a Retry button when the catalog fails to load, focuses Title while disabled, and Retry both recovers it and moves focus to the game select', async () => {
    let gamesCalls = 0;
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') {
        gamesCalls += 1;
        if (gamesCalls === 1) throw new Error('network down');
        return { success: true, data: [{ key: 'dice', name: 'Dice' }] };
      }
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    const errorMessage = await screen.findByText('Could not load games.');
    expect(errorMessage).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('button', { name: 'Create competition' })).toBeDisabled();
    expect(screen.getByLabelText('Title')).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByText('Could not load games.')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Game') as HTMLSelectElement).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create competition' })).not.toBeDisabled();
    // A successful Retry moves focus onto the now-usable game select.
    await waitFor(() => expect(screen.getByLabelText('Game')).toHaveFocus());
  });

  it('keeps focus on the Retry button (the same DOM node) when a retry fails again', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') throw new Error('network down');
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();
    await screen.findByText('Could not load games.');

    const retry = screen.getByRole('button', { name: 'Retry' });
    retry.focus();
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText('Could not load games.')).toBeInTheDocument());
    // Same conditional block, same position -> React reuses this exact node,
    // so the browser's own focus persistence carries it through untouched —
    // no code needs to actively re-focus it, and nothing should steal focus.
    expect(screen.getByRole('button', { name: 'Retry' })).toHaveFocus();
  });

  it('after a Retry that succeeds with an empty catalog, focus lands on Title rather than <body>', async () => {
    let gamesCalls = 0;
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') {
        gamesCalls += 1;
        if (gamesCalls === 1) throw new Error('network down');
        return { success: true, data: [] };
      }
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();
    await screen.findByText('Could not load games.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('No active games are available.')).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByLabelText('Title')).toHaveFocus();
  });

  it('shows "No active games are available.", disables submission when the catalog is empty, and focuses Title instead of the disabled select', async () => {
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') return { success: true, data: [] };
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    expect(await screen.findByText('No active games are available.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create competition' })).toBeDisabled());
    expect(screen.getByLabelText('Title')).toHaveFocus();
  });
});

describe('GroupCompetitionsPage — create-competition form accessibility', () => {
  function mockMembershipWithGames() {
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return { success: true, data: { isMember: true, memberRole: 'OWNER' } };
      if (url === '/games') return { success: true, data: [{ key: 'dice', name: 'Dice' }] };
      throw new Error(`unexpected api.get(${url})`);
    });
  }

  it('exposes aria-expanded/aria-controls on the toggle, stays mounted while open, and moves focus on open/Cancel', async () => {
    mockMembershipWithGames();
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();

    const toggle = await screen.findByRole('button', { name: 'Create competition' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'create-competition-form');

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByLabelText('Game')).toHaveFocus());
    // Proves the toggle was hidden, not unmounted: the exact same node
    // reference is still attached to the document.
    expect(document.body.contains(toggle)).toBe(true);
    expect(toggle).toHaveAttribute('hidden');
    // The `hidden` attribute alone loses the cascade to Button's own
    // `inline-flex` base class in the real built stylesheet (confirmed by
    // rendering the actual production CSS: `inline-flex` computed as the
    // element's `display`, leaving it visible and focusable). The `hidden`
    // utility class is what actually removes it from layout.
    expect(toggle).toHaveClass('hidden');
    expect(toggle).not.toHaveClass('inline-flex');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(toggle).toHaveFocus());
    expect(toggle).not.toHaveAttribute('hidden');
    expect(toggle).not.toHaveClass('hidden');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('associates a validation error with its field via aria-invalid and aria-describedby', async () => {
    mockMembershipWithGames();
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create competition' }));

    const gameSelect = await screen.findByLabelText('Game');
    const titleInput = screen.getByLabelText('Title');

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    const alert = await screen.findByText('Choose a game.');
    expect(alert).toHaveAttribute('id', 'create-competition-error');
    expect(gameSelect).toHaveAttribute('aria-invalid', 'true');
    expect(gameSelect).toHaveAttribute('aria-describedby', 'create-competition-error');
    expect(titleInput).not.toHaveAttribute('aria-invalid');
  });
});
