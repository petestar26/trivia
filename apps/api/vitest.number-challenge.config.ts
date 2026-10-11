import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'number-test-access-secret-00000000000000',
      JWT_REFRESH_SECRET: 'number-test-refresh-secret-000000000000',
    },
    include: [
      'src/games/number-challenge/*.test.ts',
      'src/games/coin-game-availability.test.ts',
      'src/games/game-catalog-rules.test.ts',
    ],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
  },
});
