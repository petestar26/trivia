import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PRACTICE_GIFT_POLICY } from '@socialplay/shared';
import { createPracticeGiftCollectionService } from './practice-service.js';

let db: PGlite;
let service: ReturnType<typeof createPracticeGiftCollectionService>;
let actor: string, recipient: string, outsider: string, group: string;
const sql = (strings: TemplateStringsArray, values: unknown[]) => strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, '');
function adapter(c: any): any {
  return {
    $queryRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s,v),v)).rows,
    $executeRaw: async (s: TemplateStringsArray, ...v: unknown[]) => (await c.query(sql(s,v),v)).affectedRows,
    message: { create: async ({data}: any) => { const id = randomUUID(); await c.query('INSERT INTO messages(id,"groupId","userId",type,content) VALUES($1,$2,$3,$4,$5)', [id,data.groupId,data.userId,data.type,data.content]); return {id}; } },
  };
}
beforeEach(async () => {
  db=new PGlite(); actor=randomUUID(); recipient=randomUUID(); outsider=randomUUID(); group=randomUUID();
  await db.exec(`CREATE TABLE users(id text PRIMARY KEY,username text,status text);
    CREATE TABLE groups(id text PRIMARY KEY,status text,"expiresAt" timestamptz);
    CREATE TABLE group_members(id text PRIMARY KEY,"groupId" text,"userId" text,status text);
    CREATE TABLE messages(id text PRIMARY KEY,"groupId" text,"userId" text,type text,content text);
    CREATE TABLE wallets(id text PRIMARY KEY,balance integer); INSERT INTO wallets VALUES('financial-sentinel',7281);`);
  for(const id of [actor,recipient,outsider]) await db.query('INSERT INTO users VALUES($1,$2,$3)',[id,id,'ACTIVE']);
  await db.query("INSERT INTO groups VALUES($1,'ACTIVE',clock_timestamp()+interval '1 day')",[group]);
  for(const id of [actor,recipient]) await db.query("INSERT INTO group_members VALUES($1,$2,$3,'ACTIVE')",[randomUUID(),group,id]);
  await db.exec(readFileSync(new URL('../../../../packages/database/prisma/migrations/20261104120000_practice_etb_gifts/migration.sql',import.meta.url),'utf8'));
  service=createPracticeGiftCollectionService({ ...adapter(db), $transaction: (fn: any) => db.transaction(tx=>fn(adapter(tx))) } as any);
});
afterEach(async()=>{ expect((await db.query('SELECT balance FROM wallets')).rows).toEqual([{balance:7281}]); await db.close(); });
const buy=(id=actor,key=randomUUID(),extra: any={})=>service.act(id,key,{kind:'BUY',catalogId:'little-rose',faceValue:500,recipientId:id,groupId:null,policyId:PRACTICE_GIFT_POLICY,...extra});
const count=async()=>Number((await db.query<{count:number}>('SELECT count(*)::integer AS count FROM practice_etb_gift_items')).rows[0].count);
const convert=(id: string,item: any,key=randomUUID())=>service.act(id,key,{kind:'CONVERT',itemId:item.itemId,version:0,faceValue:500,policyId:PRACTICE_GIFT_POLICY});

describe('isolated practice ETB gifts on PostgreSQL semantics',()=>{
 it('starts once at 10,000 virtual ETB and lists only gifts costing at least 500',async()=>{
  const a=await service.snapshot(null,actor);expect(a.balance).toBe(10000);expect(a.catalog.length).toBe(6);expect(a.catalog.every(g=>g.faceValue>=500)).toBe(true);
  await buy();expect((await service.snapshot(null,actor)).balance).toBe(9500);expect((await service.snapshot(null,actor)).balance).toBe(9500);
 });
 it('enforces the 500 minimum and authoritative catalogue price',async()=>{
  await expect(buy(actor,randomUUID(),{faceValue:490})).rejects.toThrow('500');
  await expect(buy(actor,randomUUID(),{faceValue:1000})).rejects.toThrow('price changed');expect(await count()).toBe(0);
 });
 it('replays concurrent identical requests once and rejects a changed payload',async()=>{
  const key=randomUUID();const [a,b]=await Promise.all([buy(actor,key),buy(actor,key)]);expect(a.itemId).toBe(b.itemId);expect(b.isReplay).toBe(true);expect(await count()).toBe(1);
  await expect(buy(actor,key,{catalogId:'royal-crown',faceValue:10000})).rejects.toThrow('different gift');
  expect((await service.snapshot(null,actor)).balance).toBe(9500);
 });
 it('never overspends the starting balance across concurrent requests',async()=>{
  const result=await Promise.allSettled([buy(actor,randomUUID(),{catalogId:'royal-crown',faceValue:10000}),buy(actor,randomUUID(),{catalogId:'royal-crown',faceValue:10000})]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(await count()).toBe(1);expect((await service.snapshot(null,actor)).balance).toBe(0);
 });
 it('delivers a purchased gift and chat card atomically without crediting the recipient',async()=>{
  const a=await buy(actor,randomUUID(),{groupId:group,recipientId:recipient});expect(a.messageId).toBeTruthy();expect(a.gift.currency).toBe('PRACTICE_ETB');
  const b=await service.snapshot(group,recipient);expect(b.owned[0].id).toBe(a.itemId);expect(b.balance).toBe(10000);
 });
 it('transfers ownership for free and converts once with an exact 10 percent fee',async()=>{
  const a=await buy();const send=await service.act(actor,randomUUID(),{kind:'SEND',groupId:group,itemId:a.itemId,recipientId:recipient,version:0,policyId:PRACTICE_GIFT_POLICY});
  expect(send.amount).toBe(0);expect(send.balance).toBe(9500);
  await expect(convert(actor,a)).rejects.toThrow('no longer');
  const key=randomUUID();const req={kind:'CONVERT' as const,itemId:a.itemId,version:1,faceValue:500,policyId:PRACTICE_GIFT_POLICY};
  const c=await service.act(recipient,key,req);expect(c.amount).toBe(450);expect(c.fee).toBe(50);expect(c.balance).toBe(10450);
  expect((await service.act(recipient,key,req)).isReplay).toBe(true);
  await expect(service.act(recipient,randomUUID(),req)).rejects.toThrow('no longer');
 });
 it('refuses nonmembers and expired rooms without a debit',async()=>{
  await expect(buy(actor,randomUUID(),{groupId:group,recipientId:outsider})).rejects.toThrow('active members');
  await db.query("UPDATE groups SET \"expiresAt\"=clock_timestamp()-interval '1 day'");
  await expect(buy(actor,randomUUID(),{groupId:group,recipientId:recipient})).rejects.toThrow('not available');expect(await count()).toBe(0);
 });
 it('refuses inactive accounts before creating a practice balance',async()=>{
  await db.query("UPDATE users SET status='SUSPENDED' WHERE id=$1",[actor]);await expect(service.snapshot(null,actor)).rejects.toThrow('active accounts');
  expect((await db.query('SELECT * FROM practice_etb_gift_accounts')).rows).toHaveLength(0);
 });
 it('rejects balance tampering, receipt edits and account deletion at the database',async()=>{
  const a=await buy();await expect(db.query('UPDATE practice_etb_gift_accounts SET balance=balance+500 WHERE user_id=$1',[actor])).rejects.toThrow('immutable gift receipts');
  await expect(db.query('UPDATE practice_etb_gift_operations SET amount=1 WHERE id=$1',[a.operationId])).rejects.toThrow('cannot be changed');
  await expect(db.query('DELETE FROM practice_etb_gift_accounts WHERE user_id=$1',[actor])).rejects.toThrow('cannot be deleted');
 });
 it('rolls back debit and ownership if chat delivery fails',async()=>{
  await db.exec("ALTER TABLE messages ADD CONSTRAINT refuse_test CHECK(type<>'GIFT')");
  await expect(buy(actor,randomUUID(),{groupId:group,recipientId:recipient})).rejects.toThrow();expect(await count()).toBe(0);expect((await service.snapshot(null,actor)).balance).toBe(10000);
 });
});
