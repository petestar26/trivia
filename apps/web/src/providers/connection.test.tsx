import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { SocketProvider } from './socket-provider';
import { AuthProvider, useAuth } from './auth-provider';
import { VoiceMessagePlayer } from '../components/voice/voice-message-player';

vi.mock('@/lib/api-config', () => ({
  API_ORIGIN: 'https://api.example.com',
  API_BASE: 'https://api.example.com/api/v1',
}));
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ on: vi.fn(), disconnect: vi.fn() })),
}));

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => apiGet(...a), post: (...a: unknown[]) => apiPost(...a) },
  voiceMessageUrl: (groupId: string, messageId: string) =>
    `https://api.example.com/api/v1/groups/${groupId}/voice-messages/${messageId}`,
}));

// Auth context access so a test can drive identity transitions.
const authStore = { current: null as ReturnType<typeof useAuth> | null };
function AuthProbe() {
  const auth = useAuth();
  authStore.current = auth;
  return null;
}

const testUser = (id: string) => ({
  id,
  username: id,
  displayName: id,
  email: `${id}@example.com`,
  isVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
});

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  vi.mocked(io).mockClear();
  authStore.current = null;
});

function renderSocketStack() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <SocketProvider>
          <AuthProbe />
        </SocketProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return client;
}

it('connects Socket.IO to the API origin with credentials and the root /ws path', async () => {
  apiGet.mockResolvedValue({ success: true, data: { user: testUser('u1') } });
  renderSocketStack();

  await waitFor(() => expect(io).toHaveBeenCalledTimes(1));
  expect(io).toHaveBeenCalledWith('https://api.example.com', expect.objectContaining({
    path: '/ws', withCredentials: true,
  }));
});

// A direct authenticated A → B identity transition must tear down the old
// socket and create a fresh lifecycle for B. This relies on the AuthProvider
// boundary remounting its child subtree (which includes SocketProvider).
it('identity A → B: old socket disconnects and a new socket is created', async () => {
  apiGet.mockResolvedValue({ success: true, data: { user: testUser('a') } });
  const socketA = { on: vi.fn(), disconnect: vi.fn() } as unknown as Socket;
  const socketB = { on: vi.fn(), disconnect: vi.fn() } as unknown as Socket;
  vi.mocked(io).mockReturnValueOnce(socketA).mockReturnValueOnce(socketB);

  renderSocketStack();
  await waitFor(() => expect(io).toHaveBeenCalledTimes(1)); // socket A created

  apiPost.mockResolvedValue({ success: true, data: { user: testUser('b') } });
  await act(async () => { await authStore.current!.login('b@example.com', 'pass'); });

  // A new socket lifecycle ran for B and the old one was cleaned up.
  expect(io).toHaveBeenCalledTimes(2);
  expect(socketA.disconnect).toHaveBeenCalled();
});

// A same-user profile refresh must NOT remount the subtree, so the socket
// connection stays up exactly as it was (no teardown, no replacement).
it('same-user refresh does not reconnect the socket', async () => {
  apiGet.mockResolvedValue({ success: true, data: { user: testUser('a') } });
  const socketA = { on: vi.fn(), disconnect: vi.fn() } as unknown as Socket;
  vi.mocked(io).mockReturnValueOnce(socketA);

  renderSocketStack();
  await waitFor(() => expect(io).toHaveBeenCalledTimes(1));

  apiGet.mockResolvedValueOnce({ success: true, data: { user: testUser('a') } });
  await act(async () => { await authStore.current!.refreshUser(); });

  expect(io).toHaveBeenCalledTimes(1);               // no new socket
  expect(socketA.disconnect).not.toHaveBeenCalled(); // connection preserved
});

it('loads authenticated voice messages from the API with CORS credentials', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  const { container } = render(<VoiceMessagePlayer groupId="group" messageId="message" />);
  const audio = container.querySelector('audio');
  expect(audio).toHaveAttribute('src', 'https://api.example.com/api/v1/groups/group/voice-messages/message');
  expect(audio).toHaveAttribute('crossorigin', 'use-credentials');
});