import {expect,it,vi} from 'vitest';
import {enabledGroupWorkers,runGroupWorkerLoops,workerFailure} from './group-worker-runtime.js';
it.each(Array.from({length:8},(_,i)=>i))('starts exactly the independently enabled loops for flag mask %i',async mask=>{
  const enabled=enabledGroupWorkers({GROUP_PVP_GAME_POINTS_ENABLED:String(!!(mask&1)),SYSTEM_KENO_PRACTICE_ENABLED:String(!!(mask&2)),SYSTEM_DICE_PRACTICE_ENABLED:String(!!(mask&4))});
  const ticks={SOCIAL_LIFECYCLE:vi.fn(async()=>{}),PVP:vi.fn(async()=>{}),KENO_PRACTICE:vi.fn(async()=>{}),DICE_PRACTICE:vi.fn(async()=>{})};let stopped=false;
  const task=()=>runGroupWorkerLoops({enabled,ticks,stopped:()=>stopped,wait:async()=>{stopped=true;},report:()=>{}});
  expect(enabled).toContain('SOCIAL_LIFECYCLE');
  await task();for(const [kind,tick] of Object.entries(ticks))expect(tick).toHaveBeenCalledTimes(enabled.includes(kind as typeof enabled[number])?1:0);
});
it('reports safe diagnostic codes for failures and continues the loop',async()=>{
  const logs:unknown[]=[];let stopped=false;
  const fail=async(onError:(id:string,error:unknown)=>void)=>{onError('ticket-1',{code:'P2010',meta:{code:'P0001'},message:'postgresql://owner:SECRET@db; SQL private values'});};
  await runGroupWorkerLoops({enabled:['DICE_PRACTICE'],ticks:{SOCIAL_LIFECYCLE:fail,PVP:fail,KENO_PRACTICE:fail,DICE_PRACTICE:fail},stopped:()=>stopped,wait:async()=>{stopped=true;},report:event=>logs.push(event)});
  expect(logs).toEqual([{event:'DICE_PRACTICE_WORKER_RETRY',id:'ticket-1',code:'P2010',databaseCode:'P0001',message:'Database rejected the operation'}]);
  expect(JSON.stringify(logs)).not.toContain('SECRET');
  expect(workerFailure(new Error('PVP funding receipt mismatch')).message).toBe('PVP funding receipt mismatch');
});
it.each(['failure','stall'])('room maintenance %s cannot prevent a due payout tick',async mode=>{
  let release!:()=>void;let stopped=false;const reports:unknown[]=[];
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const payout=vi.fn(async()=>{});
  const task=runGroupWorkerLoops({enabled:['SOCIAL_LIFECYCLE','PVP'],
    ticks:{SOCIAL_LIFECYCLE:async()=>{if(mode==='failure')throw {code:'P2010',meta:{code:'42501'}};await gate;},PVP:payout,KENO_PRACTICE:async()=>{},DICE_PRACTICE:async()=>{}},
    stopped:()=>stopped,wait:async()=>{stopped=true;},report:event=>reports.push(event)});
  await Promise.resolve();expect(payout).toHaveBeenCalledOnce();
  release();await task;
  if(mode==='failure')expect(reports).toEqual([expect.objectContaining({event:'SOCIAL_LIFECYCLE_WORKER_RETRY',databaseCode:'42501'})]);
});
