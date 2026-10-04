import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {creditCoins,debitCoins,settleWagerCoins} from './coin-ledger-service.js';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/playqube_scheduled_throwaway'||process.env.SCHEDULED_NATIVE_DB_ACK!=='throwaway')throw new Error('Throwaway database required');
const db=new PrismaClient({log:[]});afterAll(()=>db.$disconnect());
async function fixture(){
  const userId=randomUUID();await db.user.create({data:{id:userId,username:`reward_${userId.replaceAll('-','')}`}});
  const countryCode=`R${randomUUID().slice(0,6)}`;
  const policy=await db.countryCasinoPolicy.create({data:{countryCode,version:1,status:'ENABLED',playthroughMultiplier:2,qualifyingGames:['dice'],maxQualifyingStake:1000}});
  const grant=await db.$transaction(tx=>creditCoins(tx,userId,100,{type:'BONUS_GRANT',bonusRule:'NET_WINNINGS_V1',scopeType:'REWARD_CLAIM',scopeId:randomUUID(),referenceType:'TASK',description:'Disposable reward',policy:{id:policy.id,version:1},requirementAmount:200}));
  return {userId,policy,grant};
}
async function play(f:Awaited<ReturnType<typeof fixture>>,stake:number,payout:number){
  return db.$transaction(tx=>settleWagerCoins(tx,f.userId,{sessionId:randomUUID(),gameKey:'dice',stake,payout,idempotencyKey:randomUUID(),policy:{id:f.policy.id,version:1},responseSnapshot:coinsBalance=>({coinsBalance})}));
}
async function balances(userId:string){
  const lots=await db.coinProvenance.findMany({where:{userId}});
  return {restricted:lots.filter(lot=>lot.lotClass==='RESTRICTED').reduce((n,lot)=>n+(lot.availableAmount??0),0),spendable:lots.filter(lot=>lot.lotClass==='WITHDRAWABLE').reduce((n,lot)=>n+(lot.availableAmount??0),0),wallet:(await db.wallet.findUniqueOrThrow({where:{userId}})).coinsBalance};
}
it('free Coins cannot buy gifts; only the profit from a win becomes spendable',async()=>{
  const f=await fixture();
  const gift=()=>db.$transaction(tx=>debitCoins(tx,f.userId,10,{type:'GIFT_SPEND',scopeType:'GIFT',scopeId:randomUUID(),referenceType:'GIFT',description:'Disposable gift'}));
  await expect(gift()).rejects.toThrow('Free reward Coins');expect(await balances(f.userId)).toEqual({restricted:100,spendable:0,wallet:100});
  await play(f,20,36);expect(await balances(f.userId)).toEqual({restricted:100,spendable:16,wallet:116});
  await gift();expect(await balances(f.userId)).toEqual({restricted:100,spendable:6,wallet:106});
  const source=await db.coinProvenance.findFirstOrThrow({where:{userId:f.userId,bonusRule:'NET_WINNINGS_V1'}});expect(source.progressAmount).toBe(0);expect(source.state).toBe('OPEN');
});
it('a loss reduces reward principal and a break-even return never unlocks it',async()=>{
  const f=await fixture();await play(f,20,0);expect(await balances(f.userId)).toEqual({restricted:80,spendable:0,wallet:80});
  await play(f,20,20);expect(await balances(f.userId)).toEqual({restricted:80,spendable:0,wallet:80});
});
it('mixed funding remains conserved and free principal never becomes spendable',async()=>{
  const f=await fixture();await play(f,100,180);expect(await balances(f.userId)).toEqual({restricted:100,spendable:80,wallet:180});
  await play(f,120,216);expect(await balances(f.userId)).toEqual({restricted:100,spendable:176,wallet:276});
  await play(f,120,0);expect(await balances(f.userId)).toEqual({restricted:0,spendable:156,wallet:156});
});
it('the database rejects changing a reward rule or a direct gift debit of reward Coins',async()=>{
  const f=await fixture();const lot=await db.coinProvenance.findFirstOrThrow({where:{userId:f.userId}});
  await expect(db.coinProvenance.update({where:{id:lot.id},data:{bonusRule:null}})).rejects.toThrow('immutable');
  await expect(db.$transaction(async tx=>{
    const op=await tx.economicOperation.create({data:{type:'GIFT_SPEND',userId:f.userId,createdBy:f.userId,scopeType:'GIFT',scopeId:randomUUID(),walletTransactionIds:[]}});
    await tx.coinLotEntry.create({data:{operationId:op.id,userId:f.userId,lotId:lot.id,sequence:0,entryType:'CONSUME',availableDelta:-1,obligationShare:2}});
  })).rejects.toThrow('cannot buy gifts');
});

it('a forged conversion cannot unlock the principal or invent a winning settlement',async()=>{
  const f=await fixture();const lot=await db.coinProvenance.findFirstOrThrow({where:{userId:f.userId}});
  for(const scopeType of ['LOT','BONUS_NET_WIN'])await expect(db.$transaction(async tx=>{
    const op=await tx.economicOperation.create({data:{type:'BONUS_CONVERSION',userId:f.userId,createdBy:f.userId,scopeType,scopeId:randomUUID(),countryPolicyId:f.policy.id,countryPolicyVersion:1,walletTransactionIds:[],snapshot:{rule:'NET_WINNINGS_V1',sourceLotId:lot.id,sessionId:randomUUID(),sourceKind:'GAME_SESSION'}}});
    await tx.coinLotEntry.create({data:{operationId:op.id,userId:f.userId,lotId:lot.id,sequence:0,entryType:'CONVERT_OUT',availableDelta:-50}});
  })).rejects.toThrow(scopeType==='LOT'?'Free principal':'Only proven net winnings');
  expect(await balances(f.userId)).toEqual({restricted:100,spendable:0,wallet:100});
});
