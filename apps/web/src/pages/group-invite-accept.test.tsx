import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupInviteAcceptPage } from './group-invite-accept';

vi.mock('@/lib/api', () => ({
  api: {
    resolveGroupInvite: vi.fn(),
    acceptGroupInvite: vi.fn(),
  },
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: (...args: unknown[]) => toastMock(...args) }),
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
          <Route path="/groups" element={<div>Groups list</div>} />
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
    mocked.resolveGroupInvite.mockRejectedValue(new Error('{"status":404,"code":"NOT_FOUND","message":"Invalid invite token"}'));
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

  describe('accessibility', () => {
    const apiError = (status: number, message: string) => new Error(JSON.stringify({ status, code: 'X', message }));
    const pendingInvite = { data: { id: 'inv-1', group: { id: 'g-1', name: 'Book Club', isPrivate: true }, status: 'PENDING', expiresAt: '' } };

    it('announces loading as a status, not a bare spinner', async () => {
      mocked.resolveGroupInvite.mockReturnValue(new Promise(() => {}));
      renderPage('tok-load');
      const status = await screen.findByRole('status');
      expect(status).toHaveTextContent('Loading invitation…');
      expect(status).toHaveAttribute('aria-busy', 'true');
      // The decorative spinner is hidden from assistive technology.
      expect(status.querySelector('.animate-spin')).toHaveAttribute('aria-hidden', 'true');
    });

    it('an unknown link is a role=alert message with a way out — and offers no pointless retry', async () => {
      mocked.resolveGroupInvite.mockRejectedValue(apiError(404, 'Invalid invite token'));
      renderPage('tok-bad');
      expect(await screen.findByRole('alert')).toHaveTextContent('Invalid or unrecognized invite link.');
      expect(screen.getByText(/ask the person who invited you/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back to groups' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Back to groups' }));
      expect(await screen.findByText('Groups list')).toBeInTheDocument();
    });

    it('a network/server failure is a different alert, with Try again — not "invalid link"', async () => {
      mocked.resolveGroupInvite.mockRejectedValue(new TypeError('Failed to fetch'));
      renderPage('tok-net');
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this invitation.");
      expect(screen.queryByText(/Invalid or unrecognized/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Back to groups' })).toBeInTheDocument();
    });

    it('a 500 is retryable too', async () => {
      mocked.resolveGroupInvite.mockRejectedValue(apiError(500, 'boom'));
      renderPage('tok-500');
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this invitation.");
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('Try again keeps the failure view — and focus — while it runs, then lands focus on the invitation heading', async () => {
      mocked.resolveGroupInvite.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      renderPage('tok-retry');
      const retry = await screen.findByRole('button', { name: 'Try again' });

      let release!: () => void;
      mocked.resolveGroupInvite.mockImplementation(
        () => new Promise((resolve) => { release = () => resolve(pendingInvite); })
      );
      retry.focus();
      await user.keyboard('{Enter}');

      await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'true'));
      expect(retry).toBeInTheDocument();
      expect(retry).toHaveFocus();
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveTextContent('Retrying…');
      // No swap to the loading status under the user's focus.
      expect(screen.queryByText('Loading invitation…')).not.toBeInTheDocument();
      // Pressing it again while it runs asks for nothing more.
      const callsBefore = mocked.resolveGroupInvite.mock.calls.length;
      await user.keyboard('{Enter}');
      expect(mocked.resolveGroupInvite.mock.calls.length).toBe(callsBefore);

      act(() => release());
      expect(await screen.findByText('Book Club')).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Group invitation' })).toHaveFocus());
    });

    it('a Try again that fails again stays on the alert with the button, still focused', async () => {
      mocked.resolveGroupInvite.mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      renderPage('tok-retry2');
      const retry = await screen.findByRole('button', { name: 'Try again' });
      retry.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(mocked.resolveGroupInvite.mock.calls.length).toBe(2));
      await waitFor(() => expect(retry).not.toHaveAttribute('aria-disabled'));
      expect(retry).toHaveTextContent('Try again');
      expect(retry).toHaveFocus();
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this invitation.");
    });

    it.each([
      ['EXPIRED', /has expired/, true],
      ['REVOKED', /has been revoked/, true],
      ['ACCEPTED', /already been accepted/, false],
    ])('%s: says so, offers no Accept, and %s a way forward', async (status, message, hasHint) => {
      mocked.resolveGroupInvite.mockResolvedValue({ data: { ...pendingInvite.data, status } });
      renderPage('tok-term');
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Accept invite' })).not.toBeInTheDocument();
      expect(Boolean(screen.queryByText(/send you a new one/))).toBe(hasHint);
    });

    describe('accepting', () => {
      it('a failure stays on the page as a role=alert (the toast is only an echo) and Accept remains usable', async () => {
        mocked.resolveGroupInvite.mockResolvedValue(pendingInvite);
        mocked.acceptGroupInvite.mockRejectedValueOnce(apiError(403, 'You must have a verified email to accept invites'));
        const user = userEvent.setup();
        renderPage('tok-403');
        const accept = await screen.findByRole('button', { name: 'Accept invite' });
        accept.focus();
        await user.keyboard('{Enter}');

        expect(await screen.findByRole('alert')).toHaveTextContent('You must have a verified email to accept invites');
        expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ description: 'You must have a verified email to accept invites' }));
        // Same button, same focus, ready to try again.
        expect(screen.getByRole('button', { name: 'Accept invite' })).toBe(accept);
        expect(accept).toHaveFocus();
        expect(accept).not.toHaveAttribute('aria-disabled');

        mocked.acceptGroupInvite.mockResolvedValueOnce({ success: true, data: { message: 'Invite accepted', groupId: 'g-1' } });
        await user.keyboard('{Enter}');
        expect(await screen.findByText('Groups list')).toBeInTheDocument();
      });

      it("a failure that means the invite changed (it was revoked) refreshes the page to its new state", async () => {
        mocked.resolveGroupInvite.mockResolvedValueOnce(pendingInvite);
        mocked.acceptGroupInvite.mockRejectedValueOnce(apiError(409, 'This invite has been revoked'));
        renderPage('tok-rev');
        fireEvent.click(await screen.findByRole('button', { name: 'Accept invite' }));

        mocked.resolveGroupInvite.mockResolvedValue({ data: { ...pendingInvite.data, status: 'REVOKED' } });
        // The reason is announced and stays — it does not vanish with the Accept
        // button when the page switches to its terminal state...
        expect(await screen.findByRole('alert')).toHaveTextContent('This invite has been revoked');
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Accept invite' })).not.toBeInTheDocument());
        expect(screen.getByRole('alert')).toHaveTextContent('This invite has been revoked');
        expect(screen.getByText(/send you a new one/)).toBeInTheDocument();
        // ...and is not said a second time as a paragraph.
        expect(screen.getAllByText(/has been revoked/)).toHaveLength(1);
      });

      it('while pending the button is aria-disabled — never native disabled — and keeps focus', async () => {
        mocked.resolveGroupInvite.mockResolvedValue(pendingInvite);
        let settle!: () => void;
        mocked.acceptGroupInvite.mockImplementation(() => new Promise((resolve) => { settle = () => resolve({ success: true, data: {} }); }));
        const user = userEvent.setup();
        renderPage('tok-pending');
        const accept = await screen.findByRole('button', { name: 'Accept invite' });
        accept.focus();
        await user.keyboard('{Enter}');

        await waitFor(() => expect(accept).toHaveAttribute('aria-disabled', 'true'));
        expect(accept).not.toBeDisabled();
        expect(accept).toHaveFocus();
        expect(accept).toHaveTextContent('Accepting…');
        await user.keyboard('{Enter}');
        expect(mocked.acceptGroupInvite).toHaveBeenCalledTimes(1);
        act(() => settle());
        expect(await screen.findByText('Groups list')).toBeInTheDocument();
      });

      it('two same-tick activations send ONE accept request (no spurious "already accepted")', async () => {
        mocked.resolveGroupInvite.mockResolvedValue(pendingInvite);
        renderPage('tok-double');
        const accept = await screen.findByRole('button', { name: 'Accept invite' });
        act(() => {
          accept.click();
          accept.click();
        });
        await screen.findByText('Groups list');
        expect(mocked.acceptGroupInvite).toHaveBeenCalledTimes(1);
      });
    });
  });
});
