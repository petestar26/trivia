import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@socialplay/database';
import { rows, execute } from './store.js';

/** Claims are durable, bounded, and independent of API/browser lifetimes.
 * Financial row locks and ledger witnesses remain the exactly-once authority. */
export async function runTogetherJobs(
  db: PrismaClient,
  recover: (id: string) => Promise<void>,
  workerId: string,
  practiceOnly = false
) {
  const token = randomUUID();
  const jobs = await db.$transaction(async (tx) => {
    const due = await rows<{ round_id: string }>(
      tx,
      'SELECT j.round_id FROM play_together_jobs j JOIN play_together_rounds r ON r.id=j.round_id LEFT JOIN groups g ON g.id=r.group_id WHERE ' +
        "r.state IN ('OPEN','LOCKED','DRAWN') AND (NOT $1 OR r.currency='GAME_POINTS') AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp()) AND j.next_attempt_at<=clock_timestamp() AND " +
        "((r.state='OPEN' AND (r.closes_at<=clock_timestamp() OR g.status<>'ACTIVE' OR g.\"expiresAt\"<=clock_timestamp())) OR " +
        "r.state='LOCKED' OR (r.state='DRAWN' AND (r.presentation_finishes_at IS NULL OR r.presentation_finishes_at<=clock_timestamp()))) " +
        'ORDER BY j.next_attempt_at,r.closes_at LIMIT 4 FOR UPDATE OF j SKIP LOCKED',
      practiceOnly
    );
    for (const job of due)
      await execute(
        tx,
        "UPDATE play_together_jobs SET lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',attempts=attempts+1 WHERE round_id=$1",
        job.round_id,
        token
      );
    return due;
  });
  // One failed obligation does not block other claims or mark the worker dead.
  await Promise.all(
    jobs.map(async (job) => {
      let failed = false;
      const renew = setInterval(() => {
        void db
          .$executeRawUnsafe(
            "UPDATE play_together_jobs SET lease_until=clock_timestamp()+interval '90 seconds' WHERE round_id=$1 AND lease_token=$2",
            job.round_id,
            token
          )
          .catch(() => {});
      }, 15000);
      renew.unref?.();
      try {
        await recover(job.round_id);
      } catch {
        failed = true;
      } finally {
        clearInterval(renew);
      }
      await db.$executeRawUnsafe(
        'UPDATE play_together_jobs j SET lease_token=NULL,lease_until=NULL,' +
          "last_error_at=CASE WHEN $3 THEN clock_timestamp() ELSE last_error_at END,next_attempt_at=CASE WHEN $3 THEN clock_timestamp()+interval '10 seconds' " +
          "WHEN r.state IN ('PAID','REFUNDED') THEN 'infinity'::timestamptz WHEN r.presentation_finishes_at IS NOT NULL THEN r.presentation_finishes_at ELSE clock_timestamp()+interval '1 second' END " +
          'FROM play_together_rounds r WHERE j.round_id=$1 AND r.id=j.round_id AND j.lease_token=$2',
        job.round_id,
        token,
        failed
      );
    })
  );
  await db.$executeRawUnsafe(
    'INSERT INTO play_together_workers(id,healthy_at,processing) VALUES($1,clock_timestamp(),$2) ON CONFLICT(id) DO UPDATE SET healthy_at=EXCLUDED.healthy_at,processing=EXCLUDED.processing',
    workerId,
    jobs.length
  );
}

export async function togetherDatabaseWorkerReady(db: PrismaClient): Promise<boolean> {
  const [value] = await db.$queryRawUnsafe<{ ready: boolean }[]>(
    "SELECT EXISTS(SELECT 1 FROM play_together_workers WHERE healthy_at>clock_timestamp()-interval '30 seconds') AS ready"
  );
  return value.ready;
}

export async function togetherJobHealth(db: PrismaClient) {
  const [value] = await db.$queryRawUnsafe<
    { pending: number; delayed: number; failed: number; outbox: number }[]
  >(
    "SELECT count(*)::int AS pending,count(*) FILTER(WHERE r.presentation_finishes_at<clock_timestamp()-interval '30 seconds')::int AS delayed," +
      'count(*) FILTER(WHERE j.last_error_at IS NOT NULL)::int AS failed,' +
      "(SELECT count(*)::int FROM play_together_events WHERE delivered_at IS NULL AND available_at<clock_timestamp()-interval '10 seconds') AS outbox " +
      "FROM play_together_jobs j JOIN play_together_rounds r ON r.id=j.round_id WHERE r.state IN ('OPEN','LOCKED','DRAWN')"
  );
  return { ready: await togetherDatabaseWorkerReady(db), ...value };
}
