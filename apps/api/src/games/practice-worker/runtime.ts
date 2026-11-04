import { PracticeWorkerHealth, runPracticeWorker } from '../scheduled/practice-worker-runtime.js';
import { workerFailure } from '../../scripts/group-worker-runtime.js';

export const PRACTICE_TASK_FLAGS = Object.freeze({
  DICE: 'SYSTEM_DICE_PRACTICE_ENABLED',
  KENO: 'SYSTEM_KENO_PRACTICE_ENABLED',
  NUMBER: 'NUMBER_CHALLENGE_PRACTICE_ENABLED',
  SKY_CRASH: 'SKY_CRASH_PRACTICE_ENABLED',
  CRASH_POINT: 'CRASH_POINT_PRACTICE_ENABLED',
  DERBY: 'THUNDER_DERBY_PRACTICE_ENABLED',
  DOG_RACING: 'DOG_RACING_PRACTICE_ENABLED',
  FOOTBALL: 'VIRTUAL_FOOTBALL_PRACTICE_ENABLED',
  SPIN: 'SCHEDULED_PRACTICE_WORKER_ENABLED',
} as const);
export type PracticeTaskKind = keyof typeof PRACTICE_TASK_FLAGS;

/** This runner has no PVP, social lifecycle, wallet or ledger task. */
export function enabledPracticeTasks(env: Record<string, string | undefined>): PracticeTaskKind[] {
  return (Object.keys(PRACTICE_TASK_FLAGS) as PracticeTaskKind[]).filter(
    (task) => env[PRACTICE_TASK_FLAGS[task]] === 'true'
  );
}

/** Every enabled loop must make progress; a fast loop cannot hide a stalled one. */
export class PracticeGamesHealth extends PracticeWorkerHealth {
  private readonly loops: Map<PracticeTaskKind, PracticeWorkerHealth>;

  constructor(
    readonly enabled: readonly PracticeTaskKind[],
    now?: () => number
  ) {
    super(now);
    if (!enabled.length || new Set(enabled).size !== enabled.length)
      throw new Error('Practice worker requires distinct enabled tasks');
    this.loops = new Map(enabled.map((task) => [task, new PracticeWorkerHealth(now)]));
  }

  task(task: PracticeTaskKind): PracticeWorkerHealth {
    const health = this.loops.get(task);
    if (!health) throw new Error('Practice task is not enabled');
    return health;
  }

  override stalled() {
    return [...this.loops.values()].some((health) => health.stalled());
  }

  override stop() {
    super.stop();
    for (const health of this.loops.values()) health.stop();
  }

  override snapshot() {
    const snapshots = [...this.loops].map(([task, health]) => [task, health.snapshot()] as const);
    const status =
      ['STOPPING', 'TICK_FAILED', 'STALE', 'STARTING'].find((status) =>
        snapshots.some(([, snapshot]) => snapshot.status === status)
      ) ?? 'OK';
    return {
      status,
      mode: 'PRACTICE' as const,
      coinsAccepted: false,
      ready: snapshots.every(([, snapshot]) => snapshot.ready),
      tasks: Object.fromEntries(snapshots.map(([task, snapshot]) => [task, snapshot.status])),
    };
  }
}

/** Existing service ticks report individual settlement failures through a callback. */
export function observePracticeTick(
  tick: (onError: (id: string, error: unknown) => void) => Promise<void>
): () => Promise<void> {
  return async () => {
    let failed = false;
    let failure: unknown;
    await tick((_id, error) => {
      failed = true;
      failure = error;
    });
    if (failed) throw failure ?? new Error('Practice settlement failed');
  };
}

export async function runPracticeGamesWorker(options: {
  health: PracticeGamesHealth;
  ticks: Partial<Record<PracticeTaskKind, () => Promise<void>>>;
  signal: AbortSignal;
  report: (
    event: ReturnType<typeof workerFailure> & { event: string; task: PracticeTaskKind }
  ) => void;
}): Promise<void> {
  for (const task of options.health.enabled)
    if (typeof options.ticks[task] !== 'function')
      throw new Error('Enabled practice tick is missing');
  const controller = new AbortController();
  const stop = () => {
    options.health.stop();
    controller.abort();
  };
  options.signal.addEventListener('abort', stop, { once: true });
  if (options.signal.aborted) stop();
  const loops = options.health.enabled.map((task) =>
    runPracticeWorker({
      health: options.health.task(task),
      signal: controller.signal,
      once: false,
      tick: async () => {
        try {
          await options.ticks[task]!();
        } catch (error) {
          options.report({ event: 'PRACTICE_GAME_TICK_FAILED', task, ...workerFailure(error) });
          throw error;
        }
      },
      publish: () => {},
      reportFailure: () => {},
    })
  );
  try {
    await Promise.all(loops);
  } finally {
    stop();
    options.signal.removeEventListener('abort', stop);
    await Promise.allSettled(loops);
  }
}
