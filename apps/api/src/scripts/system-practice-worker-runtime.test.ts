import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import {
  SYSTEM_PRACTICE_FAMILIES, SystemPracticeHealth, runSystemPracticeWorker,
  systemPracticeConfiguration, type SystemPracticeEvent, type SystemPracticeFamily,
  type SystemPracticeServices,
  type SystemPracticeDependencies,
} from './system-practice-worker-runtime.js';
import { main } from './system-practice-worker.js';

const flags: Record<SystemPracticeFamily, string> = {
  SKY_CRASH: 'SKY_CRASH_PRACTICE_ENABLED', CRASH_POINT: 'CRASH_POINT_PRACTICE_ENABLED',
  THUNDER_DERBY: 'THUNDER_DERBY_PRACTICE_ENABLED', VIRTUAL_FOOTBALL: 'VIRTUAL_FOOTBALL_PRACTICE_ENABLED',
  SYSTEM_DICE: 'SYSTEM_DICE_PRACTICE_ENABLED', SYSTEM_KENO: 'SYSTEM_KENO_PRACTICE_ENABLED',
};
const env = (families: SystemPracticeFamily[] = ['SKY_CRASH']): NodeJS.ProcessEnv => ({
  SYSTEM_PRACTICE_WORKER_ENABLED: 'true', DATABASE_URL: 'postgresql://restricted:private@127.0.0.1:9/unused',
  ...Object.fromEntries(families.map(family => [flags[family], 'true'])),
});
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
async function flush() { await vi.advanceTimersByTimeAsync(0); }
function fixture(families: SystemPracticeFamily[] = ['SKY_CRASH']) {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const controller = new AbortController();
  const events: SystemPracticeEvent[] = [];
  const server = { close: vi.fn((done: () => void) => done()), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() };
  const ticks = Object.fromEntries(families.map(family => [family, vi.fn(async () => {})]));
  const services: SystemPracticeServices = { ticks, disconnect: vi.fn(async () => {}) };
  let health!: SystemPracticeHealth;
  const dependencies: SystemPracticeDependencies = {
    signal: controller.signal, report: (event: SystemPracticeEvent) => events.push(event), now: () => Date.now(),
    loadServices: vi.fn(async () => services),
    listenHealth: vi.fn(async (value: SystemPracticeHealth) => { health=value; return server as unknown as Server; }),
  };
  return { controller, events, server, ticks, services, dependencies, health: () => health };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('inert exact admission', () => {
  it.each([undefined, 'false', 'TRUE', '1', ' true'])('refuses master %s before loading services', async value => {
    const f=fixture();
    await expect(runSystemPracticeWorker({...env(),SYSTEM_PRACTICE_WORKER_ENABLED:value},f.dependencies)).rejects.toThrow();
    expect(f.dependencies.loadServices).not.toHaveBeenCalled(); expect(f.dependencies.listenHealth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses all-disabled before a URL, client, listener or timer is consumed', async () => {
    const f=fixture(); const input={SYSTEM_PRACTICE_WORKER_ENABLED:'true'};
    await expect(runSystemPracticeWorker(input,f.dependencies)).rejects.toThrow('SYSTEM_PRACTICE_NO_FAMILIES');
    expect(f.dependencies.loadServices).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(SYSTEM_PRACTICE_FAMILIES)('selects only literal %s', family => {
    expect(systemPracticeConfiguration(env([family])).families).toEqual([family]);
    expect(() => systemPracticeConfiguration({...env([family]),[flags[family]]:'TRUE'})).toThrow('INVALID_FLAG');
  });
  it.each(['', 'https://user:pass@example.com/db', 'postgresql://localhost/db', 'postgresql://u:p@localhost/'])('refuses invalid target %s', value => {
    expect(() => systemPracticeConfiguration({...env(),DATABASE_URL:value})).toThrow('INVALID_DATABASE');
  });
  it.each(['0','65536','1.2','-1','abc'])('refuses invalid health port %s', value => {
    expect(() => systemPracticeConfiguration({...env(),PORT:value})).toThrow('INVALID_PORT');
  });
  it('freezes its allowlist and ignores every out-of-scope family switch', () => {
    const input:NodeJS.ProcessEnv={...env(),NUMBER_CHALLENGE_PRACTICE_ENABLED:'true',GROUP_PVP_GAME_POINTS_ENABLED:'true',SCHEDULED_PRACTICE_WORKER_ENABLED:'true'};
    const config=systemPracticeConfiguration(input); input.SKY_CRASH_PRACTICE_ENABLED='false';
    expect(config.families).toEqual(['SKY_CRASH']); expect(Object.isFrozen(config)).toBe(true); expect(Object.isFrozen(config.families)).toBe(true);
  });
  it('help, invalid arguments and disabled main never call its service loader', async () => {
    vi.spyOn(console,'log').mockImplementation(()=>{}); vi.spyOn(console,'error').mockImplementation(()=>{});
    const f=fixture();
    expect(await main(['--help'],{},f.dependencies)).toBe(0);
    expect(await main(['--once'],env(),f.dependencies)).toBe(1);
    expect(await main([],{},f.dependencies)).toBe(1);
    expect(f.dependencies.loadServices).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('family-specific health and stop supervision with mock ticks', () => {
  it('requires success from every enabled family and never lets another success hide failure/staleness', () => {
    let now=0; const health=new SystemPracticeHealth(['SKY_CRASH','SYSTEM_DICE'],()=>now);
    health.succeeded('SKY_CRASH'); expect(health.snapshot().ready).toBe(false);
    health.succeeded('SYSTEM_DICE'); expect(health.snapshot().ready).toBe(true);
    health.failed('SKY_CRASH'); health.succeeded('SYSTEM_DICE'); expect(health.snapshot().ready).toBe(false);
    health.succeeded('SKY_CRASH'); now=30000; health.succeeded('SYSTEM_DICE');
    expect(health.snapshot().families).toContainEqual({family:'SKY_CRASH',status:'STALE'});
    now=60000; health.succeeded('SYSTEM_DICE'); expect(health.stalledFamilies()).toEqual(['SKY_CRASH']);
    expect(health.snapshot().families).toContainEqual({family:'SKY_CRASH',status:'STALLED'});
    health.stop(); health.succeeded('SKY_CRASH'); expect(health.snapshot().ready).toBe(false);
  });
  it('runs only the exact dispatcher; signal wakes waits and disconnects once', async () => {
    const f=fixture(['SKY_CRASH','SYSTEM_DICE']); const running=runSystemPracticeWorker(env(['SKY_CRASH','SYSTEM_DICE']),f.dependencies);
    await flush(); expect(f.health().snapshot().ready).toBe(true);
    expect(f.ticks.SKY_CRASH).toHaveBeenCalledTimes(1); expect(f.ticks.SYSTEM_DICE).toHaveBeenCalledTimes(1);
    f.controller.abort(); expect(await running).toBe(0);
    expect(f.server.close).toHaveBeenCalledTimes(1); expect(f.services.disconnect).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toEqual({event:'SYSTEM_PRACTICE_STOPPED',cleanup:'COMPLETE'}); expect(vi.getTimerCount()).toBe(0);
  });
  it('treats swallowed callback errors as failures without logging the error or identifier', async () => {
    const f=fixture(); let passes=0;
    f.services.ticks.SKY_CRASH=vi.fn(async onError => { if(!passes++) onError('private-ticket',new Error('postgresql://secret:password@private/db')); });
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush();
    expect(f.health().snapshot().families[0].status).toBe('TICK_FAILED');
    expect(f.events).toEqual([{event:'SYSTEM_PRACTICE_TICK_FAILED',family:'SKY_CRASH'}]);
    await vi.advanceTimersByTimeAsync(1000); expect(f.health().snapshot().ready).toBe(true);
    f.controller.abort(); expect(await running).toBe(0); expect(JSON.stringify(f.events)).not.toMatch(/private-ticket|password|postgresql/);
  });
  it('never overlaps a family tick', async () => {
    const f=fixture(); const pending=deferred<void>(); f.services.ticks.SKY_CRASH=vi.fn(()=>pending.promise);
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush();
    await vi.advanceTimersByTimeAsync(5000); expect(f.services.ticks.SKY_CRASH).toHaveBeenCalledTimes(1);
    f.controller.abort(); pending.resolve(); expect(await running).toBe(0);
  });
  it('attributes a hung first tick despite another family continuing successfully', async () => {
    const f=fixture(['SKY_CRASH','SYSTEM_DICE']); const pending=deferred<void>(); f.services.ticks.SKY_CRASH=vi.fn(()=>pending.promise);
    const running=runSystemPracticeWorker(env(['SKY_CRASH','SYSTEM_DICE']),f.dependencies); await flush();
    await vi.advanceTimersByTimeAsync(60000); expect(f.events).toContainEqual({event:'SYSTEM_PRACTICE_STALLED',family:'SKY_CRASH'});
    expect(f.events).not.toContainEqual({event:'SYSTEM_PRACTICE_STALLED',family:'SYSTEM_DICE'});
    expect(f.server.close).toHaveBeenCalledTimes(1); expect(f.health().snapshot().ready).toBe(false);
    await vi.advanceTimersByTimeAsync(25000); expect(await running).toBe(1);
    expect(f.services.disconnect).toHaveBeenCalledTimes(1); expect(f.events.at(-1)?.cleanup).toBe('UNCONFIRMED'); pending.resolve(); await flush();
  });
  it('rejects extra dispatcher jobs before executing any mock tick', async () => {
    const f=fixture(); (f.services.ticks as Record<string,unknown>).SOCIAL_LIFECYCLE=vi.fn();
    expect(await runSystemPracticeWorker(env(),f.dependencies)).toBe(1);
    expect(f.ticks.SKY_CRASH).not.toHaveBeenCalled(); expect(f.dependencies.listenHealth).not.toHaveBeenCalled();
    expect(f.services.disconnect).toHaveBeenCalledTimes(1);
  });
  it('uses one stop deadline through disconnect', async () => {
    const f=fixture(); const pending=deferred<void>(); f.services.disconnect=vi.fn(()=>pending.promise);
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush(); f.controller.abort(); await flush();
    await vi.advanceTimersByTimeAsync(25000); expect(await running).toBe(1); expect(f.events.at(-1)?.cleanup).toBe('UNCONFIRMED');
    pending.resolve(); await flush();
  });
  it('does not leak a late cleanup rejection after the stop deadline has expired', async () => {
    const f=fixture(); const pending=deferred<void>(); f.services.ticks.SKY_CRASH=()=>pending.promise;
    f.services.disconnect=vi.fn(async()=>{throw new Error('sensitive simulated Prisma failure');});
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush(); f.controller.abort();
    await vi.advanceTimersByTimeAsync(25000); expect(await running).toBe(1); await flush();
    expect(JSON.stringify(f.events)).not.toContain('sensitive'); pending.resolve(); await flush();
  });
});

describe('startup ownership and absolute deadlines', () => {
  it('normal stop during startup does not start ticks and waits only within its stop deadline', async () => {
    const f=fixture(); const acquisition=deferred<SystemPracticeServices>(); f.dependencies.loadServices=vi.fn(()=>acquisition.promise);
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush(); f.controller.abort();
    await vi.advanceTimersByTimeAsync(24000); acquisition.resolve(f.services); expect(await running).toBe(0);
    expect(f.ticks.SKY_CRASH).not.toHaveBeenCalled(); expect(f.services.disconnect).toHaveBeenCalledTimes(1);
  });
  it('unresolved startup after an external stop is unconfirmed, then a late client is still owned', async () => {
    const f=fixture(); const acquisition=deferred<SystemPracticeServices>(); f.dependencies.loadServices=vi.fn(()=>acquisition.promise);
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush(); f.controller.abort();
    await vi.advanceTimersByTimeAsync(25000); expect(await running).toBe(1); expect(f.events.at(-1)?.cleanup).toBe('UNCONFIRMED');
    acquisition.resolve(f.services); await flush(); expect(f.services.disconnect).toHaveBeenCalledTimes(1); expect(f.ticks.SKY_CRASH).not.toHaveBeenCalled();
  });
  it('startup timeout never reports complete for an unacquired service', async () => {
    const f=fixture(); const acquisition=deferred<SystemPracticeServices>(); f.dependencies.loadServices=vi.fn(()=>acquisition.promise);
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush();
    await vi.advanceTimersByTimeAsync(50000); expect(await running).toBe(1); expect(f.events.at(-1)?.cleanup).toBe('UNCONFIRMED');
    acquisition.resolve(f.services); await flush(); expect(f.services.disconnect).toHaveBeenCalledTimes(1);
  });
  it('a late health listener is closed and cannot start a job after startup timeout', async () => {
    const f=fixture(); const listener=deferred<Server>(); f.dependencies.listenHealth=vi.fn(()=>listener.promise);
    const running=runSystemPracticeWorker(env(),f.dependencies); await flush();
    await vi.advanceTimersByTimeAsync(50000); expect(await running).toBe(1); expect(f.events.at(-1)?.cleanup).toBe('UNCONFIRMED');
    expect(f.services.disconnect).toHaveBeenCalledTimes(1); listener.resolve(f.server as unknown as Server); await flush();
    expect(f.server.close).toHaveBeenCalledTimes(1); expect(f.ticks.SKY_CRASH).not.toHaveBeenCalled();
  });
  it('checks the clock again when a promise resolves after the deadline before its timeout callback', async () => {
    const f=fixture(); let now=0; f.dependencies.now=()=>now;
    f.dependencies.loadServices=vi.fn(()=>Promise.resolve().then(()=>{now=25000;return f.services;}));
    expect(await runSystemPracticeWorker(env(),f.dependencies)).toBe(1);
    expect(f.ticks.SKY_CRASH).not.toHaveBeenCalled(); expect(f.dependencies.listenHealth).not.toHaveBeenCalled();
    expect(f.services.disconnect).toHaveBeenCalledTimes(1); expect(f.events).toContainEqual({event:'SYSTEM_PRACTICE_START_FAILED'});
  });
  it('sanitizes startup rejection without claiming any gameplay acceptance', async () => {
    const f=fixture(); f.dependencies.loadServices=vi.fn(async()=>{throw new Error('password=private SQL SELECT secret');});
    expect(await runSystemPracticeWorker(env(),f.dependencies)).toBe(1);
    expect(f.events).toEqual([{event:'SYSTEM_PRACTICE_START_FAILED'},{event:'SYSTEM_PRACTICE_STOPPED',cleanup:'UNCONFIRMED'}]);
  });
});
