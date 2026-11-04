import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';

const RAILWAY_IDENTITY_KEYS = [
  'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID',
  'RAILWAY_DEPLOYMENT_ID', 'RAILWAY_REPLICA_ID', 'RAILWAY_REPLICA_REGION',
] as const;

export class MediaMaintenance {
  readonly incarnation = randomUUID();
  readonly identity: Readonly<Record<string, string | null>>;
  private closed = false;
  private active = 0;
  private admitted = 0;
  private settled = 0;
  private waiters = new Set<() => void>();
  private latch?: () => Promise<void>;
  private validate: () => Promise<void> = async () => {};
  private closing?: Promise<void>;
  private recoveryRequired = false;
  private latchFailed = false;
  private unresolvedCleanup = 0;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.identity = Object.freeze(Object.fromEntries(RAILWAY_IDENTITY_KEYS.map(key => [key, env[key] ?? null])));
  }

  /** Called only by startup's local authority, never by a request or JWT. */
  configure(latch: () => Promise<void>, recoveryRequired: boolean, validate: () => Promise<void> = async () => {}): void {
    if (this.latch) throw new Error('Media maintenance already configured');
    this.latch = latch;
    this.validate = validate;
    this.recoveryRequired = recoveryRequired;
    this.closed = recoveryRequired;
  }

  admit(): () => void {
    if (this.closed) {
      throw Object.assign(new Error('Media mutations are unavailable during maintenance'), { statusCode: 503 });
    }
    this.active++;
    this.admitted++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.settled++;
      if (this.active === 0) for (const resolve of this.waiters) resolve();
    };
  }

  snapshot() {
    return {
      version: 1, scope: 'single-api-server-instance-only', incarnation: this.incarnation,
      railway: this.identity, configured: Boolean(this.latch), closed: this.closed,
      recoveryRequired: this.recoveryRequired, latchFailed: this.latchFailed,
      active: this.active, admitted: this.admitted, settled: this.settled,
      unresolvedCleanup: this.unresolvedCleanup,
    };
  }

  async closeAndDrain(timeoutMs: number) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid drain timeout');
    const deadline = performance.now() + timeoutMs;
    // Synchronous, before any await: no new operation can slip past close.
    this.closed = true;
    if (!this.closing) {
      this.closing = this.latch ? Promise.resolve().then(this.latch).catch(() => { this.latchFailed = true; }) : Promise.resolve();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const verified = this.closing.then(() => this.validate()).then(() => true).catch(() => { this.latchFailed = true; return false; });
    let durable = await Promise.race([verified, timeout]);
    if (performance.now() >= deadline) durable = false;
    let zero = this.active === 0;
    if (durable && !zero && performance.now() < deadline) {
      let done!: () => void;
      const pending = new Promise<true>(resolve => { done = () => resolve(true); this.waiters.add(done); });
      try { zero = await Promise.race([pending, timeout]); }
      finally { this.waiters.delete(done); }
    }
    if (durable && zero) {
      durable = await Promise.race([
        this.validate().then(() => true).catch(() => { this.latchFailed = true; return false; }), timeout,
      ]);
    }
    if (performance.now() >= deadline) durable = false;
    if (timer) clearTimeout(timer);
    const state = this.snapshot();
    const identityValid = ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID']
      .every(key => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(this.identity[key] ?? ''));
    const ready = Boolean(state.configured && identityValid && !state.recoveryRequired && !state.latchFailed &&
      !state.unresolvedCleanup && durable && zero && performance.now() < deadline);
    return {
      ...state,
      outcome: !state.configured ? 'unconfigured' : state.recoveryRequired ? 'recovery-required' :
        state.latchFailed ? 'latch-failed' : state.unresolvedCleanup ? 'unresolved-cleanup' :
          !identityValid ? 'identity-unavailable' : ready ? 'drained' : 'timeout',
      // Never claims anything about another process, replica or prior incarnation.
      drained: ready,
    };
  }

  async markCleanupFailure(): Promise<void> {
    this.unresolvedCleanup++;
    if (this.latch) {
      this.closed = true;
      if (!this.closing) this.closing = Promise.resolve().then(this.latch).catch(() => { this.latchFailed = true; });
      await this.closing;
    }
  }
}

const gates = new WeakMap<object, MediaMaintenance>();
export function mediaMaintenance(server: FastifyInstance): MediaMaintenance {
  const root = server.server;
  // Fastify encapsulation shares the same underlying HTTP server.
  const key = root;
  let gate = gates.get(key);
  if (!gate) { gate = new MediaMaintenance(); gates.set(key, gate); }
  return gate;
}

const leases = new WeakMap<FastifyRequest, { release: () => void; started: boolean; released: boolean; authRunning: boolean }>();
export function mediaMutationHooks(server: FastifyInstance) {
  const gate = mediaMaintenance(server);
  const releaseBeforeHandler = (request: FastifyRequest) => {
    const lease = leases.get(request);
    if (lease && !lease.started && !lease.authRunning) { lease.released = true; lease.release(); }
  };
  return {
    onRequest: async (request: FastifyRequest) => { leases.set(request, { release: gate.admit(), started: false, released: false, authRunning: false }); },
    onError: async (request: FastifyRequest, _reply: FastifyReply, error: FastifyError) => {
      // These framework failures follow completed parsing/validation. Unknown
      // earlier hooks may still be running after an early error response;
      // retain admission rather than infer their settlement from that event.
      if (error.code === 'FST_ERR_VALIDATION' || error.code?.startsWith('FST_ERR_CTP_')) releaseBeforeHandler(request);
    },
  };
}


/** Auth may finish after the client has gone or after an early response. Await
 * its actual promise before settling the pre-handler lease in either case. */
export function mediaAuthentication(authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const lease = leases.get(request);
    if (!lease || lease.released) throw new Error('Missing media admission');
    lease.authRunning = true;
    try {
      await authenticate(request, reply);
      if (reply.sent || request.raw.aborted) {
        lease.released = true;
        lease.release();
      }
    } catch (error) {
      lease.released = true;
      lease.release();
      throw error;
    } finally { lease.authRunning = false; }
  };
}

const operationContext = new AsyncLocalStorage<MediaMaintenance>();
export async function recordMediaCleanupFailure(): Promise<void> {
  await operationContext.getStore()?.markCleanupFailure();
}

export async function withMediaMutation<T>(request: FastifyRequest, operation: () => Promise<T>): Promise<T> {
  const lease = leases.get(request);
  if (!lease || lease.released) throw new Error('Missing media admission');
  lease.started = true;
  try { return await operationContext.run(mediaMaintenance(request.server), operation); }
  finally { lease.release(); }
}
