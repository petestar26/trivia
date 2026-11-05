import { randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@socialplay/database';
import { LUCKY_SIX_RULES as R, lsPayout, lsValidate } from '@socialplay/shared';
import type { LuckySixEntry, LuckySixSnapshot, LuckySixMarket } from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';

interface Round {
  id: string;
  opens_at: Date;
  closes_at: Date;
  ends_at: Date;
  outcome: number[] | null;
}
interface Ticket {
  id: string;
  round_id: string;
  user_id: string;
  slot: number;
  market: LuckySixMarket;
  picks: number[];
  amount: number;
  stake: number;
  payout: number | null;
}
export function drawLuckySix(): number[] {
  const pool = Array.from({ length: R.balls }, (_, i) => i + 1);
  for (let i = 0; i < R.drawn; i++) {
    const j = randomInt(i, pool.length);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, R.drawn);
}
export function createLuckySixService(db: PrismaClient) {
  const clock = async (tx: Prisma.TransactionClient) =>
    (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  async function account(tx: Prisma.TransactionClient, userId: string) {
    const [user] = await tx.$queryRaw<
      { status: string }[]
    >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (!user || user.status !== 'ACTIVE')
      throw ApiError.forbidden('An active account is required');
    await tx.$executeRaw`INSERT INTO ls_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }
  async function snapshot(userId: string): Promise<LuckySixSnapshot> {
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      // Take the account lock before the timestamp so a concurrent settlement
      // cannot publish an advanced balance alongside an earlier reveal time.
      const [wallet] = await tx.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM ls_accounts WHERE user_id=${userId} FOR SHARE`;
      const now = await clock(tx);
      const rounds = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM ls_rounds WHERE opens_at<=${now} ORDER BY opens_at DESC LIMIT 6`;
      const tickets = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM ls_tickets WHERE user_id=${userId} AND round_id=ANY(${rounds.map((r) => r.id)}::text[])`;
      return {
        enabled: true,
        rulesId: R.id,
        serverTime: +now,
        balance: Number(wallet.balance),
        maxTickets: R.maxTickets,
        rounds: rounds.map((r) => {
          const count = Math.max(
            0,
            Math.min(R.drawn, Math.floor((+now - +r.closes_at) / R.revealMs))
          );
          const complete = !!r.outcome && count === R.drawn;
          return {
            id: r.id,
            opensAt: +r.opens_at,
            closesAt: +r.closes_at,
            endsAt: +r.ends_at,
            revealed: r.outcome?.slice(0, count) ?? [],
            complete,
            tickets: tickets
              .filter((t) => t.round_id === r.id)
              .sort((a, b) => a.slot - b.slot)
              .map((t) => ({
                id: t.id,
                roundId: t.round_id,
                slot: t.slot,
                market: t.market,
                picks: t.picks,
                amount: t.amount,
                stake: t.stake,
                payout: complete ? t.payout : null,
              })),
          };
        }),
      };
    });
  }
  async function enter(userId: string, entry: LuckySixEntry) {
    let values: ReturnType<typeof lsValidate>;
    try {
      values = lsValidate(entry.market, entry.picks, entry.amount);
    } catch (e) {
      throw ApiError.badRequest((e as Error).message);
    }
    if (!Number.isInteger(entry.slot) || entry.slot < 1 || entry.slot > R.maxTickets)
      throw ApiError.badRequest('Choose Bet 1 to Bet 10');
    const { market, picks, amount, stake } = values;
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [round] = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM ls_rounds WHERE id=${entry.roundId} FOR UPDATE`;
      if (!round) throw ApiError.notFound('Round not found');
      const [prior] = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM ls_tickets WHERE round_id=${round.id} AND user_id=${userId} AND slot=${entry.slot}`;
      if (prior) {
        if (
          prior.market !== market ||
          prior.amount !== amount ||
          JSON.stringify(prior.picks) !== JSON.stringify(picks)
        )
          throw ApiError.conflict('This bet already has a different confirmed ticket');
        return { accepted: true, isReplay: true, id: prior.id };
      }
      const [wallet] = await tx.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM ls_accounts WHERE user_id=${userId} FOR UPDATE`;
      const now = await clock(tx);
      if (now < round.opens_at || now >= round.closes_at || round.outcome)
        throw ApiError.conflict('Entry has closed for this draw');
      if (BigInt(wallet.balance) < BigInt(stake))
        throw ApiError.badRequest('Insufficient practice ETB');
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO ls_tickets(id,round_id,user_id,slot,market,picks,amount,stake) VALUES(${id},${round.id},${userId},${entry.slot},${market},${JSON.stringify(picks)}::jsonb,${amount},${stake})`;
      await tx.$executeRaw`UPDATE ls_accounts SET balance=balance-${stake} WHERE user_id=${userId}`;
      if ((await clock(tx)) >= round.closes_at)
        throw ApiError.conflict('Entry has closed for this draw');
      return { accepted: true, isReplay: false, id };
    });
  }
  async function tick(onError: (id: string, error: unknown) => void = () => {}) {
    await db.$transaction(async (tx) => {
      const now = await clock(tx),
        opens = Math.floor(+now / R.roundMs) * R.roundMs;
      await tx.$executeRaw`INSERT INTO ls_rounds(id,opens_at,closes_at,ends_at) VALUES(${`ls-${opens / R.roundMs}`},${new Date(opens)},${new Date(opens + R.entryMs)},${new Date(opens + R.roundMs)}) ON CONFLICT DO NOTHING`;
    });
    const due = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM ls_rounds WHERE outcome IS NULL AND closes_at<=clock_timestamp() AND retry_at<=clock_timestamp() ORDER BY retry_at,closes_at LIMIT 100`;
    for (const r of due)
      try {
        await db.$executeRaw`UPDATE ls_rounds SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${r.id} AND outcome IS NULL`;
        await db.$transaction(async (tx) => {
          const [r0] = await tx.$queryRaw<
            Round[]
          >`SELECT * FROM ls_rounds WHERE id=${r.id} FOR UPDATE`;
          if (r0.outcome) return;
          await tx.$executeRaw`UPDATE ls_rounds SET outcome=${JSON.stringify(drawLuckySix())}::jsonb WHERE id=${r.id}`;
        });
      } catch (e) {
        onError(r.id, e);
      }
    const dueTickets = await db.$queryRaw<
      { id: string }[]
    >`SELECT t.id FROM ls_tickets t JOIN ls_rounds r ON r.id=t.round_id WHERE t.payout IS NULL AND r.outcome IS NOT NULL AND r.closes_at+interval '70 seconds'<=clock_timestamp() AND t.retry_at<=clock_timestamp() ORDER BY t.retry_at,r.closes_at,t.id LIMIT 200`;
    for (const t of dueTickets)
      try {
        await db.$executeRaw`UPDATE ls_tickets SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${t.id} AND payout IS NULL`;
        await db.$transaction(async (tx) => {
          // Lock the account before its ticket, matching snapshot's account-first
          // read. Admission cannot overlap settlement in this closed round.
          const [owner] = await tx.$queryRaw<
            { user_id: string }[]
          >`SELECT user_id FROM ls_tickets WHERE id=${t.id}`;
          await tx.$queryRaw`SELECT user_id FROM ls_accounts WHERE user_id=${owner.user_id} FOR UPDATE`;
          const [ticket] = await tx.$queryRaw<
            Ticket[]
          >`SELECT * FROM ls_tickets WHERE id=${t.id} FOR UPDATE`;
          if (ticket.payout !== null) return;
          const [round] = await tx.$queryRaw<
            Round[]
          >`SELECT * FROM ls_rounds WHERE id=${ticket.round_id}`;
          const payout = lsPayout(ticket, round.outcome!);
          await tx.$executeRaw`UPDATE ls_tickets SET payout=${payout} WHERE id=${ticket.id}`;
          await tx.$executeRaw`UPDATE ls_accounts SET balance=balance+${payout} WHERE user_id=${ticket.user_id}`;
        });
      } catch (e) {
        onError(t.id, e);
      }
  }
  return { snapshot, enter, tick };
}
