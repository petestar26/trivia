import { expect, it, vi } from 'vitest';
import { paymentWorkerTarget, startVerifiedPaymentWorker } from './staging-payment-worker.js';
const env = {
  RAILWAY_ENVIRONMENT_ID: '7de0c716-24df-4e97-a998-ed99abfa256f',
  PRACTICE_STAGING_ACK: 'spin-practice-rehearsal-20261002',
  DATABASE_URL: 'postgresql://spin_rehearsal_api_fixture:disposable@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
};
it('derives the expected restricted role without returning credentials', () => {
  expect(paymentWorkerTarget(env)).toBe('spin_rehearsal_api_fixture');
});
it.each([
  { RAILWAY_ENVIRONMENT_ID: 'production' },
  { PRACTICE_STAGING_ACK: undefined },
  { DATABASE_URL: env.DATABASE_URL.replace('spin-practice-db-20261002', 'production-db') },
  { DATABASE_URL: env.DATABASE_URL.replace('/playqube_spin_rehearsal_20261002', '/production') },
  { DATABASE_URL: env.DATABASE_URL.replace('spin_rehearsal_api_fixture', 'postgres') },
  { DATABASE_URL: env.DATABASE_URL + '?options=-crole%3Dpostgres' },
  { DATABASE_URL: env.DATABASE_URL + '?host=production-db' },
  { DATABASE_URL: env.DATABASE_URL + '?schema=untrusted' },
  { DATABASE_URL: 'invalid secret connection data' },
  { LEDGER_OWNER_DATABASE_URL: 'owner-secret' },
])('refuses unsafe target before connecting or sweeping: %j', async (change) => {
  const verify = vi.fn(), run = vi.fn();
  await expect(startVerifiedPaymentWorker({ ...env, ...change }, verify, run)).rejects.toThrow('PAYMENT_WORKER_TARGET_REFUSED');
  expect(verify).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
it('never runs if database identity verification fails', async () => {
  const run = vi.fn();
  await expect(startVerifiedPaymentWorker(env, async () => { throw Error('unsafe identity'); }, run)).rejects.toThrow('unsafe identity');
  expect(run).not.toHaveBeenCalled();
});
it('waits for verified identity before running and preserves a failed sweep exit code', async () => {
  const order: string[] = [];
  const code = await startVerifiedPaymentWorker(env, async () => { order.push('verify'); }, async () => { order.push('run'); return 1; });
  expect(order).toEqual(['verify', 'run']);
  expect(code).toBe(1);
});
