import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const getGroupMessages = vi.fn();
const post = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    getGroupMessages: (...a: unknown[]) => getGroupMessages(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));
// A no-op socket: the page's room join/leave and realtime listeners must keep
// working, but this test is about render correctness, not transport.
vi.mock('@/providers/socket-provider', () => ({
  useSocket: () => ({ socket: null, isConnected: false }),
}));

import { MessagesPage } from './messages';

// jsdom does not implement scrollIntoView (same reason setup.ts stubs
// matchMedia/localStorage). The page's auto-scroll effect calls it on every
// message change; without this the effect throws and masks what we're testing.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  getGroupMessages.mockReset();
  post.mockReset();
});

function renderAtGroup(groupId = 'group-1', client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/messages/${groupId}`]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <Routes>
      <Route path="/messages/:groupId" element={<MessagesPage />} />
    </Routes>,
    { wrapper },
  );
}

describe('MessagesPage', () => {
  // Regression, two defects at once:
  //  1. `useMutation` used to sit *after* the !groupId / isLoading / isError
  //     early returns, so the loading render skipped it and the loaded render
  //     called it. The hook count changed between renders and React threw
  //     error #310 ("Rendered more hooks than during the previous render"),
  //     crashing the page to a blank screen.
  //  2. The query already resolves to the message array, but the page then
  //     unwrapped `.data` off it again — so even without the crash the list
  //     would have rendered permanently empty.
  // Resolving asynchronously is essential: it forces the real
  // loading -> loaded transition that triggered the hook-order crash.
  it('survives the loading -> loaded transition and renders messages', async () => {
    getGroupMessages.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                success: true,
                data: [
                  {
                    id: 'msg-1',
                    content: 'staging smoke test message',
                    createdAt: new Date('2026-09-07T06:00:00Z').toISOString(),
                    sender: { displayName: 'Staging Smoke Test', username: 'sp_smoketest' },
                  },
                ],
              }),
            0,
          ),
        ),
    );

    renderAtGroup();

    // Loaded render: content present, no crash, and the composer is usable.
    expect(await screen.findByText('staging smoke test message')).toBeInTheDocument();
    expect(screen.getByText('Staging Smoke Test')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet. Start the conversation!')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type a message…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('shows the empty state when the group genuinely has no messages', async () => {
    getGroupMessages.mockResolvedValue({ success: true, data: [] });

    renderAtGroup();

    expect(await screen.findByText('No messages yet. Start the conversation!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('surfaces the error state without crashing', async () => {
    getGroupMessages.mockRejectedValue(new Error('forbidden'));

    renderAtGroup();

    expect(await screen.findByText(/Failed to load messages/)).toBeInTheDocument();
  });
});

describe('MessagesPage — send progression invalidation', () => {
  it('invalidates progression caches on successful message send, preserving the messages refresh', async () => {
    getGroupMessages.mockResolvedValue({ success: true, data: [] });
    post.mockResolvedValue({ success: true });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderAtGroup('group-1', client);

    await screen.findByRole('button', { name: 'Send' });
    fireEvent.change(screen.getByPlaceholderText('Type a message…'), { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['messages', 'group-1'] }))
    );
    // invalidateProgressionQueries effects.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }))
    );
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
  });

  it('does NOT invalidate progression caches when the send fails', async () => {
    getGroupMessages.mockResolvedValue({ success: true, data: [] });
    post.mockRejectedValue(new Error('fail'));

    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    renderAtGroup('group-1', client);

    await screen.findByRole('button', { name: 'Send' });
    fireEvent.change(screen.getByPlaceholderText('Type a message…'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // onSuccess never runs, so neither the messages refresh nor any
    // progression surface is invalidated.
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['messages', 'group-1'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['achievements'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['progress'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['tasks'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet'] }));
    expect(invalidateSpy).not.toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['wallet-transactions'] }));
  });
});
