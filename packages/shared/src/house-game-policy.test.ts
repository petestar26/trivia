import { expect, it } from 'vitest';
import { HOUSE_GAME_MODES, HOUSE_GAME_POLICY, KENO_90_RULES } from './house-game-policy.js';
import { SPIN90_MARKETS, settleSpin90Bets } from './spin-win-90.js';
it.each(HOUSE_GAME_MODES)('preserves the common house return without an extra fee in %s',()=>{
  expect(HOUSE_GAME_POLICY.additionalGroupFeeBps).toBe(0);
  expect(HOUSE_GAME_POLICY.targetRtpBps+HOUSE_GAME_POLICY.expectedHouseEdgeBps).toBe(10000);
  for(const market of SPIN90_MARKETS){
    const sum=Array.from({length:37},(_,n)=>settleSpin90Bets([{marketId:market.id,amount:40}],n).payout).reduce((a,b)=>a+b,0);
    expect(sum*10000).toBe(37*40*HOUSE_GAME_POLICY.targetRtpBps);
  }
  const k=KENO_90_RULES;
  expect(k.drawCount*k.returnPerStep*10000).toBe(k.choices*k.stakeStep*HOUSE_GAME_POLICY.targetRtpBps);
});
