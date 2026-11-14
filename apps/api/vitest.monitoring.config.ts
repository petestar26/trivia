import { defineConfig } from 'vitest/config';

// No database global setup, teardown, or production credentials.
export default defineConfig({
  test: {
    include: [
      'src/monitoring/*.test.ts',
      'src/support/service.test.ts',
      'src/support/routes.test.ts',
      'src/providers/softaggregator/*.test.ts',
    ],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'isolated-monitor-access-secret-only-32',
      JWT_REFRESH_SECRET: 'isolated-monitor-refresh-secret-only-32',
    },
  },
});
