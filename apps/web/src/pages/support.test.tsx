import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { SupportPage } from './support';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/providers/auth-provider', () => ({ useAuth: () => ({ user: { id: 'member' } }) }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  api: mocks,
}));
const ok = (data: unknown) => ({ success: true, data });
const ticket = {
  id: 'id',
  subject: 'A game problem',
  category: 'GAME',
  status: 'OPEN',
  last_sender: 'USER',
  updated_at: '2026-11-05T12:00:00Z',
};
function mount(admin = false) {
  render(
    <MemoryRouter>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
          })
        }
      >
        <SupportPage admin={admin} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}
beforeEach(() => {
  mocks.get.mockImplementation(async (path: string) =>
    ok(
      path === '/support/help'
        ? {
            aiEnabled: false,
            articles: [
              {
                id: 'wallet',
                title: 'Deposits and withdrawals',
                body: 'Open Wallet.',
                href: '/wallet',
              },
            ],
          }
        : path.includes('/tickets/id')
          ? {
              ticket,
              messages: [
                {
                  id: 'message',
                  body: 'Please help.',
                  staff: false,
                  created_at: '2026-11-05T12:00:00Z',
                },
              ],
              hasMore: false,
            }
          : { tickets: [ticket], hasMore: false }
    )
  );
  mocks.post.mockResolvedValue(ok({ id: 'id' }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it('offers human support and guides without pretending unconfigured AI is active', async () => {
  mount();
  await screen.findByText('Deposits and withdrawals');
  expect(screen.getByText(/AI assistance is unavailable/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ask assistant' })).toBeNull();
  expect(mocks.post).not.toHaveBeenCalled();
});
it('creates a request and opens its conversation after server confirmation', async () => {
  mount();
  fireEvent.click((await screen.findAllByRole('button', { name: 'Contact support' }))[0]);
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'A game problem' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Please help.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      '/support/tickets',
      expect.objectContaining({
        subject: 'A game problem',
        body: 'Please help.',
        requestId: expect.any(String),
      })
    )
  );
  await screen.findByText('Please help.');
  expect(screen.getByLabelText('Reply')).toBeInTheDocument();
});
it('retries an unconfirmed create with the exact original id and body', async () => {
  mocks.post.mockRejectedValueOnce(Error('Network lost'));
  mount();
  fireEvent.click((await screen.findAllByRole('button', { name: 'Contact support' }))[0]);
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'A game problem' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Please help.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Message')).toBeDisabled();
  const first = mocks.post.mock.calls[0];
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  expect(mocks.post.mock.calls[1]).toEqual(first);
});
it('allows correcting a rejected submission instead of trapping the user in retry', async () => {
  mocks.post.mockRejectedValueOnce(
    Error(JSON.stringify({ status: 409, message: 'You have 10 open requests.' }))
  );
  mount();
  fireEvent.click((await screen.findAllByRole('button', { name: 'Contact support' }))[0]);
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'A game problem' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Please help.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('You have 10 open requests.');
  expect(screen.getByLabelText('Message')).toBeEnabled();
});
it('uses the admin endpoint for replies and shows messages as text', async () => {
  mount(true);
  fireEvent.click(await screen.findByRole('button', { name: /A game problem/ }));
  await screen.findByText('Please help.');
  fireEvent.change(screen.getByLabelText('Reply'), {
    target: { value: '<script>text only</script>' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(mocks.post).toHaveBeenCalledWith(
      '/support/admin/tickets/id/messages',
      expect.objectContaining({ body: '<script>text only</script>' })
    )
  );
});
