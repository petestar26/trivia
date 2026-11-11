import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeLaunchIntent, createLaunchIntent } from './launch-intent';
import { installMemoryStorage } from '@/test/memory-storage';

let storage: ReturnType<typeof installMemoryStorage>;
beforeEach(async () => {
  storage = installMemoryStorage();
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  storage.restore();
});

describe('one-time launch intents', async () => {
  it('lets the clicking member launch the clicked target exactly once', async () => {
    const nonce = createLaunchIntent('casino', 'member-a', 'studio/slot');
    expect(await consumeLaunchIntent('casino', 'member-a', nonce, 'studio/slot')).toBe(true);
    expect(await consumeLaunchIntent('casino', 'member-a', nonce, 'studio/slot')).toBe(false);
    expect(storage.memory.size).toBe(0);
  });

  it.each([
    ['another member', 'sports', 'member-b', ''],
    ['another launch kind', 'casino', 'member-a', ''],
    ['another casino game', 'sports', 'member-a', 'other-game'],
  ] as const)('refuses %s and still spends the intent', async (_label, kind, userId, target) => {
    const nonce = createLaunchIntent('sports', 'member-a');
    expect(await consumeLaunchIntent(kind, userId, nonce, target)).toBe(false);
    expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
  });

  it.each([null, '', 'not-a-nonce', '../salem-language', '0f8b1c2e-3d4a-4b5c-8d9e-112233445566'])(
    'refuses a missing, malformed or unknown nonce %j',
    async (nonce) => {
      expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
    }
  );

  it('refuses a signed-out visitor', async () => {
    expect(createLaunchIntent('sports', '')).toBeNull();
    const nonce = createLaunchIntent('sports', 'member-a');
    expect(await consumeLaunchIntent('sports', undefined, nonce)).toBe(false);
  });

  it('expires after a minute and clears expired intents when a new one is made', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const old = createLaunchIntent('sports', 'member-a');
    vi.setSystemTime(Date.now() + 61_000);
    expect(await consumeLaunchIntent('sports', 'member-a', old)).toBe(false);
    const stale = createLaunchIntent('sports', 'member-a');
    vi.setSystemTime(Date.now() + 61_000);
    createLaunchIntent('sports', 'member-a');
    expect(storage.memory.size).toBe(1);
    expect(await consumeLaunchIntent('sports', 'member-a', stale)).toBe(false);
  });

  it('fails closed when storage is unavailable', async () => {
    storage.restore();
    // The shared test setup's inert localStorage stores nothing.
    const nonce = createLaunchIntent('sports', 'member-a');
    expect(nonce).toBeNull();
    expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
    storage = installMemoryStorage();
  });
});

it('authorizes only one of two concurrent tab consumers', async () => {
  const nonce = createLaunchIntent('sports', 'member-a');
  const results = await Promise.all([
    consumeLaunchIntent('sports', 'member-a', nonce),
    consumeLaunchIntent('sports', 'member-a', nonce),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
});
it('rejects an intent after logout and login as the same member', async () => {
  const nonce = createLaunchIntent('sports', 'member-a');
  localStorage.setItem(
    'socialplay.session-boundary',
    JSON.stringify({ revision: 'new-login', signedOut: false })
  );
  expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
});
it('rejects a session change while waiting for the cross-tab lock', async () => {
  const nonce = createLaunchIntent('sports', 'member-a');
  const result = consumeLaunchIntent('sports', 'member-a', nonce);
  localStorage.setItem(
    'socialplay.session-boundary',
    JSON.stringify({ revision: 'changed', signedOut: false })
  );
  expect(await result).toBe(false);
});
it('fails closed without Web Locks or when a lock is denied', async () => {
  const nonce = createLaunchIntent('sports', 'member-a');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  expect(createLaunchIntent('sports', 'member-a')).toBeNull();
  expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: () => Promise.reject(Error('Denied')) },
  });
  expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
});

it.each(['reload', 'back_forward'])(
  'spends but refuses an unused nonce on %s navigation',
  async (type) => {
    const nonce = createLaunchIntent('sports', 'member-a');
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: vi.fn(() => [{ type }]),
    });
    try {
      expect(await consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
      expect(storage.memory.size).toBe(0);
    } finally {
      Reflect.deleteProperty(performance, 'getEntriesByType');
    }
  }
);
