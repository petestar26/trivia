import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/member-rewards/*.native.ts', 'src/economy/reward-coins.native.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      LOG_PRETTY: 'false',
      JWT_ACCESS_SECRET: 'isolated-member-reward-access-test-secret',
      JWT_REFRESH_SECRET: 'isolated-member-reward-refresh-test-secret',
    },
  },
});
