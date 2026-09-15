/**
 * Cross-page query-key compatibility.
 *
 * `GroupsPage` (browser) and `CompetitionsPage` (hub picker) both read
 * `GET /groups` but historically used separate hand-written query keys —
 * create and join mutations invalidate them TOGETHER via
 * `GROUP_LIST_QUERY_KEYS` from `@/lib/groups-query-keys`. If the hub page's
 * key ever drifts away from the shared invalidation list (i.e. someone
 * renames only ONE of the two), the other page silently stops refreshing
 * after create/join — this suite pins both endpoints to the same one shared
 * QueryClient and counts the refetches triggered by each mutation.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const listGroups = vi.fn();
const joinGroup = vi.fn();
const createGroup = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    listGroups: (...a: unknown[]) => listGroups(...a),
    joinGroup: (...a: unknown[]) => joinGroup(...a),
    createGroup: (...a: unknown[]) => createGroup(...a),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));

import { GroupsPage } from './groups';
import { CompetitionsPage } from './competitions';

afterEach(() => {
  cleanup();
  listGroups.mockReset();
  joinGroup.mockReset();
  createGroup.mockReset();
  toastMock.mockReset();
});

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

function renderBothPages(client: QueryClient) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  // The two routes render as siblings so BOTH observers stay active on one
  // shared client — a QueryClientProvider per page would defeat the purpose
  // of this coverage.
  return render(
    <MemoryRouter>
      <GroupsPage />
      <CompetitionsPage />
    </MemoryRouter>,
    { wrapper },
  );
}

/** Counts listGroups calls by which page they belong to. */
function listCallCounts() {
  const calls = listGroups.mock.calls as Array<[{ mine?: boolean; limit?: number; page?: number }]>;
  const hub = calls.filter(([params]) => params.mine === true && params.limit === 20).length;
  const browser = calls.filter(([params]) => params.mine === undefined && params.limit === 50).length;
  return { hub, browser };
}

/** GroupsPage shows a public group the user isn't a member of (Join CTA). */
function mockSharedLists() {
  listGroups.mockImplementation(async (params: { mine?: boolean }) => {
    if (params.mine === true) {
      return {
        success: true,
        data: [],
        meta: { page: 1, limit: 20, total: 0, totalPages: 0, hasNextPage: false, hasPrevPage: false },
      };
    }
    return {
      success: true,
      data: [{ id: 'g-join', name: 'Joinable Group', isMember: false, memberCount: 1, isPrivate: false, memberRole: null }],
    };
  });
}

describe('group-list query keys stay in sync across both pages', () => {
  it('a created group refetches BOTH the browser list and the hub picker', async () => {
    const client = makeClient();
    mockSharedLists();
    createGroup.mockResolvedValue({ success: true, data: { id: 'new' } });

    renderBothPages(client);
    // Initial loads: one request per page.
    await screen.findByText('Joinable Group');
    await screen.findByText('You are not a member of any groups yet.');
    expect(listCallCounts()).toEqual({ hub: 1, browser: 1 });

    // Open the create form, type a name (server validates length >= 2), submit.
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Brand New Group' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));

    // Wait for the create mutation to succeed and trigger invalidation.
    await waitFor(() => expect(createGroup).toHaveBeenCalledTimes(1));

    // Both lists were invalidated and refetched.
    await waitFor(() => expect(listCallCounts()).toEqual({ hub: 2, browser: 2 }));
  });

  it('a joined group refetches BOTH the browser list and the hub picker', async () => {
    const client = makeClient();
    mockSharedLists();
    joinGroup.mockResolvedValue({ success: true });

    renderBothPages(client);
    await screen.findByText('Joinable Group');
    await screen.findByText('You are not a member of any groups yet.');
    expect(listCallCounts()).toEqual({ hub: 1, browser: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(listCallCounts()).toEqual({ hub: 2, browser: 2 }));
  });
});
