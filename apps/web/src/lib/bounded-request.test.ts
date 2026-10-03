import { afterEach, expect, it, vi } from 'vitest';
import { boundedRequest } from './bounded-request';
afterEach(()=>{vi.useRealTimers();});
it('times out an unresponsive transport and aborts it',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined;
  const pending=boundedRequest(s=>{signal=s;return new Promise(()=>{});});
  const assertion=expect(pending).rejects.toThrow('not confirmed');
  await vi.advanceTimersByTimeAsync(8000);await assertion;expect(signal?.aborted).toBe(true);
});
it('rejects promptly when its caller aborts and preserves ordinary results',async()=>{
  const parent=new AbortController();const pending=boundedRequest(()=>new Promise(()=>{}),parent.signal);
  parent.abort();await expect(pending).rejects.toThrow();
  await expect(boundedRequest(async()=>42)).resolves.toBe(42);
});
