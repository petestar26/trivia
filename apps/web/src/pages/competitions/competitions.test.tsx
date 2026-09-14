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

    renderPage();

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
      startsAt: new Date('2026-06-01T10:00').toISOString(),
      endsAt: new Date('2026-06-01T12:00').toISOString(),
      entryAmount: 25,
      maxParticipants: 8,
      rewardGamePoints: 100,
      rewardCoins: 5,
    });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['competitions', 'g1'] }))
    );
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
});
