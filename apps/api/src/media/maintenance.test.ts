import { describe, expect, it } from 'vitest';
import { MediaMaintenance } from './maintenance.js';
import { performance } from 'node:perf_hooks';

const identity = Object.fromEntries(['PROJECT', 'ENVIRONMENT', 'SERVICE', 'DEPLOYMENT'].map((name, i) =>
  [`RAILWAY_${name}_ID`, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`]));

describe('server-owned media admission', () => {
  it.each(['latch', 'validation'])('keeps a bounded monotonic deadline despite synchronous blocking %s', async phase => {
    const block = async () => { const until=performance.now()+35; while(performance.now()<until) { /* simulate blocked fs/validation boundary */ } };
    const gate=new MediaMaintenance(identity);
    gate.configure(phase==='latch'?block:async()=>{},false,phase==='validation'?block:async()=>{});
    expect(await gate.closeAndDrain(10)).toMatchObject({drained:false,outcome:'timeout',closed:true});
    expect(()=>gate.admit()).toThrow();
  });
  it('counts all operations, closes atomically, releases idempotently and never reopens on timeout', async () => {
    let writes = 0;
    const gate = new MediaMaintenance(identity);
    gate.configure(async () => { writes++; }, false);
    const a = gate.admit(); const b = gate.admit();
    const pending = gate.closeAndDrain(20);
    expect(() => gate.admit()).toThrow('maintenance');
    a(); a();
    expect(await pending).toMatchObject({ outcome: 'timeout', active: 1, admitted: 2, settled: 1, drained: false });
    expect(() => gate.admit()).toThrow();
    b();
    expect(await gate.closeAndDrain(20)).toMatchObject({ outcome: 'drained', active: 0, closed: true, drained: true });
    expect(writes).toBe(1);
  });

  it('bounds persistence as well as drain and cannot claim readiness without identity/authority', async () => {
    const stuck = new MediaMaintenance(identity);
    stuck.configure(() => new Promise(() => {}), false);
    expect(await stuck.closeAndDrain(10)).toMatchObject({ outcome: 'timeout', drained: false, closed: true });
    expect(await new MediaMaintenance(identity).closeAndDrain(10)).toMatchObject({ outcome: 'unconfigured', drained: false });
    const unknown = new MediaMaintenance({}); unknown.configure(async () => {}, false);
    expect(await unknown.closeAndDrain(10)).toMatchObject({ outcome: 'identity-unavailable', drained: false });
  });

  it('retains recovery, persistence failure, and uncertain cleanup as terminal states', async () => {
    const recovery = new MediaMaintenance(identity); recovery.configure(async () => {}, true);
    expect(await recovery.closeAndDrain(10)).toMatchObject({ outcome: 'recovery-required', drained: false });
    const broken = new MediaMaintenance(identity); broken.configure(async () => { throw new Error('disk'); }, false);
    expect(await broken.closeAndDrain(10)).toMatchObject({ outcome: 'latch-failed', drained: false });
    const uncertain = new MediaMaintenance(identity); uncertain.configure(async () => {}, false);
    await uncertain.markCleanupFailure();
    expect(await uncertain.closeAndDrain(10)).toMatchObject({ outcome: 'unresolved-cleanup', drained: false, unresolvedCleanup: 1 });
  });

  it('binds exact available replica identity and a unique process incarnation', () => {
    const a = new MediaMaintenance({ ...identity, RAILWAY_REPLICA_ID: 'replica-a' });
    const b = new MediaMaintenance({ ...identity, RAILWAY_REPLICA_ID: 'replica-b' });
    expect(a.snapshot().incarnation).not.toBe(b.snapshot().incarnation);
    expect(a.snapshot()).toMatchObject({ scope: 'single-api-server-instance-only', railway: { ...identity, RAILWAY_REPLICA_ID: 'replica-a', RAILWAY_REPLICA_REGION: null } });
    expect(b.snapshot().closed).toBe(false);
  });
});
