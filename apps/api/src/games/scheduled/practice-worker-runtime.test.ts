import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import type { Server } from 'node:http';
import {
  closePracticeHealth,
  listenPracticeHealth,
  PRACTICE_HEALTH_STALE_MS,
  PRACTICE_WORKER_STALLED_MS,
  PracticeWorkerHealth,
  runPracticeWorker,
  watchPracticeWorker,
} from './practice-worker-runtime.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('practice worker process health', () => {
  it('fails closed until a tick succeeds, becomes stale, and recovers', () => {
    let now = 0;
    const health = new PracticeWorkerHealth(() => now);
    expect(health.snapshot()).toEqual({
      status: 'STARTING',
      mode: 'PRACTICE',
      coinsAccepted: false,
      ready: false,
    });
    health.succeeded();
    expect(health.snapshot().ready).toBe(true);
    now = PRACTICE_HEALTH_STALE_MS;
    expect(health.snapshot()).toMatchObject({ status: 'STALE', ready: false });
    health.succeeded();
    expect(health.snapshot()).toMatchObject({ status: 'OK', ready: true });
    health.failedTick();
    expect(health.snapshot()).toMatchObject({ status: 'TICK_FAILED', ready: false });
    health.succeeded();
    expect(health.snapshot().ready).toBe(true);
    health.stop();
    health.succeeded(); // An in-flight committed tick cannot reopen readiness after SIGTERM.
    expect(health.snapshot()).toMatchObject({ status: 'STOPPING', ready: false });
  });

  it('requests restart after bounded startup or lost progress, never during shutdown', () => {
    let now = 0;
    const health = new PracticeWorkerHealth(() => now);
    now = PRACTICE_WORKER_STALLED_MS - 1;
    expect(health.stalled()).toBe(false);
    now++;
    expect(health.stalled()).toBe(true);
    health.succeeded();
    now += PRACTICE_WORKER_STALLED_MS - 1;
    expect(health.stalled()).toBe(false);
    health.failedTick();
    now++;
    expect(health.stalled()).toBe(true);
    health.stop();
    expect(health.stalled()).toBe(false);
  });

  it('serves uncached readiness over HTTP without runtime or database details', async () => {
    const health = new PracticeWorkerHealth();
    const server = await listenPracticeHealth(health, 0);
    const read = (path = '/health', method = 'GET') => readHealth(server, path, method);
    try {
      const starting = await read();
      expect(starting.status).toBe(503);
      expect(starting.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(starting.body)).toEqual({
        status: 'STARTING',
        mode: 'PRACTICE',
        coinsAccepted: false,
        ready: false,
      });
      health.succeeded();
      expect(await read()).toMatchObject({ status: 200 });
      expect(await read('/health', 'HEAD')).toMatchObject({ status: 200, body: '' });
      expect(await read('/health', 'POST')).toMatchObject({ status: 405 });
      expect(await read('/api')).toMatchObject({ status: 404 });
      health.failedTick();
      expect(await read()).toMatchObject({ status: 503 });
      health.stop();
      expect(await read()).toMatchObject({ status: 503 });
    } finally {
      await closePracticeHealth(server);
    }
    expect(server.listening).toBe(false);
  });

  it('fires the watchdog once on stalled progress and cancels it on shutdown', async () => {
    vi.useFakeTimers();
    const health = new PracticeWorkerHealth(() => Date.now());
    const restart = vi.fn();
    const stopWatchdog = watchPracticeWorker(health, restart);
    await vi.advanceTimersByTimeAsync(PRACTICE_WORKER_STALLED_MS - 1_000);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PRACTICE_WORKER_STALLED_MS);
    expect(restart).toHaveBeenCalledTimes(1);
    stopWatchdog();
    const secondRestart = vi.fn();
    const second = watchPracticeWorker(new PracticeWorkerHealth(() => Date.now()), secondRestart);
    second();
    await vi.advanceTimersByTimeAsync(PRACTICE_WORKER_STALLED_MS);
    expect(secondRestart).not.toHaveBeenCalled();
  });
});

describe('supervised practice loop', () => {
  it('publishes only resolved ticks and exits once on success or failure', async () => {
    const controller = new AbortController();
    const health = new PracticeWorkerHealth();
    const publish = vi.fn();
    const reportFailure = vi.fn();
    const tick = vi.fn().mockResolvedValue({ busy: false, created: null, drawn: [] });
    const options = { tick, signal: controller.signal, once: true, health, publish, reportFailure };
    expect(await runPracticeWorker(options)).toBe(0);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    tick.mockRejectedValueOnce(new Error('private database credential'));
    publish.mockClear();
    expect(await runPracticeWorker(options)).toBe(1);
    expect(publish).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith();
    expect(health.snapshot().ready).toBe(false);
  });

  it('retries a failed tick without publishing it and recovers readiness', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const health = new PracticeWorkerHealth();
    const publish = vi.fn(() => controller.abort());
    const reportFailure = vi.fn();
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('private details'))
      .mockResolvedValueOnce({ drawn: ['committed'] });
    const run = runPracticeWorker({
      tick,
      signal: controller.signal,
      once: false,
      health,
      publish,
      reportFailure,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(health.snapshot().ready).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await run).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ drawn: ['committed'] });
    expect(health.snapshot().ready).toBe(true);
  });

  it('does not overlap slow ticks, then stops after the in-flight commit', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const health = new PracticeWorkerHealth();
    let commit!: (result: { drawn: string[] }) => void;
    const tick = vi.fn(
      () =>
        new Promise<{ drawn: string[] }>((resolve) => {
          commit = resolve;
        })
    );
    const publish = vi.fn();
    const run = runPracticeWorker({
      tick,
      signal: controller.signal,
      once: false,
      health,
      publish,
      reportFailure: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    health.stop();
    controller.abort();
    commit({ drawn: ['committed'] });
    expect(await run).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({ drawn: ['committed'] });
    expect(tick).toHaveBeenCalledTimes(1);
    expect(health.snapshot()).toMatchObject({ status: 'STOPPING', ready: false });
  });

  it('wakes immediately when stopped between ticks', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const tick = vi.fn().mockResolvedValue({ drawn: [] });
    const run = runPracticeWorker({
      tick,
      signal: controller.signal,
      once: false,
      health: new PracticeWorkerHealth(),
      publish: vi.fn(),
      reportFailure: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await run).toBe(0);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('does no work when shutdown has already been requested', async () => {
    const controller = new AbortController();
    controller.abort();
    const tick = vi.fn();
    expect(
      await runPracticeWorker({
        tick,
        signal: controller.signal,
        once: false,
        health: new PracticeWorkerHealth(),
        publish: vi.fn(),
        reportFailure: vi.fn(),
      })
    ).toBe(0);
    expect(tick).not.toHaveBeenCalled();
  });
});

function readHealth(
  server: Server,
  path: string,
  method: string
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing health listener');
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: address.port, path, method, agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode!, headers: response.headers, body })
        );
        response.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}
