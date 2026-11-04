import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'blackjack-test-access-secret-00000000',
      JWT_REFRESH_SECRET: 'blackjack-test-refresh-secret-0000000',
    },
    include: ['src/games/blackjack/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
