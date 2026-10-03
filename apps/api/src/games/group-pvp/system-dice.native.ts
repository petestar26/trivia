import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {createSystemDiceService} from './system-dice.js';
const source=process.env.DATABASE_URL;const url=source?new URL(source):null;
if(!url||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/playqube_scheduled_throwaway'||process.env.SCHEDULED_NATIVE_DB_ACK!=='throwaway')throw new Error('Acknowledged throwaway database required');
const db=new PrismaClient({datasourceUrl:source,log:[]});const service=createSystemDiceService(db);
beforeAll(async()=>{await db.$connect();});afterAll(async()=>{await db.$disconnect();});
async function fixture(closeIn=20000,userId=randomUUID()){
 const roundId=randomUUID();const closes=new Date(Date.now()+closeIn);
 await db.user.upsert({where:{id:userId},create:{id:userId,username:`dice_${userId.replaceAll('-','')}`,isVerified:false},update:{}});
 await service.snapshot(userId);
 await db.$executeRaw`INSERT INTO system_dice_practice_rounds(id,opens_at,closes_at,ends_at) VALUES(${roundId},${new Date(closes.getTime()-45000)},${closes},${new Date(closes.getTime()+15000)})`;
 return {userId,roundId,closes};
}
const balance=async(userId:string)=>Number((await db.$queryRaw<{balance:bigint}[]>`SELECT balance FROM system_dice_practice_accounts WHERE user_id=${userId}`)[0].balance);
const afterCutoff=async(closes:Date)=>{const delay=closes.getTime()-Date.now()+60;if(delay>0)await new Promise(r=>setTimeout(r,delay));};
it('serializes concurrent confirmations; retries debit once and changed amounts conflict',async()=>{
 const f=await fixture();const responses=await Promise.all([1,2].map(()=>service.enter(f.userId,f.roundId,35)));
 expect(responses.map(r=>r.isReplay).sort()).toEqual([false,true]);expect(await balance(f.userId)).toBe(965);
 await expect(service.enter(f.userId,f.roundId,70)).rejects.toThrow('confirmed');
 expect(await db.wallet.findUnique({where:{userId:f.userId}})).toBeNull();
});
it('settles the persisted winning roll once across concurrent workers and replays after cutoff',async()=>{
 const f=await fixture(1100);await service.enter(f.userId,f.roundId,70);await afterCutoff(f.closes);
 await db.$executeRaw`UPDATE system_dice_practice_rounds SET die1=1,die2=6 WHERE id=${f.roundId}`;
 const errors:string[]=[];await Promise.all([service.tick(id=>errors.push(id)),service.tick(id=>errors.push(id))]);expect(errors).toEqual([]);
 expect(await balance(f.userId)).toBe(1038);expect(await service.enter(f.userId,f.roundId,70)).toEqual({accepted:true,isReplay:true});
 await service.tick();expect(await balance(f.userId)).toBe(1038);
});
it('records a zero payout on a losing roll without another debit',async()=>{
 const f=await fixture(1000);await service.enter(f.userId,f.roundId,35);await afterCutoff(f.closes);
 await db.$executeRaw`UPDATE system_dice_practice_rounds SET die1=1,die2=1 WHERE id=${f.roundId}`;await service.tick();
 expect(await balance(f.userId)).toBe(965);
 expect((await db.$queryRaw<{payout:number}[]>`SELECT payout FROM system_dice_practice_tickets WHERE round_id=${f.roundId}`)[0].payout).toBe(0);
});
it('persists one unbiased-domain roll per epoch-minute and restores its snapshot',async()=>{
 const f=await fixture(-1000);const errors:string[]=[];await Promise.all([service.tick(id=>errors.push(id)),service.tick(id=>errors.push(id))]);expect(errors).toEqual([]);
 const [draw]=await db.$queryRaw<{die1:number;die2:number}[]>`SELECT die1,die2 FROM system_dice_practice_rounds WHERE id=${f.roundId}`;
 expect([draw.die1,draw.die2].every(n=>n>=1&&n<=6)).toBe(true);await service.tick();
 expect((await db.$queryRaw`SELECT die1,die2 FROM system_dice_practice_rounds WHERE id=${f.roundId}`)).toEqual([draw]);
 const [r]=await db.$queryRaw<{opens_at:Date;closes_at:Date;ends_at:Date}[]>`SELECT * FROM system_dice_practice_rounds WHERE id LIKE 'dice-minute-%' ORDER BY opens_at DESC LIMIT 1`;
 expect(r.opens_at.getTime()%60000).toBe(0);expect(r.closes_at.getTime()-r.opens_at.getTime()).toBe(45000);expect(r.ends_at.getTime()-r.opens_at.getTime()).toBe(60000);
 expect((await service.snapshot(f.userId)).rulesId).toBe('dice-sum7-practice90-v1');
});
it('rechecks time after waiting for the balance lock and rolls back late admission',async()=>{
 const f=await fixture(1000);let release!:()=>void,locked!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>locked=r);
 const holder=db.$transaction(async tx=>{await tx.$queryRaw`SELECT user_id FROM system_dice_practice_accounts WHERE user_id=${f.userId} FOR UPDATE`;locked();await gate;});
 await started;const entry=service.enter(f.userId,f.roundId,35);const checked=expect(entry).rejects.toThrow('closed');await afterCutoff(f.closes);release();await holder;await checked;
 expect(await balance(f.userId)).toBe(1000);expect(await db.$queryRaw`SELECT id FROM system_dice_practice_tickets WHERE user_id=${f.userId}`).toEqual([]);
});
it('rejects invalid amounts and insufficient balance without changing earlier tickets',async()=>{
 const f=await fixture();for(const stake of [0,34,36,525,70.5])await expect(service.enter(f.userId,f.roundId,stake)).rejects.toThrow('steps');
 await service.enter(f.userId,f.roundId,490);const two=await fixture(20000,f.userId);await service.enter(f.userId,two.roundId,490);
 const three=await fixture(20000,f.userId);await expect(service.enter(f.userId,three.roundId,35)).rejects.toThrow('Insufficient');expect(await balance(f.userId)).toBe(20);
});
it('refuses inactive accounts before creating a practice balance',async()=>{
 const id=randomUUID();await db.user.create({data:{id,username:`inactive_${id}`,status:'BANNED'}});
 await expect(service.snapshot(id)).rejects.toThrow('active');expect(await db.$queryRaw`SELECT * FROM system_dice_practice_accounts WHERE user_id=${id}`).toEqual([]);
});
it('database guards reject early rolls, incorrect returns, balance edits, and mutable results',async()=>{
 const f=await fixture(1000);await service.enter(f.userId,f.roundId,35);
 await expect(db.$executeRaw`UPDATE system_dice_practice_rounds SET die1=6,die2=6 WHERE id=${f.roundId}`).rejects.toThrow('cutoff');
 await afterCutoff(f.closes);await db.$executeRaw`UPDATE system_dice_practice_rounds SET die1=6,die2=6 WHERE id=${f.roundId}`;
 await expect(db.$executeRaw`UPDATE system_dice_practice_tickets SET payout=70 WHERE round_id=${f.roundId}`).rejects.toThrow('exact payout');
 await expect(db.$executeRaw`UPDATE system_dice_practice_accounts SET balance=balance+1 WHERE user_id=${f.userId}`).rejects.toThrow('balance');
 await service.tick();await expect(db.$executeRaw`UPDATE system_dice_practice_rounds SET die1=1,die2=1 WHERE id=${f.roundId}`).rejects.toThrow('immutable');
 await expect(db.$executeRaw`DELETE FROM system_dice_practice_tickets WHERE round_id=${f.roundId}`).rejects.toThrow('immutable');
});
it('failed settlement keeps the roll and ticket unpaid, then retries exactly once',async()=>{
 const f=await fixture(1000);await service.enter(f.userId,f.roundId,35);await afterCutoff(f.closes);
 await db.$executeRaw`UPDATE system_dice_practice_rounds SET die1=6,die2=6 WHERE id=${f.roundId}`;
 await db.$executeRawUnsafe(`ALTER TABLE system_dice_practice_accounts ADD CONSTRAINT dice_native_credit_block CHECK(user_id<>'${f.userId}' OR balance<=1000) NOT VALID`);
 try{const errors:string[]=[];await service.tick(id=>errors.push(id));expect(errors.length).toBeGreaterThan(0);expect(await balance(f.userId)).toBe(965);
  expect((await db.$queryRaw<{payout:number|null}[]>`SELECT payout FROM system_dice_practice_tickets WHERE round_id=${f.roundId}`)[0].payout).toBeNull();
 }finally{await db.$executeRawUnsafe('ALTER TABLE system_dice_practice_accounts DROP CONSTRAINT dice_native_credit_block');}
 await new Promise(r=>setTimeout(r,10100));await service.tick();expect(await balance(f.userId)).toBe(1019);await service.tick();expect(await balance(f.userId)).toBe(1019);
 expect((await db.$queryRaw<{die1:number;die2:number}[]>`SELECT die1,die2 FROM system_dice_practice_rounds WHERE id=${f.roundId}`)[0]).toEqual({die1:6,die2:6});
});
it('works using explicit restricted runtime grants, including row-lock privileges',async()=>{
 const role=`dice_native_${randomUUID().replaceAll('-','')}`,password=randomUUID();const clientUrl=new URL(source!);clientUrl.username=role;clientUrl.password=password;
 const limited=new PrismaClient({datasourceUrl:clientUrl.toString(),log:[]});const f=await fixture();
 await db.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
 try{
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await db.$executeRawUnsafe(`GRANT SELECT, UPDATE(id) ON users TO "${role}"`);
  await db.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE ON system_dice_practice_accounts,system_dice_practice_rounds,system_dice_practice_tickets TO "${role}"`);
  const runtime=createSystemDiceService(limited);expect((await runtime.snapshot(f.userId)).balance).toBe(1000);await runtime.enter(f.userId,f.roundId,35);
  expect((await runtime.snapshot(f.userId)).balance).toBe(965);
 }finally{await limited.$disconnect();await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);await db.$executeRawUnsafe(`DROP ROLE "${role}"`);}
});
it('keeps legacy Coin Dice paused without rewriting its historical rule',async()=>{
 const game=await db.gameDefinition.findUniqueOrThrow({where:{key:'dice'}});expect(game.isActive).toBe(false);expect(game.catalogStatus).toBe('COMING_SOON');
 const old=await db.gameRules.findUniqueOrThrow({where:{gameId_version:{gameId:game.id,version:1}}});expect(old.rules).toMatchObject({winThreshold:7,multiplier:2});
});
