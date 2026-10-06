import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOUSE_GAME_MODES, HOUSE_GAME_POLICY, KENO_90_RULES } from '@socialplay/shared';
import { advanceKeno, drawKeno, KENO_INTERVAL, loadKeno, newKenoState, revealedCount, startKeno } from './keno-practice';
const numbers = Array.from({length:20},(_,i)=>i+1);
afterEach(()=>{vi.restoreAllMocks();});
describe('Keno practice integrity',()=>{
  it('draws 20 unique integers within 1–80',()=>{
    for(let i=0;i<100;i++){ const draw=drawKeno(); expect(new Set(draw).size).toBe(20); expect(draw.every(n=>Number.isInteger(n)&&n>=1&&n<=80)).toBe(true); }
  });
  it('rejects the biased tail before choosing a pool index',()=>{
    let calls=0;
    vi.spyOn(crypto,'getRandomValues').mockImplementation((array:any)=>{array[0]=calls++===0?0xffffffff:0;return array;});
    expect(drawKeno()).toEqual(numbers); expect(calls).toBe(21);
  });
  it('debits once and locks the ticket until completion',()=>{
    const state=startKeno(newKenoState(),[1,40],1000,numbers);
    expect(state.balance).toBe(990);
    expect(()=>startKeno(state,[2],1001,numbers)).toThrow();
    expect(advanceKeno(state,1000+19*KENO_INTERVAL)).toBe(state);
    const end=advanceKeno(state,1000+20*KENO_INTERVAL);
    expect(end.balance).toBe(1008); expect(end.history).toHaveLength(1);
    expect(advanceKeno(end,100000)).toBe(end);
  });
  it.each([[],[1,1],[0],[81],Array.from({length:11},(_,i)=>i+1)].map(picks=>({picks})))('rejects invalid picks $picks',({picks})=>{
    expect(()=>startKeno(newKenoState(),picks,0,numbers)).toThrow();
  });
  it('rejects insufficient balance and malformed draws',()=>{
    expect(()=>startKeno({...newKenoState(),balance:4},[1],0,numbers)).toThrow();
    expect(()=>startKeno(newKenoState(),[1],0,Array(20).fill(1))).toThrow();
  });
  it('recovers mid-draw and after completion without a second debit or credit',()=>{
    const state=startKeno(newKenoState(),[1,2,80],1000,numbers);
    const recovered=loadKeno(JSON.stringify(state));
    expect(revealedCount(recovered.active!,1000+7*KENO_INTERVAL)).toBe(7);
    expect(revealedCount(recovered.active!,0)).toBe(0);
    const end=advanceKeno(recovered,50000); expect(end.balance).toBe(1021);
    expect(advanceKeno(loadKeno(JSON.stringify(end)),60000).balance).toBe(1021);
  });
  it('copies picks and retains only the latest five draws',()=>{
    let state=newKenoState(); const picks=[1];
    state=startKeno(state,picks,0,numbers); picks[0]=80;
    expect(state.active?.picks).toEqual([1]);
    state=advanceKeno(state,20000);
    for(let i=0;i<6;i++) state=advanceKeno(startKeno(state,[1],0,numbers),20000);
    expect(state.history.map(r=>r.id)).toEqual([7,6,5,4,3]);
  });
  it.each([null,'broken','{}',JSON.stringify({...newKenoState(),balance:-1}),JSON.stringify({...newKenoState(),active:{}})])('recovers invalid storage safely',(raw)=>{
    expect(loadKeno(raw)).toEqual(newKenoState());
  });
});

it('uses the same 90% house return for all house modes with no extra group fee',()=>{
  expect(HOUSE_GAME_MODES).toEqual(['SOLO','SHARED','GROUP']);
  expect(HOUSE_GAME_POLICY.additionalGroupFeeBps).toBe(0);
  // Exact integer expected-value identity; independent of presentation and RNG.
  expect(KENO_90_RULES.drawCount*KENO_90_RULES.returnPerStep*10000).toBe(KENO_90_RULES.choices*KENO_90_RULES.stakeStep*HOUSE_GAME_POLICY.targetRtpBps);
});
it('scales returns exactly and recovers custom stakes without duplicate payment',()=>{
  const state=startKeno(newKenoState(),[1,80],1000,numbers,20);
  expect(state.balance).toBe(960);
  const end=advanceKeno(loadKeno(JSON.stringify(state)),20000);
  expect(end.balance).toBe(1032);
  expect(advanceKeno(loadKeno(JSON.stringify(end)),30000).balance).toBe(1032);
});
it('migrates existing five-credit active tickets without losing or duplicating settlement',()=>{
  const state=startKeno(newKenoState(),[1,80],1000,numbers);
  const {stakePerNumber: _stake,...legacyRound}=state.active!;
  const old={...state,version:1,active:legacyRound};
  const recovered=loadKeno(JSON.stringify(old));
  expect(recovered.version).toBe(2);expect(recovered.active?.stakePerNumber).toBe(5);
  expect(advanceKeno(recovered,20000).balance).toBe(1008);
});
it.each([0,-5,6,5.5,500])('rejects invalid per-number stake %s',stake=>{
  expect(()=>startKeno(newKenoState(),[1],0,numbers,stake)).toThrow();
});
