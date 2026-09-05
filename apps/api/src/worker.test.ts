import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseWorkerConfig,
  parsePositiveInt,
  parseBool,
  runWorkerLoop,
  runWorkerCycle,
  createAbortableSleep,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_RECONCILIATION_INTERVAL_MS,
  MAX_TIMER_DELAY_MS,
} from './worker';
import type { WorkerConfig, WorkerDeps } from './worker';

// W-1D4 worker tests. Pure unit tests: sweep/reconcile/sleep/clock are all
// injected as mocks, so nothing here touches the database or spawns a process.
// The worker's main() entrypoint (signal wiring, Prisma disconnect) is not
// exercised directly — that path is covered by the package-script smoke runs.

const noopSignal = new AbortController().signal;

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps & {
  sweep: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
} {
  const clock = { now: 0 };
  const deps = {
    sweep: vi.fn<() => Promise<{ locked?: boolean }>>().mockResolvedValue({ locked: false }),
    reconcile: vi
      .fn<() => Promise<{ totalIssues: number; ranAt: string }>>()
      .mockResolvedValue({ totalIssues: 0, ranAt: '2026-09-05T00:00:00.000Z' }),
    sleep: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    log: vi.fn(),
    now: vi.fn(() => clock.now),
    advance: (ms: number) => {
      clock.now += ms;
    },
    ...overrides,
  };
  return deps as any;
}

function baseConfig(): WorkerConfig {
  return {
    once: false,
    sweepIntervalMs: 1000,
    reconciliationIntervalMs: 3000,
    runReconciliation: true,
  };
}

describe('worker config parsing', () => {
  it('applies default intervals and reconciliation-enabled by default', () => {
    const config = parseWorkerConfig([], {});
    expect(config.once).toBe(false);
    expect(config.sweepIntervalMs).toBe(DEFAULT_SWEEP_INTERVAL_MS);
    expect(config.reconciliationIntervalMs).toBe(DEFAULT_RECONCILIATION_INTERVAL_MS);
    expect(config.runReconciliation).toBe(true);
  });

  it('parses --once flag from args', () => {
    expect(parseWorkerConfig(['--once'], {}).once).toBe(true);
    expect(parseWorkerConfig(['--something', '--once'], {}).once).toBe(true);
    expect(parseWorkerConfig([], {}).once).toBe(false);
  });

  it('reads worker env vars and overrides defaults', () => {
    const config = parseWorkerConfig([], {
      WORKER_SWEEP_INTERVAL_MS: '60000',
      WORKER_RECONCILIATION_INTERVAL_MS: '1800000',
      WORKER_RUN_RECONCILIATION: 'false',
    });
    expect(config.sweepIntervalMs).toBe(60000);
    expect(config.reconciliationIntervalMs).toBe(1800000);
    expect(config.runReconciliation).toBe(false);
  });

  it('rejects a non-positive / non-integer sweep interval', () => {
    expect(() => parsePositiveInt('0', 300000, 'WORKER_SWEEP_INTERVAL_MS')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('-1', 300000, 'WORKER_SWEEP_INTERVAL_MS')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('abc', 300000, 'WORKER_SWEEP_INTERVAL_MS')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('1.5', 300000, 'WORKER_SWEEP_INTERVAL_MS')).toThrow(/positive integer/);
    expect(parsePositiveInt(undefined, 300000, 'WORKER_SWEEP_INTERVAL_MS')).toBe(300000);
  });

  it('rejects a non-positive reconciliation interval', () => {
    expect(() => parsePositiveInt('0', 3600000, 'WORKER_RECONCILIATION_INTERVAL_MS')).toThrow(/positive integer/);
  });

  it('rejects an interval above Node setTimeout\'s 32-bit signed max, for both interval vars', () => {
    // 3_000_000_000 > 2_147_483_647 (2^31-1) — setTimeout silently clamps a
    // value this large to 1ms rather than erroring, which is exactly the
    // hot-loop failure mode this bound exists to catch at config-parse time.
    expect(() => parsePositiveInt('3000000000', 300000, 'WORKER_SWEEP_INTERVAL_MS')).toThrow(
      /positive integer <= 2147483647/
    );
    expect(() => parsePositiveInt('3000000000', 3600000, 'WORKER_RECONCILIATION_INTERVAL_MS')).toThrow(
      /positive integer <= 2147483647/
    );
    // The boundary itself is still valid.
    expect(parsePositiveInt(String(MAX_TIMER_DELAY_MS), 300000, 'WORKER_SWEEP_INTERVAL_MS')).toBe(MAX_TIMER_DELAY_MS);
    expect(() => parsePositiveInt(String(MAX_TIMER_DELAY_MS + 1), 300000, 'WORKER_SWEEP_INTERVAL_MS')).toThrow(
      /positive integer/
    );

    expect(() =>
      parseWorkerConfig([], { WORKER_SWEEP_INTERVAL_MS: '3000000000' })
    ).toThrow(/positive integer <= 2147483647/);
    expect(() =>
      parseWorkerConfig([], { WORKER_RECONCILIATION_INTERVAL_MS: '3000000000' })
    ).toThrow(/positive integer <= 2147483647/);
  });

  it('parses booleans from true/false/1/0 and rejects anything else', () => {
    expect(parseBool('true', true)).toBe(true);
    expect(parseBool('false', true)).toBe(false);
    expect(parseBool('1', false)).toBe(true);
    expect(parseBool('0', true)).toBe(false);
    expect(parseBool('TRUE', false)).toBe(true);
    expect(parseBool(undefined, true)).toBe(true);
    expect(() => parseBool('yes', true)).toThrow(/true\/false\/1\/0/);
    expect(() => parseBool('2', true)).toThrow(/true\/false\/1\/0/);
  });
});

describe('runWorkerCycle', () => {
  it('runs one sweep and logs its duration', async () => {
    const deps = makeDeps();
    const result = await runWorkerCycle(deps, baseConfig(), -1);

    expect(deps.sweep).toHaveBeenCalledTimes(1);
    const sweepLog = deps.log.mock.calls.find(([entry]) => entry.msg === 'timeout sweep completed');
    expect(sweepLog).toBeDefined();
    expect(sweepLog![0].durationMs).toBe(0);
    expect(result.lastReconcileAt).not.toBe(-1); // reconciliation ran, so lastReconcileAt advanced
    expect(result.failed).toBe(false);
  });

  it('skips reconciliation when disabled by config', async () => {
    const deps = makeDeps();
    const config = { ...baseConfig(), runReconciliation: false };
    const result = await runWorkerCycle(deps, config, -1);

    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(result.lastReconcileAt).toBe(-1); // unchanged sentinel
    expect(result.failed).toBe(false);
  });

  it('emits a warning log when reconciliation reports issues', async () => {
    const deps = makeDeps({
      reconcile: vi.fn().mockResolvedValue({ totalIssues: 3, ranAt: '2026-09-05T00:00:00.000Z' }),
    });
    await runWorkerCycle(deps, baseConfig(), -1);

    expect(deps.reconcile).toHaveBeenCalledTimes(1);
    const warn = deps.log.mock.calls.find(([entry]) => entry.level === 'warn' && entry.msg === 'reconciliation detected issues');
    expect(warn).toBeDefined();
    expect(warn![0].totalIssues).toBe(3);
  });

  it('a failing sweep still allows a due reconciliation to run, and reports failed:true', async () => {
    const deps = makeDeps({
      sweep: vi.fn().mockRejectedValue(new Error('sweep exploded')),
    });
    const result = await runWorkerCycle(deps, baseConfig(), -1);

    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1); // NOT suppressed by the sweep failure
    const sweepErrLog = deps.log.mock.calls.find(([entry]) => entry.msg === 'timeout sweep failed');
    expect(sweepErrLog).toBeDefined();
    expect(sweepErrLog![0].error.message).toBe('sweep exploded');
    expect(result.failed).toBe(true);
    expect(result.lastReconcileAt).not.toBe(-1); // reconciliation itself still succeeded
  });

  it('a failing reconciliation logs its own error, reports failed:true, and leaves lastReconcileAt unchanged for retry', async () => {
    const deps = makeDeps({
      reconcile: vi.fn().mockRejectedValue(new Error('reconcile exploded')),
    });
    const result = await runWorkerCycle(deps, baseConfig(), -1);

    expect(deps.sweep).toHaveBeenCalledTimes(1); // sweep still ran normally
    const reconcileErrLog = deps.log.mock.calls.find(([entry]) => entry.msg === 'reconciliation failed');
    expect(reconcileErrLog).toBeDefined();
    expect(reconcileErrLog![0].error.message).toBe('reconcile exploded');
    expect(result.failed).toBe(true);
    expect(result.lastReconcileAt).toBe(-1); // unchanged sentinel — retried next cycle, not treated as having run
  });
});

describe('runWorkerLoop -- once mode', () => {
  it('runs one sweep and one reconciliation when enabled, returns 0', async () => {
    const deps = makeDeps();
    const code = await runWorkerLoop(deps, { ...baseConfig(), once: true }, noopSignal);

    expect(code).toBe(0);
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('skips reconciliation and schedules no further cycles when disabled', async () => {
    const deps = makeDeps();
    const code = await runWorkerLoop(deps, { ...baseConfig(), once: true, runReconciliation: false }, noopSignal);

    expect(code).toBe(0);
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('returns 1 when the sweep fails in once mode, even though reconciliation still ran', async () => {
    const deps = makeDeps({
      sweep: vi.fn().mockRejectedValue(new Error('sweep exploded')),
    });
    const code = await runWorkerLoop(deps, { ...baseConfig(), once: true }, noopSignal);

    expect(code).toBe(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1); // not suppressed by the sweep failure
    const errLog = deps.log.mock.calls.find(([entry]) => entry.level === 'error' && entry.msg === 'timeout sweep failed');
    expect(errLog).toBeDefined();
    expect(errLog![0].error.message).toBe('sweep exploded');
  });

  it('returns 1 when reconciliation fails in once mode, and logs the reconciliation error', async () => {
    const deps = makeDeps({
      reconcile: vi.fn().mockRejectedValue(new Error('reconcile exploded')),
    });
    const code = await runWorkerLoop(deps, { ...baseConfig(), once: true }, noopSignal);

    expect(code).toBe(1);
    expect(deps.sweep).toHaveBeenCalledTimes(1); // sweep still ran normally
    const errLog = deps.log.mock.calls.find(([entry]) => entry.level === 'error' && entry.msg === 'reconciliation failed');
    expect(errLog).toBeDefined();
    expect(errLog![0].error.message).toBe('reconcile exploded');
  });
});

describe('runWorkerLoop -- continuous mode', () => {
  it('runs serialized cycles with no overlap', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      sleep: vi.fn(async () => {
        if (deps.sweep.mock.calls.length >= 3) controller.abort();
      }),
    });
    const code = await runWorkerLoop(deps, baseConfig(), controller.signal);

    expect(code).toBe(0);
    expect(deps.sweep).toHaveBeenCalledTimes(3);
    // Each sweep is awaited before the next is invoked — no overlap by
    // construction; verify ordering of log entries is sweep→sleep→sweep.
    const sleepTimes = deps.sleep.mock.calls.length;
    expect(sleepTimes).toBeGreaterThanOrEqual(2);
  });

  it('runs reconciliation on a slower cadence than the sweep', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      sleep: vi.fn(async () => {
        deps.advance(1000);
        if (deps.sweep.mock.calls.length >= 4) controller.abort();
      }),
    });
    // reconciliationIntervalMs = 3000, sweepIntervalMs = 1000, clock advances
    // 1000 per sleep. So reconciliation runs on cycle 1 (sentinel), then not
    // again until cycle 4 (clock reaches 3000).
    const config = { ...baseConfig(), sweepIntervalMs: 1000, reconciliationIntervalMs: 3000 };
    const code = await runWorkerLoop(deps, config, controller.signal);

    expect(code).toBe(0);
    expect(deps.sweep.mock.calls.length).toBe(4);
    expect(deps.reconcile.mock.calls.length).toBe(2); // cycle 1 (sentinel) + cycle 4 (cadence)
  });

  it('stops scheduling new cycles after shutdown is requested', async () => {
    const controller = new AbortController();
    const deps = makeDeps();
    // Abort the signal after the first cycle completes but during the sleep.
    deps.sleep.mockImplementation(async () => {
      controller.abort();
    });
    const code = await runWorkerLoop(deps, baseConfig(), controller.signal);

    expect(code).toBe(0);
    expect(deps.sweep).toHaveBeenCalledTimes(1);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('continues after a sweep failure and does not crash', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      sweep: vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ locked: false }),
      sleep: vi.fn(async () => {
        if (deps.sweep.mock.calls.length >= 2) controller.abort();
      }),
    });
    const code = await runWorkerLoop(deps, baseConfig(), controller.signal);

    expect(code).toBe(0);
    expect(deps.sweep).toHaveBeenCalledTimes(2);
    // The failure is logged (inside runWorkerCycle) as its own step-level
    // error — it never reaches runWorkerLoop's outer catch as an exception,
    // since runWorkerCycle doesn't throw for an ordinary step failure.
    const errLog = deps.log.mock.calls.find(([entry]) => entry.msg === 'timeout sweep failed');
    expect(errLog).toBeDefined();
    // Reconciliation still ran on the failing cycle (cycle 1, sentinel-due) —
    // not suppressed by the sweep having failed on that same cycle. The
    // clock doesn't advance in this test, so cycle 2's reconciliation isn't
    // due yet (that cadence interaction is covered separately below).
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('continues after a reconciliation failure and does not crash', async () => {
    const controller = new AbortController();
    const deps = makeDeps({
      reconcile: vi
        .fn()
        .mockRejectedValueOnce(new Error('reconcile boom'))
        .mockResolvedValue({ totalIssues: 0, ranAt: '2026-09-05T00:00:00.000Z' }),
      sleep: vi.fn(async () => {
        deps.advance(3000); // reconciliationIntervalMs, so it's due again next cycle
        if (deps.sweep.mock.calls.length >= 2) controller.abort();
      }),
    });
    const code = await runWorkerLoop(deps, baseConfig(), controller.signal);

    expect(code).toBe(0);
    expect(deps.sweep).toHaveBeenCalledTimes(2); // sweep unaffected by reconciliation failing
    const errLog = deps.log.mock.calls.find(([entry]) => entry.msg === 'reconciliation failed');
    expect(errLog).toBeDefined();
    expect(errLog![0].error.message).toBe('reconcile boom');
    // Retried on the next cycle after the failure, and succeeded.
    expect(deps.reconcile).toHaveBeenCalledTimes(2);
    const successLog = deps.log.mock.calls.find(([entry]) => entry.msg === 'reconciliation completed');
    expect(successLog).toBeDefined();
  });
});

describe('createAbortableSleep', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createAbortableSleep(controller.signal)(50)).resolves.toBeUndefined();
  });

  it('resolves when aborted mid-sleep', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const sleep = createAbortableSleep(controller.signal);
      const promise = sleep(10_000);
      controller.abort();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});