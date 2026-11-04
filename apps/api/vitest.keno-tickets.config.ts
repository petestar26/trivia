import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/games/group-pvp/system-keno-tickets.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
