import { defineConfig } from 'vitest/config';

// Isolated integration boundary: never run database global setup or fixtures.
export default defineConfig({
  test: {
    include: ['src/providers/softaggregator/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'isolated-provider-access-secret-only-32',
      JWT_REFRESH_SECRET: 'isolated-provider-refresh-secret-only-32',
    },
  },
});
