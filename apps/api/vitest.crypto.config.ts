import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/crypto-payments/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 120000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      DATABASE_URL: 'postgresql://unused@127.0.0.1/unused',
      JWT_ACCESS_SECRET: 'disposable-crypto-access-secret-for-tests',
      JWT_REFRESH_SECRET: 'disposable-crypto-refresh-secret-for-tests',
    },
  },
});
