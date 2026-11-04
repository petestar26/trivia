import { createServer, type Server } from 'node:http';
import { performance } from 'node:perf_hooks';

export const SYSTEM_PRACTICE_FAMILIES = [
  'SKY_CRASH', 'CRASH_POINT', 'THUNDER_DERBY', 'VIRTUAL_FOOTBALL', 'SYSTEM_DICE', 'SYSTEM_KENO',
] as const;
export type SystemPracticeFamily = typeof SYSTEM_PRACTICE_FAMILIES[number];
export const SYSTEM_PRACTICE_STALE_MS = 30_000;
export const SYSTEM_PRACTICE_STALLED_MS = 60_000;
export const SYSTEM_PRACTICE_SHUTDOWN_MS = 25_000;
export const SYSTEM_PRACTICE_STARTUP_MS = 25_000;

const FLAG: Record<SystemPracticeFamily, string> = {
  SKY_CRASH: 'SKY_CRASH_PRACTICE_ENABLED',
  CRASH_POINT: 'CRASH_POINT_PRACTICE_ENABLED',
  THUNDER_DERBY: 'THUNDER_DERBY_PRACTICE_ENABLED',
  VIRTUAL_FOOTBALL: 'VIRTUAL_FOOTBALL_PRACTICE_ENABLED',
  SYSTEM_DICE: 'SYSTEM_DICE_PRACTICE_ENABLED',
  SYSTEM_KENO: 'SYSTEM_KENO_PRACTICE_ENABLED',
};

export interface SystemPracticeConfiguration {
  readonly families: readonly SystemPracticeFamily[];
  readonly databaseUrl: string;
  readonly port: number;
}

/** Admission precedes imports, clients, listeners, timers and service creation. */
export function systemPracticeConfiguration(env: NodeJS.ProcessEnv): SystemPracticeConfiguration {
  if (env.SYSTEM_PRACTICE_WORKER_ENABLED !== 'true') throw new Error('SYSTEM_PRACTICE_MASTER_DISABLED');
  for (const family of SYSTEM_PRACTICE_FAMILIES) {
    const value = env[FLAG[family]];
    if (value !== undefined && value !== 'false' && value !== 'true') throw new Error('SYSTEM_PRACTICE_INVALID_FLAG');
  }
  const families = SYSTEM_PRACTICE_FAMILIES.filter(family => env[FLAG[family]] === 'true');
  if (!families.length) throw new Error('SYSTEM_PRACTICE_NO_FAMILIES');
  let target: URL;
  try { target = new URL(env.DATABASE_URL ?? ''); } catch { throw new Error('SYSTEM_PRACTICE_INVALID_DATABASE'); }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !target.hostname || !target.username || target.pathname.length < 2) {
    throw new Error('SYSTEM_PRACTICE_INVALID_DATABASE');
  }
  const rawPort = env.SYSTEM_PRACTICE_WORKER_PORT ?? env.PORT ?? '3011';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('SYSTEM_PRACTICE_INVALID_PORT');
  return Object.freeze({ families: Object.freeze(families), databaseUrl: target.href, port: Number(rawPort) });
}

type FamilyState = { lastSuccess: number | null; failed: boolean };
export class SystemPracticeHealth {
  private readonly startedAt: number;
  private readonly states = new Map<SystemPracticeFamily, FamilyState>();
  private stopping = false;
  constructor(families: readonly SystemPracticeFamily[], private readonly now = () => performance.now()) {
    if (!families.length || new Set(families).size !== families.length || families.some(f => !SYSTEM_PRACTICE_FAMILIES.includes(f))) {
      throw new Error('SYSTEM_PRACTICE_INVALID_FAMILIES');
    }
    this.startedAt = now();
    for (const family of families) this.states.set(family, { lastSuccess: null, failed: false });
  }
  succeeded(family: SystemPracticeFamily) {
    const state = this.state(family);
    state.lastSuccess = this.now(); state.failed = false;
  }
  failed(family: SystemPracticeFamily) { this.state(family).failed = true; }
  stop() { this.stopping = true; }
  stalledFamilies(): SystemPracticeFamily[] {
    return this.stopping ? [] : [...this.states].filter(([_family, state]) =>
      this.now() - (state.lastSuccess ?? this.startedAt) >= SYSTEM_PRACTICE_STALLED_MS).map(([family]) => family);
  }
  stalled() {
    return this.stalledFamilies().length > 0;
  }
  snapshot() {
    const families = [...this.states].map(([family, state]) => ({
      family,
      status: this.stopping ? 'STOPPING' : this.now() - (state.lastSuccess ?? this.startedAt) >= SYSTEM_PRACTICE_STALLED_MS ? 'STALLED'
        : state.failed ? 'TICK_FAILED' : state.lastSuccess === null ? 'STARTING'
        : this.now() - state.lastSuccess >= SYSTEM_PRACTICE_STALE_MS ? 'STALE' : 'OK',
    }));
    return { mode: 'SYSTEM_PRACTICE' as const, ready: families.every(family => family.status === 'OK'), families };
  }
  private state(family: SystemPracticeFamily) {
    const state = this.states.get(family);
    if (!state) throw new Error('SYSTEM_PRACTICE_DISABLED_FAMILY');
    return state;
  }
}

export type SystemPracticeTick = (onError: (id: string, error: unknown) => void) => Promise<void>;
export interface SystemPracticeServices {
  ticks: Partial<Record<SystemPracticeFamily, SystemPracticeTick>>;
  disconnect: () => Promise<void>;
}
export type SystemPracticeEvent = {
  event: 'SYSTEM_PRACTICE_TICK_FAILED' | 'SYSTEM_PRACTICE_STALLED' | 'SYSTEM_PRACTICE_START_FAILED' | 'SYSTEM_PRACTICE_STOPPED';
  family?: SystemPracticeFamily;
  cleanup?: 'COMPLETE' | 'UNCONFIRMED';
};

export async function listenSystemPracticeHealth(health: SystemPracticeHealth, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.url !== '/health') { response.writeHead(404).end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD'); response.writeHead(405).end(); return;
    }
    const snapshot = health.snapshot();
    response.writeHead(snapshot.ready ? 200 : 503);
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(snapshot));
  });
  server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => { server.removeListener('error', reject); resolve(); });
    });
    return server;
  } catch (error) { server.close(); throw error; }
}

async function closeHealth(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
    server.closeAllConnections();
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    // The caller has already started cleanup. Observe a later rejection even
    // when its deadline expired before this helper acquired the promise.
    void work.catch(() => undefined);
    throw new Error('SYSTEM_PRACTICE_DEADLINE');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SYSTEM_PRACTICE_DEADLINE')), remaining);
    })]);
    if (now() >= deadline) throw new Error('SYSTEM_PRACTICE_DEADLINE');
    return value;
  } finally { if (timer) clearTimeout(timer); }
}

export interface SystemPracticeDependencies {
  loadServices: (config: SystemPracticeConfiguration) => Promise<SystemPracticeServices>;
  signal: AbortSignal;
  report: (event: SystemPracticeEvent) => void;
  now?: () => number;
  listenHealth?: typeof listenSystemPracticeHealth;
}

/** Timeout withdraws admission and reports uncertainty; it never claims DB cancellation. */
export async function runSystemPracticeWorker(env: NodeJS.ProcessEnv, dependencies: SystemPracticeDependencies): Promise<number> {
  const config = systemPracticeConfiguration(env);
  const now = dependencies.now ?? (() => performance.now());
  const health = new SystemPracticeHealth(config.families, now);
  const controller = new AbortController();
  let resolveStop!: () => void;
  const stopped = new Promise<void>(resolve => { resolveStop = resolve; });
  let stopDeadline: number | null = null;
  let exitCode = 0;
  let resources: SystemPracticeServices | undefined;
  let listener: Server | undefined;
  let acquisition: Promise<SystemPracticeServices> | undefined;
  let listening: Promise<Server> | undefined;
  let disconnected: Promise<void> | undefined;
  let healthClosed: Promise<void> | undefined;
  let finished = false;
  let acquisitionRejected = false;
  let loops: Promise<void> | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const disconnect = () => disconnected ??= resources ? Promise.resolve().then(() => resources!.disconnect()) : Promise.resolve();
  const closeListener = () => healthClosed ??= listener ? closeHealth(listener) : Promise.resolve();
  const stop = (failure = false) => {
    if (failure) exitCode = 1;
    if (watchdog) clearInterval(watchdog);
    if (stopDeadline !== null) return;
    stopDeadline = now() + SYSTEM_PRACTICE_SHUTDOWN_MS;
    health.stop(); controller.abort(); resolveStop();
    if (listener) void closeListener().catch(() => undefined);
  };
  const onSignal = () => stop();
  dependencies.signal.addEventListener('abort', onSignal, { once: true });
  if (dependencies.signal.aborted) stop();
  try {
    if (!controller.signal.aborted) {
      const startupDeadline = now() + SYSTEM_PRACTICE_STARTUP_MS;
      acquisition = dependencies.loadServices(config).then(value => {
        resources = value;
        // A library caller might not exit after an uncertain stop. Retain
        // ownership of a late acquisition and request cleanup without claiming
        // that it completed within the recorded shutdown deadline.
        if (finished || controller.signal.aborted) void disconnect().catch(() => undefined);
        return value;
      }, error => { acquisitionRejected = true; throw error; });
      const loaded = await Promise.race([beforeDeadline(acquisition, startupDeadline, now), stopped.then(() => { throw new Error('SYSTEM_PRACTICE_STOPPING'); })]);
      const keys = Object.keys(loaded.ticks);
      if (keys.length !== config.families.length || keys.some(key => !config.families.includes(key as SystemPracticeFamily)) ||
          config.families.some(family => typeof resources!.ticks[family] !== 'function')) throw new Error('SYSTEM_PRACTICE_INVALID_DISPATCH');
      if (!controller.signal.aborted) {
        listening = (dependencies.listenHealth ?? listenSystemPracticeHealth)(health, config.port).then(value => {
          listener = value;
          if (finished || controller.signal.aborted) void closeListener().catch(() => undefined);
          return value;
        });
        await Promise.race([beforeDeadline(listening, startupDeadline, now), stopped.then(() => { throw new Error('SYSTEM_PRACTICE_STOPPING'); })]);
        if (!controller.signal.aborted) {
          watchdog = setInterval(() => {
            const stalled = health.stalledFamilies();
            if (stalled.length) {
              for (const family of stalled) dependencies.report({ event: 'SYSTEM_PRACTICE_STALLED', family });
              stop(true);
            }
          }, 1_000);
          loops = Promise.all(config.families.map(async family => {
          while (!controller.signal.aborted) {
            let failed = false;
            const fail = () => {
              if (!failed) dependencies.report({ event: 'SYSTEM_PRACTICE_TICK_FAILED', family });
              failed = true; health.failed(family);
            };
            try { await resources!.ticks[family]!(fail); } catch { fail(); }
            if (!failed) health.succeeded(family);
            await wait(1_000, controller.signal);
          }
          })).then(() => undefined);
        }
        await Promise.race([loops ?? Promise.resolve(), stopped]);
      }
    }
  } catch {
    if (!controller.signal.aborted) { dependencies.report({ event: 'SYSTEM_PRACTICE_START_FAILED' }); stop(true); }
  } finally {
    stop();
    dependencies.signal.removeEventListener('abort', onSignal);
    if (watchdog) clearInterval(watchdog);
    // An adapter rejection supplies no ownership/cleanup receipt. Its failure
    // may include failed constructor cleanup, so absence of a returned client
    // cannot establish that every acquired resource was closed.
    let cleanup: 'COMPLETE' | 'UNCONFIRMED' = acquisitionRejected ? 'UNCONFIRMED' : 'COMPLETE';
    if (acquisitionRejected) exitCode = 1;
    try {
      // Also wait for startup ownership: a pending acquisition/listener is
      // unresolved work, never evidence of an empty, cleaned-up runtime.
      const pending = [acquisition, listening, loops].filter(Boolean).map(work => work!.then(() => undefined, () => undefined));
      await beforeDeadline(Promise.all(pending), stopDeadline!, now);
    } catch { cleanup = 'UNCONFIRMED'; exitCode = 1; }
    try {
      // Request all available cleanup even if a tick/startup timed out. One
      // deadline includes in-flight ticks, listener close AND disconnect.
      const cleanupTasks: Promise<unknown>[] = [];
      if (listener) cleanupTasks.push(closeListener());
      if (resources) cleanupTasks.push(disconnect());
      await beforeDeadline(Promise.all(cleanupTasks), stopDeadline!, now);
    } catch { cleanup = 'UNCONFIRMED'; exitCode = 1; }
    finished = true;
    dependencies.report({ event: 'SYSTEM_PRACTICE_STOPPED', cleanup });
  }
  return exitCode;
}
