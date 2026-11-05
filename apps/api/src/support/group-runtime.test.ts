import { afterEach, it, expect, vi } from 'vitest';
import { startGroupPvpRuntime, groupPvpWorkerReady } from '../games/group-pvp/runtime.js';
afterEach(() => {
  vi.useRealTimers();
});
it('runs only when enabled, waits for success, pauses on failure and stops without another tick', async () => {
  vi.useFakeTimers();
  const tick = vi.fn().mockResolvedValue(undefined);
  const report = vi.fn();
  const stopOff = startGroupPvpRuntime({ enabled: false, tick, report });
  expect(groupPvpWorkerReady()).toBe(false);
  expect(tick).not.toHaveBeenCalled();
  stopOff();
  const stop = startGroupPvpRuntime({ enabled: true, tick, report });
  await vi.advanceTimersByTimeAsync(0);
  expect(groupPvpWorkerReady()).toBe(true);
  tick.mockRejectedValueOnce(Error('private database detail'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(groupPvpWorkerReady()).toBe(false);
  expect(report).toHaveBeenCalledWith();
  await vi.advanceTimersByTimeAsync(1000);
  expect(groupPvpWorkerReady()).toBe(true);
  stop();
  const count = tick.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenCalledTimes(count);
  expect(groupPvpWorkerReady()).toBe(false);
});
it('does not overlap slow ticks and treats per-round failures as unhealthy', async () => {
  vi.useFakeTimers();
  let done!: () => void;
  const tick = vi.fn().mockImplementation(
    (fail) =>
      new Promise<void>((resolve) => {
        done = () => {
          fail('round', Error('private'));
          resolve();
        };
      })
  );
  const stop = startGroupPvpRuntime({ enabled: true, tick, report: vi.fn() });
  await vi.advanceTimersByTimeAsync(10000);
  expect(tick).toHaveBeenCalledTimes(1);
  expect(groupPvpWorkerReady()).toBe(false);
  done();
  await vi.advanceTimersByTimeAsync(0);
  expect(groupPvpWorkerReady()).toBe(false);
  stop();
});
