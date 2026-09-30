import { defineConfig } from 'vitest/config';

// Pure mathematical contracts must run without secrets, database or test fixtures.
export default defineConfig({
  test: {
    include: ['src/games/economics/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
  },
});
