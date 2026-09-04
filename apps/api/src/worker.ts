import { fileURLToPath } from 'node:url';
import { config } from '@socialplay/config';
import { prisma } from '@socialplay/database';
import { sweepWithdrawalTimeouts, TimeoutSweepSummary } from './withdrawals/timeout-service';
import { runWithdrawalReconciliation, ReconciliationReport } from './withdrawals/reconciliation-service';

// W-1D4: withdrawal worker entrypoint.
//
// Runs sweepWithdrawalTimeouts() on a configurable cadence, and
// runWithdrawalReconciliation() on a slower cadence, in a SERIALIZED loop: a
// cycle fully completes (sweep, then reconciliation if due) before the next
// begins, so overlapping cycles can never run concurrently. The loop simply
// awaits each cycle and then awaits a delay — no setInterval, no overlapping
// firing.
//
//   node dist/worker.js            # long-running self-scheduling worker
//   node dist/worker.js --once     # one sweep + one reconciliation, then exit
//
// Graceful shutdown: on SIGTERM/SIGINT the in-flight cycle is allowed to
// finish, no new cycle is scheduled, Prisma disconnects, and the process
// exits 0. A fatal startup error (invalid env config) or a fatal --once cycle
// error exits 1.
//
// Money-movement note: the sweep only ESCALATES to DISPUTED (it never
// auto-completes and never auto-refunds) and reconciliation is read-only.
// No money changes hands in this worker, by design. See timeout-service.ts
// and reconciliation-service.ts for those guarantees.

export interface WorkerConfig {
  once: boolean;
  sweepIntervalMs: number;
  reconciliationIntervalMs: number;
  runReconciliation: boolean;
}

export interface WorkerDeps {
  sweep: () => Promise<TimeoutSweepSummary>;
  reconcile: () => Promise<ReconciliationReport>;
  sleep: (ms: number) => Promise<void>;
  log: (entry: Record<string, unknown>) => void;
  now: () => number;
}

export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
export const DEFAULT_RUN_RECONCILIATION = true;
export const ONCE_FLAG = '--once';

// Sentinel for "reconciliation has never run yet". Distinct from any real
// timestamp so the very first cycle always performs a reconciliation run.
const NEVER_RAN = -1;

export function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`expected true/false/1/0, got "${value}"`);
}

export function parseWorkerConfig(args: string[], env: Record<string, string | undefined>): WorkerConfig {
  return {
    once: args.includes(ONCE_FLAG),
    sweepIntervalMs: parsePositiveInt(env.WORKER_SWEEP_INTERVAL_MS, DEFAULT_SWEEP_INTERVAL_MS, 'WORKER_SWEEP_INTERVAL_MS'),
    reconciliationIntervalMs: parsePositiveInt(
      env.WORKER_RECONCILIATION_INTERVAL_MS,
      DEFAULT_RECONCILIATION_INTERVAL_MS,
      'WORKER_RECONCILIATION_INTERVAL_MS'
    ),
    runReconciliation: parseBool(env.WORKER_RUN_RECONCILIATION, DEFAULT_RUN_RECONCILIATION),
  };
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

export function createWorkerLogger(): (entry: Record<string, unknown>) => void {
  return (entry) => {
    // Callers only ever emit whitelisted fields (never paymentSnapshot, user
    // payout details, or credentials). Log lines are structured JSON on stdout.
    console.log(JSON.stringify(entry));
  };
}

export function createAbortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
}

// Runs one sweep, then one reconciliation if (a) enabled and (b) the cadence
// has elapsed. Returns the updated "last reconciliation ran" timestamp.
// Throws if either step fails — the caller decides whether to continue or
// exit. durationMs is measured with deps.now() so tests can drive the clock.
export async function runWorkerCycle(
  deps: WorkerDeps,
  config: WorkerConfig,
  lastReconcileAt: number
): Promise<number> {
  const sweepStart = deps.now();
  const summary = await deps.sweep();
  deps.log({
    level: 'info',
    msg: 'timeout sweep completed',
    durationMs: deps.now() - sweepStart,
    results: summary,
  });

  if (!config.runReconciliation) return lastReconcileAt;
  // NEVER_RAN means reconciliation has never run (startup) — run it
  // immediately, then respect the configured cadence thereafter.
  if (lastReconcileAt !== NEVER_RAN && deps.now() - lastReconcileAt < config.reconciliationIntervalMs) {
    return lastReconcileAt;
  }

  const reconcileStart = deps.now();
  const report = await deps.reconcile();
  deps.log({
    level: 'info',
    msg: 'reconciliation completed',
    durationMs: deps.now() - reconcileStart,
    totalIssues: report.totalIssues,
    ranAt: report.ranAt,
  });
  if (report.totalIssues > 0) {
    deps.log({
      level: 'warn',
      msg: 'reconciliation detected issues',
      totalIssues: report.totalIssues,
      ranAt: report.ranAt,
    });
  }
  return deps.now();
}

export async function runWorkerLoop(deps: WorkerDeps, config: WorkerConfig, signal: AbortSignal): Promise<number> {
  let lastReconcileAt = NEVER_RAN;

  const cycle = async () => {
    lastReconcileAt = await runWorkerCycle(deps, config, lastReconcileAt);
  };

  if (config.once) {
    try {
      await cycle();
      return 0;
    } catch (err) {
      deps.log({ level: 'error', msg: 'worker cycle failed', error: serializeError(err) });
      return 1;
    }
  }

  while (!signal.aborted) {
    try {
      await cycle();
    } catch (err) {
      // A failed cycle must not kill a long-running worker; log and continue.
      deps.log({ level: 'error', msg: 'worker cycle failed; continuing', error: serializeError(err) });
    }
    if (signal.aborted) break;
    await deps.sleep(config.sweepIntervalMs);
  }
  return 0;
}

async function main(): Promise<number> {
  let workerConfig: WorkerConfig;
  try {
    workerConfig = parseWorkerConfig(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'invalid worker configuration', error: serializeError(err) }));
    return 1;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'withdrawal worker starting',
      nodeEnv: config.NODE_ENV,
      once: workerConfig.once,
      sweepIntervalMs: workerConfig.sweepIntervalMs,
      reconciliationIntervalMs: workerConfig.reconciliationIntervalMs,
      runReconciliation: workerConfig.runReconciliation,
    })
  );

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const deps: WorkerDeps = {
    sweep: () => sweepWithdrawalTimeouts(),
    reconcile: () => runWithdrawalReconciliation(),
    sleep: createAbortableSleep(controller.signal),
    log: createWorkerLogger(),
    now: Date.now,
  };

  const code = await runWorkerLoop(deps, workerConfig, controller.signal);
  await prisma.$disconnect();
  if (code !== 0) {
    process.exitCode = code;
  }
  return code;
}

// Same cross-platform guard as server.ts: file://${process.argv[1]} builds a
// malformed URL on Windows (argv[1] is a native backslash path), so compare
// native-to-native via fileURLToPath instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main };