import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { COMPETITIONS_HUB_GROUPS_QUERY_KEY } from '@/lib/groups-query-keys';

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

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Every `listGroups` call returns its own deferred promise, recorded in call
 * order, so a test decides exactly when — and how — each request settles.
 */
function controlListGroups() {
  const calls: Array<{ page: number; request: Deferred }> = [];
  listGroups.mockImplementation(({ page }: { page: number }) => {
    const request = deferred();
    calls.push({ page, request });
    return request.promise;
  });
  return calls;
}

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected item #${index + 1} to exist`);
  return item;
}

function listPage(page: number, data: unknown[], hasNextPage: boolean) {
  return {
    success: true,
    data,
    meta: { page, limit: 20, total: data.length, totalPages: hasNextPage ? page + 1 : page, hasNextPage, hasPrevPage: page > 1 },
  };
}

async function settle(action: () => void) {
  await act(async () => {
    action();
  });
}

function refetchHub(client: QueryClient) {
  act(() => {
    void client.refetchQueries({ queryKey: COMPETITIONS_HUB_GROUPS_QUERY_KEY });
  });
}

const viewButtons = () => screen.getAllByRole('button', { name: 'View competitions' });

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
      await client.refetchQueries({ queryKey: COMPETITIONS_HUB_GROUPS_QUERY_KEY });
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
      await client.refetchQueries({ queryKey: COMPETITIONS_HUB_GROUPS_QUERY_KEY });
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

  it('keeps the empty state and offers a refresh Retry when a background refetch of an empty hub fails', async () => {
    const calls = controlListGroups();
    const client = makeClient();
    renderPage(client);

    await settle(() => nth(calls, 0).request.resolve(listPage(1, [], false)));
    expect(await screen.findByText('You are not a member of any groups yet.')).toBeInTheDocument();

    refetchHub(client);
    await waitFor(() => expect(calls).toHaveLength(2));
    await settle(() => nth(calls, 1).request.reject(new Error('refresh blip')));

    // Not a blank heading-only page: the refresh error, its Retry, and the
    // previously rendered empty state and CTA are all present.
    expect(await screen.findByText('Couldn\'t refresh groups.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Competitions' })).toBeInTheDocument();
    expect(screen.getByText('You are not a member of any groups yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a group' })).toBeInTheDocument();
    expect(screen.queryByText('Couldn\'t load more groups.')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls).toHaveLength(3));
    // Retry refetches the query from its first page — not a next-page fetch.
    expect(nth(calls, 2).page).toBe(1);

    await settle(() => nth(calls, 2).request.resolve(listPage(1, [GROUP_A], false)));
    expect(await screen.findByText('Group Alpha')).toBeInTheDocument();
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

    it('disables Load more during a background refetch and makes it usable again afterwards', async () => {
      const calls = controlListGroups();
      const client = makeClient();
      renderPage(client);
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      expect(await screen.findByRole('button', { name: 'Load more' })).toBeEnabled();

      refetchHub(client);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled());

      // An activation during the refresh cannot start (or be absorbed into)
      // any request.
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(calls.map((c) => c.page)).toEqual([1, 1]);

      await settle(() => nth(calls, 1).request.resolve(listPage(1, [GROUP_A], true)));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());

      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(calls.map((c) => c.page)).toEqual([1, 1, 2]));
      await settle(() => nth(calls, 2).request.resolve(listPage(2, [GROUP_B], false)));
      expect(await screen.findByText('Group Beta')).toBeInTheDocument();
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

      await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
      expect(await screen.findByText('Group Gamma')).toBeInTheDocument();

      // The page walk advanced 1 -> 2 -> 3 instead of stalling on a repeated
      // page 2 (the pre-hardening code chunked `meta.page ?? 1`, which would
      // have re-requested page 2 here since meta.page is absent).
      const pages = listGroups.mock.calls.map((c) => (c[0] as { page: number }).page);
      expect(pages).toEqual([1, 2, 3]);
    });

    it('next-page failure keeps cards, is classified as next-page only, then a labelled Retry re-requests the failed page', async () => {
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
      // Cards stay visible.
      expect(screen.getByText('Group Alpha')).toBeInTheDocument();
      // Classified as a next-page failure ONLY: no refresh banner, a single
      // alert, and the next-page Retry is the only recovery control.
      expect(screen.queryByText('Couldn\'t refresh groups.')).not.toBeInTheDocument();
      expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(['Couldn\'t load more groups.']);
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
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

    it('issues exactly one request for the failed page for two same-tick Retry next page activations', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(calls).toHaveLength(2));
      await settle(() => nth(calls, 1).request.reject(new Error('page 2 down')));
      const retryNext = await screen.findByRole('button', { name: 'Retry next page' });

      // Both activations land before any re-render could disable Retry; a
      // Retry without `cancelRefetch: false` would cancel and re-send page 2.
      await act(async () => {
        fireEvent.click(retryNext);
        fireEvent.click(retryNext);
        await Promise.resolve();
      });
      expect(calls.slice(2).map((c) => c.page)).toEqual([2]);

      await settle(() => nth(calls, 2).request.resolve(listPage(2, [GROUP_B], false)));
      expect(await screen.findByText('Group Beta')).toBeInTheDocument();
      expect(calls.slice(2).map((c) => c.page)).toEqual([2]);
    });
  });

  describe('keyboard focus through Load more and Retry transitions', () => {
    it('moves focus to "Retry next page" when the focused Load more request fails', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      expect(document.activeElement).toBe(loadMore);

      fireEvent.click(loadMore);
      await waitFor(() => expect(loadMore).toBeDisabled());
      expect(loadMore).toHaveTextContent('Loading…');
      expect(screen.getByRole('status')).toHaveTextContent('Loading more groups…');
      await waitFor(() => expect(calls).toHaveLength(2));

      await settle(() => nth(calls, 1).request.reject(new Error('page 2 down')));

      const retryNext = await screen.findByRole('button', { name: 'Retry next page' });
      expect(loadMore.isConnected).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(retryNext));
      expect(document.activeElement).not.toBe(document.body);
      expect(screen.getByRole('alert')).toHaveTextContent('Couldn\'t load more groups.');
    });

    it('moves focus to the first newly added group when Load more fetches the final page', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      fireEvent.click(loadMore);
      await waitFor(() => expect(loadMore).toBeDisabled());
      expect(screen.getByRole('status')).toHaveTextContent('Loading more groups…');
      await waitFor(() => expect(calls).toHaveLength(2));

      await settle(() => nth(calls, 1).request.resolve(listPage(2, [GROUP_B, GROUP_C], false)));

      await screen.findByText('Group Gamma');
      expect(loadMore.isConnected).toBe(false);
      expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
        'Group Alpha',
        'Group Beta',
        'Group Gamma',
      ]);
      // Page 1 held one group, so the first newly added card is the second.
      const firstNewGroupAction = nth(viewButtons(), 1);
      await waitFor(() => expect(document.activeElement).toBe(firstNewGroupAction));
      expect(document.activeElement).not.toBe(document.body);
      // The footer's live region stayed mounted to announce completion.
      expect(screen.getByRole('status')).toHaveTextContent('All 3 groups loaded.');
    });

    it('moves focus from a successful final-page Retry to the first newly added group', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      fireEvent.click(loadMore);
      await waitFor(() => expect(calls).toHaveLength(2));
      await settle(() => nth(calls, 1).request.reject(new Error('page 2 down')));

      const retryNext = await screen.findByRole('button', { name: 'Retry next page' });
      await waitFor(() => expect(document.activeElement).toBe(retryNext));

      fireEvent.click(retryNext);
      await waitFor(() => expect(retryNext).toBeDisabled());
      expect(retryNext).toHaveTextContent('Retrying…');
      await waitFor(() => expect(calls).toHaveLength(3));
      expect(nth(calls, 2).page).toBe(2);

      await settle(() => nth(calls, 2).request.resolve(listPage(2, [GROUP_B], false)));

      await screen.findByText('Group Beta');
      expect(retryNext.isConnected).toBe(false);
      const firstNewGroupAction = nth(viewButtons(), 1);
      await waitFor(() => expect(document.activeElement).toBe(firstNewGroupAction));
      expect(document.activeElement).not.toBe(document.body);
      expect(screen.queryByText('Couldn\'t load more groups.')).not.toBeInTheDocument();
    });

    it('keeps focus on the still-mounted Load more after a mid-list page loads', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      fireEvent.click(loadMore);
      await waitFor(() => expect(calls).toHaveLength(2));
      await settle(() => nth(calls, 1).request.resolve(listPage(2, [GROUP_B], true)));

      await screen.findByText('Group Beta');
      await waitFor(() => expect(loadMore).toBeEnabled());
      expect(loadMore.isConnected).toBe(true);
      expect(loadMore).toHaveTextContent('Load more');
      expect(document.activeElement).toBe(loadMore);
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Showing 2 groups.'));
    });

    it('does not pull focus back if the user moved elsewhere before the page settled', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      fireEvent.click(loadMore);
      await waitFor(() => expect(calls).toHaveLength(2));

      const alphaAction = nth(viewButtons(), 0);
      alphaAction.focus();

      await settle(() => nth(calls, 1).request.resolve(listPage(2, [GROUP_B], false)));
      await screen.findByText('Group Beta');
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('All 2 groups loaded.'));
      expect(document.activeElement).toBe(alphaAction);
    });

    it('never moves focus for programmatic background refetches, successful or failed', async () => {
      const calls = controlListGroups();
      const client = makeClient();
      renderPage(client);
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], true)));

      // A completed user-initiated final page first, so any stale focus
      // intent would be exposed by the refetches below.
      const loadMore = await screen.findByRole('button', { name: 'Load more' });
      loadMore.focus();
      fireEvent.click(loadMore);
      await waitFor(() => expect(calls).toHaveLength(2));
      await settle(() => nth(calls, 1).request.resolve(listPage(2, [GROUP_B], false)));
      await waitFor(() => expect(document.activeElement).toBe(nth(viewButtons(), 1)));

      const alphaAction = nth(viewButtons(), 0);
      alphaAction.focus();

      // Successful refetch that changes the list (pages are re-requested in order).
      refetchHub(client);
      await waitFor(() => expect(calls).toHaveLength(3));
      await settle(() => nth(calls, 2).request.resolve(listPage(1, [GROUP_A, GROUP_C], true)));
      await waitFor(() => expect(calls).toHaveLength(4));
      await settle(() => nth(calls, 3).request.resolve(listPage(2, [GROUP_B], false)));
      expect(await screen.findByText('Group Gamma')).toBeInTheDocument();
      expect(document.activeElement).toBe(alphaAction);

      // Failed refetch.
      refetchHub(client);
      await waitFor(() => expect(calls).toHaveLength(5));
      await settle(() => nth(calls, 4).request.reject(new Error('refresh blip')));
      expect(await screen.findByText('Couldn\'t refresh groups.')).toBeInTheDocument();
      expect(document.activeElement).toBe(alphaAction);

      // With nothing focused at all, a later successful refetch must still
      // not grab focus on behalf of the earlier, already-settled Load more.
      alphaAction.blur();
      expect(document.activeElement).toBe(document.body);
      refetchHub(client);
      await waitFor(() => expect(calls).toHaveLength(6));
      await settle(() => nth(calls, 5).request.resolve(listPage(1, [GROUP_A, GROUP_C], true)));
      await waitFor(() => expect(calls).toHaveLength(7));
      await settle(() => nth(calls, 6).request.resolve(listPage(2, [GROUP_B], false)));
      await waitFor(() => expect(screen.queryByText('Couldn\'t refresh groups.')).not.toBeInTheDocument());
      expect(document.activeElement).toBe(document.body);
    });

    it('moves focus from the initial-load Retry to the first group once that retry succeeds', async () => {
      const calls = controlListGroups();
      renderPage();
      await settle(() => nth(calls, 0).request.reject(new Error('network down')));

      const retry = await screen.findByRole('button', { name: 'Retry' });
      retry.focus();
      fireEvent.click(retry);
      await waitFor(() => expect(calls).toHaveLength(2));
      await settle(() => nth(calls, 1).request.resolve(listPage(1, [GROUP_A], false)));

      const action = await screen.findByRole('button', { name: 'View competitions' });
      expect(retry.isConnected).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(action));
    });

    it('moves focus from a successful refresh Retry to the first group when the banner closes', async () => {
      const calls = controlListGroups();
      const client = makeClient();
      renderPage(client);
      await settle(() => nth(calls, 0).request.resolve(listPage(1, [GROUP_A], false)));
      await screen.findByText('Group Alpha');

      refetchHub(client);
      await waitFor(() => expect(calls).toHaveLength(2));
      await settle(() => nth(calls, 1).request.reject(new Error('refresh blip')));

      const retry = await screen.findByRole('button', { name: 'Retry' });
      retry.focus();
      fireEvent.click(retry);
      await waitFor(() => expect(calls).toHaveLength(3));
      await settle(() => nth(calls, 2).request.resolve(listPage(1, [GROUP_A], false)));

      await waitFor(() => expect(screen.queryByText('Couldn\'t refresh groups.')).not.toBeInTheDocument());
      expect(retry.isConnected).toBe(false);
      await waitFor(() => expect(document.activeElement).toBe(nth(viewButtons(), 0)));
    });
  });
});
