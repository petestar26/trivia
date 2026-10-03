import { randomInt,randomUUID } from 'node:crypto';
import type { PrismaClient,Prisma } from '@socialplay/database';
import type { SystemKenoSnapshot } from '@socialplay/shared';
import { ApiError } from '../../middleware/api-error.js';

interface Round {id:string;opens_at:Date;closes_at:Date;ends_at:Date;outcome:number[]|null}
interface Ticket {id:string;round_id:string;user_id:string;picks:number[];stake_per_number:number;stake:number;payout:number|null}
export function createSystemKenoService(db:PrismaClient) {
  const clock=async(tx:Prisma.TransactionClient)=>(await tx.$queryRaw<{now:Date}[]>`SELECT clock_timestamp() AS now`)[0].now;
  async function account(tx:Prisma.TransactionClient,userId:string) {
    const [user]=await tx.$queryRaw<{status:string;isVerified:boolean}[]>`SELECT status::text,"isVerified" FROM users WHERE id=${userId} FOR SHARE`;
    if(!user||user.status!=='ACTIVE'||!user.isVerified)throw ApiError.forbidden('An active verified account is required');
    await tx.$executeRaw`INSERT INTO system_keno_practice_accounts(user_id) VALUES(${userId}) ON CONFLICT DO NOTHING`;
  }
  async function snapshot(userId:string):Promise<SystemKenoSnapshot> {
    return db.$transaction(async tx=>{
      await account(tx,userId);const now=await clock(tx);
      const rounds=await tx.$queryRaw<Round[]>`SELECT * FROM system_keno_practice_rounds WHERE opens_at<=${now} ORDER BY opens_at DESC LIMIT 3`;
      const tickets=await tx.$queryRaw<Ticket[]>`SELECT * FROM system_keno_practice_tickets WHERE user_id=${userId} AND round_id=ANY(${rounds.map(r=>r.id)}::text[])`;
      const [wallet]=await tx.$queryRaw<{balance:bigint}[]>`SELECT balance FROM system_keno_practice_accounts WHERE user_id=${userId}`;
      return {enabled:true,serverTime:now.getTime(),balance:Number(wallet.balance),rounds:rounds.map(r=>{
        const t=tickets.find(t=>t.round_id===r.id);return {id:r.id,opensAt:r.opens_at.getTime(),closesAt:r.closes_at.getTime(),endsAt:r.ends_at.getTime(),outcome:r.outcome,
          ticket:t?{picks:t.picks,stakePerNumber:t.stake_per_number,stake:t.stake,payout:t.payout}:null};})};
    });
  }
  async function enter(userId:string,roundId:string,values:unknown,stake:number) {
    if(!Array.isArray(values)||values.length<1||values.length>10||new Set(values).size!==values.length||values.some(n=>!Number.isInteger(n)||n<1||n>80)||
      !Number.isSafeInteger(stake)||stake<5||stake%5||stake*values.length>480)throw ApiError.badRequest('Choose 1–10 numbers and stakes in steps of 5, up to 480 total');
    const picks=[...values].sort((a,b)=>a-b) as number[];
    return db.$transaction(async tx=>{
      await account(tx,userId);
      const [r]=await tx.$queryRaw<Round[]>`SELECT * FROM system_keno_practice_rounds WHERE id=${roundId} FOR UPDATE`;
      if(!r)throw ApiError.notFound('Round not found');
      const [prior]=await tx.$queryRaw<Ticket[]>`SELECT * FROM system_keno_practice_tickets WHERE round_id=${roundId} AND user_id=${userId}`;
      if(prior){if(prior.stake_per_number!==stake||JSON.stringify(prior.picks)!==JSON.stringify(picks))throw ApiError.conflict('This round already has your confirmed ticket');return {accepted:true,isReplay:true};}
      const [wallet]=await tx.$queryRaw<{balance:bigint}[]>`SELECT balance FROM system_keno_practice_accounts WHERE user_id=${userId} FOR UPDATE`;
      const now=await clock(tx);
      if(now<r.opens_at||now>=r.closes_at||r.outcome)throw ApiError.conflict('Betting has closed for this round');
      const total=picks.length*stake;if(wallet.balance<BigInt(total))throw ApiError.badRequest('Insufficient practice credits');
      await tx.$executeRaw`INSERT INTO system_keno_practice_tickets(id,round_id,user_id,picks,stake_per_number,stake) VALUES(${randomUUID()},${roundId},${userId},${JSON.stringify(picks)}::jsonb,${stake},${total})`;
      await tx.$executeRaw`UPDATE system_keno_practice_accounts SET balance=balance-${total} WHERE user_id=${userId}`;
      if(await clock(tx)>=r.closes_at)throw ApiError.conflict('Betting has closed for this round');
      return {accepted:true,isReplay:false};
    });
  }
  async function tick(onError:(id:string)=>void=()=>{}) {
    await db.$transaction(async tx=>{
      const now=await clock(tx);const opens=Math.floor(now.getTime()/60000)*60000;
      await tx.$executeRaw`INSERT INTO system_keno_practice_rounds(id,opens_at,closes_at,ends_at) VALUES(${`keno-minute-${opens/60000}`},${new Date(opens)},${new Date(opens+45000)},${new Date(opens+60000)}) ON CONFLICT DO NOTHING`;
    });
    const due=await db.$queryRaw<{id:string}[]>`SELECT id FROM system_keno_practice_rounds WHERE outcome IS NULL AND closes_at<=clock_timestamp() AND retry_at<=clock_timestamp() ORDER BY retry_at,closes_at LIMIT 100`;
    for(const r of due)try{
      await db.$executeRaw`UPDATE system_keno_practice_rounds SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${r.id} AND outcome IS NULL`;
      await db.$transaction(async tx=>{
        const [locked]=await tx.$queryRaw<Round[]>`SELECT * FROM system_keno_practice_rounds WHERE id=${r.id} FOR UPDATE`;
        if(locked.outcome)return;
        const balls=Array.from({length:80},(_,i)=>i+1);for(let i=0;i<20;i++){const j=randomInt(i,80);[balls[i],balls[j]]=[balls[j],balls[i]];}
        await tx.$executeRaw`UPDATE system_keno_practice_rounds SET outcome=${JSON.stringify(balls.slice(0,20))}::jsonb WHERE id=${r.id}`;
      });
    }catch{onError(r.id);}
    const tickets=await db.$queryRaw<{id:string}[]>`SELECT t.id FROM system_keno_practice_tickets t JOIN system_keno_practice_rounds r ON r.id=t.round_id WHERE t.payout IS NULL AND r.outcome IS NOT NULL AND t.retry_at<=clock_timestamp() ORDER BY t.retry_at,r.closes_at,t.id LIMIT 200`;
    for(const ticket of tickets)try{
      await db.$executeRaw`UPDATE system_keno_practice_tickets SET retry_at=clock_timestamp()+interval '10 seconds' WHERE id=${ticket.id} AND payout IS NULL`;
      await db.$transaction(async tx=>{
        const [t]=await tx.$queryRaw<Ticket[]>`SELECT * FROM system_keno_practice_tickets WHERE id=${ticket.id} FOR UPDATE`;
        if(t.payout!==null)return;
        const [r]=await tx.$queryRaw<Round[]>`SELECT * FROM system_keno_practice_rounds WHERE id=${t.round_id}`;
        const payout=t.picks.filter(n=>r.outcome!.includes(n)).length*t.stake_per_number/5*18;
        await tx.$queryRaw`SELECT user_id FROM system_keno_practice_accounts WHERE user_id=${t.user_id} FOR UPDATE`;
        await tx.$executeRaw`UPDATE system_keno_practice_tickets SET payout=${payout} WHERE id=${t.id}`;
        await tx.$executeRaw`UPDATE system_keno_practice_accounts SET balance=balance+${payout} WHERE user_id=${t.user_id}`;
      });
    }catch{onError(ticket.id);}
  }
  return {snapshot,enter,tick};
}