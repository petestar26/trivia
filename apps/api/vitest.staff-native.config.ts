import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'src/workspaces/workspaces.native.ts',
      'src/workspaces/withdrawals.native.ts',
      'src/agents/admin-account.native.ts',
      'src/agents/payment-readiness.native.ts',
      'src/auth/password-reset.native.ts',
      'src/member-rewards/rewards.native.ts',
      // Staff database identity guard and explicit-client isolation.
      'src/database/identity.test.ts',
      'src/database/no-default-fallback.test.ts',
      'src/database/staff-identity.native.ts',
    ],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      JWT_ACCESS_SECRET: 'isolated-staff-access-secret-only',
      JWT_REFRESH_SECRET: 'isolated-staff-refresh-secret-only',
    },
  },
});
