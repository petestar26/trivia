import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const listGroups = vi.fn();

vi.mock('@/lib/api', () => ({ api: { listGroups: (...a: unknown[]) => listGroups(...a), joinGroup: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { GroupsPage } from './groups';

afterEach(() => {
  cleanup();
  listGroups.mockReset();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
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
