import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/games/practice-worker/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
  },
});
