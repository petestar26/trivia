import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import { CRASH_POINT_RULES, parseCrashEntry, crashCrossingMs } from '@socialplay/shared';
import type { CrashPointSnapshot, CrashPointActivity } from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';
import { crashCommitment, crashOutcome } from './math.js';
type Tx = Prisma.TransactionClient;
interface Round {
  id: string;
  opens_at: Date;
  starts_at: Date;
  ends_at: Date;
  crash_cents: number;
  seed: string;
  commitment: string;
}
interface Ticket {
  id: string;
  slot: number;
  round_id: string;
  user_id: string;
  stake: number;
  auto_cents: number | null;
  payout: number | null;
  paid_cents: number | null;
}
export function createCrashPointService(db: PrismaClient) {
  const clock = async (tx: Tx) =>
    (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  async function account(tx: Tx, userId: string) {
    const [u] = await tx.$queryRaw<
      { status: string }[]
    >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (u?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    await tx.$executeRaw`INSERT INTO crash_point_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }
  async function ensureRound() {
    await db.$transaction(async (tx) => {
      const now = await clock(tx),
        opens = Math.floor(now.getTime() / 60000) * 60000,
        id = `crash-minute-${opens / 60000}`;
      const seed = randomBytes(32).toString('hex');
      await tx.$executeRaw`INSERT INTO crash_point_rounds(id,opens_at,starts_at,ends_at,crash_cents,seed,commitment)
    VALUES(${id},${new Date(opens)},${new Date(opens + 15000)},${new Date(opens + 60000)},${crashOutcome(seed)},${seed},${crashCommitment(id, seed)}) ON CONFLICT DO NOTHING`;
    });
  }
  async function settle(roundId: string, userId: string, manual = false, slot = 1) {
    return db.$transaction(async (tx) => {
      if (manual) {
        const [u] = await tx.$queryRaw<
          { status: string }[]
        >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
        if (u?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
      }
      const [r] = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM crash_point_rounds WHERE id=${roundId} FOR UPDATE`;
      if (!r) throw ApiError.notFound('Round not found');
      const [t] = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM crash_point_tickets WHERE round_id=${roundId} AND user_id=${userId} AND slot=${slot} FOR UPDATE`;
      if (!t) {
        if (manual) throw ApiError.notFound('Your ticket was not found');
        return null;
      }
      if (t.payout !== null) return { payout: t.payout, paidCents: t.paid_cents };
      await tx.$queryRaw`SELECT user_id FROM crash_point_accounts WHERE user_id=${userId} FOR UPDATE`;
      const [decision] = await tx.$queryRaw<{ paid: number; at: Date; ready: boolean }[]>`
    WITH timing AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS now,
      ${r.starts_at}::timestamptz+ceil(10000*ln(${r.crash_cents}::double precision/100))*interval '1 millisecond' AS crashed,
      ${r.starts_at}::timestamptz+ceil(10000*ln(${t.auto_cents}::double precision/100))*interval '1 millisecond' AS auto)
    SELECT CASE WHEN ${t.auto_cents}<${r.crash_cents} AND now>=auto THEN ${t.auto_cents}
      WHEN now>=crashed THEN 0 ELSE least(2000,floor(100*exp(extract(epoch FROM now-${r.starts_at}::timestamptz)*1000/10000))::integer) END::integer AS paid,
     CASE WHEN ${t.auto_cents}<${r.crash_cents} AND now>=auto THEN auto WHEN now>=crashed THEN crashed ELSE now END AS at,
     ((${t.auto_cents}<${r.crash_cents} AND now>=auto) OR now>=crashed OR (${manual} AND now>=${r.starts_at})) AS ready FROM timing`;
      if (!decision.ready) {
        if (manual) throw ApiError.conflict('Cash-out opens when the round starts');
        return null;
      }
      const payout = Math.floor((t.stake * decision.paid) / 100);
      await tx.$executeRaw`UPDATE crash_point_tickets SET payout=${payout},paid_cents=${decision.paid},settled_at=${decision.at} WHERE id=${t.id}`;
      await tx.$executeRaw`UPDATE crash_point_accounts SET balance=balance+${payout} WHERE user_id=${userId}`;
      return { payout, paidCents: decision.paid };
    });
  }
  async function tick(onError: (id: string, error: unknown) => void = () => {}) {
    await ensureRound();
    const due = await db.$queryRaw<{ round_id: string; user_id: string; slot: number }[]>`
   SELECT t.round_id,t.user_id,t.slot FROM crash_point_tickets t JOIN crash_point_rounds r ON r.id=t.round_id WHERE t.payout IS NULL AND
    (clock_timestamp()>=r.starts_at+ceil(10000*ln(r.crash_cents::double precision/100))*interval '1 millisecond' OR
    (t.auto_cents<r.crash_cents AND clock_timestamp()>=r.starts_at+ceil(10000*ln(t.auto_cents::double precision/100))*interval '1 millisecond'))
   ORDER BY r.opens_at,t.id LIMIT 300`;
    for (const t of due)
      try {
        await settle(t.round_id, t.user_id, false, t.slot);
      } catch (e) {
        onError(t.round_id, e);
      }
  }
  async function snapshot(userId: string): Promise<CrashPointSnapshot> {
    await ensureRound();
    const pending = await db.$queryRaw<
      { round_id: string; slot: number }[]
    >`SELECT round_id,slot FROM crash_point_tickets WHERE user_id=${userId} AND payout IS NULL ORDER BY round_id LIMIT 50`;
    for (const t of pending) await settle(t.round_id, userId, false, t.slot);
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      // User wallet lock prevents a concurrent credit between ticket and balance reads.
      const [wallet] = await tx.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM crash_point_accounts WHERE user_id=${userId} FOR SHARE`;
      const now = await clock(tx);
      const rounds = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM crash_point_rounds WHERE opens_at<=${now} ORDER BY opens_at DESC LIMIT 12`;
      const tickets = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM crash_point_tickets WHERE user_id=${userId} AND round_id=ANY(${rounds.map((r) => r.id)}::text[])`;
      return {
        rulesId: CRASH_POINT_RULES.id,
        maxTickets: 2,
        serverTime: now.getTime(),
        balance: Number(wallet.balance),
        rounds: rounds.map((r) => {
          const revealed = now.getTime() >= r.starts_at.getTime() + crashCrossingMs(r.crash_cents),
            t = tickets.find((t) => t.round_id === r.id && t.slot === 1);
          return {
            id: r.id,
            opensAt: r.opens_at.getTime(),
            startsAt: r.starts_at.getTime(),
            endsAt: r.ends_at.getTime(),
            commitment: r.commitment,
            crashCents: revealed ? r.crash_cents : null,
            seed: revealed ? r.seed : null,
            tickets: tickets
              .filter((t) => t.round_id === r.id)
              .map((t) => ({
                slot: t.slot,
                stake: t.stake,
                autoCents: t.auto_cents,
                payout: t.payout,
                paidCents: t.paid_cents,
              })),
            ticket: t
              ? {
                  stake: t.stake,
                  autoCents: t.auto_cents,
                  payout: t.payout,
                  paidCents: t.paid_cents,
                }
              : null,
          };
        }),
      };
    });
  }
  async function enter(
    userId: string,
    roundId: string,
    stakeValue: unknown,
    autoValue: unknown,
    slot = 1
  ) {
    if (slot !== 1 && slot !== 2) throw ApiError.badRequest('Invalid ticket slot');
    let input;
    try {
      input = parseCrashEntry(stakeValue, autoValue);
    } catch (e) {
      throw ApiError.badRequest((e as Error).message);
    }
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [r] = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM crash_point_rounds WHERE id=${roundId} FOR UPDATE`;
      if (!r) throw ApiError.notFound('Round not found');
      const [prior] = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM crash_point_tickets WHERE round_id=${roundId} AND user_id=${userId} AND slot=${slot}`;
      if (prior) {
        if (prior.stake !== input.stake || prior.auto_cents !== input.autoCents)
          throw ApiError.conflict('Your confirmed ticket cannot be changed');
        return { accepted: true, isReplay: true };
      }
      const [wallet] = await tx.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM crash_point_accounts WHERE user_id=${userId} FOR UPDATE`;
      const now = await clock(tx);
      if (now < r.opens_at || now >= r.starts_at)
        throw ApiError.conflict('Entry has closed for this round');
      if (wallet.balance < BigInt(input.stake))
        throw ApiError.badRequest('Insufficient practice credits');
      await tx.$executeRaw`INSERT INTO crash_point_tickets(id,round_id,user_id,stake,auto_cents,slot) VALUES(${randomUUID()},${roundId},${userId},${input.stake},${input.autoCents},${slot})`;
      await tx.$executeRaw`UPDATE crash_point_accounts SET balance=balance-${input.stake} WHERE user_id=${userId}`;
      if ((await clock(tx)) >= r.starts_at)
        throw ApiError.conflict('Entry has closed for this round');
      return { accepted: true, isReplay: false };
    });
  }
  async function cashout(userId: string, roundId: string, slot = 1) {
    if (slot !== 1 && slot !== 2) throw ApiError.badRequest('Invalid ticket slot');
    return settle(roundId, userId, true, slot);
  }

  async function activity(userId: string, roundId: string): Promise<CrashPointActivity> {
    return db.$transaction(async (tx) => {
      const [user] = await tx.$queryRaw<
        { status: string }[]
      >`SELECT status::text FROM users WHERE id=${userId}`;
      if (user?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
      const [round] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM crash_point_rounds WHERE id=${roundId} AND opens_at<=clock_timestamp()`;
      if (!round) throw ApiError.notFound('Round not found');
      // Project only confirmed public receipt fields. Never read seed, outcome or auto target.
      // Window count and bounded rows come from the same statement snapshot.
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          stake: number;
          payout: number | null;
          paid_cents: number | null;
          total: bigint;
        }>
      >`SELECT id,stake,payout,paid_cents,count(*) OVER() AS total
          FROM crash_point_tickets WHERE round_id=${roundId} ORDER BY id LIMIT 100`;
      return {
        roundId,
        totalTickets: Number(rows[0]?.total ?? 0),
        tickets: rows.map((t) => ({
          player: `Player ${createHash('sha256')
            .update(roundId + ':' + t.id)
            .digest('hex')
            .slice(0, 10)}`,
          stake: t.stake,
          payout: t.payout,
          paidCents: t.paid_cents,
        })),
      };
    });
  }

  async function leaderboard(userId: string) {
    const [user] = await db.$queryRaw<
      { status: string }[]
    >`SELECT status::text FROM users WHERE id=${userId}`;
    if (user?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    const rows = await db.$queryRaw<
      Array<{ id: string; round_id: string; stake: number; payout: number; paid_cents: number }>
    >`
      SELECT id,round_id,stake,payout,paid_cents FROM crash_point_tickets
      WHERE payout>0 AND settled_at>=clock_timestamp()-interval '24 hours'
      ORDER BY payout DESC,settled_at DESC,id LIMIT 50`;
    return {
      period: '24h' as const,
      tickets: rows.map((t) => ({
        player: `Player ${createHash('sha256')
          .update(t.round_id + ':' + t.id)
          .digest('hex')
          .slice(0, 10)}`,
        roundId: t.round_id,
        stake: t.stake,
        payout: t.payout,
        paidCents: t.paid_cents,
      })),
    };
  }
  return { snapshot, enter, cashout, tick, activity, leaderboard };
}
