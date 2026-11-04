import { defineConfig } from 'vitest/config';
// Isolated in-memory databases. Never runs the production fixture setup.
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'roulette-keno-test-access-secret-00000000',
      JWT_REFRESH_SECRET: 'roulette-keno-test-refresh-secret-0000000',
    },
    include: ['src/games/roulette-keno/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
