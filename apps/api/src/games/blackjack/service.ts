import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@socialplay/database';
import {
  BLACKJACK_RULES as R,
  bjKey,
  bjValidate,
  bjWon,
  type BlackjackEntry,
  type BlackjackSnapshot,
  type BlackjackMarket,
} from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';
import { advanceHands, priceHands } from './engine.js';
interface Round {
  id: string;
  opens_at: Date;
  stage: number;
  hands: number[][];
  quotes: Record<string, number>;
}
interface Ticket {
  id: string;
  round_id: string;
  user_id: string;
  slot: number;
  stage: number;
  seat: number;
  market: BlackjackMarket;
  amount: number;
  odds: number;
  payout_cents: number | null;
}
export function createBlackjackService(db: PrismaClient) {
  const clock = async (tx: Prisma.TransactionClient) =>
    (await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
  async function account(tx: Prisma.TransactionClient, userId: string) {
    const [u] = await tx.$queryRaw<
      { status: string }[]
    >`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (!u || u.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    await tx.$executeRaw`INSERT INTO bj_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }
  async function snapshot(userId: string): Promise<BlackjackSnapshot> {
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [wallet] = await tx.$queryRaw<
        { balance_cents: bigint }[]
      >`SELECT balance_cents FROM bj_accounts WHERE user_id=${userId} FOR SHARE`;
      const rounds = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM bj_rounds WHERE opens_at<=clock_timestamp() ORDER BY opens_at DESC LIMIT 16`;
      const tickets = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM bj_tickets WHERE user_id=${userId} AND round_id=ANY(${rounds.map((r) => r.id)}::text[])`;
      const now = await clock(tx);
      return {
        enabled: true,
        rulesId: R.id,
        serverTime: +now,
        balance: Number(wallet.balance_cents) / 100,
        maxTickets: R.maxTickets,
        rounds: rounds.map((r) => ({
          id: r.id,
          opensAt: +r.opens_at,
          endsAt: +r.opens_at + R.roundMs,
          stage: r.stage,
          hands: r.hands,
          quotes: r.quotes,
          tickets: tickets
            .filter((t) => t.round_id === r.id)
            .sort((a, b) => a.slot - b.slot)
            .map((t) => ({
              id: t.id,
              roundId: t.round_id,
              slot: t.slot,
              stage: t.stage,
              seat: t.seat,
              market: t.market,
              amount: t.amount,
              odds: t.odds,
              payout: r.stage === 3 && t.payout_cents !== null ? t.payout_cents / 100 : null,
            })),
        })),
      };
    });
  }
  async function enter(userId: string, entry: BlackjackEntry) {
    try {
      bjValidate(entry);
    } catch (e) {
      throw ApiError.badRequest((e as Error).message);
    }
    return db.$transaction(async (tx) => {
      await account(tx, userId);
      const [r] = await tx.$queryRaw<
        Round[]
      >`SELECT * FROM bj_rounds WHERE id=${entry.roundId} FOR UPDATE`;
      if (!r) throw ApiError.notFound('Round not found');
      const [prior] = await tx.$queryRaw<
        Ticket[]
      >`SELECT * FROM bj_tickets WHERE round_id=${r.id} AND user_id=${userId} AND slot=${entry.slot}`;
      if (prior) {
        if (
          prior.stage !== entry.stage ||
          prior.seat !== entry.seat ||
          prior.market !== entry.market ||
          prior.amount !== entry.amount ||
          prior.odds !== entry.odds
        )
          throw ApiError.conflict('This bet already has a different confirmed ticket');
        return { accepted: true, isReplay: true, id: prior.id };
      }
      const [wallet] = await tx.$queryRaw<
        { balance_cents: bigint }[]
      >`SELECT balance_cents FROM bj_accounts WHERE user_id=${userId} FOR UPDATE`;
      const now = await clock(tx),
        phase = Math.floor((+now - +r.opens_at) / R.stageMs);
      if (phase < 0 || phase > 2 || r.stage !== phase || entry.stage !== phase)
        throw ApiError.conflict('Betting stage closed. Review the latest cards and prices.');
      if (r.quotes[bjKey(entry.seat, entry.market)] !== entry.odds)
        throw ApiError.conflict('This price has changed or the market is closed');
      if (BigInt(wallet.balance_cents) < BigInt(entry.amount * 100))
        throw ApiError.badRequest('Insufficient practice ETB');
      const id = randomUUID();
      await tx.$executeRaw`INSERT INTO bj_tickets(id,round_id,user_id,slot,stage,seat,market,amount,odds) VALUES(${id},${r.id},${userId},${entry.slot},${entry.stage},${entry.seat},${entry.market},${entry.amount},${entry.odds})`;
      await tx.$executeRaw`UPDATE bj_accounts SET balance_cents=balance_cents-${entry.amount * 100} WHERE user_id=${userId}`;
      if (+(await clock(tx)) >= +r.opens_at + (entry.stage + 1) * R.stageMs)
        throw ApiError.conflict('Betting stage closed');
      return { accepted: true, isReplay: false, id };
    });
  }
  async function tick(onError: (id: string, error: unknown) => void = () => {}) {
    const now = await clock(db),
      opens = Math.floor(+now / R.roundMs) * R.roundMs,
      id = `bj-${opens / R.roundMs}`;
    const exists = await db.$queryRaw<{ id: string }[]>`SELECT id FROM bj_rounds WHERE id=${id}`;
    if (!exists.length) {
      const hands = advanceHands(
          Array.from({ length: 7 }, () => []),
          0
        ),
        quotes = priceHands(hands, 0);
      await db.$executeRaw`INSERT INTO bj_rounds(id,opens_at,stage,hands,quotes) VALUES(${id},${new Date(opens)},0,${JSON.stringify(hands)}::jsonb,${JSON.stringify(quotes)}::jsonb) ON CONFLICT DO NOTHING`;
    }
    const due = await db.$queryRaw<
      { id: string }[]
    >`SELECT id FROM bj_rounds WHERE stage<3 AND opens_at+(stage+1)*interval '40 seconds'<=clock_timestamp() AND retry_at<=clock_timestamp() ORDER BY retry_at,opens_at LIMIT 100`;
    for (const { id } of due)
      try {
        await db.$executeRaw`UPDATE bj_rounds SET retry_at=clock_timestamp()+interval '2 seconds' WHERE id=${id} AND stage<3`;
        await db.$transaction(
          async (tx) => {
            let [r] = await tx.$queryRaw<
              Round[]
            >`SELECT * FROM bj_rounds WHERE id=${id} FOR UPDATE`;
            const target = Math.min(3, Math.floor((+(await clock(tx)) - +r.opens_at) / R.stageMs));
            while (r.stage < target) {
              const stage = r.stage + 1,
                hands = advanceHands(r.hands, stage),
                quotes = stage === 3 ? {} : priceHands(hands, stage);
              await tx.$executeRaw`UPDATE bj_rounds SET stage=${stage},hands=${JSON.stringify(hands)}::jsonb,quotes=${JSON.stringify(quotes)}::jsonb WHERE id=${id}`;
              r = { ...r, stage, hands, quotes };
            }
          },
          { timeout: 20000 }
        );
      } catch (e) {
        onError(id, e);
      }
    const dueTickets = await db.$queryRaw<
      { id: string }[]
    >`SELECT t.id FROM bj_tickets t JOIN bj_rounds r ON r.id=t.round_id WHERE t.payout_cents IS NULL AND r.stage=3 AND t.retry_at<=clock_timestamp() ORDER BY t.retry_at,r.opens_at,t.id LIMIT 200`;
    for (const { id } of dueTickets)
      try {
        await db.$executeRaw`UPDATE bj_tickets SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${id} AND payout_cents IS NULL`;
        await db.$transaction(async (tx) => {
          const [owner] = await tx.$queryRaw<
            { user_id: string }[]
          >`SELECT user_id FROM bj_tickets WHERE id=${id}`;
          await tx.$queryRaw`SELECT user_id FROM bj_accounts WHERE user_id=${owner.user_id} FOR UPDATE`;
          const [t] = await tx.$queryRaw<
            Ticket[]
          >`SELECT * FROM bj_tickets WHERE id=${id} FOR UPDATE`;
          if (t.payout_cents !== null) return;
          const [r] = await tx.$queryRaw<Round[]>`SELECT * FROM bj_rounds WHERE id=${t.round_id}`;
          const cents = bjWon(t.seat, t.market, r.hands) ? t.amount * t.odds : 0;
          await tx.$executeRaw`UPDATE bj_tickets SET payout_cents=${cents} WHERE id=${id}`;
          await tx.$executeRaw`UPDATE bj_accounts SET balance_cents=balance_cents+${cents} WHERE user_id=${t.user_id}`;
        });
      } catch (e) {
        onError(id, e);
      }
  }
  return { snapshot, enter, tick };
}
