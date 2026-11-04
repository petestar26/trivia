import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSystemPracticeWorker, systemPracticeConfiguration, type SystemPracticeEvent } from './system-practice-worker-runtime.js';

const probe=vi.hoisted(()=>({
  client:vi.fn(),disconnect:vi.fn(async()=>{}),
  SKY_CRASH:vi.fn(()=>({tick:vi.fn(async()=>{})})), CRASH_POINT:vi.fn(()=>({tick:vi.fn(async()=>{})})),
  THUNDER_DERBY:vi.fn(()=>({tick:vi.fn(async()=>{})})), VIRTUAL_FOOTBALL:vi.fn(()=>({tick:vi.fn(async()=>{})})),
  SYSTEM_DICE:vi.fn(()=>({tick:vi.fn(async()=>{})})), SYSTEM_KENO:vi.fn(()=>({tick:vi.fn(async()=>{})})),
}));
vi.mock('@prisma/client',()=>({PrismaClient:class {constructor(){probe.client();} $disconnect(){return probe.disconnect();}}}));
vi.mock('../games/sky-crash/service.js',()=>({createSkyCrashService:probe.SKY_CRASH}));
vi.mock('../games/crash-point/service.js',()=>({createCrashPointService:probe.CRASH_POINT}));
vi.mock('../games/thunder-derby/service.js',()=>({createDerbyService:probe.THUNDER_DERBY}));
vi.mock('../games/virtual-football/service.js',()=>({createFootballService:probe.VIRTUAL_FOOTBALL}));
vi.mock('../games/group-pvp/system-dice.js',()=>({createSystemDiceService:probe.SYSTEM_DICE}));
vi.mock('../games/group-pvp/system-keno.js',()=>({createSystemKenoService:probe.SYSTEM_KENO}));

describe('static service adapter with fully mocked clients/factories',()=>{
  beforeEach(()=>{vi.clearAllMocks();});
  it('import creates no client or service; only admitted selected factories are constructed',async()=>{
    const {loadSystemPracticeServices}=await import('./system-practice-worker-services.js');
    expect(probe.client).not.toHaveBeenCalled();
    for(const name of ['SKY_CRASH','CRASH_POINT','THUNDER_DERBY','VIRTUAL_FOOTBALL','SYSTEM_DICE','SYSTEM_KENO'] as const) expect(probe[name]).not.toHaveBeenCalled();
    const result=await loadSystemPracticeServices(systemPracticeConfiguration({
      SYSTEM_PRACTICE_WORKER_ENABLED:'true',SKY_CRASH_PRACTICE_ENABLED:'true',SYSTEM_DICE_PRACTICE_ENABLED:'true',
      DATABASE_URL:'postgresql://restricted:private@127.0.0.1:9/unused',
    }));
    expect(probe.client).toHaveBeenCalledTimes(1); expect(Object.keys(result.ticks)).toEqual(['SKY_CRASH','SYSTEM_DICE']);
    expect(probe.SKY_CRASH).toHaveBeenCalledTimes(1); expect(probe.SYSTEM_DICE).toHaveBeenCalledTimes(1);
    for(const name of ['CRASH_POINT','THUNDER_DERBY','VIRTUAL_FOOTBALL','SYSTEM_KENO'] as const) expect(probe[name]).not.toHaveBeenCalled();
    await result.disconnect(); expect(probe.disconnect).toHaveBeenCalledTimes(1);
  });
  it('does not claim cleanup complete when factory initialization and its disconnect both fail',async()=>{
    const {loadSystemPracticeServices}=await import('./system-practice-worker-services.js');
    probe.SKY_CRASH.mockImplementationOnce(()=>{throw new Error('private factory diagnostic');});
    probe.disconnect.mockRejectedValueOnce(new Error('private engine diagnostic'));
    const events:SystemPracticeEvent[]=[];
    const result=await runSystemPracticeWorker({
      SYSTEM_PRACTICE_WORKER_ENABLED:'true',SKY_CRASH_PRACTICE_ENABLED:'true',
      DATABASE_URL:'postgresql://restricted:private@127.0.0.1:9/unused',
    },{signal:new AbortController().signal,loadServices:loadSystemPracticeServices,report:event=>events.push(event)});
    expect(result).toBe(1); expect(probe.client).toHaveBeenCalledTimes(1); expect(probe.disconnect).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({event:'SYSTEM_PRACTICE_STOPPED',cleanup:'UNCONFIRMED'});
    expect(JSON.stringify(events)).not.toMatch(/private|engine|diagnostic/);
  });
});
