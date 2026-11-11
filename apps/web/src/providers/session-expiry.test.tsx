import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import {
  credentialRequest,
  setSessionUser,
  sessionRevision,
  sessionSignedOut,
} from '@/lib/session';
import { AuthProvider, useAuth } from './auth-provider';
import { SocketProvider } from './socket-provider';

const sockets = vi.hoisted(() => ({
  disconnect: vi.fn(),
  removeAllListeners: vi.fn(),
  on: vi.fn(),
  connect: vi.fn(),
}));
vi.mock('socket.io-client', () => ({ io: () => sockets }));
vi.mock('./language-provider', () => ({ useLanguage: () => ({ t: (s: string) => s }) }));
const response = (status: number, data: unknown = {}) => ({
  status,
  ok: status === 200,
  json: async () => data,
});
const member = (id = 'alice') =>
  response(200, { success: true, data: { user: { id, username: id } } });
const denied = () => response(401);
let auth: ReturnType<typeof useAuth>;
let unmounts = 0;
function Page() {
  auth = useAuth();
  const [privateState, setPrivateState] = useState('empty');
  useEffect(() => {
    if (auth.user) setPrivateState('private-page');
    return () => {
      unmounts++;
    };
  }, []);
  return (
    <div>
      {auth.user?.id ?? 'guest'}:{String(auth.isLoading)}:{privateState}
    </div>
  );
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <SocketProvider>
          <Page />
        </SocketProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
  return client;
}
beforeEach(async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_name: string, options: { signal: AbortSignal }, action: () => unknown) => {
        options.signal.throwIfAborted();
        return action();
      },
    },
  });
  // A fresh explicit credential boundary resets the module's persistent state.
  await credentialRequest('/auth/login', async () => undefined);
  setSessionUser(null);
  unmounts = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('real API session expiry privacy boundary', () => {
  it.each([401, 403])(
    'clears identity, cache, page state and socket on refresh denial %i',
    async (status) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
      const client = mount();
      await screen.findByText('alice:false:private-page');
      client.setQueryData(['wallet'], { privateBalance: 9876 });
      const priorUnmounts = unmounts;
      let resolveLate!: (value: unknown) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) =>
          url.endsWith('/late')
            ? new Promise((resolve) => {
                resolveLate = resolve;
              })
            : Promise.resolve(url.endsWith('/auth/refresh') ? response(status) : denied())
        )
      );
      const late = api.get('/late');
      const lateRejected = expect(late).rejects.toMatchObject({ name: 'AbortError' });
      await act(async () => {
        await expect(api.get('/wallet')).rejects.toMatchObject({ name: 'AbortError' });
      });
      expect(screen.getByText('guest:false:empty')).toBeTruthy();
      expect(client.getQueryData(['wallet'])).toBeUndefined();
      expect(sessionSignedOut()).toBe(true);
      expect(unmounts).toBeGreaterThan(priorUnmounts);
      expect(sockets.disconnect).toHaveBeenCalled();
      resolveLate(response(200, { success: true, data: { privateBalance: 9876 } }));
      await lateRejected;
    }
  );

  it('clears the old identity when a successful authoritative probe identifies another user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
    const client = mount();
    await screen.findByText('alice:false:private-page');
    client.setQueryData(['wallet'], 9876);
    const priorRevision = sessionRevision();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => Promise.resolve(url.endsWith('/auth/me') ? member('bob') : denied()))
    );
    await act(async () => {
      await expect(api.get('/wallet')).rejects.toMatchObject({ name: 'AbortError' });
    });
    expect(screen.getByText('guest:false:empty')).toBeTruthy();
    expect(client.getQueryData(['wallet'])).toBeUndefined();
    expect(sessionRevision()).not.toBe(priorRevision);
    expect(sessionSignedOut()).toBe(true);
    expect(sockets.disconnect).toHaveBeenCalled();
  });

  it('retains the existing identity when a successful probe has malformed identity data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
    const client = mount();
    await screen.findByText('alice:false:private-page');
    client.setQueryData(['wallet'], 9876);
    const priorRevision = sessionRevision();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith('/auth/me') ? response(200, { success: true, data: { user: {} } }) : denied()
        )
      )
    );
    await act(async () => {
      await expect(api.get('/wallet')).rejects.toThrow('401');
    });
    expect(screen.getByText('alice:false:private-page')).toBeTruthy();
    expect(client.getQueryData(['wallet'])).toBe(9876);
    expect(sessionRevision()).toBe(priorRevision);
  });

  it.each(['mutation', 'upload'])(
    'rejects late %s results across confirmed expiry without replaying them',
    async (kind) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
      mount();
      await screen.findByText('alice:false:private-page');
      let finish!: (value: unknown) => void;
      const fetcher = vi.fn((url: string) =>
        url.endsWith('/private-write')
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(denied())
      );
      vi.stubGlobal('fetch', fetcher);
      const pending =
        kind === 'upload'
          ? api.upload('/private-write', new FormData())
          : api.post('/private-write', { fixture: true });
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await act(async () => {
        await expect(api.get('/wallet')).rejects.toMatchObject({ name: 'AbortError' });
      });
      finish(response(200, { success: true, data: { privateRecord: 'old-user' } }));
      await rejected;
      expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/private-write'))).toHaveLength(1);
      expect(screen.getByText('guest:false:empty')).toBeTruthy();
    }
  );

  it.each(['server', 'offline', 'abort'])(
    'retains member identity and cache on %s renewal failure',
    async (kind) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
      const client = mount();
      await screen.findByText('alice:false:private-page');
      client.setQueryData(['wallet'], 9876);
      const revision = sessionRevision();
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (!url.endsWith('/auth/refresh')) return Promise.resolve(denied());
          if (kind === 'server') return Promise.resolve(response(503));
          return Promise.reject(
            kind === 'abort' ? new DOMException('Aborted', 'AbortError') : new Error('offline')
          );
        })
      );
      await act(async () => {
        await auth.refreshUser();
      });
      expect(screen.getByText('alice:false:private-page')).toBeTruthy();
      expect(client.getQueryData(['wallet'])).toBe(9876);
      expect(sessionRevision()).toBe(revision);
    }
  );

  it('does not let an outdated refresh denial clear a newer successful login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
    mount();
    await screen.findByText('alice:false:private-page');
    let finish!: (value: unknown) => void;
    const fetcher = vi.fn((url: string) => {
      if (url.endsWith('/auth/refresh'))
        return new Promise((resolve) => {
          finish = resolve;
        });
      return Promise.resolve(url.endsWith('/auth/login') ? member('bob') : denied());
    });
    vi.stubGlobal('fetch', fetcher);
    const stale = api.get('/wallet');
    const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => {
      await auth.login('fixture', 'fixture');
    });
    await screen.findByText('bob:false:private-page');
    const revision = sessionRevision();
    await act(async () => {
      finish(response(403));
      await rejected;
    });
    expect(screen.getByText('bob:false:private-page')).toBeTruthy();
    expect(sessionRevision()).toBe(revision);
    expect(sessionSignedOut()).toBe(false);
  });

  it('clears private state immediately on another tab boundary, before reload completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
    const client = mount();
    await screen.findByText('alice:false:private-page');
    client.setQueryData(['wallet'], 9876);
    // jsdom cannot navigate; this also proves cleanup does not rely on reload.
    const navigationError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      localStorage.setItem(
        'socialplay.session-boundary',
        JSON.stringify({ revision: 'other-tab-expiry', signedOut: true })
      );
      await act(async () => {
        window.dispatchEvent(new StorageEvent('storage', { key: 'socialplay.session-boundary' }));
      });
      expect(screen.getByText('guest:false:empty')).toBeTruthy();
      expect(client.getQueryData(['wallet'])).toBeUndefined();
      expect(sockets.disconnect).toHaveBeenCalled();
      await expect(api.get('/wallet')).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      navigationError.mockRestore();
    }
  });

  it('makes initial definitive anonymous denial usable and permits explicit login afterward', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(denied()));
    mount();
    await screen.findByText('guest:false:empty');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(member()));
    await act(async () => {
      await auth.login('fixture', 'fixture');
    });
    expect(screen.getByText('alice:false:private-page')).toBeTruthy();
  });
});
