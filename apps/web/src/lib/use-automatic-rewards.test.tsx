import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useAutomaticRewards } from './use-automatic-rewards';

const post = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({
  api: { post },
  unwrapData: (response: { data: unknown }) => response.data,
}));
let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  vi.useFakeTimers();
  client = new QueryClient();
  post.mockReset().mockResolvedValue({ data: { earned: false, credited: 0 } });
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('records signed-in activity automatically and keeps a long-lived session eligible across days', async () => {
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  post.mockResolvedValueOnce({ data: { earned: true, credited: 1 } });
  const hook = renderHook(({ id }) => useAutomaticRewards(id), {
    wrapper,
    initialProps: { id: 'member-1' as string | undefined },
  });
  await act(async () => {});
  expect(post).toHaveBeenCalledWith('/member-rewards/activity', {}, undefined, {
    signal: expect.any(AbortSignal),
  });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['member-rewards', 'member-1'] });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(post).toHaveBeenCalledTimes(2);
  // Logging out removes the automatic activity timer and listeners.
  hook.rerender({ id: undefined });
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(post).toHaveBeenCalledTimes(2);
});

it('waits while hidden or offline and resumes automatically with a bounded retry', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  renderHook(() => useAutomaticRewards('member-2'), { wrapper });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(post).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(post).not.toHaveBeenCalled();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  // A hung transport cannot prevent all future rewards for this session.
  post.mockImplementationOnce(() => new Promise(() => {}));
  act(() => window.dispatchEvent(new Event('online')));
  expect(post).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(post).toHaveBeenCalledTimes(2);
});

it('aborts old-account requests and never refreshes an account from a late response', async () => {
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  let complete!: (value: unknown) => void;
  post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const hook = renderHook(({ id }) => useAutomaticRewards(id), {
    wrapper,
    initialProps: { id: 'old' },
  });
  const oldSignal = post.mock.calls[0][3].signal;
  hook.rerender({ id: 'new' });
  await act(async () => complete({ data: { earned: true, credited: 1 } }));
  expect(oldSignal.aborted).toBe(true);
  expect(invalidate).not.toHaveBeenCalled();
});
