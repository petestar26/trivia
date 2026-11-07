import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'src/agents/payment-room.native.ts',
      'src/agents/payment-maintenance.test.ts',
      'src/workspaces/withdrawals.native.ts',
      'src/agents/payment-readiness.native.ts',
    ],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 120000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      JWT_ACCESS_SECRET: 'isolated-payment-access-test-only',
      JWT_REFRESH_SECRET: 'isolated-payment-refresh-test-only',
    },
  },
});
