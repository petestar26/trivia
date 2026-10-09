import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://fixture:fixture@127.0.0.1:1/unused',
      JWT_ACCESS_SECRET: 'football-test-access-secret-0000000000000',
      JWT_REFRESH_SECRET: 'football-test-refresh-secret-000000000000',
    },
    include: [
      'src/games/virtual-football/*.test.ts',
      'src/scripts/staging-football-upgrade.test.ts',
      'src/scripts/staging-derby-upgrade.test.ts',
      'src/scripts/group-worker-runtime.test.ts',
      'src/games/game-catalog-rules.test.ts',
    ],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
