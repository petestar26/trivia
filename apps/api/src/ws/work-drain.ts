/** Local candidate. A lease spans authorization, queued dispatch and handler work. */
export function createWorkDrain() {
  let accepting = true;
  let failed = false;
  const leases = new Set<object>();
  const waiters = new Set<() => void>();
  function acquire() {
    if (!accepting) return undefined;
    const token = {}; leases.add(token);
    let released = false;
    return {
      finish(didFail = false) {
        if (released) return;
        released = true;
        if (didFail) failed = true;
        leases.delete(token);
        if (!leases.size) for (const wake of [...waiters]) wake();
      }
    };
  }
  function stop() { accepting = false; }
  async function wait(deadlineMs: number): Promise<'drained' | 'failed' | 'timed-out'> {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2147483647) throw new RangeError('deadlineMs');
    stop();
    if (!leases.size) return failed ? 'failed' : 'drained';
    return new Promise(resolve => {
      const complete = () => { clearTimeout(timer); waiters.delete(complete); resolve(failed ? 'failed' : 'drained'); };
      const timer = setTimeout(() => { waiters.delete(complete); resolve('timed-out'); }, deadlineMs);
      waiters.add(complete);
    });
  }
  return { acquire, stop, wait, get accepting() { return accepting; }, get pending() { return leases.size; } };
}
export type WorkLease = NonNullable<ReturnType<ReturnType<typeof createWorkDrain>['acquire']>>;
