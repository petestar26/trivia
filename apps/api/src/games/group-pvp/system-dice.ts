import { randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@socialplay/database';
import { parseDiceStake, settleDicePractice, SYSTEM_DICE_RULES } from '@socialplay/shared';
import type { SystemDiceSnapshot } from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';

interface Round { id: string; opens_at: Date; closes_at: Date; ends_at: Date; die1: number | null; die2: number | null }
interface Ticket { id: string; round_id: string; user_id: string; stake: number; payout: number | null }
export function createSystemDiceService(db: PrismaClient) {
  const clock = async (tx: Prisma.TransactionClient) => (await tx.$queryRaw<{now: Date}[]>`SELECT clock_timestamp() AS now`)[0].now;
  async function account(tx: Prisma.TransactionClient, userId: string) {
    const [user] = await tx.$queryRaw<{status: string}[]>`SELECT status::text FROM users WHERE id=${userId} FOR SHARE`;
    if (!user || user.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
    await tx.$executeRaw`INSERT INTO system_dice_practice_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }
  async function snapshot(userId: string): Promise<SystemDiceSnapshot> {
    return db.$transaction(async tx => {
      await account(tx, userId); const now = await clock(tx);
      const rounds = await tx.$queryRaw<Round[]>`SELECT * FROM system_dice_practice_rounds WHERE opens_at<=${now} ORDER BY opens_at DESC LIMIT 5`;
      const tickets = await tx.$queryRaw<Ticket[]>`SELECT * FROM system_dice_practice_tickets WHERE user_id=${userId} AND round_id=ANY(${rounds.map(r=>r.id)}::text[])`;
      const [wallet] = await tx.$queryRaw<{balance: bigint}[]>`SELECT balance FROM system_dice_practice_accounts WHERE user_id=${userId}`;
      return { enabled: true, rulesId: SYSTEM_DICE_RULES.id, serverTime: now.getTime(), balance: Number(wallet.balance),
        rounds: rounds.map(r => { const ticket = tickets.find(t=>t.round_id===r.id); return {
          id:r.id, opensAt:r.opens_at.getTime(), closesAt:r.closes_at.getTime(), endsAt:r.ends_at.getTime(),
          outcome:r.die1===null?null:[r.die1,r.die2!] as [number,number], ticket:ticket?{stake:ticket.stake,payout:ticket.payout}:null,
        }; }) };
    });
  }
  async function enter(userId: string, roundId: string, value: unknown) {
    let stake: number; try { stake = parseDiceStake(value); } catch (e) { throw ApiError.badRequest((e as Error).message); }
    return db.$transaction(async tx => {
      await account(tx,userId);
      const [round] = await tx.$queryRaw<Round[]>`SELECT * FROM system_dice_practice_rounds WHERE id=${roundId} FOR UPDATE`;
      if (!round) throw ApiError.notFound('Round not found');
      const [prior] = await tx.$queryRaw<Ticket[]>`SELECT * FROM system_dice_practice_tickets WHERE round_id=${roundId} AND user_id=${userId}`;
      if (prior) {
        if (prior.stake !== stake) throw ApiError.conflict('This round already has your confirmed ticket');
        return {accepted:true,isReplay:true};
      }
      const [wallet] = await tx.$queryRaw<{balance:bigint}[]>`SELECT balance FROM system_dice_practice_accounts WHERE user_id=${userId} FOR UPDATE`;
      const now = await clock(tx);
      if (now < round.opens_at || now >= round.closes_at || round.die1 !== null) throw ApiError.conflict('Betting has closed for this round');
      if (wallet.balance < BigInt(stake)) throw ApiError.badRequest('Insufficient practice credits');
      await tx.$executeRaw`INSERT INTO system_dice_practice_tickets(id,round_id,user_id,stake) VALUES(${randomUUID()},${roundId},${userId},${stake})`;
      await tx.$executeRaw`UPDATE system_dice_practice_accounts SET balance=balance-${stake} WHERE user_id=${userId}`;
      if (await clock(tx) >= round.closes_at) throw ApiError.conflict('Betting has closed for this round');
      return {accepted:true,isReplay:false};
    });
  }
  async function tick(onError: (id:string,error:unknown)=>void = ()=>{}) {
    await db.$transaction(async tx => {
      const now = await clock(tx), opens = Math.floor(now.getTime()/60000)*60000;
      await tx.$executeRaw`INSERT INTO system_dice_practice_rounds(id,opens_at,closes_at,ends_at)
        VALUES(${`dice-minute-${opens/60000}`},${new Date(opens)},${new Date(opens+45000)},${new Date(opens+60000)}) ON CONFLICT DO NOTHING`;
    });
    const due = await db.$queryRaw<{id:string}[]>`SELECT id FROM system_dice_practice_rounds WHERE die1 IS NULL AND closes_at<=clock_timestamp() AND retry_at<=clock_timestamp() ORDER BY retry_at,closes_at LIMIT 100`;
    for (const r of due) try {
      await db.$executeRaw`UPDATE system_dice_practice_rounds SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${r.id} AND die1 IS NULL`;
      await db.$transaction(async tx => {
        const [locked] = await tx.$queryRaw<Round[]>`SELECT * FROM system_dice_practice_rounds WHERE id=${r.id} FOR UPDATE`;
        if (locked.die1 !== null) return;
        await tx.$executeRaw`UPDATE system_dice_practice_rounds SET die1=${randomInt(1,7)},die2=${randomInt(1,7)} WHERE id=${r.id}`;
      });
    } catch (error) { onError(r.id,error); }
    // Separate durable outcome and credits: a failed credit never causes a reroll.
    const tickets = await db.$queryRaw<{id:string}[]>`SELECT t.id FROM system_dice_practice_tickets t JOIN system_dice_practice_rounds r ON r.id=t.round_id
      WHERE t.payout IS NULL AND r.die1 IS NOT NULL AND t.retry_at<=clock_timestamp() ORDER BY t.retry_at,r.closes_at,t.id LIMIT 200`;
    for (const ticket of tickets) try {
      await db.$executeRaw`UPDATE system_dice_practice_tickets SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${ticket.id} AND payout IS NULL`;
      await db.$transaction(async tx => {
        const [t] = await tx.$queryRaw<Ticket[]>`SELECT * FROM system_dice_practice_tickets WHERE id=${ticket.id} FOR UPDATE`;
        if (t.payout !== null) return;
        const [r] = await tx.$queryRaw<Round[]>`SELECT * FROM system_dice_practice_rounds WHERE id=${t.round_id}`;
        const payout = settleDicePractice(t.stake,[r.die1!,r.die2!]);
        await tx.$queryRaw`SELECT user_id FROM system_dice_practice_accounts WHERE user_id=${t.user_id} FOR UPDATE`;
        await tx.$executeRaw`UPDATE system_dice_practice_tickets SET payout=${payout} WHERE id=${t.id}`;
        await tx.$executeRaw`UPDATE system_dice_practice_accounts SET balance=balance+${payout} WHERE user_id=${t.user_id}`;
      });
    } catch (error) { onError(ticket.id,error); }
  }
  return {snapshot,enter,tick};
}
