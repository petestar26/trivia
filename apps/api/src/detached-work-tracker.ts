/** Tracks detached promises without changing their result or deferring their start.
 * Wait only after every producer has settled. This is ownership, not a queue,
 * retry mechanism, admission gate, success guarantee, or independent deadline.
 */
export function createDetachedWorkTracker() {
  const active = new Set<Promise<void>>();
  function track<T>(start: () => Promise<T>): Promise<T> {
    let complete!: () => void;
    const settled = new Promise<void>(resolve => { complete = resolve; });
    // Register before start, including any synchronous/reentrant producer work.
    active.add(settled);
    const release = () => { active.delete(settled); complete(); };
    try {
      const job = start();
      // Observe either outcome without replacing the caller's promise or result.
      void job.then(release, release);
      return job;
    } catch (error) {
      release();
      return Promise.reject(error);
    }
  }
  async function wait(): Promise<void> {
    // Re-snapshot to include work registered while prior jobs were settling.
    // Producer quiescence is required before the final empty observation.
    while (active.size) await Promise.all([...active]);
  }
  return { track, wait };
}
