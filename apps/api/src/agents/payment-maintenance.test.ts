import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./order-service.js', () => ({ sweepExpiredAgentOrders: vi.fn() }));
vi.mock('../withdrawals/timeout-service.js', () => ({ sweepWithdrawalTimeouts: vi.fn() }));
import { schedulePaymentMaintenance } from './payment-maintenance.js';
afterEach(() => {
  vi.useRealTimers();
});
it('does not overlap sweeps and waits for the in-flight job during shutdown', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const job = vi.fn(
      () =>
        new Promise<void>((r) => {
          finish = r;
        })
    ),
    other = vi.fn(async () => {});
  const stop = schedulePaymentMaintenance([job, other], vi.fn(), 1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(job).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
  let stopped = false;
  const stopping = stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await stopping;
  await vi.advanceTimersByTimeAsync(5000);
  expect(job).toHaveBeenCalledTimes(1);
  expect(other).not.toHaveBeenCalled();
});
it('reports a failed sweep but continues independent checks and retries next cycle', async () => {
  vi.useFakeTimers();
  const bad = vi.fn(async () => {
      throw Error('private detail');
    }),
    good = vi.fn(async () => {}),
    report = vi.fn();
  const stop = schedulePaymentMaintenance([bad, good], report, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(report).toHaveBeenCalledWith();
  expect(good).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(bad).toHaveBeenCalledTimes(2);
  expect(good).toHaveBeenCalledTimes(2);
  await stop();
});
