import { defineConfig } from 'vitest/config';
// Isolated in-memory databases. Never runs the production fixture setup.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'lucky-six-test-access-secret-00000000',
      JWT_REFRESH_SECRET: 'lucky-six-test-refresh-secret-0000000',
    },
    include: ['src/games/lucky-six/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 90000,
    hookTimeout: 30000,
  },
});
