import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/games/play-together/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unit_tests_do_not_connect',
      JWT_ACCESS_SECRET: 'isolated-group-test-access-secret-32',
      JWT_REFRESH_SECRET: 'isolated-group-test-refresh-secret-32',
    },
  },
});
