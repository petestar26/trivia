import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { GIFT_COLLECTION_POLICY } from '@socialplay/shared';
import type { GiftAction } from '@socialplay/shared';
import { createGiftCollectionService, giftCardsForMessages } from './service.js';
import { setMessageReaction } from '../realtime/reaction-service.js';
import { applyBalanceChanges } from '../economy/wallet-service.js';
const source = process.env.DATABASE_URL; const url = source ? new URL(source) : null;
if (!url || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname !== '/playqube_scheduled_throwaway' || process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') throw new Error('Acknowledged throwaway database required');
const db = new PrismaClient({ datasourceUrl: source, log: [] });
const service = createGiftCollectionService(db);
beforeAll(() => db.$connect()); afterAll(() => db.$disconnect());
async function points(id: string, amount: number) {
  return db.$transaction(tx => applyBalanceChanges(tx,id,[{currency:'GAME_POINTS',amount:Math.abs(amount),ledgerType:amount>0?'CREDIT':'DEBIT',transactionType:amount>0?'GAME_POINT_CREDIT':'GAME_POINT_DEBIT',referenceType:'ADMIN',description:'Disposable gift test funding'}]));
}
async function fixture() {
  const ids=[randomUUID(),randomUUID(),randomUUID()]; const groupId=randomUUID();
  for (const id of ids) { await db.user.create({data:{id,username:`gift_${id.replaceAll('-','')}`}}); await db.wallet.create({data:{userId:id}}); await points(id,1000); }
  await db.$transaction(async tx => { await tx.group.create({data:{id:groupId,name:'Disposable gift test',ownerId:ids[0],isPrivate:true}});
    for(const id of ids) await tx.groupMember.create({data:{groupId,userId:id,role:id===ids[0]?'OWNER':'MEMBER'}}); });
  return {ids,groupId};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const balance=async(id:string)=>(await db.wallet.findUniqueOrThrow({where:{userId:id}})).gamePointsBalance;
const buy=(f:Fixture,recipientId=f.ids[0]):GiftAction=>({kind:'BUY',groupId:f.groupId,catalogId:'golden-heart',recipientId,faceValue:100,policyId:GIFT_COLLECTION_POLICY});
const convert=(itemId:string,version=0):GiftAction=>({kind:'CONVERT',itemId,version,faceValue:100,policyId:GIFT_COLLECTION_POLICY});
const send=(f:Fixture,itemId:string,recipientId=f.ids[1],version=0):GiftAction=>({kind:'SEND',groupId:f.groupId,itemId,recipientId,version,policyId:GIFT_COLLECTION_POLICY});

it('charges exactly face value with zero purchase fee; duplicate purchase creates one owned item',async()=>{
  const f=await fixture(),key=randomUUID(); const results=await Promise.all([1,2].map(()=>service.act(f.ids[0],key,buy(f))));
  expect(results.map(r=>r.itemId)[0]).toBe(results[1].itemId);expect(results[0].amount).toBe(100);expect(results[0].fee).toBe(0);
  expect(await balance(f.ids[0])).toBe(900);expect((await service.snapshot(f.groupId,f.ids[0])).totalOwned).toBe(1);
});
it('delivers purchased gift and authoritative chat card atomically without crediting recipient points',async()=>{
  const f=await fixture();const r=await service.act(f.ids[0],randomUUID(),buy(f,f.ids[1]));
  expect(await balance(f.ids[1])).toBe(1000);expect((await service.snapshot(f.groupId,f.ids[1])).owned[0].id).toBe(r.itemId);
  const message=await db.message.findUniqueOrThrow({where:{id:r.messageId!}});expect(message.type).toBe('GIFT');expect(message.groupId).toBe(f.groupId);
  const cards=await giftCardsForMessages(db,[r.messageId!]);expect(cards.get(r.messageId!)?.recipientId).toBe(f.ids[1]);
});
it('converts once for 90 points with a 10 point fee and prevents another conversion under a new key',async()=>{
  const f=await fixture();const purchased=await service.act(f.ids[0],randomUUID(),buy(f));const key=randomUUID();
  const results=await Promise.all([1,2].map(()=>service.act(f.ids[0],key,convert(purchased.itemId))));
  expect(results[0].amount).toBe(90);expect(results[0].fee).toBe(10);expect(await balance(f.ids[0])).toBe(990);
  expect((await service.snapshot(f.groupId,f.ids[0])).totalOwned).toBe(0);
  await expect(service.act(f.ids[0],randomUUID(),convert(purchased.itemId))).rejects.toThrow('no longer');
  const coins=await db.wallet.findMany({where:{userId:{in:f.ids}},select:{coinsBalance:true}});expect(coins.every(w=>w.coinsBalance===0)).toBe(true);
});
it('transfers ownership free, writes one chat card, and only the new owner can convert',async()=>{
  const f=await fixture();const purchased=await service.act(f.ids[0],randomUUID(),buy(f));const key=randomUUID();
  const first=await service.act(f.ids[0],key,send(f,purchased.itemId));const replay=await service.act(f.ids[0],key,send(f,purchased.itemId));
  expect(first.messageId).toBe(replay.messageId);expect(first.amount).toBe(0);expect(first.fee).toBe(0);expect(await balance(f.ids[0])).toBe(900);
  await expect(service.act(f.ids[0],randomUUID(),convert(purchased.itemId,1))).rejects.toThrow();
  await service.act(f.ids[1],randomUUID(),convert(purchased.itemId,1));expect(await balance(f.ids[1])).toBe(1090);
});
it('send versus convert races settle one action without minting points twice',async()=>{
  const f=await fixture();const purchased=await service.act(f.ids[0],randomUUID(),buy(f));
  const results=await Promise.allSettled([service.act(f.ids[0],randomUUID(),send(f,purchased.itemId)),service.act(f.ids[0],randomUUID(),convert(purchased.itemId))]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const owner0=await service.snapshot(f.groupId,f.ids[0]);const owner1=await service.snapshot(f.groupId,f.ids[1]);
  expect(owner0.totalOwned+owner1.totalOwned).toBeLessThanOrEqual(1);expect(await balance(f.ids[0])).toBeLessThanOrEqual(990);
});
it('rejects insufficient points, stale prices, wrong policies, and outsiders before creating any gift',async()=>{
  const f=await fixture();await points(f.ids[0],-950);await expect(service.act(f.ids[0],randomUUID(),buy(f))).rejects.toThrow('Insufficient');
  await expect(service.act(f.ids[1],randomUUID(),{...buy(f),faceValue:200} as GiftAction)).rejects.toThrow('price changed');
  await expect(service.act(f.ids[1],randomUUID(),{...buy(f),policyId:'wrong'})).rejects.toThrow('terms');
  const other=await fixture();await expect(service.act(f.ids[0],randomUUID(),buy(f,other.ids[1]))).rejects.toThrow('active members');
  expect((await service.snapshot(f.groupId,f.ids[0])).totalOwned).toBe(0);expect(await balance(f.ids[0])).toBe(50);
});
it('keeps gift value and retry response unchanged after catalog edits or conversion',async()=>{
  const f=await fixture();const catalogId=`test-${randomUUID()}`;
  await db.$executeRaw`INSERT INTO collectible_gift_catalog(id,name,emoji,description,theme,face_value) VALUES(${catalogId},'Original','💛','','amber',100)`;
  const action={...buy(f),catalogId} as GiftAction;const key=randomUUID();const receipt=await service.act(f.ids[0],key,action);
  await db.$executeRaw`UPDATE collectible_gift_catalog SET face_value=200,name='Changed',is_active=false WHERE id=${catalogId}`;
  await service.act(f.ids[0],randomUUID(),convert(receipt.itemId));
  const replay=await service.act(f.ids[0],key,action);expect(replay.gift.name).toBe('Original');expect(replay.amount).toBe(100);expect(replay.itemId).toBe(receipt.itemId);
  expect(await balance(f.ids[0])).toBe(990);
  await expect(service.act(f.ids[0],key,buy(f,f.ids[1]))).rejects.toThrow('different gift');
});
it('rolls back conversion at the balance cap and permits the same receipt after capacity is released',async()=>{
  const f=await fixture();const receipt=await service.act(f.ids[0],randomUUID(),buy(f));await points(f.ids[0],1000000000-900);
  const key=randomUUID();await expect(service.act(f.ids[0],key,convert(receipt.itemId))).rejects.toThrow('maximum');
  expect((await service.snapshot(f.groupId,f.ids[0])).owned[0].id).toBe(receipt.itemId);
  await points(f.ids[0],-100);await service.act(f.ids[0],key,convert(receipt.itemId));expect(await balance(f.ids[0])).toBe(999999990);
});
it('blocks tampering with historical gift amounts, receipts, or terminal items',async()=>{
  const f=await fixture();const receipt=await service.act(f.ids[0],randomUUID(),buy(f));
  await expect(db.$executeRaw`UPDATE collectible_gift_items SET face_value=1000 WHERE id=${receipt.itemId}`).rejects.toThrow();
  await expect(db.$executeRaw`UPDATE collectible_gift_operations SET fee=5 WHERE id=${receipt.operationId}`).rejects.toThrow();
  await expect(db.$executeRaw`DELETE FROM collectible_gift_items WHERE id=${receipt.itemId}`).rejects.toThrow();
  await service.act(f.ids[0],randomUUID(),convert(receipt.itemId));
  await expect(db.$executeRaw`UPDATE collectible_gift_items SET state='OWNED' WHERE id=${receipt.itemId}`).rejects.toThrow();
});
it('checks group bans under the membership lock, including a ban committed while send waits',async()=>{
  const f=await fixture();const receipt=await service.act(f.ids[0],randomUUID(),buy(f));
  let unlock!:()=>void,held!:()=>void;const release=new Promise<void>(r=>unlock=r),ready=new Promise<void>(r=>held=r);
  const ban=db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM group_members WHERE "groupId"=${f.groupId} AND "userId"=${f.ids[1]} FOR UPDATE`;held();await release;await tx.groupMember.update({where:{groupId_userId:{groupId:f.groupId,userId:f.ids[1]}},data:{status:'BANNED'}});});
  await ready;const pending=service.act(f.ids[0],randomUUID(),send(f,receipt.itemId));const rejected=expect(pending).rejects.toThrow('active members');
  await new Promise(r=>setTimeout(r,50));unlock();await ban;await rejected;
  expect((await service.snapshot(f.groupId,f.ids[0])).totalOwned).toBe(1);expect(await balance(f.ids[0])).toBe(900);
});
it('cannot replay an old ownership version after a gift is sent back',async()=>{
  const f=await fixture();const receipt=await service.act(f.ids[0],randomUUID(),buy(f));
  await service.act(f.ids[0],randomUUID(),send(f,receipt.itemId));await service.act(f.ids[1],randomUUID(),send(f,receipt.itemId,f.ids[0],1));
  await expect(service.act(f.ids[0],randomUUID(),convert(receipt.itemId,0))).rejects.toThrow('changed');
  await service.act(f.ids[0],randomUUID(),convert(receipt.itemId,2));expect(await balance(f.ids[0])).toBe(990);
});
it('allows owners to convert after leaving the group but blocks sending in that group',async()=>{
  const f=await fixture();const r=await service.act(f.ids[1],randomUUID(),buy(f,f.ids[1]));
  await db.groupMember.update({where:{groupId_userId:{groupId:f.groupId,userId:f.ids[1]}},data:{status:'LEFT'}});
  await expect(service.act(f.ids[1],randomUUID(),send(f,r.itemId,f.ids[0]))).rejects.toThrow();
  expect((await service.snapshot(null,f.ids[1])).owned[0].id).toBe(r.itemId);
  await service.act(f.ids[1],randomUUID(),convert(r.itemId));expect(await balance(f.ids[1])).toBe(990);
});
it('adds and removes reactions idempotently; other users’ reactions remain untouched',async()=>{
  const f=await fixture();const message=await db.message.create({data:{groupId:f.groupId,userId:f.ids[0],content:'Fixture message'}});
  await Promise.all([1,2].map(()=>setMessageReaction(db,f.groupId,f.ids[1],message.id,'LOVE',true)));
  await setMessageReaction(db,f.groupId,f.ids[2],message.id,'LOVE',true);
  expect(await db.messageReaction.count({where:{messageId:message.id}})).toBe(2);
  await Promise.all([1,2].map(()=>setMessageReaction(db,f.groupId,f.ids[1],message.id,'LOVE',false)));
  expect(await db.messageReaction.count({where:{messageId:message.id}})).toBe(1);
});
it('rejects reactions for nonmembers, wrong groups, deleted messages, and inactive accounts',async()=>{
  const f=await fixture(),other=await fixture();const message=await db.message.create({data:{groupId:f.groupId,userId:f.ids[0],content:'Fixture message'}});
  await expect(setMessageReaction(db,f.groupId,other.ids[0],message.id,'LIKE',true)).rejects.toThrow();
  await expect(setMessageReaction(db,other.groupId,other.ids[0],message.id,'LIKE',true)).rejects.toThrow('Message not found');
  await db.message.update({where:{id:message.id},data:{isDeleted:true}});
  await expect(setMessageReaction(db,f.groupId,f.ids[1],message.id,'LIKE',true)).rejects.toThrow('Message not found');
  await db.user.update({where:{id:f.ids[2]},data:{status:'BANNED'}});
  await expect(service.act(f.ids[2],randomUUID(),buy(f,f.ids[2]))).rejects.toThrow('active accounts');
});

it('permits global purchases for yourself, but requires a shared group for delivery',async()=>{
  const f=await fixture();await service.act(f.ids[0],randomUUID(),{...buy(f),groupId:null} as GiftAction);
  expect((await service.snapshot(null,f.ids[0])).totalOwned).toBe(1);
  await expect(service.act(f.ids[0],randomUUID(),{...buy(f,f.ids[1]),groupId:null} as GiftAction)).rejects.toThrow('Choose a group');
});
