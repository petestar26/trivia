import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/games/scheduled/*.test.ts'],
    pool: 'forks', minWorkers: 1, maxWorkers: 1,
    hookTimeout: 30_000, testTimeout: 15_000,
  },
});
