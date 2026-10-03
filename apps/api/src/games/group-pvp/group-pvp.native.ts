import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createGroupPvpService } from './service.js';
import { applyBalanceChanges } from '../../economy/wallet-service.js';
import { PVP_POLICY } from '../economics/policy.js';

const source=process.env.DATABASE_URL; const url=source?new URL(source):null;
if(!url || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname!=='/playqube_scheduled_throwaway' ||
   process.env.SCHEDULED_NATIVE_DB_ACK!=='throwaway')throw new Error('Acknowledged throwaway database required');
const db=new PrismaClient({datasourceUrl:source,log:[]});
const service=createGroupPvpService(db);
beforeAll(async()=>{await db.$connect();});afterAll(async()=>{await db.$disconnect();});
async function fixture(game:'spin_win'|'turbo_keno'='spin_win',lobbyMs?:number) {
  const groupId=randomUUID(); const ids=[randomUUID(),randomUUID(),randomUUID()];
  for(const id of ids){await db.user.create({data:{id,username:`pvp_${id.replaceAll('-','')}`,isVerified:true}});
    await db.wallet.create({data:{userId:id}});
    await db.$transaction(tx=>applyBalanceChanges(tx,id,[{currency:'GAME_POINTS',amount:10000,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable PVP test funding'}]));}
  await db.$transaction(async tx=>{
    await tx.group.create({data:{id:groupId,name:'PVP disposable test',ownerId:ids[0],isPrivate:true}});
    for(const id of ids)await tx.groupMember.create({data:{groupId,userId:id,role:id===ids[0]?'OWNER':'MEMBER'}});
  });
  const roundId=lobbyMs===undefined?await service.create(groupId,ids[0],game,100,randomUUID()):randomUUID();
  if(lobbyMs!==undefined)await db.$executeRaw`INSERT INTO group_pvp_rounds(id,group_id,creator_id,request_id,game,rules_id,policy_id,entry_amount,expires_at)
    VALUES(${roundId},${groupId},${ids[0]},${randomUUID()},${game},'group-pvp-points-v1',${PVP_POLICY},100,${new Date(Date.now()+lobbyMs)})`;
  return {groupId,ids,roundId,game};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function ready(f:F,index:number,picks=f.game==='spin_win'?[7]:[1,2,3,4,5]) {
  await service.join(f.groupId,f.ids[index],f.roundId);
  await service.ready(f.groupId,f.ids[index],f.roundId,picks,PVP_POLICY,100);
}
const balance=async(id:string)=>(await db.wallet.findUniqueOrThrow({where:{userId:id}})).gamePointsBalance;
async function storedDraw(f:F,outcome:number[]=[7]) {
  // Fixture a crash immediately after a committed draw. Production uses the worker.
  await db.$executeRaw`UPDATE group_pvp_rounds SET state='COUNTDOWN',starts_at=clock_timestamp()-interval '1 second' WHERE id=${f.roundId}`;
  await db.$executeRaw`UPDATE group_pvp_rounds SET state='DRAWN',outcome=${JSON.stringify(outcome)}::jsonb WHERE id=${f.roundId}`;
}

it('charges duplicate ready requests exactly once and keeps selected terms immutable',async()=>{
  const f=await fixture();await service.join(f.groupId,f.ids[0],f.roundId);
  await Promise.all([1,2].map(()=>service.ready(f.groupId,f.ids[0],f.roundId,[7],PVP_POLICY,100)));
  expect(await balance(f.ids[0])).toBe(9900);
  await expect(service.ready(f.groupId,f.ids[0],f.roundId,[8],PVP_POLICY,100)).rejects.toThrow();
  await expect(service.ready(f.groupId,f.ids[0],f.roundId,[7],PVP_POLICY,200)).rejects.toThrow();
});
it('refunds a concurrent duplicate withdrawal exactly once',async()=>{
  const f=await fixture();await ready(f,1);
  await Promise.all([1,2].map(()=>service.withdraw(f.groupId,f.ids[1],f.roundId)));
  expect(await balance(f.ids[1])).toBe(10000);
  await expect(service.join(f.groupId,f.ids[1],f.roundId)).rejects.toThrow();
});
it('only the current owner can start, all joined players must be ready, and deadline cannot reset',async()=>{
  const f=await fixture();await ready(f,0);await ready(f,1);await service.join(f.groupId,f.ids[2],f.roundId);
  await expect(service.start(f.groupId,f.ids[0],f.roundId)).rejects.toThrow('everyone');
  await service.withdraw(f.groupId,f.ids[2],f.roundId);
  await expect(service.start(f.groupId,f.ids[1],f.roundId)).rejects.toThrow('owner');
  const before=Date.now();await service.start(f.groupId,f.ids[0],f.roundId);
  const first=await service.snapshot(f.groupId,f.ids[0]);
  expect(first.round!.startsAt!-before).toBeGreaterThanOrEqual(29000);
  await service.start(f.groupId,f.ids[0],f.roundId);
  expect((await service.snapshot(f.groupId,f.ids[0])).round!.startsAt).toBe(first.round!.startsAt);
  await expect(service.join(f.groupId,f.ids[2],f.roundId)).rejects.toThrow('locked');
  await expect(service.withdraw(f.groupId,f.ids[1],f.roundId)).rejects.toThrow('locked');
  await expect(service.cancel(f.groupId,f.ids[0],f.roundId)).rejects.toThrow('cannot be cancelled');
});
it('two settlers recover one stored result and pay the 93% pool once',async()=>{
  const f=await fixture();await ready(f,0);await ready(f,1,[8]);await storedDraw(f);
  await Promise.all([service.recoverOne(f.groupId,f.roundId),service.recoverOne(f.groupId,f.roundId)]);
  const s=await service.snapshot(f.groupId,f.ids[0]);
  expect(s.round!.outcome).toEqual([7]);expect(s.round!.settlement!.platformFee).toBe(14);
  expect(s.round!.settlement!.prizes[0].amount).toBe(186);expect(await balance(f.ids[0])).toBe(10086);
  expect(await balance(f.ids[1])).toBe(9900);
  await expect(db.$executeRaw`UPDATE group_pvp_rounds SET outcome='[8]'::jsonb WHERE id=${f.roundId}`).rejects.toThrow();
});
it('refunds all entries with no fee when no Spin player wins',async()=>{
  const f=await fixture();await ready(f,0);await ready(f,1);await storedDraw(f,[9]);
  await service.recoverOne(f.groupId,f.roundId);
  expect(await balance(f.ids[0])).toBe(10000);expect(await balance(f.ids[1])).toBe(10000);
  expect((await service.snapshot(f.groupId,f.ids[0])).round!.state).toBe('VOID');
});
it('keeps a cap-blocked refund as a durable pending obligation and resumes after capacity is available',async()=>{
  const f=await fixture();await ready(f,0);await ready(f,1);await storedDraw(f,[9]);
  await db.$transaction(tx=>applyBalanceChanges(tx,f.ids[0],[{currency:'GAME_POINTS',amount:999990100,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable cap test'}]));
  await expect(service.recoverOne(f.groupId,f.roundId)).rejects.toThrow('maximum');
  expect((await service.snapshot(f.groupId,f.ids[0])).round!.state).toBe('DRAWN');expect(await balance(f.ids[1])).toBe(9900);
  await db.$transaction(tx=>applyBalanceChanges(tx,f.ids[0],[{currency:'GAME_POINTS',amount:1000,ledgerType:'DEBIT',transactionType:'GAME_POINT_DEBIT',referenceType:'GAME',description:'Release disposable test capacity'}]));
  await service.recoverOne(f.groupId,f.roundId);
  expect((await service.snapshot(f.groupId,f.ids[0])).round!.state).toBe('VOID');expect(await balance(f.ids[1])).toBe(10000);
});
it('protects paid obligations from group deletion and blocks an ineligible participant at start',async()=>{
  const f=await fixture();await ready(f,0);await ready(f,1);
  await expect(db.group.delete({where:{id:f.groupId}})).rejects.toThrow();
  await db.groupMember.update({where:{groupId_userId:{groupId:f.groupId,userId:f.ids[1]}},data:{status:'BANNED'}});
  await expect(service.start(f.groupId,f.ids[0],f.roundId)).rejects.toThrow('no longer eligible');
  await service.cancel(f.groupId,f.ids[0],f.roundId);expect(await balance(f.ids[1])).toBe(10000);
});
it('denies outsiders access and keeps other players choices hidden while open',async()=>{
  const f=await fixture();const other=await fixture();await ready(f,0);
  await expect(service.snapshot(f.groupId,other.ids[0])).rejects.toThrow();
  expect((await service.snapshot(f.groupId,f.ids[1])).round!.entries[0].selection).toBeNull();
});
it('makes ready versus start safe regardless of which request wins the race',async()=>{
  const f=await fixture();await ready(f,0);await service.join(f.groupId,f.ids[1],f.roundId);
  await Promise.allSettled([service.ready(f.groupId,f.ids[1],f.roundId,[7],PVP_POLICY,100),service.start(f.groupId,f.ids[0],f.roundId)]);
  await service.start(f.groupId,f.ids[0],f.roundId);
  expect((await service.snapshot(f.groupId,f.ids[0])).round!.entries.every(e=>e.ready)).toBe(true);
  expect(await balance(f.ids[1])).toBe(9900);
});
it('uses highest Keno hit counts and splits ties from the same stored draw',async()=>{
  const f=await fixture('turbo_keno');await ready(f,0);await ready(f,1);await ready(f,2,[70,71,72,73,74]);
  await storedDraw(f,Array.from({length:20},(_,i)=>i+1));await service.recoverOne(f.groupId,f.roundId);
  const s=await service.snapshot(f.groupId,f.ids[0]);expect(s.round!.settlement!.platformFee).toBe(21);
  expect(s.round!.settlement!.prizes.map(p=>p.amount).sort()).toEqual([139,140]);
});

it('rolls back readiness when a wallet lock delays admission past lobby expiry',async()=>{
  const f=await fixture('spin_win',3000);await service.join(f.groupId,f.ids[0],f.roundId);
  let unlock!:()=>void;let held!:()=>void;const heldPromise=new Promise<void>(r=>held=r);const release=new Promise<void>(r=>unlock=r);
  const lock=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM wallets WHERE "userId"=${f.ids[0]} FOR UPDATE`;held();await release;},{timeout:10000});
  await heldPromise;const attempt=service.ready(f.groupId,f.ids[0],f.roundId,[7],PVP_POLICY,100);const rejection=expect(attempt).rejects.toThrow('locked');
  try {await new Promise(r=>setTimeout(r,3200));}finally{unlock();}
  await lock;await rejection;expect(await balance(f.ids[0])).toBe(10000);
});

it('does not start after ownership changes while waiting for the group lock',async()=>{
  const f=await fixture();await ready(f,0);await ready(f,1);
  let unlock!:()=>void;let held!:()=>void;const heldPromise=new Promise<void>(r=>held=r);const release=new Promise<void>(r=>unlock=r);
  const transfer=db.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM groups WHERE id=${f.groupId} FOR NO KEY UPDATE`;held();await release;
    await tx.group.update({where:{id:f.groupId},data:{ownerId:f.ids[1]}});
    await tx.groupMember.update({where:{groupId_userId:{groupId:f.groupId,userId:f.ids[0]}},data:{role:'ADMIN'}});
    await tx.groupMember.update({where:{groupId_userId:{groupId:f.groupId,userId:f.ids[1]}},data:{role:'OWNER'}});
  });
  await heldPromise;const attempt=service.start(f.groupId,f.ids[0],f.roundId);const rejection=expect(attempt).rejects.toThrow('owner');
  await new Promise(r=>setTimeout(r,50));unlock();await transfer;await rejection;
});

it('backs off 50 failed obligations so newer payouts and expired lobbies still finish',async()=>{
  // All rows are in the disposable database; never reset or delete financial history.
  const blocked=await fixture();await ready(blocked,0);await ready(blocked,1);await storedDraw(blocked,[9]);
  await db.$transaction(tx=>applyBalanceChanges(tx,blocked.ids[0],[{currency:'GAME_POINTS',amount:999990100,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable stalled refund'}]));
  // Additional invalid-receipt obligations simulate persistent per-round failures.
  for(let i=0;i<49;i++){
    const f=await fixture();await ready(f,0);await ready(f,1);await storedDraw(f,[9]);
    await db.$transaction(tx=>applyBalanceChanges(tx,f.ids[0],[{currency:'GAME_POINTS',amount:999990100,ledgerType:'CREDIT',transactionType:'GAME_POINT_CREDIT',referenceType:'ADMIN',description:'Disposable stalled refund'}]));
  }
  const payable=await fixture();await ready(payable,0);await ready(payable,1,[8]);await storedDraw(payable);
  const expired=await fixture('spin_win',-1);
  // Prior tests may leave additional due rows, so use several bounded scans.
  for(let i=0;i<5;i++)await service.tick();
  expect((await service.snapshot(payable.groupId,payable.ids[0])).round!.state).toBe('SETTLED');
  expect((await service.snapshot(expired.groupId,expired.ids[0])).round!.state).toBe('VOID');
  expect((await service.snapshot(blocked.groupId,blocked.ids[0])).round!.state).toBe('DRAWN');
});
