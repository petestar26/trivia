import { expect, it } from 'vitest';
import { assertUsdStagingTarget } from './staging-usd-payment-upgrade.js';

const env = {
  RAILWAY_ENVIRONMENT_ID: '7de0c716-24df-4e97-a998-ed99abfa256f',
  PRACTICE_STAGING_ACK: 'spin-practice-rehearsal-20261002',
  DATABASE_URL:
    'postgresql://test:fixture@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  PRACTICE_API_ROLE: 'spin_rehearsal_api_fixture',
};
it('accepts only the exact disposable staging target', () => {
  expect(() => assertUsdStagingTarget(env)).not.toThrow();
  for (const field of Object.keys(env))
    expect(() => assertUsdStagingTarget({ ...env, [field]: 'wrong' })).toThrow();
});
it('rejects production, unrelated databases and identifier injection', () => {
  expect(() =>
    assertUsdStagingTarget({
      ...env,
      RAILWAY_ENVIRONMENT_ID: '0e7a10b5-2e44-4b92-8949-5685679da45b',
    })
  ).toThrow();
  expect(() =>
    assertUsdStagingTarget({
      ...env,
      DATABASE_URL: env.DATABASE_URL.replace('/playqube_spin_rehearsal_20261002', '/production'),
    })
  ).toThrow();
  expect(() =>
    assertUsdStagingTarget({ ...env, PRACTICE_API_ROLE: 'spin_rehearsal_api_fixture"; SELECT 1' })
  ).toThrow();
});
