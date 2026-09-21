import { prisma } from '@socialplay/database';

/**
 * Helpers for deterministic PostgreSQL concurrency schedules.
 *
 * A schedule built on `sleep()` proves nothing: a request that is merely slow
 * looks identical to one parked on a lock. These helpers instead observe the
 * database, so a test can assert that a specific request is blocked inside a
 * specific lock wait BEFORE it lets the interleaving proceed.
 *
 * Usage pattern:
 *   1. hold a lock (an open `prisma.$transaction`) on the contended object
 *   2. fire the request under test (do not await it)
 *   3. `await waitForBlockedBackends(1, { queryLike: '%FOR SHARE%' })`
 *      — now the request is provably parked inside that statement
 *   4. commit whatever the test wants to have "won" the race, releasing it
 *   5. await the request and assert
 */

interface BlockedBackend {
  pid: number;
  query: string;
  /** What kind of lock it waits for: 'transactionid' / 'tuple' (a row lock), 'advisory', 'relation', ... */
  waitEvent: string;
}

/**
 * The wait events of a request queued behind a ROW lock held by another transaction:
 * 'transactionid' (waiting for the holder to finish) or 'tuple' (queued behind another
 * waiter for the same row). Not 'advisory': a statement that stands still because a
 * test-held ADVISORY lock (a write gate, a subject lock) has it parked is waiting for
 * something else, and a schedule that means "it waits behind the other request's row
 * lock" must not be satisfied by that.
 */
export const ROW_LOCK_WAITS: readonly string[] = ['transactionid', 'tuple'];

/** Backends in THIS database currently waiting on a lock, optionally filtered by SQL text. */
export async function blockedBackends(queryLike = '%', waitEvents?: readonly string[]): Promise<BlockedBackend[]> {
  const rows = await prisma.$queryRaw<{ pid: number; query: string; wait_event: string }[]>`
    SELECT pid, query, wait_event
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
      AND wait_event_type = 'Lock'
      AND query ILIKE ${queryLike}
  `;
  return rows
    .map((r) => ({ pid: r.pid, query: r.query, waitEvent: r.wait_event }))
    .filter((r) => waitEvents === undefined || waitEvents.includes(r.waitEvent));
}

export interface WaitOptions {
  /** ILIKE pattern the waiting statement's SQL must match. Default: any statement. */
  queryLike?: string;
  /** Only count backends waiting on one of these lock kinds (see ROW_LOCK_WAITS). Default: any. */
  waitEvents?: readonly string[];
  timeoutMs?: number;
}

/**
 * Resolve once at least `count` matching backends are blocked on a lock.
 * Throws — listing what IS blocked — if that never happens, so a schedule that
 * silently stopped exercising the interleaving fails loudly instead of
 * passing for the wrong reason.
 */
export async function waitForBlockedBackends(count: number, opts: WaitOptions = {}): Promise<void> {
  const { queryLike = '%', waitEvents, timeoutMs = 8_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  let last: BlockedBackend[] = [];
  while (Date.now() < deadline) {
    last = await blockedBackends(queryLike, waitEvents);
    if (last.length >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  const detail = (await blockedBackends()).map((b) => `  pid ${b.pid} (${b.waitEvent}): ${b.query.slice(0, 120)}`).join('\n');
  throw new Error(
    `Expected >= ${count} backend(s) blocked on a lock matching ${JSON.stringify(queryLike)}` +
      `${waitEvents ? ` (wait event ${waitEvents.join('/')})` : ''}, ` +
      `saw ${last.length} within ${timeoutMs}ms. Currently blocked (any statement):\n${detail || '  (none)'}`
  );
}

/**
 * Resolve once a backend running a statement matching `queryLike` is sitting in
 * the given wait event (e.g. 'PgSleep' while a trigger runs pg_sleep()).
 *
 * This proves a request is MID-TRANSACTION — it has already acquired the locks
 * it takes before that statement, and is holding them — which a plain lock
 * wait cannot show. Used to force "A holds X and is paused; now B runs".
 */
export async function waitForWaitEvent(
  waitEvent: string,
  opts: { queryLike?: string; timeoutMs?: number } = {}
): Promise<void> {
  const { queryLike = '%', timeoutMs = 8_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event = ${waitEvent}
        AND query ILIKE ${queryLike}
    `;
    if (rows.length > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    `No backend reached wait event ${JSON.stringify(waitEvent)} for a statement matching ${JSON.stringify(queryLike)} within ${timeoutMs}ms.`
  );
}
