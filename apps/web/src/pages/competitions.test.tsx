import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const listGroups = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { listGroups: (...a: unknown[]) => listGroups(...a) },
}));

import { CompetitionsPage } from './competitions';

afterEach(() => {
  cleanup();
  listGroups.mockReset();
});

/** Marker rendered at /groups so a navigate() there is observable. */
function GroupsRouteMarker() {
  return <div data-testid="groups-marker">groups page</div>;
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderPage(client = makeClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/competitions']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/competitions" element={<CompetitionsPage />} />
      <Route path="/groups" element={<GroupsRouteMarker />} />
      <Route path="*" element={null} />
    </Routes>,
    { wrapper },
  );
}

function page1Meta(overrides: Partial<Record<string, unknown>> = {}) {
  return { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false, ...overrides };
}

const GROUP_A = { id: 'g1', name: 'Group Alpha', isMember: true, memberCount: 2, memberRole: 'OWNER' };
const GROUP_B = { id: 'g2', name: 'Group Beta', isMember: true, memberCount: 1, memberRole: 'MEMBER' };
const GROUP_C = { id: 'g3', name: 'Group Gamma', isMember: true, memberCount: 5, memberRole: 'ADMIN' };

describe('CompetitionsPage', () => {
  it('requests server-filtered memberships with mine: true', async () => {
    listGroups.mockResolvedValue({ success: true, data: [], meta: page1Meta() });

    renderPage();
    await screen.findByText('You are not a member of any groups yet.');

    expect(listGroups).toHaveBeenCalledWith({ mine: true, limit: 20, page: 1 });
  });

  it('renders every group the server returns without re-filtering on isMember client-side', async () => {
    // The server is trusted for membership filtering now — a client-side
    // `.filter(g => g.isMember)` would incorrectly hide this entry even
    // though `mine=true` was what was requested. Real server responses to
    // `mine=true` are always `isMember: true`; this exercises what the
    // *client* does with whatever the server sends, not what a correct
    // server would send.
    listGroups.mockResolvedValue({
      success: true,
      data: [{ id: 'g1', name: 'Unfiltered Group', isMember: false, memberCount: 3, memberRole: 'MEMBER' }],
      meta: page1Meta({ total: 1, totalPages: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Unfiltered Group')).toBeInTheDocument();
  });

  it('shows a Create a group CTA linking to /groups when the user belongs to no groups', async () => {
    listGroups.mockResolvedValue({ success: true, data: [], meta: page1Meta() });

    renderPage();

    expect(await screen.findByText('You are not a member of any groups yet.')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Create a group' });
    expect(cta).toBeInTheDocument();

    fireEvent.click(cta);

    expect(await screen.findByTestId('groups-marker')).toBeInTheDocument();
  });

  it('does not show the empty-state CTA once the user has at least one group', async () => {
    listGroups.mockResolvedValue({
      success: true,
      data: [GROUP_A],
      meta: page1Meta({ total: 1, totalPages: 1 }),
    });

    renderPage();

    expect(await screen.findByText('Group Alpha')).toBeInTheDocument();
    expect(screen.queryByText('You are not a member of any groups yet.')).not.toBeInTheDocument();
  });

  it('shows an accessible loading indicator without flashing the empty state while the first page loads', async () => {
    let resolvePage!: (v: unknown) => void;
    listGroups.mockImplementation(() => new Promise((resolve) => { resolvePage = resolve; }));

    renderPage();

    // Observable + announced loading state (role="status"), no premature
    // empty-state text or CTA.
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Loading your groups');
    expect(screen.getByText('Loading your groups…')).toBeInTheDocument();
    expect(screen.queryByText('You are not a member of any groups yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create a group' })).not.toBeInTheDocument();

    // Cards appear only once the request settles.
    resolvePage({ success: true, data: [GROUP_A], meta: page1Meta({ total: 1, totalPages: 1 }) });
    expect(await screen.findByText('Group Alpha')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows a real loading error, not the empty membership state, when the initial request fails', async () => {
    listGroups.mockRejectedValue(new Error('network down'));

    renderPage();

    expect(await screen.findByText('Failed to load your groups.')).toBeInTheDocument();
    expect(screen.queryByText('You are not a member of any groups yet.')).not.toBeInTheDocument();
    // A Retry control is offered for the failed initial load.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('recovers from an initial request failure via Retry', async () => {
    listGroups.mockRejectedValueOnce(new Error('network down'));
    renderPage();
    expect(await screen.findByText('Failed to load your groups.')).toBeInTheDocument();

    listGroups.mockResolvedValueOnce({ success: true, data: [GROUP_A], meta: page1Meta({ total: 1, totalPages: 1 }) });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Group Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load your groups.')).not.toBeInTheDocument();
  });

  it('keeps cards visible and shows a distinct refresh error when a background refetch fails', async () => {
    listGroups.mockResolvedValueOnce({ success: true, data: [GROUP_A], meta: page1Meta({ total: 1, totalPages: 1 }) });
    const client = makeClient();
    renderPage(client);
    expect(await screen.findByText('Group Alpha')).toBeInTheDocument();

    // Force a background refetch (data already cached) that now fails.
    listGroups.mockRejectedValueOnce(new Error('refresh blip'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['groups-for-competitions'] });
    });

    // Existing cards stay on screen; the failure is NOT labelled as a
    // Load-more error and a refresh Retry is offered.
    await waitFor(() => {
      expect(screen.getByText('Group Alpha')).toBeInTheDocument();
      expect(screen.getByText('Couldn\'t refresh groups.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Couldn\'t load more groups.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('recovers from a failed background refresh via Retry', async () => {
    listGroups.mockResolvedValueOnce({ success: true, data: [GROUP_A], meta: page1Meta({ total: 1, totalPages: 1 }) });
    const client = makeClient();
    renderPage(client);
    expect(await screen.findByText('Group Alpha')).toBeInTheDocument();

    listGroups.mockRejectedValueOnce(new Error('refresh blip'));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['groups-for-competitions'] });
    });
    await waitFor(() => expect(screen.getByText('Couldn\'t refresh groups.')).toBeInTheDocument());

    // Retry succeeds and the banner clears.
    listGroups.mockResolvedValueOnce({
      success: true,
      data: [GROUP_A, GROUP_B],
      meta: page1Meta({ total: 2, totalPages: 1 }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Group Beta')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Couldn\'t refresh groups.')).not.toBeInTheDocument());
  });

  describe('pagination — Load more', () => {
    it('does not show Load more when the first page is already everything', async () => {
      listGroups.mockResolvedValue({
        success: true,
        data: [GROUP_A],
        meta: page1Meta({ total: 1, totalPages: 1 }),
      });

      renderPage();
      await screen.findByText('Group Alpha');

      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('loads a second page via Load more, appending in server order with no duplicates, then hides the button', async () => {
      listGroups.mockImplementation(async ({ page }: { page: number }) => {
        if (page === 1) {
          return {
            success: true,
            data: [GROUP_A, GROUP_B],
            meta: { page: 1, limit: 2, total: 3, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          };
        }
        return {
          success: true,
          data: [GROUP_C],
          meta: { page: 2, limit: 2, total: 3, totalPages: 2, hasNextPage: false, hasPrevPage: true },
        };
      });
      renderPage();

      expect(await screen.findByText('Group Alpha')).toBeInTheDocument();
      expect(screen.getByText('Group Beta')).toBeInTheDocument();
      expect(screen.queryByText('Group Gamma')).not.toBeInTheDocument();

      const loadMoreButton = screen.getByRole('button', { name: 'Load more' });
      fireEvent.click(loadMoreButton);

      expect(await screen.findByText('Group Gamma')).toBeInTheDocument();
      expect(listGroups).toHaveBeenCalledWith({ mine: true, limit: 20, page: 2 });

      // No duplication of the first page's groups.
      expect(screen.getAllByText('Group Alpha')).toHaveLength(1);
      expect(screen.getAllByText('Group Beta')).toHaveLength(1);
      expect(screen.getAllByText('Group Gamma')).toHaveLength(1);

      // Server order preserved: page-1 groups precede the page-2 group in
      // document order.
      const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      expect(titles).toEqual(['Group Alpha', 'Group Beta', 'Group Gamma']);

      // hasNextPage was false on page 2 — no further Load more control.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument());
    });

    it('disables Load more while the next page is in flight', async () => {
      let resolvePage2!: (v: unknown) => void;
      listGroups.mockImplementation(({ page }: { page: number }) => {
        if (page === 1) {
          return Promise.resolve({
            success: true,
            data: [GROUP_A],
            meta: { page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          });
        }
        return new Promise((resolve) => {
          resolvePage2 = resolve;
        });
      });

      renderPage();
      const loadMoreButton = await screen.findByRole('button', { name: 'Load more' });
      fireEvent.click(loadMoreButton);

      await waitFor(() => expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled());

      resolvePage2({
        success: true,
        data: [GROUP_B],
        meta: { page: 2, limit: 1, total: 2, totalPages: 2, hasNextPage: false, hasPrevPage: true },
      });

      await screen.findByText('Group Beta');
      expect(screen.queryByRole('button', { name: 'Loading…' })).not.toBeInTheDocument();
    });

    it('issues exactly one page request for two same-tick Load more activations', async () => {
      let resolvePage2!: (v: unknown) => void;
      let page2Calls = 0;
      listGroups.mockImplementation(({ page }: { page: number }) => {
        if (page === 1) {
          return Promise.resolve({
            success: true,
            data: [GROUP_A],
            meta: { page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          });
        }
        page2Calls += 1;
        return new Promise((resolve) => {
          resolvePage2 = resolve;
        });
      });

      renderPage();
      const loadMoreButton = await screen.findByRole('button', { name: 'Load more' });

      // Both clicks land in one tick, before any re-render can disable the
      // button. `cancelRefetch: false` must coalesce them into ONE page-2
      // request; without it the second activation cancels and resends.
      await act(async () => {
        fireEvent.click(loadMoreButton);
        fireEvent.click(loadMoreButton);
        await Promise.resolve();
      });

      expect(page2Calls).toBe(1);

      resolvePage2({
        success: true,
        data: [GROUP_B],
        meta: { page: 2, limit: 1, total: 2, totalPages: 2, hasNextPage: false, hasPrevPage: true },
      });
      await screen.findByText('Group Beta');
      expect(page2Calls).toBe(1);
    });

    it('issues exactly one page request for two microtask-separated Load more activations', async () => {
      let resolvePage2!: (v: unknown) => void;
      let page2Calls = 0;
      listGroups.mockImplementation(({ page }: { page: number }) => {
        if (page === 1) {
          return Promise.resolve({
            success: true,
            data: [GROUP_A],
            meta: { page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          });
        }
        page2Calls += 1;
        return new Promise((resolve) => {
          resolvePage2 = resolve;
        });
      });

      renderPage();
      const loadMoreButton = await screen.findByRole('button', { name: 'Load more' });

      await act(async () => {
        fireEvent.click(loadMoreButton);
        await Promise.resolve();
        fireEvent.click(loadMoreButton);
        await Promise.resolve();
      });

      expect(page2Calls).toBe(1);

      resolvePage2({
        success: true,
        data: [GROUP_B],
        meta: { page: 2, limit: 1, total: 2, totalPages: 2, hasNextPage: false, hasPrevPage: true },
      });
      await screen.findByText('Group Beta');
      expect(page2Calls).toBe(1);
    });

    it('omitting meta.page from responses cannot cause a repeated page 2 request', async () => {
      listGroups.mockImplementation(async ({ page }: { page: number }) => {
        if (page === 1) {
          return {
            success: true,
            data: [GROUP_A],
            // Note: no `page` field at all. hasNextPage still drives the walk.
            meta: { limit: 1, total: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          };
        }
        if (page === 2) {
          return {
            success: true,
            data: [GROUP_B],
            meta: { limit: 1, total: 3, totalPages: 3, hasNextPage: true, hasPrevPage: false },
          };
        }
        return {
          success: true,
          data: [GROUP_C],
          meta: { limit: 1, total: 3, totalPages: 3, hasNextPage: false, hasPrevPage: false },
        };
      });

      renderPage();
      expect(await screen.findByText('Group Alpha')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Group Beta')).toBeInTheDocument();
      expect(listGroups).toHaveBeenCalledWith({ mine: true, limit: 20, page: 2 });

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Group Gamma')).toBeInTheDocument();

      // The page walk advanced 1 -> 2 -> 3 instead of stalling on a repeated
      // page 2 (the pre-hardening code chunked `meta.page ?? 1`, which would
      // have re-requested page 2 here since meta.page is absent).
      const pages = listGroups.mock.calls.map((c) => (c[0] as { page: number }).page);
      expect(pages).toEqual([1, 2, 3]);
    });

    it('next-page failure keeps cards, then a labelled Retry re-requests the failed page', async () => {
      listGroups.mockImplementation(async ({ page }: { page: number }) => {
        if (page === 1) {
          return {
            success: true,
            data: [GROUP_A],
            meta: { page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          };
        }
        throw new Error('page 2 down');
      });

      renderPage();
      expect(await screen.findByText('Group Alpha')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

      expect(await screen.findByText('Couldn\'t load more groups.')).toBeInTheDocument();
      // Cards stay visible and the failure is clearly labelled as next-page.
      expect(screen.getByText('Group Alpha')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
      const retryNext = screen.getByRole('button', { name: 'Retry next page' });
      expect(retryNext).toBeInTheDocument();

      // Recovery: Retry re-requests the exact page that failed (page 2).
      listGroups.mockImplementation(async ({ page }: { page: number }) => {
        if (page === 1) {
          return {
            success: true,
            data: [GROUP_A],
            meta: { page: 1, limit: 1, total: 2, totalPages: 2, hasNextPage: true, hasPrevPage: false },
          };
        }
        return {
          success: true,
          data: [GROUP_B],
          meta: { page: 2, limit: 1, total: 2, totalPages: 2, hasNextPage: false, hasPrevPage: true },
        };
      });
      fireEvent.click(retryNext);

      expect(await screen.findByText('Group Beta')).toBeInTheDocument();
      expect(listGroups).toHaveBeenLastCalledWith({ mine: true, limit: 20, page: 2 });
      expect(screen.getAllByText('Group Alpha')).toHaveLength(1);
      const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      expect(titles).toEqual(['Group Alpha', 'Group Beta']);
      await waitFor(() => expect(screen.queryByText('Couldn\'t load more groups.')).not.toBeInTheDocument());
    });
  });
});