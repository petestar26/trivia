import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Competition, CompetitionPhase } from '@/lib/api';

const listCompetitionsForGroup = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listCompetitionsForGroup: (...a: unknown[]) => listCompetitionsForGroup(...a),
  },
}));

import { GroupCompetitionsPage } from './index';

function makeCompetition(overrides: {
  id: string;
  phase: CompetitionPhase;
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
    phase: overrides.phase,
    isFull: overrides.isFull ?? false,
    participantCount: 0,
    entryAmount: 0,
    maxParticipants: null,
    rewardGamePoints: 10,
    rewardCoins: 0,
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const PAST_START = '2026-01-01T00:00:00.000Z';
const PAST_END = '2026-01-02T00:00:00.000Z';
const FUTURE_START = '2027-01-01T00:00:00.000Z';
const FUTURE_END = '2027-01-02T00:00:00.000Z';

afterEach(() => {
  cleanup();
  listCompetitionsForGroup.mockReset();
});

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/competitions/g1']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/competitions/:groupId" element={<GroupCompetitionsPage />} />
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

  it('OPEN lists the competition as Open (persisted status irrelevant)', async () => {
    // Persisted status stays SCHEDULED in production (no SCHEDULED→ACTIVE
    // path); the OPEN badge must come from phase, not from status.
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

  it('crossing startsAt transitions the card from Upcoming to Open without reload', async () => {
    const startsAt = new Date(Date.now() + 150).toISOString();
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    // The server derives phase from the clock on every read, so the mock must
    // do the same for the post-refetch data to change.
    listCompetitionsForGroup.mockImplementation(async () => {
      const now = Date.now();
      const phase: CompetitionPhase = now < new Date(startsAt).getTime() ? 'UPCOMING' : 'OPEN';
      return {
        success: true,
        data: [
          makeCompetition({ id: 'c-boundary', phase, status: 'SCHEDULED', startsAt, endsAt }),
        ],
      };
    });

    renderPage();

    expect(await screen.findByText('Upcoming')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Open')).toBeInTheDocument(), {
      timeout: 3000,
      interval: 50,
    });
  }, 10_000);
});