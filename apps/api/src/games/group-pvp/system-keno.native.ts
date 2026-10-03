import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {createSystemKenoService} from './system-keno.js';
const source=process.env.DATABASE_URL;const url=source?new URL(source):null;
if(!url||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/playqube_scheduled_throwaway'||process.env.SCHEDULED_NATIVE_DB_ACK!=='throwaway')throw new Error('Acknowledged throwaway database required');
const db=new PrismaClient({datasourceUrl:source,log:[]});const service=createSystemKenoService(db);
beforeAll(async()=>{await db.$connect();});afterAll(async()=>{await db.$disconnect();});
async function fixture(closeIn=20000){
 const userId=randomUUID(),roundId=randomUUID();const closes=new Date(Date.now()+closeIn);await db.user.create({data:{id:userId,username:`keno_${userId.replaceAll('-','')}`,isVerified:true}});
 await service.snapshot(userId);
 await db.$executeRaw`INSERT INTO system_keno_practice_rounds(id,opens_at,closes_at,ends_at) VALUES(${roundId},${new Date(closes.getTime()-45000)},${closes},${new Date(closes.getTime()+15000)})`;
 return {userId,roundId};
}
const balance=async(userId:string)=>Number((await db.$queryRaw<{balance:bigint}[]>`SELECT balance FROM system_keno_practice_accounts WHERE user_id=${userId}`)[0].balance);
it('concurrent confirmations debit once and reject changed tickets',async()=>{
 const f=await fixture();await Promise.all([1,2].map(()=>service.enter(f.userId,f.roundId,[3,2,1],5)));
 expect(await balance(f.userId)).toBe(985);await expect(service.enter(f.userId,f.roundId,[4],5)).rejects.toThrow('confirmed');
});
it('recovers a stored draw and pays once across concurrent workers',async()=>{
 const f=await fixture();await service.enter(f.userId,f.roundId,[1,2,80],10);
 await db.$executeRaw`UPDATE system_keno_practice_rounds SET outcome=${JSON.stringify(Array.from({length:20},(_,i)=>i+1))}::jsonb WHERE id=${f.roundId}`;
 const errors:string[]=[];await Promise.all([service.tick(id=>errors.push(id)),service.tick(id=>errors.push(id))]);expect(errors).toEqual([]);
 expect(await balance(f.userId)).toBe(1042);await service.tick();expect(await balance(f.userId)).toBe(1042);
 await expect(db.$executeRaw`UPDATE system_keno_practice_rounds SET outcome='[2]'::jsonb WHERE id=${f.roundId}`).rejects.toThrow();
 await expect(db.$executeRaw`UPDATE system_keno_practice_accounts SET balance=balance+1 WHERE user_id=${f.userId}`).rejects.toThrow('balance');
});
it('uses one epoch-minute schedule and persists a unique 20-ball draw',async()=>{
 const f=await fixture(-1000);const errors:string[]=[];await Promise.all([service.tick(id=>errors.push(id)),service.tick(id=>errors.push(id))]);expect(errors).toEqual([]);
 const [draw]=await db.$queryRaw<{outcome:number[]}[]>`SELECT outcome FROM system_keno_practice_rounds WHERE id=${f.roundId}`;
 expect(draw.outcome).toHaveLength(20);expect(new Set(draw.outcome).size).toBe(20);expect(draw.outcome.every(n=>n>=1&&n<=80)).toBe(true);
 await service.tick();expect((await db.$queryRaw<{outcome:number[]}[]>`SELECT outcome FROM system_keno_practice_rounds WHERE id=${f.roundId}`)[0].outcome).toEqual(draw.outcome);
 const rows=await db.$queryRaw<{opens_at:Date;closes_at:Date;ends_at:Date}[]>`SELECT * FROM system_keno_practice_rounds WHERE id LIKE 'keno-minute-%' ORDER BY opens_at DESC LIMIT 1`;
 expect(rows[0].opens_at.getTime()%60000).toBe(0);expect(rows[0].closes_at.getTime()-rows[0].opens_at.getTime()).toBe(45000);expect(rows[0].ends_at.getTime()-rows[0].opens_at.getTime()).toBe(60000);
});
it('rechecks the cutoff after waiting for the wallet lock and never charges late',async()=>{
 const f=await fixture(1200);let release!:()=>void,locked!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>locked=r);
 const holder=db.$transaction(async tx=>{await tx.$queryRaw`SELECT user_id FROM system_keno_practice_accounts WHERE user_id=${f.userId} FOR UPDATE`;locked();await gate;});
 await started;const entry=service.enter(f.userId,f.roundId,[1],5);const check=expect(entry).rejects.toThrow('closed');await new Promise(r=>setTimeout(r,1400));release();await holder;await check;expect(await balance(f.userId)).toBe(1000);
});