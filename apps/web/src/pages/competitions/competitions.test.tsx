import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  defaultScheduler,
  notifyManager,
  onlineManager,
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

import { GroupCompetitionsPage, parseStrictLocalDateTime } from './index';

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
  // Safety net alongside each paused-state test's own try/finally:
  // `onlineManager` is a module-level singleton, so leaving it offline
  // after a failed assertion would otherwise leak into later tests.
  onlineManager.setOnline(true);
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


// A native `datetime-local` input's own value setter sanitizes an
// out-of-range CALENDAR date (e.g. February 30, or February 29 in a
// non-leap year) to "" before onChange ever sees it — confirmed identical
// in jsdom and real browsers, since both implement the same "valid
// floating date and time string" grammar. That guarantee makes the
// calendar-rejection branch of `parseStrictLocalDateTime` unreachable
// through the rendered form itself (a blank value there just hits the
// pre-existing "Start and end time are required." check instead) — so it's
// tested directly here as a pure function, the same way
// competition-lifecycle.test.ts tests `normalizeCompetitionPhase`. The
// DST-gap rejection and the ordinary/boundary acceptance cases, in
// contrast, ARE reachable through the widget (a DST-gap time like
// 2027-03-14T02:30 is calendar-valid, just not a valid local instant), and
// are covered by the full-form tests in the "self-service competition
// creation" describe below.
describe('parseStrictLocalDateTime', () => {
  it('rejects invalid normalized calendar dates instead of silently rolling them over', () => {
    // `new Date(2026, 1, 30, ...)` would silently normalize to March 2.
    expect(parseStrictLocalDateTime('2026-02-30T10:00')).toBeNull();
    // `new Date(2026, 3, 31, ...)` would silently normalize to May 1.
    expect(parseStrictLocalDateTime('2026-04-31T10:00')).toBeNull();
    // 2026 is not a leap year.
    expect(parseStrictLocalDateTime('2026-02-29T10:00')).toBeNull();
    // Malformed strings.
    expect(parseStrictLocalDateTime('not-a-date')).toBeNull();
    expect(parseStrictLocalDateTime('')).toBeNull();
  });

  it('rejects a local time that falls in the DST spring-forward gap', () => {
    // Pinned suite timezone: America/New_York (vitest.config.ts). 2027 is
    // the US spring-forward date — 02:00-02:59:59 does not exist locally.
    expect(parseStrictLocalDateTime('2027-03-14T02:00')).toBeNull();
    expect(parseStrictLocalDateTime('2027-03-14T02:30')).toBeNull();
    expect(parseStrictLocalDateTime('2027-03-14T02:59:59')).toBeNull();
  });

  it('accepts ordinary and gap-adjacent valid values and produces the exact expected instant', () => {
    expect(parseStrictLocalDateTime('2026-06-01T10:00')?.toISOString()).toBe('2026-06-01T14:00:00.000Z');
    expect(parseStrictLocalDateTime('2026-06-01T12:00')?.toISOString()).toBe('2026-06-01T16:00:00.000Z');
    // Immediately before and after the DST gap.
    expect(parseStrictLocalDateTime('2027-03-14T01:59')?.toISOString()).toBe('2027-03-14T06:59:00.000Z');
    expect(parseStrictLocalDateTime('2027-03-14T03:00')?.toISOString()).toBe('2027-03-14T07:00:00.000Z');
    // Optional seconds component.
    expect(parseStrictLocalDateTime('2026-06-01T10:00:30')?.toISOString()).toBe('2026-06-01T14:00:30.000Z');
  });
});

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

  // The whole suite is pinned to America/New_York (vitest.config.ts
  // `process.env.TZ`), where 2027-03-14 is the US spring-forward date:
  // local clocks jump from 02:00 directly to 03:00, so 02:00-02:59:59 on
  // that date does not exist as a local time at all.
  it('rejects a start time that falls in the DST spring-forward gap and sends no request', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Nonexistent Start');
    // 02:30 does not exist locally on this date — the naive `new Date(str)`
    // this replaced would have silently shifted it to 03:30 instead of
    // rejecting it.
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2027-03-14T02:30' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-03-14T04:30' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Choose a valid local start time.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('rejects an end time that falls in the DST spring-forward gap', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Nonexistent End');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2027-03-14T01:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-03-14T02:45' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    expect(await screen.findByText('Choose a valid local end time.')).toBeInTheDocument();
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('accepts a valid local time immediately outside the DST gap and converts it to the exact expected ISO instant', async () => {
    mockMembershipWithGames('OWNER');
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    createCompetition.mockResolvedValue({ success: true, data: { id: 'post-gap-1' } });

    renderPage();
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Right After The Gap');
    // 03:00 is the first local instant that exists again after the
    // spring-forward gap — already on EDT (UTC-4) for this date.
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2027-03-14T03:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-03-14T04:30' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    await waitFor(() => expect(createCompetition).toHaveBeenCalledTimes(1));
    expect(createCompetition).toHaveBeenCalledWith(
      expect.objectContaining({
        startsAt: '2027-03-14T07:00:00.000Z',
        endsAt: '2027-03-14T08:30:00.000Z',
      }),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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

  it('renders an accessible warning, closes the form, and does not navigate when the server responds success with no competition id', async () => {
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

    // Wait for the accessible warning banner before asserting anything — the
    // mutation's onSuccess fires asynchronously.
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(
      "We couldn't confirm the competition was created. Check the competition list before trying again.",
    );

    // Never claims the normal success toast, and never navigates — we can't
    // confirm the competition was actually created or find its id.
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

    // Reopening the form clears the warning.
    const toggle = await screen.findByRole('button', { name: 'Create competition' });
    fireEvent.click(toggle);
    await screen.findByLabelText('Title');
    expect(screen.queryByText(/couldn't confirm/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(createCompetition).toHaveBeenCalledTimes(1);
  });

  it('preserves the missing-ID warning when the competition list subsequently fails to refresh', async () => {
    mockMembershipWithGames('OWNER');
    // First call succeeds (initial mount), second call fails (refetch after mutation invalidation).
    listCompetitionsForGroup
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockRejectedValueOnce(new Error('network blip'));
    createCompetition.mockResolvedValue({ success: true, data: {} });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderPage(client);
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Ghost Comp');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create competition' }));

    // Wait for the creation to complete and the warning to appear.
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveTextContent(
      "We couldn't confirm the competition was created. Check the competition list before trying again.",
    );

    // The mutation already invalidated the list query; the refetch will use
    // the second (rejected) mock, putting the query into error state.
    await waitFor(() =>
      expect(screen.getByText(/Could not load competitions/)).toBeInTheDocument(),
    );

    // The missing-ID warning persists alongside the list error — the two
    // messages carry distinct, non-confusing content.
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't confirm/);
    expect(screen.getByText(/Could not load competitions/)).toBeInTheDocument();
    // There is exactly one role="alert" for the warning (the list error uses
    // a plain <CardContent> without role="alert", so no duplicate alerts).
    expect(screen.getAllByRole('alert')).toHaveLength(1);
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

describe('GroupCompetitionsPage — membership authorization gate', () => {
  const ACTIVE_GAMES = [{ key: 'dice', name: 'Dice' }];

  function mockOwnerMembership() {
    apiGet.mockImplementation((url: string) => {
      if (url === '/groups/g1') {
        return Promise.resolve({ success: true, data: { isMember: true, memberRole: 'OWNER' } });
      }
      if (url === '/games') return Promise.resolve({ success: true, data: ACTIVE_GAMES });
      return Promise.reject(new Error(`unexpected api.get(${url})`));
    });
  }

  async function openForm() {
    fireEvent.click(await screen.findByRole('button', { name: 'Create competition' }));
    return screen.findByRole('button', { name: 'Create competition' });
  }

  it('cached successful OWNER membership followed by a pending refresh: controls are unavailable while unresolved', async () => {
    let groupCalls = 0;
    apiGet.mockImplementation((url: string) => {
      if (url === '/groups/g1') {
        groupCalls += 1;
        if (groupCalls === 1) {
          return Promise.resolve({ success: true, data: { isMember: true, memberRole: 'OWNER' } });
        }
        // The refetch (2nd+ call) never settles — simulates an in-flight,
        // unresolved refresh of previously-successful cached data.
        return new Promise(() => {});
      }
      if (url === '/games') return Promise.resolve({ success: true, data: ACTIVE_GAMES });
      return Promise.reject(new Error(`unexpected api.get(${url})`));
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderPage(client);

    // Initial resolve: OWNER, controls available.
    await screen.findByRole('button', { name: 'Create competition' });

    // Trigger a refetch that will hang.
    client.refetchQueries({ queryKey: ['group', 'g1'] });
    await waitFor(() => expect(groupCalls).toBe(2));

    // Cached `memberRole: 'OWNER'` data is still sitting in the cache, but
    // the gate must not derive authorization from it alone while a
    // fetch/refetch is unresolved.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create competition' })).not.toBeInTheDocument(),
    );
  });

  it('cached OWNER membership followed by a failed refresh: controls remain unavailable despite retained cached data', async () => {
    let groupCalls = 0;
    apiGet.mockImplementation((url: string) => {
      if (url === '/groups/g1') {
        groupCalls += 1;
        if (groupCalls === 1) {
          return Promise.resolve({ success: true, data: { isMember: true, memberRole: 'OWNER' } });
        }
        return Promise.reject(new Error('network blip'));
      }
      if (url === '/games') return Promise.resolve({ success: true, data: ACTIVE_GAMES });
      return Promise.reject(new Error(`unexpected api.get(${url})`));
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderPage(client);

    await screen.findByRole('button', { name: 'Create competition' });

    client.refetchQueries({ queryKey: ['group', 'g1'] });
    await waitFor(() => expect(client.getQueryState(['group', 'g1'])?.status).toBe('error'));

    // React Query keeps the last successful `data` (OWNER) around through a
    // failing background refetch by default — this proves the gate checks
    // the query's own status, not merely "does cached memberRole data
    // exist and look right".
    expect(client.getQueryData(['group', 'g1'])).toEqual({ isMember: true, memberRole: 'OWNER' });
    expect(screen.queryByRole('button', { name: 'Create competition' })).not.toBeInTheDocument();
  });

  it('memberRole OWNER with isMember false: controls remain unavailable', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/groups/g1') {
        return Promise.resolve({ success: true, data: { isMember: false, memberRole: 'OWNER' } });
      }
      if (url === '/games') return Promise.resolve({ success: true, data: ACTIVE_GAMES });
      return Promise.reject(new Error(`unexpected api.get(${url})`));
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();

    await screen.findByText('No competitions in this group yet.');
    expect(screen.queryByRole('button', { name: 'Create competition' })).not.toBeInTheDocument();
  });

  it('a programmatic submit after authorization becomes invalid in the query cache does not call createCompetition', async () => {
    mockOwnerMembership();
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });
    // Never resolves: if the mutation *did* fire, this isolates that fact
    // (call count) from any onSuccess/onError side effects.
    createCompetition.mockImplementation(() => new Promise(() => {}));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderPage(client);
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Race Cup');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    const form = screen.getByRole('form', { name: 'Create competition' });

    // Revoke authorization directly in the query cache WITHOUT letting React
    // re-render first — React Query's notifications are scheduled, not
    // synchronous, so the component's own `canCreate` (captured by this
    // render's closure) is still stale-true at this exact instant. Firing
    // the submit synchronously right after proves the handler re-checks the
    // live cache (via `isMembershipAuthorized`) rather than trusting that
    // stale closure value.
    client.setQueryData(['group', 'g1'], { isMember: false, memberRole: 'MEMBER' });
    fireEvent.submit(form);

    // `useMutation().mutate(...)` invokes the mutationFn on a later
    // microtask, not synchronously with the submit event, so this must
    // actually flush before a "was not called" assertion means anything —
    // without it, the assertion below passes trivially whether or not the
    // guard exists at all, because any call simply hasn't happened yet at
    // the point of the check (confirmed via mutation testing).
    await act(async () => {
      await Promise.resolve();
    });
    expect(createCompetition).not.toHaveBeenCalled();
  });

  it('a subsequent successful active OWNER refresh restores creation access', async () => {
    let groupCalls = 0;
    apiGet.mockImplementation((url: string) => {
      if (url === '/groups/g1') {
        groupCalls += 1;
        if (groupCalls === 2) return Promise.reject(new Error('network blip'));
        return Promise.resolve({ success: true, data: { isMember: true, memberRole: 'OWNER' } });
      }
      if (url === '/games') return Promise.resolve({ success: true, data: ACTIVE_GAMES });
      return Promise.reject(new Error(`unexpected api.get(${url})`));
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderPage(client);

    await screen.findByRole('button', { name: 'Create competition' });

    // First refetch fails: controls disappear despite retained cached data.
    client.refetchQueries({ queryKey: ['group', 'g1'] });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create competition' })).not.toBeInTheDocument(),
    );

    // Second refetch succeeds (active OWNER again): controls return.
    client.refetchQueries({ queryKey: ['group', 'g1'] });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create competition' })).toBeInTheDocument(),
    );
  });

  it('treats a paused (offline) membership refresh as unresolved, not as settled retained data', async () => {
    apiGet.mockImplementation((url: string) => {
      // Every call resolves OWNER — the offline-triggered refetch, once it
      // auto-resumes back online, settles successfully again too.
      if (url === '/groups/g1') {
        return Promise.resolve({ success: true, data: { isMember: true, memberRole: 'OWNER' } });
      }
      if (url === '/games') return Promise.resolve({ success: true, data: ACTIVE_GAMES });
      return Promise.reject(new Error(`unexpected api.get(${url})`));
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderPage(client);

    await screen.findByRole('button', { name: 'Create competition' });
    const gamesCallsBeforePause = apiGet.mock.calls.filter(([u]) => u === '/games').length;

    try {
      onlineManager.setOnline(false);
      // With `networkMode: 'online'` (the default) and a mounted observer,
      // this transitions the query's `fetchStatus` to 'paused' — retained
      // `status: 'success'` and retained OWNER data — synchronously, with
      // no fetch attempt and no `queryFn` re-invocation while offline.
      client.refetchQueries({ queryKey: ['group', 'g1'] });

      const pausedState = client.getQueryState(['group', 'g1']);
      expect(pausedState?.status).toBe('success');
      expect(pausedState?.fetchStatus).toBe('paused');
      // `isFetching` is strictly `fetchStatus === 'fetching'`, so a paused
      // query also reports `isFetching: false` — this is exactly the case
      // `!isFetching` alone would get wrong.
      expect(pausedState?.fetchStatus).not.toBe('fetching');
      expect(pausedState?.data).toEqual({ isMember: true, memberRole: 'OWNER' });

      // Controls unavailable despite the retained OWNER data.
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Create competition' })).not.toBeInTheDocument(),
      );
      // The games query gains no new enablement off the retained role.
      const gamesCallsWhilePaused = apiGet.mock.calls.filter(([u]) => u === '/games').length;
      expect(gamesCallsWhilePaused).toBe(gamesCallsBeforePause);
      // No creation request is reachable through any path while paused.
      expect(createCompetition).not.toHaveBeenCalled();
    } finally {
      onlineManager.setOnline(true);
    }

    // Coming back online auto-resumes the paused refetch; it settles
    // successfully (still active OWNER), restoring access.
    await waitFor(() => expect(client.getQueryState(['group', 'g1'])?.fetchStatus).toBe('idle'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create competition' })).toBeInTheDocument(),
    );
  });

  it('a microtask-boundary revocation between submit and mutationFn prevents the API call, with no success side effects', async () => {
    mockOwnerMembership();
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);
    await openForm();

    fireEvent.change(screen.getByLabelText('Game'), { target: { value: 'dice' } });
    await userEvent.type(screen.getByLabelText('Title'), 'Race Cup');
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-06-01T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-06-01T12:00' } });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const form = screen.getByRole('form', { name: 'Create competition' });
      // Submit while still genuinely authorized — this passes BOTH the
      // submit-handler's own live-cache check and (at this instant) would
      // also pass the mutationFn's. `mutate()` schedules the mutationFn
      // call for a later microtask rather than invoking it synchronously
      // (confirmed via mutation testing below), so revoking authorization
      // in the SAME synchronous tick, immediately after, lands in exactly
      // the gap the mutationFn-level guard exists to cover — the submit
      // handler's own check has already run and already passed.
      fireEvent.submit(form);
      client.setQueryData(['group', 'g1'], { isMember: false, memberRole: 'MEMBER' });

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      // Give a same-turn `unhandledRejection` (Node fires it on a later
      // microtask/macrotask than the rejection itself) room to surface.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(createCompetition).not.toHaveBeenCalled();
      expect(toastMock).not.toHaveBeenCalledWith({ title: 'Competition created' });
      expect(screen.queryByTestId('detail-marker')).not.toBeInTheDocument();
      expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['competitions', 'g1'] }));
      expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
      expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
      // React Query's mutation observer catches the mutationFn's throw and
      // routes it to `onError` — it must never surface as an unhandled
      // rejection in the page's own promise chain.
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  // Not separately tested: "paused membership state at mutation
  // invocation". Attempted via `onlineManager.setOnline(false)` right after
  // `mutate()` — but `useMutation` itself defaults to the same
  // `networkMode: 'online'` as queries, sharing the same global
  // `onlineManager`. Going offline that way pauses the MUTATION itself
  // (confirmed directly: `mutationFn` never runs while offline, the
  // mutation cache reports `isPaused: true`) before its own scheduled
  // microtask fires — so a "createCompetition not called" assertion built
  // that way would pass for the wrong reason (React Query's own
  // network-mode gate on the mutation), not because of the mutationFn's
  // authorization guard above, and would keep passing even with that guard
  // deleted. There's no way to pause the membership *query* without also
  // pausing the mutation without either changing the mutation's own
  // `networkMode` (a production behavior change outside this fix's scope)
  // or poking at `Query` internals directly. This is covered anyway,
  // by construction: both the render-time gate (see the paused-refresh
  // test above) and the mutationFn guard call the exact same
  // `isMembershipSnapshotAuthorized`, and mutation testing already proves
  // that function's `fetchStatus !== 'idle'` check is load-bearing for a
  // 'paused' snapshot — there is no code path where the mutationFn's call
  // to that identical function would treat 'paused' any differently.
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

  it('shows an accessible error with a Retry button when the catalog fails to load, focuses Title while disabled, and a successful Retry recovers it and moves focus to the game select', async () => {
    let resolveGames!: (v: { success: true; data: { key: string; name: string }[] }) => void;
    let gamesCalls = 0;
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') {
        gamesCalls += 1;
        if (gamesCalls === 1) throw new Error('network down');
        // Deferred: makes the loading state observable and proves the
        // original Retry button actually unmounts, rather than resolving
        // in the same tick where a stale reference could still "pass".
        return new Promise((resolve) => { resolveGames = resolve as typeof resolveGames; });
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

    // Focus and activate the original Retry button.
    const initialRetry = screen.getByRole('button', { name: 'Retry' });
    initialRetry.focus();
    fireEvent.click(initialRetry);

    // The deferred promise means the loading state is observable, and
    // proves the original Retry button (and its error text) unmounted —
    // not just that some button named "Retry" happens to still resolve.
    expect(await screen.findByText('Loading games…')).toBeInTheDocument();
    expect(initialRetry).not.toBeInTheDocument();
    expect(screen.queryByText('Could not load games.')).not.toBeInTheDocument();

    resolveGames({ success: true, data: [{ key: 'dice', name: 'Dice' }] });

    await waitFor(() => expect(screen.queryByText('Loading games…')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Game') as HTMLSelectElement).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create competition' })).not.toBeDisabled();
    // A successful Retry moves focus onto the now-usable game select.
    await waitFor(() => expect(screen.getByLabelText('Game')).toHaveFocus());
  });

  it('restores focus to the new Retry button when a retry fails again', async () => {
    let resolveGames!: (v: { success: true; data: { key: string; name: string }[] }) => void;
    let rejectGames!: (err: Error) => void;
    let gamesCalls = 0;
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') {
        gamesCalls += 1;
        if (gamesCalls === 1) throw new Error('network down');
        return new Promise((resolve, reject) => {
          resolveGames = resolve as typeof resolveGames;
          rejectGames = reject;
        });
      }
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();
    await screen.findByText('Could not load games.');

    // Focus and activate the initial Retry button.
    const initialRetry = screen.getByRole('button', { name: 'Retry' });
    initialRetry.focus();
    fireEvent.click(initialRetry);

    // The deferred promise means the loading state is observable.
    expect(await screen.findByText('Loading games…')).toBeInTheDocument();
    // React Query re-rendered the error block; the initial Retry button is gone.
    expect(initialRetry).not.toBeInTheDocument();

    // Reject the deferred request so the error block reappears.
    rejectGames(new Error('still down'));
    await waitFor(() => expect(screen.getByText('Could not load games.')).toBeInTheDocument());

    // The replacement Retry button is a different DOM node and receives focus.
    const replacementRetry = screen.getByRole('button', { name: 'Retry' });
    expect(replacementRetry).not.toBe(initialRetry);
    expect(replacementRetry).toHaveFocus();
  });

  it('after a Retry that succeeds with an empty catalog, focus lands on Title rather than <body>', async () => {
    let resolveGames!: (v: { success: true; data: { key: string; name: string }[] }) => void;
    let gamesCalls = 0;
    apiGet.mockImplementation(async (url: string) => {
      if (url === '/groups/g1') return OWNER_MEMBERSHIP;
      if (url === '/games') {
        gamesCalls += 1;
        if (gamesCalls === 1) throw new Error('network down');
        return new Promise((resolve) => {
          resolveGames = resolve as typeof resolveGames;
        });
      }
      throw new Error(`unexpected api.get(${url})`);
    });
    listCompetitionsForGroup.mockResolvedValue({ success: true, data: [] });

    renderPage();
    await openForm();
    await screen.findByText('Could not load games.');

    // Focus the initial Retry button so we can verify it disappears.
    const initialRetry = screen.getByRole('button', { name: 'Retry' });
    initialRetry.focus();
    fireEvent.click(initialRetry);

    // The deferred promise means the loading state is observable.
    expect(await screen.findByText('Loading games…')).toBeInTheDocument();
    expect(initialRetry).not.toBeInTheDocument();

    // Resolve with an empty games array.
    resolveGames({ success: true, data: [] });
    expect(await screen.findByText('No active games are available.')).toBeInTheDocument();
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
