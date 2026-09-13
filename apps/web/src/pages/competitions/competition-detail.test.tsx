import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
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
}): Competition {
  return {
    id: 'c1',
    groupId: 'g1',
    game: { key: 'dice', name: 'Dice' },
    title: 'Detail Comp',
    description: null,
    status: overrides.status ?? 'SCHEDULED',
    isFull: overrides.isFull ?? false,
    participantCount: overrides.participantCount ?? 0,
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

  it('crosses BOTH boundaries UPCOMING → OPEN → ENDED on a single mount', async () => {
    // Regression: the boundary effect originally omitted `phase` from its deps,
    // so after the startsAt refetch flipped the phase to OPEN the effect never
    // re-ran — no endsAt timer was ever armed and ENDED was never reached. A
    // test that starts OPEN cannot catch that. This mounts exactly once in
    // UPCOMING state and expects the page to traverse the whole lifecycle with
    // no reload, remount, focus change, or socket event.
    memberRole = 'OWNER';
    const startsAt = new Date(Date.now() + 150).toISOString();
    // 250 ms grace after startsAt, then ~750+ ms of OPEN before the endsAt
    // refresh lands; endsAt leaves enough headroom for slow CI without dragging.
    const endsAt = new Date(Date.now() + 1400).toISOString();
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

    // 1. UPCOMING: banner only, no Join/Play.
    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Join/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument();

    // 2. startsAt crossed: refetch → OPEN → existing participant sees Play.
    await waitFor(() => expect(screen.getByRole('button', { name: /Play a round/ })).toBeInTheDocument(), {
      timeout: 4000,
      interval: 40,
    });

    // 3+4. endsAt crossed: second refetch → ENDED → Play disappears.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Play a round/ })).not.toBeInTheDocument(), {
      timeout: 4000,
      interval: 40,
    });

    // 5. Manager sees Finalize in the ENDED phase.
    expect(screen.getByRole('button', { name: /Finalize & distribute rewards/ })).toBeInTheDocument();
    expect(screen.getByText('This competition has ended.')).toBeInTheDocument();
  }, 15_000);

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