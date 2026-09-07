import { cleanup, render, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { UserPublicProfile } from '@socialplay/shared';

/* ── API mocks ────────────────────────────────────────────────────── */
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: (...a: unknown[]) => apiPost(...a),
  },
}));

import { AuthProvider, useAuth } from './auth-provider';

/* ── Test users ────────────────────────────────────────────────────── */
const userA: UserPublicProfile = {
  id: 'user-a', username: 'alice', displayName: 'Alice',
  email: 'alice@example.com', isVerified: true, createdAt: '2026-01-01T00:00:00.000Z',
};
const userB: UserPublicProfile = {
  id: 'user-b', username: 'bob', displayName: 'Bob',
  email: 'bob@example.com', isVerified: true, createdAt: '2026-01-02T00:00:00.000Z',
};
const userC: UserPublicProfile = {
  id: 'user-c', username: 'charlie', displayName: 'Charlie',
  email: 'charlie@example.com', isVerified: false, createdAt: '2026-01-03T00:00:00.000Z',
};

type MeResponse = { success: boolean; data: { user: UserPublicProfile | null } };
const meResponse = (user: UserPublicProfile | null): MeResponse => ({ success: true, data: { user } });
const loginResponse = (user: UserPublicProfile): MeResponse => meResponse(user);

/** Matches ApiClient's thrown shape: JSON.stringify({ status, ...error }). */
const authError = (status: number, code: string, message: string) =>
  new Error(JSON.stringify({ status, code, message }));

/* ── Deferred promise helper ───────────────────────────────────────── */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}

/* ── Harness ───────────────────────────────────────────────────────── */
const authStore = { current: null as ReturnType<typeof useAuth> | null };
function AuthProbe() {
  const auth = useAuth();
  authStore.current = auth;
  return <div data-testid="loading">{String(auth.isLoading)}</div>;
}

// Cumulative mount counter — only ever increments. A key change unmounts the
// old instance (cleanup does NOT decrement) then mounts a new one (increment).
let cumulativeMounts = 0;
function MountProbe() {
  useEffect(() => { cumulativeMounts++; }, []);
  return <div data-testid="mounts">{cumulativeMounts}</div>;
}

/** Renders a private per-user query entry so tests observe actual UI output. */
function WalletRow({ onA, onB }: { onA: () => Promise<string>; onB: () => Promise<string> }) {
  const { user } = useAuth();
  const { data, isPending } = useQuery({
    queryKey: ['wallet-row'],
    queryFn: () => (user?.id === 'user-b' ? onB() : onA()),
    retry: false,
  });
  return (
    <div data-testid="wallet-row">
      <span data-testid="row-user">{user?.id ?? 'anon'}</span>
      <span data-testid="row-data">{isPending ? 'loading' : String(data)}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  apiGet.mockReset();
  apiPost.mockReset();
  authStore.current = null;
  cumulativeMounts = 0;
});

// Infinity gcTime keeps seeded cache entries alive for the duration of a test;
// the provider's publishTransition still roars through and destroys them.
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
}

function renderStack(client: QueryClient, children: ReactNode = null) {
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AuthProbe />
        <MountProbe />
        {children}
      </AuthProvider>
    </QueryClientProvider>,
  );
}

async function waitForAuth() {
  await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
  return authStore.current!;
}

/** Run an auth operation and flush React state updates. */
async function flushAuth(fn: () => Promise<void>) {
  await act(async () => { await fn(); });
}

/** Run a potentially-rejecting operation, capturing the rejection. */
async function captureRejection(fn: () => Promise<unknown>) {
  let error: unknown;
  await act(async () => {
    try { await fn(); } catch (err) { error = err; }
  });
  return error;
}

/* ════════════ Credential cache isolation ════════════ */
describe('AuthProvider — credential cache isolation', () => {
  it('logout removes the logged-in user cache', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderStack(client);
    const auth = await waitForAuth();
    expect(auth.user?.id).toBe('user-a');

    // Seed AFTER the session probe settles — the authenticated null→user
    // boundary itself clears whatever existed before it published.
    client.setQueryData(['achievements'], [{ key: 'test' }]);
    client.setQueryData(['wallet'], { coins: 100 });
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    clearSpy.mockClear();
    expect(client.getQueryData(['achievements'])).toBeDefined();

    apiPost.mockResolvedValue({ success: true });
    await flushAuth(() => auth.logout());

    expect(authStore.current?.user).toBeNull();
    expect(client.getQueryData(['achievements'])).toBeUndefined();
    expect(client.getQueryData(['wallet'])).toBeUndefined();
    expect(client.getQueryData(['groups'])).toBeUndefined();
  });

  it('failed server logout still removes local private cache', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    client.setQueryData(['wallet'], { coins: 100 });
    renderStack(client);
    const auth = await waitForAuth();

    apiPost.mockRejectedValue(new Error('network'));
    await flushAuth(() => auth.logout());

    expect(authStore.current?.user).toBeNull();
    expect(client.getQueryData(['wallet'])).toBeUndefined();
  });

  it('login as B removes A cache', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    client.setQueryData(['wallet'], { coins: 100 });
    renderStack(client);
    const auth = await waitForAuth();

    apiPost.mockResolvedValue(loginResponse(userB));
    await flushAuth(() => auth.login('bob@test.com', 'pass'));

    expect(authStore.current?.user?.id).toBe('user-b');
    expect(client.getQueryData(['wallet'])).toBeUndefined();
  });

  it('register as B clears prior cache', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    client.setQueryData(['wallet'], { coins: 50 });
    renderStack(client);
    const auth = await waitForAuth();

    apiPost.mockResolvedValue(loginResponse(userB));
    await flushAuth(() => auth.register({ username: 'bob', email: 'bob@test.com', password: 'Passw0rd!' }));

    expect(authStore.current?.user?.id).toBe('user-b');
    expect(client.getQueryData(['wallet'])).toBeUndefined();
  });
});

/* ════════════ Current-operation failure propagation ════════════ */
describe('AuthProvider — current-operation failure propagation', () => {
  it('a rejected login reaches the caller, publishes nothing, clears nothing', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    const client = makeClient();
    client.setQueryData(['wallet'], { coins: 1 });
    const clearSpy = vi.spyOn(client, 'clear');
    renderStack(client);
    const auth = await waitForAuth();

    apiPost.mockRejectedValue(authError(401, 'UNAUTHORIZED', 'Invalid credentials'));
    const error = await captureRejection(() => auth.login('a@test.com', 'bad'));

    expect((error as Error).message).toContain('Invalid credentials');
    expect(authStore.current?.user).toBeNull();
    expect(authStore.current?.isAuthenticated).toBe(false);
    expect(authStore.current?.isLoading).toBe(false);
    expect(client.getQueryData(['wallet'])).toBeDefined(); // no clear on failure
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('a rejected register reaches the caller and publishes nothing', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    renderStack(makeClient());
    const auth = await waitForAuth();

    apiPost.mockRejectedValue(authError(409, 'USERNAME_TAKEN', 'Username already taken'));
    const error = await captureRejection(() =>
      auth.register({ username: 'bob', email: 'bob@example.com', password: 'Passw0rd!' }),
    );

    expect((error as Error).message).toContain('Username already taken');
    expect(authStore.current?.user).toBeNull();
    expect(authStore.current?.isLoading).toBe(false);
  });

  it('a 2xx success:false login is treated as a current failure and rejects', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    renderStack(makeClient());
    const auth = await waitForAuth();

    apiPost.mockResolvedValue({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Bad credentials' } });
    const error = await captureRejection(() => auth.login('a@test.com', 'bad'));

    expect((error as Error).message).toBe('Bad credentials');
    expect(authStore.current?.user).toBeNull();
  });

  it('a superseded login failure is silently ignored (no throw, no identity change)', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    renderStack(makeClient());
    const auth = await waitForAuth();

    const dLogin = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dLogin.promise);
    const staleLogin = auth.login('a@test.com', 'pass');

    // Supersede with a logout that completes immediately.
    apiPost.mockResolvedValue({ success: true });
    await flushAuth(() => authStore.current!.logout());
    expect(authStore.current?.user).toBeNull();

    // The stale login rejects later — it must be swallowed, not thrown.
    await act(async () => { dLogin.reject(authError(500, 'SERVER', 'boom')); });
    await expect(staleLogin).resolves.toBeUndefined();
    expect(authStore.current?.user).toBeNull();
  });
});

/* ════════════ Last intent wins among credential operations ════════════ */
describe('AuthProvider — last intent wins among credential ops', () => {
  it('login A then login B: B resolves first, late A cannot beat it', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    renderStack(makeClient());
    const auth = await waitForAuth();

    const dA = deferred<MeResponse>();
    const dB = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dA.promise).mockReturnValueOnce(dB.promise);

    const pA = auth.login('a@test.com', 'x');
    const pB = auth.login('b@test.com', 'y');

    await flushAuth(async () => { dB.resolve(loginResponse(userB)); });
    await pB;
    expect(authStore.current?.user?.id).toBe('user-b');

    await flushAuth(async () => { dA.resolve(loginResponse(userA)); });
    await pA; // swallowed: resolves without publishing
    expect(authStore.current?.user?.id).toBe('user-b');
  });

  it('register older, login newer: login wins even when register resolves late', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    renderStack(makeClient());
    const auth = await waitForAuth();

    const dReg = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dReg.promise).mockReturnValueOnce(Promise.resolve(loginResponse(userB)));
    const pReg = auth.register({ username: 'carol', email: 'c@example.com', password: 'Passw0rd!' });
    const pLogin = auth.login('b@test.com', 'y');

    await flushAuth(async () => { await pLogin; });
    expect(authStore.current?.user?.id).toBe('user-b');

    // The older register response resolves later — superseded and ignored.
    await flushAuth(async () => { dReg.resolve(loginResponse(userA)); await pReg; });
    expect(authStore.current?.user?.id).toBe('user-b');
  });

  it('login older, logout newer: logout wins, later login ignored', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    renderStack(makeClient());
    const auth = await waitForAuth();

    const dLogin = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dLogin.promise); // the login call
    apiPost.mockResolvedValue({ success: true }); // the logout call
    const pLogin = auth.login('a@test.com', 'x');
    const pLogout = auth.logout();

    await flushAuth(async () => { await pLogout; });
    expect(authStore.current?.user).toBeNull();

    await flushAuth(async () => { dLogin.resolve(loginResponse(userA)); await pLogin; });
    expect(authStore.current?.user).toBeNull();
  });
});

/* ════════════ Passive refresh cannot supersede credential intent ════════════ */
describe('AuthProvider — passive refresh vs credential authority', () => {
  it('login B pending → refresh fails → login B succeeds: B wins', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    renderStack(makeClient());
    await waitForAuth();

    const dLogin = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dLogin.promise);
    const pLogin = authStore.current!.login('b@test.com', 'y');

    // Refresh starts while login is pending and FAILS — must neither null the
    // user nor revoke the pending login's authority.
    apiGet.mockRejectedValueOnce(authError(500, 'SERVER', 'boom'));
    await captureRejection(() => authStore.current!.refreshUser());
    expect(authStore.current?.user?.id).toBe('user-a'); // not nulled

    await flushAuth(async () => { dLogin.resolve(loginResponse(userB)); await pLogin; });
    expect(authStore.current?.user?.id).toBe('user-b');
  });

  it('login B pending → refresh succeeds as A → login B wins', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    renderStack(makeClient());
    await waitForAuth();

    const dLogin = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dLogin.promise);
    const pLogin = authStore.current!.login('b@test.com', 'y');

    apiGet.mockResolvedValueOnce(meResponse(userA)); // refresh returns A
    await flushAuth(() => authStore.current!.refreshUser());

    await flushAuth(async () => { dLogin.resolve(loginResponse(userB)); await pLogin; });
    expect(authStore.current?.user?.id).toBe('user-b');
  });

  it('refresh starts, then login B starts: refresh resolving later is ignored', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    renderStack(makeClient());
    await waitForAuth();

    const dRefresh = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(dRefresh.promise);
    const pRefresh = authStore.current!.refreshUser();

    const dLogin = deferred<MeResponse>();
    apiPost.mockReturnValueOnce(dLogin.promise);
    const pLogin = authStore.current!.login('b@test.com', 'y');

    await flushAuth(async () => { dLogin.resolve(loginResponse(userB)); await pLogin; });
    expect(authStore.current?.user?.id).toBe('user-b');

    await flushAuth(async () => { dRefresh.resolve(meResponse(userA)); await pRefresh; });
    expect(authStore.current?.user?.id).toBe('user-b');
  });
});

/* ════════════ Stale /auth/me success and failure ════════════ */
describe('AuthProvider — stale auth/me success and failure', () => {
  it('old /auth/me SUCCESS from before a newer login is ignored', async () => {
    const me = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(me.promise); // initial probe pending
    renderStack(makeClient());
    await waitFor(() => expect(authStore.current).not.toBeNull());
    expect(authStore.current?.isLoading).toBe(true);

    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.login('b@test.com', 'y'));
    expect(authStore.current?.user?.id).toBe('user-b');
    expect(authStore.current?.isLoading).toBe(false);

    await flushAuth(async () => { me.resolve(meResponse(userA)); });
    expect(authStore.current?.user?.id).toBe('user-b'); // A ignored
  });

  it('old /auth/me FAILURE neither nulls B nor leaves loading stuck', async () => {
    const me = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(me.promise);
    renderStack(makeClient());
    await waitFor(() => expect(authStore.current).not.toBeNull());
    expect(authStore.current?.isLoading).toBe(true);

    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.login('b@test.com', 'y'));
    expect(authStore.current?.user?.id).toBe('user-b');

    // Old probe REJECTS after B is published. Must not null B.
    await act(async () => { me.reject(new Error('network down')); });
    expect(authStore.current?.user?.id).toBe('user-b');
    expect(authStore.current?.isLoading).toBe(false);
  });
});

/* ════════════ Initial loading deadlock resolution ════════════ */
describe('AuthProvider — initial probe loading deadlock', () => {
  it('probe pending + login success → loading false, B published', async () => {
    const me = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(me.promise);
    renderStack(makeClient());
    await waitFor(() => expect(authStore.current?.isLoading).toBe(true));

    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.login('b@test.com', 'y'));
    expect(authStore.current?.user?.id).toBe('user-b');
    expect(authStore.current?.isLoading).toBe(false);
  });

  it('probe pending + login failure → loading false, error reached, no identity', async () => {
    const me = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(me.promise);
    renderStack(makeClient());
    await waitFor(() => expect(authStore.current?.isLoading).toBe(true));

    apiPost.mockRejectedValueOnce(authError(401, 'UNAUTHORIZED', 'Bad creds'));
    const error = await captureRejection(() => authStore.current!.login('a@test.com', 'x'));

    expect((error as Error).message).toContain('Bad creds');
    expect(authStore.current?.isLoading).toBe(false); // NOT permanently stuck
    expect(authStore.current?.user).toBeNull();
  });

  it('probe pending + logout → loading false, null identity', async () => {
    const me = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(me.promise);
    renderStack(makeClient());
    await waitFor(() => expect(authStore.current?.isLoading).toBe(true));

    apiPost.mockResolvedValueOnce({ success: true });
    await flushAuth(() => authStore.current!.logout());
    expect(authStore.current?.user).toBeNull();
    expect(authStore.current?.isLoading).toBe(false);
  });

  it('probe pending + register success → loading false, B published', async () => {
    const me = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(me.promise);
    renderStack(makeClient());
    await waitFor(() => expect(authStore.current?.isLoading).toBe(true));

    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.register({ username: 'bob', email: 'b@test.com', password: 'Passw0rd!' }));
    expect(authStore.current?.user?.id).toBe('user-b');
    expect(authStore.current?.isLoading).toBe(false);
  });
});

/* ════════════ Initial probe uses the unified identity boundary ════════════ */
describe('AuthProvider — initial probe boundary', () => {
  it('authenticated probe: null→user runs clear + remount (no direct setUser)', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    const clearSpy = vi.spyOn(client, 'clear');
    renderStack(client);
    await waitForAuth();
    await waitFor(() => expect(cumulativeMounts).toBeGreaterThanOrEqual(2)); // initial + remount

    expect(authStore.current?.user?.id).toBe('user-a');
    expect(authStore.current?.isLoading).toBe(false);
    expect(client.getQueryData(['groups'])).toBeUndefined(); // cleared
    expect(clearSpy).toHaveBeenCalledTimes(1);               // one bounded publish
  });

  it('anonymous probe: null→null resolves loading without boundary churn', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    const client = makeClient();
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    const clearSpy = vi.spyOn(client, 'clear');
    renderStack(client);
    await waitForAuth();
    await waitFor(() => expect(cumulativeMounts).toBe(1));

    expect(authStore.current?.user).toBeNull();
    expect(authStore.current?.isLoading).toBe(false);
    expect(client.getQueryData(['groups'])).toBeDefined();  // cache preserved
    expect(clearSpy).not.toHaveBeenCalled();
  });
});

/* ════════════ StrictMode obsolete probe guard ════════════ */
describe('AuthProvider — StrictMode obsolete probe guard', () => {
  it('StrictMode effect replay runs two probes but publishes exactly once', async () => {
    const me = deferred<MeResponse>();
    let getCalls = 0;
    apiGet.mockImplementation(() => { getCalls++; return me.promise; });
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');

    render(
      <QueryClientProvider client={client}>
        <StrictMode>
          <AuthProvider>
            <AuthProbe />
            <MountProbe />
          </AuthProvider>
        </StrictMode>
      </QueryClientProvider>,
    );

    // StrictMode runs the initial effect twice → two /auth/me probes.
    await waitFor(() => expect(getCalls).toBeGreaterThanOrEqual(2));

    await flushAuth(async () => { me.resolve(meResponse(userA)); });

    expect(authStore.current?.user?.id).toBe('user-a');
    expect(authStore.current?.isLoading).toBe(false);
    expect(clearSpy).toHaveBeenCalledTimes(1); // a single authoritative publish
  });
});

/* ════════════ Refresh identity matrix ════════════ */
describe('AuthProvider — refresh identity matrix', () => {
  it('same-user refresh preserves cache and does not remount', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    const clearSpy = vi.spyOn(client, 'clear');
    renderStack(client);
    const auth = await waitForAuth();
    await waitFor(() => expect(cumulativeMounts).toBeGreaterThan(0));
    // Seed after the authenticated boundary settles; the refresh must NOT clear.
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    clearSpy.mockClear();
    const mountsBefore = cumulativeMounts;

    apiGet.mockResolvedValueOnce(meResponse({ ...userA, displayName: 'Alice II' }));
    await flushAuth(() => auth.refreshUser());

    expect(authStore.current?.user?.displayName).toBe('Alice II');
    expect(client.getQueryData(['groups'])).toBeDefined();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(cumulativeMounts).toBe(mountsBefore);
  });

  it('anonymous refresh null→B is a full boundary', async () => {
    apiGet.mockResolvedValue(meResponse(null));
    const client = makeClient();
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    const clearSpy = vi.spyOn(client, 'clear');
    renderStack(client);
    const auth = await waitForAuth();
    await waitFor(() => expect(cumulativeMounts).toBe(1));

    apiGet.mockResolvedValueOnce(meResponse(userB));
    await flushAuth(() => auth.refreshUser());

    expect(authStore.current?.user?.id).toBe('user-b');
    expect(authStore.current?.isLoading).toBe(false);
    expect(client.getQueryData(['groups'])).toBeUndefined();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(cumulativeMounts).toBe(2); // remount
  });

  it('different-user refresh A→B clears and remounts', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    renderStack(client);
    const auth = await waitForAuth();
    await waitFor(() => expect(cumulativeMounts).toBeGreaterThan(0));
    // Seed after the boundary settles so it is the REFRESH that must clear it.
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    const mountsBefore = cumulativeMounts;

    apiGet.mockResolvedValueOnce(meResponse(userB));
    await flushAuth(() => auth.refreshUser());

    expect(authStore.current?.user?.id).toBe('user-b');
    expect(client.getQueryData(['groups'])).toBeUndefined();
    expect(cumulativeMounts).toBe(mountsBefore + 1);
  });

  it('authenticated refresh failure A→null clears, remounts, resolves loading', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    renderStack(client);
    const auth = await waitForAuth();
    await waitFor(() => expect(cumulativeMounts).toBeGreaterThan(0));
    client.setQueryData(['groups'], [{ id: 'g1' }]);
    const mountsBefore = cumulativeMounts;

    apiGet.mockRejectedValueOnce(authError(401, 'UNAUTHORIZED', 'expired'));
    await flushAuth(() => auth.refreshUser());

    expect(authStore.current?.user).toBeNull();
    expect(authStore.current?.isLoading).toBe(false);
    expect(client.getQueryData(['groups'])).toBeUndefined();
    expect(cumulativeMounts).toBe(mountsBefore + 1);
  });

  it('stale refresh failure after a newer login B is ignored', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    renderStack(makeClient());
    await waitForAuth();

    const dRefresh = deferred<MeResponse>();
    apiGet.mockReturnValueOnce(dRefresh.promise);
    const pRefresh = authStore.current!.refreshUser();

    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.login('b@test.com', 'y'));
    expect(authStore.current?.user?.id).toBe('user-b');

    await act(async () => { dRefresh.reject(new Error('boom')); });
    await expect(pRefresh).resolves.toBeUndefined();
    expect(authStore.current?.user?.id).toBe('user-b'); // NOT nulled
  });
});

/* ════════════ Real pending-query cancellation ════════════ */
describe('AuthProvider — real late-query protection', () => {
  it('a pending A query is destroyed by the boundary; late A data cannot overwrite B', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    const aQuery = deferred<string>();
    const bQuery = deferred<string>();

    renderStack(client, <WalletRow onA={() => aQuery.promise} onB={() => bQuery.promise} />);

    // A's query is genuinely pending inside the real QueryClient.
    await waitFor(() => expect(screen.getByTestId('row-user')).toHaveTextContent('user-a'));
    await waitFor(() => expect(screen.getByTestId('row-data')).toHaveTextContent('loading'));
    await waitFor(() => expect(client.getQueryState(['wallet-row'])?.status).toBe('pending'));
    await waitFor(() => expect(authStore.current?.isLoading).toBe(false));

    // Login B → clear() destroys A's pending query; the remounted WalletRow
    // starts a fresh query for the same key.
    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.login('b@test.com', 'y'));

    await flushAuth(async () => { bQuery.resolve('wallet-B'); });
    await waitFor(() => expect(screen.getByTestId('row-data')).toHaveTextContent('wallet-B'));

    // Old A promise resolves last — its data must not enter the cache.
    await flushAuth(async () => { aQuery.resolve('wallet-A'); });
    expect(screen.getByTestId('row-data')).toHaveTextContent('wallet-B');
    expect(client.getQueryData(['wallet-row'])).toBe('wallet-B');
  });
});

/* ════════════ Rendered private-data isolation ════════════ */
describe('AuthProvider — rendered private-data isolation', () => {
  it('A data disappears on the boundary before B data resolves', async () => {
    apiGet.mockResolvedValue(meResponse(userA));
    const client = makeClient();
    const bQuery = deferred<string>();

    renderStack(client, <WalletRow onA={() => Promise.resolve('wallet-A')} onB={() => bQuery.promise} />);

    await waitFor(() => expect(screen.getByTestId('row-data')).toHaveTextContent('wallet-A'));
    await waitFor(() => expect(screen.getByTestId('row-user')).toHaveTextContent('user-a'));
    await waitFor(() => expect(authStore.current?.isLoading).toBe(false));

    apiPost.mockResolvedValueOnce(loginResponse(userB));
    await flushAuth(() => authStore.current!.login('b@test.com', 'y'));

    // While B's query is still pending, A's private row must NOT remain rendered.
    expect(screen.queryByText('wallet-A')).not.toBeInTheDocument();
    expect(screen.getByTestId('row-data')).toHaveTextContent('loading');
    expect(screen.getByTestId('row-user')).toHaveTextContent('user-b');

    await flushAuth(async () => { bQuery.resolve('wallet-B'); });
    await waitFor(() => expect(screen.getByTestId('row-data')).toHaveTextContent('wallet-B'));
  });
});