import { randomInt, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import {
  NUMBER_RULES_ID,
  numberScore,
  parseNumberEntry,
  type NumberRound,
} from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';

type Row = { id: string; guess: number; target: number; created_at: Date; rules_id: string };
const present = (r: Row): NumberRound => ({
  id: r.id,
  guess: r.guess,
  target: r.target,
  ...numberScore(r.guess, r.target),
  createdAt: r.created_at.toISOString(),
  rulesId: r.rules_id,
});

export function createNumberService(db: PrismaClient) {
  async function active(tx: Prisma.TransactionClient, userId: string) {
    const [u] = await tx.$queryRaw<
      { status: string }[]
    >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (u?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
  }
  return {
    async snapshot(userId: string) {
      return db.$transaction(async (tx) => {
        await active(tx, userId);
        const rows = await tx.$queryRaw<
          Row[]
        >`SELECT id,guess,target,created_at,rules_id FROM number_practice_rounds WHERE user_id=${userId} ORDER BY created_at DESC,id DESC LIMIT 20`;
        return { rulesId: NUMBER_RULES_ID, rounds: rows.map(present) };
      });
    },
    async play(userId: string, input: unknown) {
      let entry;
      try {
        entry = parseNumberEntry(input);
      } catch (e) {
        throw ApiError.badRequest((e as Error).message);
      }
      const { requestId, guess, rulesId } = entry;
      return db.$transaction(async (tx) => {
        // Serialize every request for this user across API processes. Replays read the
        // committed receipt before drawing; a key cannot generate a second result.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'number-practice:' + userId},0))::text`;
        await active(tx, userId);
        const [prior] = await tx.$queryRaw<
          Row[]
        >`SELECT id,guess,target,created_at,rules_id FROM number_practice_rounds WHERE user_id=${userId} AND request_id=${requestId}`;
        if (prior) {
          if (prior.guess !== guess || prior.rules_id !== rulesId)
            throw ApiError.conflict('This request already belongs to a different guess.');
          return { round: present(prior), isReplay: true };
        }
        // Database-wide pacing also covers multiple clients and API instances.
        const [limit] = await tx.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM number_practice_rounds WHERE user_id=${userId} AND created_at>clock_timestamp()-interval '1 minute'`;
        if (Number(limit.count) >= 15)
          throw ApiError.rateLimited('Please wait before your next guess.');
        const target = randomInt(1, 101),
          id = randomUUID();
        const [row] = await tx.$queryRaw<
          Row[]
        >`INSERT INTO number_practice_rounds(id,user_id,request_id,guess,target,rules_id) VALUES(${id},${userId},${requestId},${guess},${target},${rulesId}) RETURNING id,guess,target,created_at,rules_id`;
        return { round: present(row), isReplay: false };
      });
    },
  };
}
