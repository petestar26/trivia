import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const listGroups = vi.fn();
const joinGroup = vi.fn();
const toastMock = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { listGroups: (...a: unknown[]) => listGroups(...a), joinGroup: (...a: unknown[]) => joinGroup(...a) },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: (...a: unknown[]) => toastMock(...a) }) }));

import { GroupsPage } from './groups';

afterEach(() => {
  cleanup();
  listGroups.mockReset();
  joinGroup.mockReset();
  toastMock.mockReset();
});

function renderPage(client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(<GroupsPage />, { wrapper });
}

describe('GroupsPage', () => {
  // Regression: `api.listGroups()` returns ApiResponse, so `.data` in the
  // queryFn already yields the array. The page then unwrapped `.data` a second
  // time off that array, which is always `undefined` — so every group list
  // rendered as "No groups found." regardless of what the API returned.
  it('renders groups returned by the API instead of the empty state', async () => {
    listGroups.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'group-1',
          name: 'Smoke Group',
          description: 'Disposable staging smoke-test group',
          memberCount: 1,
          isMember: true,
          memberRole: 'OWNER',
          isPrivate: false,
        },
      ],
    });

    renderPage();

    expect(await screen.findByText('Smoke Group')).toBeInTheDocument();
    expect(screen.queryByText('No groups found.')).not.toBeInTheDocument();
    // A group the user already belongs to offers Open (not Join).
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    expect(screen.getByText(/1 member/)).toBeInTheDocument();
  });

  it('offers Join for a public group the user is not a member of', async () => {
    listGroups.mockResolvedValue({
      success: true,
      data: [{ id: 'group-2', name: 'Open Group', memberCount: 4, isMember: false, isPrivate: false }],
    });

    renderPage();

    expect(await screen.findByText('Open Group')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('still shows the empty state when the API genuinely returns no groups', async () => {
    listGroups.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByText('No groups found.')).toBeInTheDocument();
  });
});

describe('GroupsPage — join progression invalidation', () => {
  const OPEN_GROUP = { id: 'group-2', name: 'Open Group', memberCount: 4, isMember: false, isPrivate: false };

  it('invalidates progression caches on successful join, preserving the groups refresh', async () => {
    listGroups.mockResolvedValue({ success: true, data: [OPEN_GROUP] });
    joinGroup.mockResolvedValue({ success: true });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);

    const joinButton = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(joinButton);

    await waitFor(() => expect(joinGroup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['groups'] }))
    );
    // invalidateProgressionQueries effects.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }))
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
    expect(toastMock).toHaveBeenCalledWith({ title: 'Joined group' });
  });

  it('does NOT invalidate progression caches when the join fails', async () => {
    listGroups.mockResolvedValue({ success: true, data: [OPEN_GROUP] });
    joinGroup.mockRejectedValue(new Error(JSON.stringify({ status: 500, message: 'boom' })));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderPage(client);

    const joinButton = await screen.findByRole('button', { name: 'Join' });
    fireEvent.click(joinButton);

    await waitFor(() => expect(joinGroup).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith({ title: 'Error', description: 'boom', variant: 'destructive' })
    );

    // Neither the groups refresh nor any progression surface is invalidated.
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['groups'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
  });
});
