import { expect, it } from 'vitest';
import { PVP_GAME_POLICY } from '@socialplay/shared';
import { PVP_POLICY, HOUSE_RTP_BPS, ECONOMICS_POLICY } from './policy.js';
import { planContestSettlement, type ContestPool } from './contest-pool.js';
const pool = (n=10): ContestPool => ({policy:PVP_POLICY,currency:'COINS',contributions:Array.from({length:n},(_,i)=>({id:`r${i}`,userId:`u${i}`,kind:'ENTRY',amount:100n}))});
it('takes 7 per 100 entry and pays 930 from 1000 without another winner fee',()=>{
  const result=planContestSettlement(pool(),{status:'COMPLETED',winnerIds:['u0']});
  expect(result.platformFee).toBe(70n);expect(result.prizes).toEqual([{userId:'u0',amount:930n}]);
  expect(PVP_GAME_POLICY.additionalWinnerFeeBps).toBe(0);expect(HOUSE_RTP_BPS).toBe(9000n);
});
it('refunds every entry and sponsor in full when voided',()=>{
  const p=pool();p.contributions=[...p.contributions,{id:'s',userId:'sponsor',kind:'SPONSOR',amount:23n}];
  const result=planContestSettlement(p,{status:'VOID'});
  expect(result.platformFee).toBe(0n);expect(result.prizes).toEqual([]);
  expect(result.refunds.reduce((n,r)=>n+r.amount,0n)).toBe(1023n);
});
it('does not charge sponsor funding and splits ties without losing units',()=>{
  const p=pool(3);p.contributions=[...p.contributions,{id:'s',userId:'sponsor',kind:'SPONSOR',amount:2n}];
  const result=planContestSettlement(p,{status:'COMPLETED',winnerIds:['u1','u0']});
  expect(result.platformFee).toBe(21n);expect(result.prizes).toEqual([{userId:'u0',amount:141n},{userId:'u1',amount:140n}]);
});
it('retains the original economics of legacy pinned pools',()=>{
  const p=pool(2);p.policy=ECONOMICS_POLICY;
  expect(planContestSettlement(p,{status:'COMPLETED',winnerIds:['u0']}).platformFee).toBe(30n);
});
it('rejects unsupported fractional fee amounts instead of silently rounding',()=>{
  const p=pool(2);p.contributions=[{...p.contributions[0],amount:20n},p.contributions[1]];
  expect(()=>planContestSettlement(p,{status:'COMPLETED',winnerIds:['u0']})).toThrow('multiple of 100');
});
it('conserves funded money at exactly 7% across different pools and ties',()=>{
  for(let n=2;n<=20;n++)for(let winners=1;winners<=n;winners++){
    const p=pool(n);const result=planContestSettlement(p,{status:'COMPLETED',winnerIds:p.contributions.slice(0,winners).map(r=>r.userId)});
    expect(result.platformFee*100n).toBe(result.funded*7n);
    expect(result.prizes.reduce((sum,r)=>sum+r.amount,result.platformFee)).toBe(result.funded);
  }
});
