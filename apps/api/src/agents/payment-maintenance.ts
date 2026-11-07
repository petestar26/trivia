import { sweepExpiredAgentOrders } from './order-service.js';
import { sweepWithdrawalTimeouts } from '../withdrawals/timeout-service.js';

// These existing, transaction-protected sweeps never assume an external transfer
// succeeded. Only unsubmitted deposits expire; overdue payouts go to review.
export function startPaymentMaintenance(report: () => void) {
  return schedulePaymentMaintenance(
    [
      async () => {
        const result = await sweepExpiredAgentOrders();
        if (result.failed) throw Error('Deposit expiry requires review');
      },
      async () => {
        await sweepWithdrawalTimeouts({ batchSize: 100 });
      },
    ],
    report
  );
}
export function schedulePaymentMaintenance(
  jobs: Array<() => Promise<void>>,
  report: () => void,
  intervalMs = 60_000
) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const cycle = async () => {
    for (const job of jobs) {
      if (stopped) break;
      try {
        await job();
      } catch {
        report();
      }
    }
    if (!stopped) {
      timer = setTimeout(() => {
        running = cycle();
      }, intervalMs);
      timer.unref?.();
    }
  };
  running = cycle();
  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
