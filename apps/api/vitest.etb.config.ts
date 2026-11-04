import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/agents/etb-*.test.ts', 'src/crypto-payments/etb-*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 60000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      DATABASE_URL: 'postgresql://unused@127.0.0.1/unused',
      JWT_ACCESS_SECRET: 'disposable-etb-access-secret-for-tests',
      JWT_REFRESH_SECRET: 'disposable-etb-refresh-secret-for-tests',
    },
  },
});
