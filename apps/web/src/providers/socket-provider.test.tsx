import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => void>,
  renew: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (event: string, handler: any) => {
      m.handlers[event] = handler;
    },
    connect: m.connect,
    disconnect: m.disconnect,
    removeAllListeners: m.remove,
  }),
}));
vi.mock('./auth-provider', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('@/lib/session', () => ({
  renewSession: m.renew,
  sessionRevision: () => 'same-user-revision',
}));
import { SocketProvider, useSocket } from './socket-provider';
function Status() {
  return <span>{useSocket().isConnected ? 'Connected' : 'Disconnected'}</span>;
}
beforeEach(() => {
  vi.resetAllMocks();
  m.handlers = {};
  m.renew.mockResolvedValue(undefined);
});
afterEach(cleanup);
it('renews cookie authentication once and reconnects after server expiry', async () => {
  render(
    <SocketProvider>
      <Status />
    </SocketProvider>
  );
  act(() => m.handlers.connect());
  expect(screen.getByText('Connected')).toBeInTheDocument();
  act(() => m.handlers.disconnect('io server disconnect'));
  await waitFor(() => expect(m.connect).toHaveBeenCalledOnce());
  expect(m.renew).toHaveBeenCalledWith(expect.any(String), 'same-user-revision');
  expect(screen.getByText('Disconnected')).toBeInTheDocument();
  act(() => m.handlers.connect_error(new Error('UNAUTHORIZED')));
  expect(m.renew).toHaveBeenCalledOnce();
});
it('does not reconnect when session renewal rejects a suspended or signed-out account', async () => {
  m.renew.mockRejectedValue(new Error('Session unavailable'));
  render(
    <SocketProvider>
      <Status />
    </SocketProvider>
  );
  await act(async () => {
    m.handlers.connect_error(new Error('UNAUTHORIZED'));
  });
  expect(m.connect).not.toHaveBeenCalled();
});
it('does not revive a socket after unmount while renewal is pending', async () => {
  let resolve!: () => void;
  m.renew.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      })
  );
  const view = render(
    <SocketProvider>
      <Status />
    </SocketProvider>
  );
  act(() => m.handlers.disconnect('io server disconnect'));
  view.unmount();
  await act(async () => resolve());
  expect(m.connect).not.toHaveBeenCalled();
  expect(m.remove).toHaveBeenCalled();
});
it('leaves ordinary network reconnects to Socket.IO without rotating cookies', () => {
  render(
    <SocketProvider>
      <Status />
    </SocketProvider>
  );
  act(() => m.handlers.disconnect('transport close'));
  expect(m.renew).not.toHaveBeenCalled();
});
