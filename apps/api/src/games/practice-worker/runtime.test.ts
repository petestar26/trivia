import { afterEach, expect, it, vi } from 'vitest';
import { watchPracticeWorker } from '../scheduled/practice-worker-runtime.js';
import {
  enabledPracticeTasks,
  PRACTICE_TASK_FLAGS,
  observePracticeTick,
  PracticeGamesHealth,
  runPracticeGamesWorker,
} from './runtime.js';

afterEach(() => {
  vi.useRealTimers();
});

it('requires exact flags and never selects PVP or lifecycle jobs', () => {
  for (const value of [undefined, '', 'false', 'TRUE', '1', ' true', 'true '])
    expect(
      enabledPracticeTasks({
        SYSTEM_DICE_PRACTICE_ENABLED: value,
        GROUP_PVP_GAME_POINTS_ENABLED: 'true',
      })
    ).toEqual([]);
  expect(
    enabledPracticeTasks({
      SYSTEM_DICE_PRACTICE_ENABLED: 'true',
      SCHEDULED_PRACTICE_WORKER_ENABLED: 'true',
      GROUP_PVP_GAME_POINTS_ENABLED: 'true',
    })
  ).toEqual(['DICE', 'SPIN']);
});

it('is ready only when every enabled loop has succeeded and none is failed/stale', () => {
  let now = 0;
  const health = new PracticeGamesHealth(['DICE', 'KENO'], () => now);
  expect(health.snapshot().ready).toBe(false);
  health.task('DICE').succeeded();
  expect(health.snapshot().ready).toBe(false);
  health.task('KENO').succeeded();
  expect(health.snapshot()).toMatchObject({ ready: true, mode: 'PRACTICE', coinsAccepted: false });
  health.task('KENO').failedTick();
  expect(health.snapshot()).toMatchObject({ ready: false, status: 'TICK_FAILED' });
  health.task('KENO').succeeded();
  expect(health.snapshot().ready).toBe(true);
  now = 30_000;
  health.task('KENO').succeeded();
  expect(health.snapshot()).toMatchObject({ ready: false, status: 'STALE' });
  health.stop();
  expect(health.snapshot()).toMatchObject({ ready: false, status: 'STOPPING' });
});

it('watchdog detects one stalled loop even while another keeps succeeding', async () => {
  vi.useFakeTimers();
  const health = new PracticeGamesHealth(['DICE', 'KENO'], () => Date.now());
  health.task('DICE').succeeded();
  health.task('KENO').succeeded();
  const restart = vi.fn();
  const stopWatchdog = watchPracticeWorker(health, restart);
  await vi.advanceTimersByTimeAsync(59_000);
  health.task('KENO').succeeded();
  expect(restart).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(restart).toHaveBeenCalledTimes(1);
  stopWatchdog();
});

it('runs loops independently without overlap and waits for in-flight work on shutdown', async () => {
  const health = new PracticeGamesHealth(['DICE', 'KENO'], () => Date.now());
  const controller = new AbortController();
  let finishDice!: () => void;
  const dice = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishDice = resolve;
      })
  );
  const keno = vi.fn(async () => {});
  const disabled = vi.fn(async () => {});
  const done = runPracticeGamesWorker({
    health,
    signal: controller.signal,
    ticks: { DICE: dice, KENO: keno, FOOTBALL: disabled },
    report: vi.fn(),
  });
  await vi.waitFor(() => expect(keno).toHaveBeenCalledTimes(2), { timeout: 2_000, interval: 10 });
  expect(dice).toHaveBeenCalledTimes(1);
  expect(keno).toHaveBeenCalledTimes(2);
  expect(disabled).not.toHaveBeenCalled();
  expect(health.snapshot().ready).toBe(false);
  controller.abort();
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  finishDice();
  await done;
  expect(health.snapshot().ready).toBe(false);
  expect(health.snapshot().status).toBe('STOPPING');
});

it('retries failed ticks, redacts their errors and recovers readiness', async () => {
  const health = new PracticeGamesHealth(['DICE'], () => Date.now());
  const controller = new AbortController();
  const tick = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error('postgres://private-password'), { code: 'P2010' })
    )
    .mockResolvedValue(undefined);
  const report = vi.fn();
  const done = runPracticeGamesWorker({
    health,
    signal: controller.signal,
    ticks: { DICE: tick },
    report,
  });
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  expect(health.snapshot()).toMatchObject({ ready: false, status: 'TICK_FAILED' });
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ task: 'DICE', code: 'P2010' }));
  expect(JSON.stringify(report.mock.calls)).not.toContain('private-password');
  await vi.waitFor(() => expect(health.snapshot().ready).toBe(true), {
    timeout: 2_000,
    interval: 10,
  });
  expect(health.snapshot().ready).toBe(true);
  controller.abort();
  await done;
});

it('treats a swallowed service settlement callback as an unsuccessful tick', async () => {
  const fail = observePracticeTick(async (onError) => {
    onError('private-ticket', new Error('settlement failed'));
  });
  await expect(fail()).rejects.toThrow('settlement failed');
  await expect(observePracticeTick(async () => {})()).resolves.toBeUndefined();
});

it('runs every enabled game without abort-listener warnings and shuts down together', async () => {
  const enabled = enabledPracticeTasks(
    Object.fromEntries(Object.values(PRACTICE_TASK_FLAGS).map((flag) => [flag, 'true']))
  );
  expect(enabled.length).toBeGreaterThan(10);
  const health = new PracticeGamesHealth(enabled);
  const controller = new AbortController();
  const ticks = Object.fromEntries(enabled.map((task) => [task, vi.fn(async () => {})]));
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const done = runPracticeGamesWorker({ health, signal: controller.signal, ticks, report: vi.fn() });
  try {
    await vi.waitFor(() => {
      for (const tick of Object.values(ticks)) expect(tick).toHaveBeenCalledTimes(2);
    }, { timeout: 2_000, interval: 10 });
    expect(health.snapshot().ready).toBe(true);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await done;
    warning.mockRestore();
  }
  expect(health.snapshot().status).toBe('STOPPING');
});

it('refuses an enabled task without its tick before starting other tasks', async () => {
  const tick = vi.fn(async () => {});
  await expect(
    runPracticeGamesWorker({
      health: new PracticeGamesHealth(['DICE', 'KENO']),
      signal: new AbortController().signal,
      ticks: { DICE: tick },
      report: vi.fn(),
    })
  ).rejects.toThrow('Enabled practice tick is missing');
  expect(tick).not.toHaveBeenCalled();
});
