import { expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { assertRecoveryFixtureTarget, FIXTURE, recoveryFixture } from './staging-recovery-fixture.js';
const env = {
  DATABASE_URL: 'postgresql://owner@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  RAILWAY_ENVIRONMENT_ID: '7de0c716-24df-4e97-a998-ed99abfa256f',
  PRACTICE_STAGING_ACK: 'spin-practice-rehearsal-20261002',
  PRACTICE_API_ROLE: 'spin_rehearsal_api_fixture', RECOVERY_FIXTURE_ACK: FIXTURE,
};
it('requires explicit synthetic acknowledgement and the exact isolated target', () => {
  expect(() => assertRecoveryFixtureTarget(env)).not.toThrow();
  for (const change of [{RECOVERY_FIXTURE_ACK: undefined}, {RAILWAY_ENVIRONMENT_ID: 'production'},
    {DATABASE_URL: env.DATABASE_URL.replace('railway.internal', 'example.com')},
    {DATABASE_URL: env.DATABASE_URL.replace('playqube_spin_rehearsal_20261002', 'production')},
    {DATABASE_URL: env.DATABASE_URL + '?host=production'}, {DATABASE_URL: env.DATABASE_URL + '#other'}]) {
    expect(() => assertRecoveryFixtureTarget({...env, ...change})).toThrow();
  }
});
it('refuses runtime identities before reading or writing any fixture', async () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{allowed:false}]), auditLog: {findFirst: vi.fn()} };
  await expect(recoveryFixture(tx as unknown as Prisma.TransactionClient, true)).rejects.toThrow('DATABASE_OWNER_REQUIRED');
  expect(tx.auditLog.findFirst).not.toHaveBeenCalled();
});
it('verify mode refuses a missing fixture without any writes', async () => {
  const tx = { $queryRaw: vi.fn().mockResolvedValue([{allowed:true}]), auditLog: {findFirst: vi.fn().mockResolvedValue(null)}, user: {create: vi.fn()} };
  await expect(recoveryFixture(tx as unknown as Prisma.TransactionClient, false)).rejects.toThrow('SYNTHETIC_FIXTURE_NOT_SEEDED');
  expect(tx.user.create).not.toHaveBeenCalled();
});
