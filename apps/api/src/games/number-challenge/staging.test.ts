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
