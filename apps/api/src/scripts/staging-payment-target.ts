/** Shared guard; importing this module never runs a CLI command. */
export function assertUsdStagingTarget(env: NodeJS.ProcessEnv) {
  const url = new URL(env.DATABASE_URL ?? 'https://invalid');
  if (
    env.RAILWAY_ENVIRONMENT_ID !== '7de0c716-24df-4e97-a998-ed99abfa256f' ||
    env.PRACTICE_STAGING_ACK !== 'spin-practice-rehearsal-20261002' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== 'spin-practice-db-20261002.railway.internal' ||
    url.pathname !== '/playqube_spin_rehearsal_20261002' ||
    !/^spin_rehearsal_api_[a-z0-9_]{1,32}$/.test(env.PRACTICE_API_ROLE ?? '')
  ) {
    throw new Error('STAGING_TARGET_REFUSED');
  }
}

