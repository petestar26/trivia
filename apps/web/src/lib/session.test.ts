import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const response = (status: number, data: unknown = {}) => ({ ok: status === 200, status, json: async () => data });
const me = (id = 'alice') => response(200, { success: true, data: { user: { id } } });
const ok = () => response(200, { success: true, data: { result: 'kept' } });
const unauthorized = () => response(401, { error: { code: 'UNAUTHORIZED' } });
let lockTail: Promise<unknown>;
beforeEach(() => {
  vi.resetModules(); lockTail = Promise.resolve();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  });
  vi.stubGlobal('navigator', { locks: {
    request: vi.fn((_name, options, action) => {
      const p = lockTail.catch(() => undefined).then(() => { options.signal.throwIfAborted(); return action(); });
      lockTail = p; return p;
    }),
  } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); });

describe('cookie session renewal', () => {
  it('coalesces simultaneous expired reads, uses cookies, and preserves retry parameters', async () => {
    let renewed = false;
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/auth/refresh')) { renewed = true; return ok(); }
      if (url.endsWith('/auth/me')) return renewed ? me() : unauthorized();
      return renewed ? ok() : unauthorized();
    });
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    const { setSessionUser } = await import('./session'); setSessionUser('alice');
    const [a, b] = await Promise.all([api.get('/round', { n: 1 }), api.get('/round', { n: 2 })]);
    expect(a.success && b.success).toBe(true);
    const refreshes = fetcher.mock.calls.filter(([u]) => u.endsWith('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0][1]).toMatchObject({ body: '{}', credentials: 'include', method: 'POST' });
    expect(fetcher.mock.calls.filter(([u]) => u.endsWith('/round?n=1'))).toHaveLength(2);
  });

  it('rechecks under the shared lock and skips rotation when another tab renewed', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(me()).mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    expect((await api.get('/round')).success).toBe(true);
    expect(fetcher.mock.calls.some(([u]) => u.endsWith('/auth/refresh'))).toBe(false);
  });

  it('does not publish another user into the previous identity cache', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(me('bob'));
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    const { setSessionUser } = await import('./session'); setSessionUser('alice');
    await expect(api.get('/round')).rejects.toThrow('401');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([403, 500])('does not rotate after probe status %i', async (status) => {
    const fetcher = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(response(status));
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    await expect(api.get('/round')).rejects.toThrow('401');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('never automatically replays mutations', async () => {
    const fetcher = vi.fn().mockResolvedValue(unauthorized()); vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    await expect(api.post('/games/spin/tickets', { amount: 40 })).rejects.toThrow('401');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('limits recovery to a single original GET retry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(unauthorized()).mockResolvedValueOnce(me()).mockResolvedValueOnce(unauthorized());
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    await expect(api.get('/round')).rejects.toThrow('401');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('persists failed logout intent across module reload and clears it only on explicit login', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetcher);
    let { api } = await import('./api');
    await expect(api.post('/auth/logout')).rejects.toThrow('offline');
    vi.resetModules(); ({ api } = await import('./api'));
    await expect(api.get('/auth/me')).rejects.toThrow('Signed out');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await api.post('/auth/login', { email: 'fixture', password: 'fixture' });
    (await import('./session')).setSessionUser('alice');
    expect((await api.get('/auth/me')).success).toBe(true);
  });

  it('rejects a delayed read when another tab changes the persisted identity boundary', async () => {
    let finish!: (r: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const { api } = await import('./api');
    const pending = api.get('/private');
    localStorage.setItem('socialplay.session-boundary', JSON.stringify({ revision: 'other-tab', signedOut: false }));
    finish(ok());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancels one waiting read without cancelling the shared renewal', async () => {
    let finish!: (r: unknown) => void;
    let probeStarted!: () => void;
    const started = new Promise<void>((r) => { probeStarted = r; });
    let ready = false;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/auth/me')) { probeStarted(); return new Promise((r) => { finish = r; }); }
      return Promise.resolve(ready ? ok() : unauthorized());
    }));
    const { api } = await import('./api');
    const controller = new AbortController();
    const a = api.get('/round', undefined, { signal: controller.signal });
    const rejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = api.get('/round');
    await started; controller.abort(); await rejected;
    ready = true; finish(me());
    expect((await b).success).toBe(true);
  });

  it('bounds an interrupted refresh and leaves the original request failed closed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url: string, options: RequestInit) => {
      if (!url.endsWith('/auth/me')) return Promise.resolve(unauthorized());
      return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError'))));
    }));
    const { api } = await import('./api');
    const request = api.get('/round');
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10_001); await rejected;
  });

  it('fails closed when cross-tab locking is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const fetcher = vi.fn().mockResolvedValue(unauthorized()); vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    await expect(api.get('/round')).rejects.toThrow('401');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('invalidates identity when superseded login A installs cookies but latest login B fails', async () => {
    let finishA!: (r: unknown) => void;
    let startedA!: () => void;
    const started = new Promise<void>(r => { startedA = r; });
    const invalidated = vi.fn(); window.addEventListener('socialplay:session-invalidated', invalidated);
    const fetcher = vi.fn()
      .mockImplementationOnce(() => { startedA(); return new Promise(r => { finishA = r; }); })
      .mockResolvedValueOnce(unauthorized());
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    const session = await import('./session'); session.setSessionUser('carol');
    const a = api.post('/auth/login', { user: 'alice' });
    const aRejected = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    const b = api.post('/auth/login', { user: 'bob' });
    const bRejected = expect(b).rejects.toThrow('401');
    await expect(api.get('/private')).rejects.toMatchObject({ name: 'AbortError' });
    finishA(me('alice')); await aRejected; await bRejected;
    expect(invalidated).toHaveBeenCalledTimes(1); expect(session.sessionSignedOut()).toBe(true);
    await expect(api.get('/auth/me')).rejects.toThrow('Signed out');
    expect(fetcher).toHaveBeenCalledTimes(2);
    window.removeEventListener('socialplay:session-invalidated', invalidated);
  });

  it('does not rotate when logout intent arrives during a held renewal probe', async () => {
    let finish!: (r: unknown) => void;
    let started!: () => void;
    const probeStarted = new Promise<void>(r => { started = r; });
    const fetcher = vi.fn((url: string) => {
      if (url.endsWith('/auth/me')) { started(); return new Promise(r => { finish = r; }); }
      return Promise.resolve(url.endsWith('/auth/logout') ? ok() : unauthorized());
    });
    vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api');
    const read = api.get('/private'); const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    await probeStarted; const logout = api.post('/auth/logout');
    finish(unauthorized()); await rejected; await logout;
    expect(fetcher.mock.calls.some(([u]) => u.endsWith('/auth/refresh'))).toBe(false);
  });

  it('allows public reads without cookies after logout and does not repeatedly rotate a rejected session', async () => {
    const fetcher = vi.fn().mockResolvedValue(ok()); vi.stubGlobal('fetch', fetcher);
    const { api } = await import('./api'); const session = await import('./session');
    await api.post('/auth/logout'); session.setSessionUser(null);
    await api.get('/public');
    expect(fetcher.mock.lastCall?.[1]).toMatchObject({ credentials: 'omit' });
  });
});
