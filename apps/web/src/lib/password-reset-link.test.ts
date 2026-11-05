import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
  vi.resetModules();
});

it('restores a recovery link in the same tab after a fresh document load', async () => {
  window.history.replaceState(null, '', '/reset-password#token=private-one-use-link');
  const initial = await import('./password-reset-link');
  expect(initial.readPasswordResetLink()).toBe('private-one-use-link');
  window.history.replaceState(null, '', '/reset-password');
  vi.resetModules();
  const reloaded = await import('./password-reset-link');
  expect(reloaded.readPasswordResetLink()).toBe('private-one-use-link');
  reloaded.clearPasswordResetLink();
  vi.resetModules();
  expect((await import('./password-reset-link')).readPasswordResetLink()).toBe('');
});

it('does not retain a link beyond its server expiry', async () => {
  const now = Date.now();
  const token = btoa(JSON.stringify({ exp: now + 60_000 })) + '.test-signature';
  window.history.replaceState(null, '', '/reset-password#token=' + token);
  const recovery = await import('./password-reset-link');
  expect(recovery.readPasswordResetLink()).toBe(token);
  window.history.replaceState(null, '', '/reset-password');
  vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
  expect(recovery.readPasswordResetLink()).toBe('');
  expect(sessionStorage.length).toBe(0);
});

it('does not fall back to a previous account link when the new link is empty', async () => {
  const recovery = await import('./password-reset-link');
  window.history.replaceState(null, '', '/reset-password#token=previous-link');
  recovery.readPasswordResetLink();
  window.history.replaceState(null, '', '/reset-password#token=');
  expect(recovery.readPasswordResetLink()).toBe('');
  window.history.replaceState(null, '', '/reset-password');
  expect(recovery.readPasswordResetLink()).toBe('');
});

it('keeps the open form usable when browser storage is unavailable', async () => {
  for (const method of ['getItem', 'setItem', 'removeItem'] as const)
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'SecurityError');
    });
  const recovery = await import('./password-reset-link');
  window.history.replaceState(null, '', '/reset-password#token=current-link');
  expect(recovery.readPasswordResetLink()).toBe('current-link');
  window.history.replaceState(null, '', '/reset-password');
  expect(recovery.readPasswordResetLink()).toBe('current-link');
  recovery.clearPasswordResetLink();
  expect(recovery.readPasswordResetLink()).toBe('');
});
