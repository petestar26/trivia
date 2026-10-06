// Only coordination metadata is stored here, never credentials or user data.
const STORAGE_KEY = 'socialplay.session-boundary';
const LOCK_NAME = 'socialplay.session-cookie';
const TIMEOUT_MS = 10_000;
type Boundary = { revision: string; signedOut: boolean };
let memory: Boundary = { revision: '', signedOut: false };
let userId: string | null = null;
let renewal: Promise<void> | null = null;
let deniedRevision: string | null = null;
let retryAfter = 0;
let serial: Promise<unknown> = Promise.resolve();
let credentialsPending = 0;
let identityUnsettled = false;

function boundary(): Boundary {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (typeof value.revision === 'string' && typeof value.signedOut === 'boolean') return value;
    }
  } catch { /* Storage restrictions must not break explicit sign-in. */ }
  return memory;
}
let observedRevision = boundary().revision;

function publish(signedOut: boolean): void {
  memory = { revision: `${Date.now()}-${Math.random()}`, signedOut };
  observedRevision = memory.revision;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(memory)); } catch { /* per-tab fallback */ }
}

export function sessionRevision(): string { return boundary().revision; }
export function sessionSignedOut(): boolean { return boundary().signedOut; }
export function assertSessionReadable(): void {
  if (credentialsPending || identityUnsettled || sessionRevision() !== observedRevision) throw new DOMException('Session changing', 'AbortError');
}
export function setSessionUser(id: string | null): void { userId = id; identityUnsettled = false; }
export function assertSessionRevision(revision: string): void {
  if (revision !== sessionRevision() || revision !== observedRevision) throw new DOMException('Session changed', 'AbortError');
}

// Other tabs must remount the full authenticated tree before reading under a
// new cookie identity. Requests also check the persisted revision before
// publishing, so they cannot win a race against delivery of this event.
window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY) window.location.reload();
});

async function locked<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (navigator.locks) return await navigator.locks.request(LOCK_NAME, { signal }, action);
  const next = serial.catch(() => undefined).then(() => {
    signal.throwIfAborted();
    return action();
  });
  serial = next;
  return next;
}

function deadline<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return action(controller.signal).finally(() => clearTimeout(timeout));
}

export async function credentialRequest<T>(endpoint: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // Persist logout intent even if the network fails. A later reload must not
  // revive cookies that the server was unable to clear. Only explicit successful
  // login/register clears this marker.
  publish(endpoint === '/auth/logout' || sessionSignedOut());
  const revision = sessionRevision();
  identityUnsettled = true;
  credentialsPending += 1;
  try {
    return await deadline((signal) => locked(signal, async () => {
      assertSessionRevision(revision);
      const result = await action(signal);
      assertSessionRevision(revision);
      publish(endpoint === '/auth/logout');
      return result;
    }));
  } catch (error) {
    if (revision === sessionRevision()) {
      // An older successful response may already have changed the cookies.
      // A failed latest intent must never retain the previous user's cache.
      publish(true);
      userId = null;
      identityUnsettled = false;
      window.dispatchEvent(new Event('socialplay:session-invalidated'));
    }
    throw error;
  } finally { credentialsPending -= 1; }
}

export function waitForSession<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function renewSession(baseUrl: string, revision: string): Promise<void> {
  if (renewal) return renewal;
  // Without cross-tab locking, competing one-use rotations can lose a cookie.
  // Fail closed on older browsers instead of pretending a per-tab mutex suffices.
  if (!navigator.locks || sessionSignedOut() || deniedRevision === revision || Date.now() < retryAfter) return Promise.reject(new Error('Session renewal unavailable'));
  const expectedUser = userId;
  renewal = deadline((signal) => locked(signal, async () => {
    assertSessionRevision(revision);
    if (sessionSignedOut()) throw new Error('Signed out');
    const probe = () => fetch(`${baseUrl}/auth/me`, { credentials: 'include', signal, cache: 'no-store' });
    let response = await probe();
    assertSessionRevision(revision);
    if (sessionSignedOut()) throw new Error('Signed out');
    if (response.status === 401) {
      const refreshed = await fetch(`${baseUrl}/auth/refresh`, {
        method: 'POST', credentials: 'include', signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      if (!refreshed.ok) {
        if (refreshed.status === 401 || refreshed.status === 403) deniedRevision = revision;
        throw new Error('Session renewal failed');
      }
      await refreshed.json();
      response = await probe();
    }
    if (!response.ok) throw new Error('Session unavailable');
    const data = await response.json();
    assertSessionRevision(revision);
    if (!data.success || !data.data?.user?.id || (expectedUser && data.data.user.id !== expectedUser)) {
      throw new Error('Session identity changed');
    }
  })).catch((error) => { retryAfter = Date.now() + 5_000; throw error; })
    .finally(() => { renewal = null; });
  return renewal;
}
