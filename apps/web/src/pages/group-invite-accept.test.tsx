import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { GroupInviteAcceptPage } from './group-invite-accept';

vi.mock('@/lib/api', () => ({
  api: {
    resolveGroupInvite: vi.fn(),
    acceptGroupInvite: vi.fn(),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { api } from '@/lib/api';

const mocked = api as unknown as {
  resolveGroupInvite: ReturnType<typeof vi.fn>;
  acceptGroupInvite: ReturnType<typeof vi.fn>;
};

function renderPage(token: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/groups/invite/${token}`]}>
        <Routes>
          <Route path="/groups/invite/:token" element={<GroupInviteAcceptPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('GroupInviteAcceptPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mocked.resolveGroupInvite.mockResolvedValue({
      data: { id: 'inv-1', group: { id: 'g-1', name: 'Book Club', isPrivate: true }, status: 'PENDING', expiresAt: '' },
    });
    mocked.acceptGroupInvite.mockResolvedValue({ success: true, data: { message: 'Invite accepted' } });
  });

  it('renders the group invitation and an Accept button', async () => {
    renderPage('tok-1');
    expect(await screen.findByText('Book Club')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept invite' })).toBeInTheDocument();
  });

  it('accepts the invite when the button is pressed', async () => {
    renderPage('tok-2');
    await screen.findByText('Book Club');
    fireEvent.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(mocked.acceptGroupInvite).toHaveBeenCalledWith('tok-2'));
  });

  it('shows an error state for an invalid token', async () => {
    mocked.resolveGroupInvite.mockRejectedValue(new Error('{"message":"Invalid invite token"}'));
    renderPage('tok-bad');
    expect(await screen.findByText('Invalid or unrecognized invite link.')).toBeInTheDocument();
  });

  it('reflects terminal statuses without an Accept button', async () => {
    mocked.resolveGroupInvite.mockResolvedValue({
      data: { id: 'inv-3', group: { id: 'g-1', name: 'Book Club', isPrivate: true }, status: 'EXPIRED', expiresAt: '' },
    });
    renderPage('tok-3');
    expect(await screen.findByText(/has expired/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invite' })).not.toBeInTheDocument();
  });
});