import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export const PRACTICE_HEALTH_STALE_MS = 30_000;
export const PRACTICE_WORKER_STALLED_MS = 60_000;

/** Process health only: a healthy worker may be supervising a paused table. */
export class PracticeWorkerHealth {
  private readonly startedAt: number;
  private lastSuccess: number | null = null;
  private failed = false;
  private stopping = false;

  constructor(private readonly now = () => performance.now()) {
    this.startedAt = now();
  }

  succeeded() {
    this.lastSuccess = this.now();
    this.failed = false;
  }

  failedTick() {
    this.failed = true;
  }

  stop() {
    this.stopping = true;
  }

  stalled() {
    return (
      !this.stopping &&
      this.now() - (this.lastSuccess ?? this.startedAt) >= PRACTICE_WORKER_STALLED_MS
    );
  }

  snapshot() {
    const age = this.lastSuccess === null ? null : Math.max(0, this.now() - this.lastSuccess);
    const status = this.stopping
      ? 'STOPPING'
      : this.failed
        ? 'TICK_FAILED'
        : age === null
          ? 'STARTING'
          : age >= PRACTICE_HEALTH_STALE_MS
            ? 'STALE'
            : 'OK';
    return { status, mode: 'PRACTICE' as const, coinsAccepted: false, ready: status === 'OK' };
  }
}

/** Deployment probes alone do not supervise a process after it becomes healthy. */
export function watchPracticeWorker(health: PracticeWorkerHealth, restart: () => void) {
  const watchdog = setInterval(() => {
    if (health.stalled()) {
      clearInterval(watchdog);
      restart();
    }
  }, 1_000);
  return () => clearInterval(watchdog);
}

/** No connection strings, outcomes, tickets or user information enter this response. */
export async function listenPracticeHealth(
  health: PracticeWorkerHealth,
  port: number
): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'application/json');
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      response.writeHead(405).end();
      return;
    }
    const snapshot = health.snapshot();
    response.writeHead(snapshot.ready ? 200 : 503);
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(snapshot));
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Node's unspecified host supports IPv6 private networking and IPv4 probes.
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

export async function closePracticeHealth(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

interface WorkerOptions<T> {
  tick: () => Promise<T>;
  signal: AbortSignal;
  once: boolean;
  health: PracticeWorkerHealth;
  publish: (result: T) => void;
  reportFailure: () => void;
}

/** Ticks never overlap. Stop wakes the wait but allows an in-flight transaction to finish. */
export async function runPracticeWorker<T>(options: WorkerOptions<T>): Promise<number> {
  while (!options.signal.aborted) {
    let result: T;
    try {
      result = await options.tick();
      options.health.succeeded();
    } catch {
      options.health.failedTick();
      options.reportFailure();
      if (options.once) return 1;
      try {
        await delay(1_000, undefined, { signal: options.signal });
      } catch {
        if (!options.signal.aborted) throw new Error('Practice worker wait failed');
      }
      continue;
    }
    options.publish(result);
    if (options.once) return 0;
    try {
      await delay(1_000, undefined, { signal: options.signal });
    } catch {
      if (!options.signal.aborted) throw new Error('Practice worker wait failed');
    }
  }
  return 0;
}
