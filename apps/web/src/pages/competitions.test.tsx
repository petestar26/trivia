import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const apiGet = vi.fn();

vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a) },
}));

import { CompetitionsPage } from './competitions';

afterEach(() => {
  cleanup();
  apiGet.mockReset();
});

/** Marker rendered at /groups so a navigate() there is observable. */
function GroupsRouteMarker() {
  return <div data-testid="groups-marker">groups page</div>;
}

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
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

describe('CompetitionsPage', () => {
  it('lists only groups the user is an active member of', async () => {
    apiGet.mockResolvedValue({
      success: true,
      data: [
        { id: 'g1', name: 'My Group', isMember: true, memberCount: 3, memberRole: 'OWNER' },
        { id: 'g2', name: 'Not My Group', isMember: false, memberCount: 10 },
      ],
    });

    renderPage();

    expect(await screen.findByText('My Group')).toBeInTheDocument();
    expect(screen.queryByText('Not My Group')).not.toBeInTheDocument();
  });

  it('shows a Create a group CTA linking to /groups when the user belongs to no groups', async () => {
    apiGet.mockResolvedValue({ success: true, data: [] });

    renderPage();

    expect(await screen.findByText('You are not a member of any groups yet.')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Create a group' });
    expect(cta).toBeInTheDocument();

    fireEvent.click(cta);

    expect(await screen.findByTestId('groups-marker')).toBeInTheDocument();
  });

  it('also treats a response where no group is an active membership as the empty state', async () => {
    apiGet.mockResolvedValue({
      success: true,
      data: [{ id: 'g2', name: 'Not My Group', isMember: false, memberCount: 10 }],
    });

    renderPage();

    expect(await screen.findByText('You are not a member of any groups yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a group' })).toBeInTheDocument();
  });

  it('does not show the empty-state CTA once the user has at least one group', async () => {
    apiGet.mockResolvedValue({
      success: true,
      data: [{ id: 'g1', name: 'My Group', isMember: true, memberCount: 1, memberRole: 'OWNER' }],
    });

    renderPage();

    expect(await screen.findByText('My Group')).toBeInTheDocument();
    expect(screen.queryByText('You are not a member of any groups yet.')).not.toBeInTheDocument();
  });
});
