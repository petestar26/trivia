import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@socialplay/database';
import {
  DERBY_RULES,
  derbyOddsCents,
  derbyWins,
  parseDerbyEntry,
  type DerbyField,
  type DerbyMarket,
  type DerbySnapshot,
} from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';
import { derbyCommitment, derbyOrder, derbyPositions } from './math.js';
type Tx = Prisma.TransactionClient;
interface Round {
  id: string;
  field: DerbyField;
  opens_at: Date;
  starts_at: Date;
  finishes_at: Date;
  ends_at: Date;
  finish_order: number[];
  seed: string;
  commitment: string;
}
interface Ticket {
  id: string;
  round_id: string;
  user_id: string;
  market: DerbyMarket;
  picks: number[];
  stake: number;
  odds_cents: number;
  payout: number | null;
}
export function createDerbyService(db: PrismaClient) {
  const clock = async (tx: Tx) =>
    (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  async function account(tx: Tx, userId: string) {
    const [user] = await tx.$queryRaw<
      { status: string }[]
    >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (user?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    await tx.$executeRaw`INSERT INTO derby_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }
  async function flush(tx: Tx) {
    await tx.$executeRaw`SET CONSTRAINTS public.derby_account_check, public.derby_ticket_check IMMEDIATE`;
    await tx.$executeRaw`SET CONSTRAINTS public.derby_account_check, public.derby_ticket_check DEFERRED`;
  }
  async function ensureRounds() {
    for (const field of [6, 8] as const)
      await db.$transaction(async (tx) => {
        const now = await clock(tx),
          cycle = field * 30000,
          opens = Math.floor(now.getTime() / cycle) * cycle;
        const id = `derby-${field}-${opens / cycle}`,
          seed = randomBytes(32).toString('hex');
        await tx.$executeRaw`INSERT INTO derby_rounds(id,field,opens_at,starts_at,finishes_at,ends_at,finish_order,seed,commitment) VALUES(${id},${field},${new Date(opens)},${new Date(opens + cycle - 60000)},${new Date(opens + cycle - 15000)},${new Date(opens + cycle)},${derbyOrder(seed, field)}::integer[],${seed},${derbyCommitment(id, seed)}) ON CONFLICT DO NOTHING`;
      });
  }
  async function settle(roundId: string, userId: string) {
    return db.$transaction(async (tx) => {
      const [r] = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM derby_rounds WHERE id=${roundId} FOR UPDATE`;
      if (!r || (await clock(tx)) < r.finishes_at) return;
      const [t] = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM derby_tickets WHERE round_id=${roundId} AND user_id=${userId} FOR UPDATE`;
      if (!t || t.payout !== null) return;
      await tx.$queryRaw`SELECT user_id FROM derby_accounts WHERE user_id=${userId} FOR UPDATE`;
      const payout = derbyWins(t.market, t.picks, r.finish_order)
        ? Math.floor((t.stake * t.odds_cents) / 100)
        : 0;
      await tx.$executeRaw`UPDATE derby_tickets SET payout=${payout},settled_at=${r.finishes_at} WHERE id=${t.id}`;
      await tx.$executeRaw`UPDATE derby_accounts SET balance=balance+${payout} WHERE user_id=${userId}`;
      await flush(tx);
    });
  }
  async function tick(onError: (id: string, e: unknown) => void = () => {}) {
    await ensureRounds();
    const rows = await db.$queryRaw<
      { round_id: string; user_id: string }[]
    >`SELECT t.round_id,t.user_id FROM derby_tickets t JOIN derby_rounds r ON r.id=t.round_id WHERE t.payout IS NULL AND r.finishes_at<=clock_timestamp() ORDER BY r.opens_at,t.id LIMIT 300`;
    for (const t of rows)
      try {
        await settle(t.round_id, t.user_id);
      } catch (e) {
        onError(t.round_id, e);
      }
  }
  async function snapshot(userId: string, field: DerbyField): Promise<DerbySnapshot> {
    // Authenticate before any recovery or round creation work.
    await db.$transaction((tx) => account(tx, userId));
    await ensureRounds();
    const pending = await db.$queryRaw<
      { round_id: string }[]
    >`SELECT round_id FROM derby_tickets WHERE user_id=${userId} AND payout IS NULL ORDER BY round_id LIMIT 50`;
    for (const t of pending) await settle(t.round_id, userId);
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [wallet] = await tx.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM derby_accounts WHERE user_id=${userId} FOR SHARE`;
      const now = await clock(tx);
      const rounds = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM derby_rounds WHERE field=${field} AND opens_at<=${now} ORDER BY opens_at DESC LIMIT 12`;
      const tickets = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM derby_tickets WHERE user_id=${userId} AND round_id=ANY(${rounds.map((r) => r.id)}::text[])`;
      return {
        rulesId: DERBY_RULES.id,
        serverTime: now.getTime(),
        balance: Number(wallet.balance),
        rounds: rounds.map((r) => {
          const t = tickets.find((t) => t.round_id === r.id),
            reveal = now >= r.finishes_at;
          return {
            id: r.id,
            field: r.field,
            opensAt: r.opens_at.getTime(),
            startsAt: r.starts_at.getTime(),
            finishesAt: r.finishes_at.getTime(),
            endsAt: r.ends_at.getTime(),
            commitment: r.commitment,
            order: reveal ? r.finish_order : null,
            seed: reveal ? r.seed : null,
            positions: derbyPositions(
              r.finish_order,
              now.getTime() - r.starts_at.getTime(),
              r.seed
            ),
            ticket: t
              ? {
                  market: t.market,
                  picks: t.picks,
                  stake: t.stake,
                  oddsCents: t.odds_cents,
                  payout: t.payout,
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
    field: unknown,
    market: unknown,
    picks: unknown,
    stake: unknown
  ) {
    let entry;
    try {
      entry = parseDerbyEntry(field, market, picks, stake);
    } catch (e) {
      throw ApiError.badRequest((e as Error).message);
    }
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [r] = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM derby_rounds WHERE id=${roundId} FOR UPDATE`;
      if (!r || r.field !== entry.field) throw ApiError.notFound('Race not found');
      const [prior] = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM derby_tickets WHERE round_id=${roundId} AND user_id=${userId}`;
      if (prior) {
        if (
          prior.market !== entry.market ||
          prior.stake !== entry.stake ||
          JSON.stringify(prior.picks) !== JSON.stringify(entry.picks)
        )
          throw ApiError.conflict('Your confirmed selection cannot be changed');
        return { accepted: true, isReplay: true };
      }
      const [wallet] = await tx.$queryRaw<
        { balance: bigint }[]
      >`SELECT balance FROM derby_accounts WHERE user_id=${userId} FOR UPDATE`;
      const now = await clock(tx);
      if (now < r.opens_at || now >= r.starts_at)
        throw ApiError.conflict('Selections have closed for this race');
      if (wallet.balance < BigInt(entry.stake))
        throw ApiError.badRequest('Insufficient practice credits');
      await tx.$executeRaw`INSERT INTO derby_tickets(id,round_id,user_id,market,picks,stake,odds_cents) VALUES(${randomUUID()},${roundId},${userId},${entry.market},${entry.picks}::integer[],${entry.stake},${derbyOddsCents(r.field, entry.market)})`;
      await tx.$executeRaw`UPDATE derby_accounts SET balance=balance-${entry.stake} WHERE user_id=${userId}`;
      if ((await clock(tx)) >= r.starts_at)
        throw ApiError.conflict('Selections have closed for this race');
      await flush(tx);
      return { accepted: true, isReplay: false };
    });
  }
  return { snapshot, enter, tick };
}
