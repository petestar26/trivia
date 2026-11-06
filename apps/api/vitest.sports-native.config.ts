import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/providers/softaggregator/sports-wallet.native.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      JWT_ACCESS_SECRET: 'isolated-sports-access-secret-only-32',
      JWT_REFRESH_SECRET: 'isolated-sports-refresh-secret-only-32',
    },
  },
});
