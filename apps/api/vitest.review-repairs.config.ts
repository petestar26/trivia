import { defineConfig } from 'vitest/config';

// No production fixtures, environment loading, migrations or global DB setup.
export default defineConfig({
  test: {
    include: [
      'src/support/service.test.ts',
      'src/support/concurrency.native.test.ts',
      'src/routes/chat-voice-notification.test.ts',
      'src/storage/readiness.test.ts',
      'src/routes/storage.test.ts',
      'src/realtime/broadcast.test.ts',
    ],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      DATABASE_URL: 'postgresql://unused@127.0.0.1/unused',
      JWT_ACCESS_SECRET: 'disposable-review-access-secret-for-tests',
      JWT_REFRESH_SECRET: 'disposable-review-refresh-secret-for-tests',
    },
  },
});
