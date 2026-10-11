import { randomInt, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import {
  NUMBER_TIMED_RULES_ID,
  numberScore,
  parseNumberTimedEntry,
  type NumberTimedReceipt,
  type NumberTimedSnapshot,
} from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';
type Round = { id: string; opens_at: Date; closes_at: Date; ends_at: Date; target: number | null };
type Receipt = {
  id: string;
  round_id: string;
  guess: number;
  created_at: Date;
  target: number | null;
};
const present = (r: Receipt): NumberTimedReceipt => ({
  id: r.id,
  roundId: r.round_id,
  guess: r.guess,
  createdAt: r.created_at.toISOString(),
  target: r.target,
  ...(r.target === null ? { away: null, score: null } : numberScore(r.guess, r.target)),
});
async function active(tx: Prisma.TransactionClient, userId: string) {
  const [u] = await tx.$queryRaw<
    { status: string }[]
  >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
  if (u?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
}
export function createNumberTimedService(db: PrismaClient) {
  return {
    async tick() {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('number-timed-worker',0))::text`;
        const [{ n }] = await tx.$queryRaw<
          { n: bigint }[]
        >`SELECT floor(extract(epoch FROM clock_timestamp())/60)::bigint AS n`;
        for (const number of [n, n + 1n]) {
          const id = `number-v2:${number}`;
          await tx.$executeRaw`INSERT INTO number_timed_rounds(id,round_number,opens_at,closes_at,ends_at) VALUES(${id},${number},to_timestamp(${number}::double precision*60),to_timestamp(${number}::double precision*60)+interval '30 seconds',to_timestamp(${number}::double precision*60)+interval '60 seconds') ON CONFLICT DO NOTHING`;
        }
        const due = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM number_timed_rounds WHERE target IS NULL AND closes_at<=clock_timestamp() ORDER BY closes_at LIMIT 500 FOR UPDATE`;
        for (const r of due)
          await tx.$executeRaw`UPDATE number_timed_rounds SET target=${randomInt(1, 101)} WHERE id=${r.id} AND target IS NULL`;
      });
    },
    async snapshot(userId: string): Promise<NumberTimedSnapshot> {
      return db.$transaction(async (tx) => {
        await active(tx, userId);
        const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        const [r] = await tx.$queryRaw<
          Round[]
        >`SELECT id,opens_at,closes_at,ends_at,CASE WHEN closes_at<=${now} THEN target ELSE NULL END AS target FROM number_timed_rounds WHERE round_number=floor(extract(epoch FROM ${now}::timestamptz)/60)::bigint`;
        const rows = await tx.$queryRaw<
          Receipt[]
        >`SELECT e.id,e.round_id,e.guess,e.created_at,CASE WHEN r.closes_at<=${now} THEN r.target ELSE NULL END AS target FROM number_timed_entries e JOIN number_timed_rounds r ON r.id=e.round_id WHERE e.user_id=${userId} ORDER BY e.created_at DESC,e.id DESC LIMIT 20`;
        // Preserve access to v1 history while new shared rounds accumulate.
        const legacy =
          rows.length < 20
            ? await tx.$queryRaw<
                Receipt[]
              >`SELECT id,'legacy:'||id AS round_id,guess,created_at,target FROM number_practice_rounds WHERE user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT ${20 - rows.length}`
            : [];
        return {
          rulesId: NUMBER_TIMED_RULES_ID,
          serverNow: now.toISOString(),
          round: r
            ? {
                id: r.id,
                opensAt: r.opens_at.toISOString(),
                closesAt: r.closes_at.toISOString(),
                endsAt: r.ends_at.toISOString(),
                target: r.target,
              }
            : null,
          receipt: rows.find((e) => e.round_id === r?.id)
            ? present(rows.find((e) => e.round_id === r?.id)!)
            : null,
          history: [...rows, ...legacy].map(present),
        };
      });
    },
    async play(userId: string, input: unknown) {
      let entry;
      try {
        entry = parseNumberTimedEntry(input);
      } catch (e) {
        throw ApiError.badRequest((e as Error).message);
      }
      return db
        .$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'number-timed:' + userId},0))::text`;
          await active(tx, userId);
          const [prior] = await tx.$queryRaw<
            Receipt[]
          >`SELECT e.id,e.round_id,e.guess,e.created_at,CASE WHEN r.closes_at<=clock_timestamp() THEN r.target ELSE NULL END AS target FROM number_timed_entries e JOIN number_timed_rounds r ON r.id=e.round_id WHERE e.user_id=${userId} AND e.request_id=${entry.requestId}`;
          if (prior) {
            if (prior.round_id !== entry.roundId || prior.guess !== entry.guess)
              throw ApiError.conflict('This request belongs to a different guess.');
            return { receipt: present(prior), isReplay: true };
          }
          const [r] = await tx.$queryRaw<
            Round[]
          >`SELECT * FROM number_timed_rounds WHERE id=${entry.roundId} FOR SHARE`;
          const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (!r || now < r.opens_at || now >= r.closes_at || r.target !== null)
            throw ApiError.conflict('This round is closed. Wait for the next round.');
          const [existing] = await tx.$queryRaw<
            { id: string }[]
          >`SELECT id FROM number_timed_entries WHERE user_id=${userId} AND round_id=${entry.roundId}`;
          if (existing) throw ApiError.conflict('You already placed a guess in this round.');
          const id = randomUUID();
          const [saved] = await tx.$queryRaw<
            Receipt[]
          >`INSERT INTO number_timed_entries(id,user_id,round_id,request_id,guess) VALUES(${id},${userId},${entry.roundId},${entry.requestId},${entry.guess}) RETURNING id,round_id,guess,created_at,NULL::smallint AS target`;
          return { receipt: present(saved), isReplay: false };
        })
        .catch((error: unknown) => {
          if (
            error &&
            typeof error === 'object' &&
            'meta' in error &&
            (error.meta as { code?: string })?.code === 'PNC01'
          )
            throw ApiError.conflict('This round is closed. Wait for the next round.');
          throw error;
        });
    },
  };
}
