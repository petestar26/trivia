import { expect, it } from 'vitest';
import { runNumberStagingUpgrade } from '../../scripts/staging-number-upgrade.js';
it('refuses production or unacknowledged upgrade before any connection', async () => {
  for (const env of [
    {},
    { DATABASE_URL: 'postgresql://x:x@127.0.0.1/test' },
    { RAILWAY_ENVIRONMENT_ID: 'production' },
  ])
    await expect(runNumberStagingUpgrade(env, true)).rejects.toThrow('STAGING_TARGET_REFUSED');
});

it('refuses a worker pointing outside the acknowledged staging database', async () => {
  const env = {
    RAILWAY_ENVIRONMENT_ID: '7de0c716-24df-4e97-a998-ed99abfa256f',
    PRACTICE_STAGING_ACK: 'spin-practice-rehearsal-20261002',
    PRACTICE_API_ROLE: 'spin_rehearsal_api_test',
    DATABASE_URL:
      'postgresql://owner:x@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  };
  for (const worker of [
    'postgresql://worker:x@production.internal/playqube_spin_rehearsal_20261002',
    'postgresql://worker:x@spin-practice-db-20261002.railway.internal/production',
    'https://worker:x@spin-practice-db-20261002.railway.internal/playqube_spin_rehearsal_20261002',
  ])
    await expect(
      runNumberStagingUpgrade({ ...env, SOCIAL_WORKER_DATABASE_URL: worker }, true)
    ).rejects.toThrow('WORKER_TARGET_REFUSED');
});
