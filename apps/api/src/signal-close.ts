/** Injected coordination only. Not wired into the API or a proof of writer drain. */
export type ShutdownSignal = 'SIGTERM' | 'SIGINT';
export type CloseOutcome = { status: 'closed' | 'failed' | 'timed-out'; signal: ShutdownSignal };
export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): void;
  off(signal: ShutdownSignal, listener: () => void): void;
}
export interface CloseDependencies {
  close(): Promise<void>;
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
  deadlineMs: number;
}

export function createSignalCloseCoordinator(deps: CloseDependencies) {
  if (!Number.isSafeInteger(deps.deadlineMs) || deps.deadlineMs <= 0 || deps.deadlineMs > 2_147_483_647) {
    throw new RangeError('A positive, bounded shutdown deadline is required');
  }
  let pending: Promise<CloseOutcome> | undefined;
  let detach: (() => void) | undefined;
  function request(signal: ShutdownSignal): Promise<CloseOutcome> {
    if (pending) return pending;
    let resolve!: (outcome: CloseOutcome) => void;
    pending = new Promise<CloseOutcome>(done => { resolve = done; });
    let finished = false;
    let timer: unknown;
    let scheduled = false;
    const finish = (status: CloseOutcome['status']) => {
      if (finished) return;
      finished = true;
      // Timer cleanup failure must not produce a false clean-close result.
      if (scheduled) {
        try { deps.cancel(timer); } catch { status = 'failed'; }
      }
      resolve({ status, signal });
    };
    try {
      timer = deps.schedule(() => finish('timed-out'), deps.deadlineMs);
      scheduled = true;
      if (finished) { try { deps.cancel(timer); } catch { /* already timed out */ } }
    } catch { finish('failed'); }
    if (!finished) {
      // Invoke once, capture synchronous throws and async failures alike.
      void Promise.resolve().then(() => finished ? undefined : deps.close()).then(
        () => finish('closed'), () => finish('failed'),
      );
    }
    return pending;
  }
  function install(source: SignalSource): () => void {
    if (detach) throw new Error('Signal listeners are already installed');
    const term = () => { void request('SIGTERM'); };
    const interrupt = () => { void request('SIGINT'); };
    // off must be safe for an unattached listener (as EventEmitter.off is).
    // Treat registration as potentially side-effecting even when it throws.
    let termOwned = true;
    let interruptOwned = true;
    const remove = () => {
      const errors: unknown[] = [];
      if (termOwned) {
        try { source.off('SIGTERM', term); termOwned = false; } catch (error) { errors.push(error); }
      }
      if (interruptOwned) {
        try { source.off('SIGINT', interrupt); interruptOwned = false; } catch (error) { errors.push(error); }
      }
      if (!termOwned && !interruptOwned && detach === remove) detach = undefined;
      if (errors.length) throw new AggregateError(errors, 'Signal listener cleanup failed');
    };
    detach = remove;
    try {
      source.on('SIGTERM', term);
      source.on('SIGINT', interrupt);
    } catch (error) {
      try { remove(); } catch { /* retain detach for explicit dispose retry */ }
      throw error;
    }
    return remove;
  }
  // No process.exit, forced termination, DB disconnect, signal escalation,
  // or listener disposal on timeout. The owner must interpret the outcome.
  return { request, install, dispose: () => detach?.() };
}
