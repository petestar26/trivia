import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeLaunchIntent, createLaunchIntent } from './launch-intent';
import { installMemoryStorage } from '@/test/memory-storage';

let storage: ReturnType<typeof installMemoryStorage>;
beforeEach(() => {
  storage = installMemoryStorage();
});
afterEach(() => {
  vi.useRealTimers();
  storage.restore();
});

describe('one-time launch intents', () => {
  it('lets the clicking member launch the clicked target exactly once', () => {
    const nonce = createLaunchIntent('casino', 'member-a', 'studio/slot');
    expect(consumeLaunchIntent('casino', 'member-a', nonce, 'studio/slot')).toBe(true);
    expect(consumeLaunchIntent('casino', 'member-a', nonce, 'studio/slot')).toBe(false);
    expect(storage.memory.size).toBe(0);
  });

  it.each([
    ['another member', 'sports', 'member-b', ''],
    ['another launch kind', 'casino', 'member-a', ''],
    ['another casino game', 'sports', 'member-a', 'other-game'],
  ] as const)('refuses %s and still spends the intent', (_label, kind, userId, target) => {
    const nonce = createLaunchIntent('sports', 'member-a');
    expect(consumeLaunchIntent(kind, userId, nonce, target)).toBe(false);
    expect(consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
  });

  it.each([null, '', 'not-a-nonce', '../salem-language', '0f8b1c2e-3d4a-4b5c-8d9e-112233445566'])(
    'refuses a missing, malformed or unknown nonce %j',
    (nonce) => {
      expect(consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
    }
  );

  it('refuses a signed-out visitor', () => {
    expect(createLaunchIntent('sports', '')).toBeNull();
    const nonce = createLaunchIntent('sports', 'member-a');
    expect(consumeLaunchIntent('sports', undefined, nonce)).toBe(false);
  });

  it('expires after a minute and clears expired intents when a new one is made', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const old = createLaunchIntent('sports', 'member-a');
    vi.setSystemTime(Date.now() + 61_000);
    expect(consumeLaunchIntent('sports', 'member-a', old)).toBe(false);
    const stale = createLaunchIntent('sports', 'member-a');
    vi.setSystemTime(Date.now() + 61_000);
    createLaunchIntent('sports', 'member-a');
    expect(storage.memory.size).toBe(1);
    expect(consumeLaunchIntent('sports', 'member-a', stale)).toBe(false);
  });

  it('fails closed when storage is unavailable', () => {
    storage.restore();
    // The shared test setup's inert localStorage stores nothing.
    const nonce = createLaunchIntent('sports', 'member-a');
    expect(nonce).toBeNull();
    expect(consumeLaunchIntent('sports', 'member-a', nonce)).toBe(false);
    storage = installMemoryStorage();
  });
});
