import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/games/crash-point/*.test.ts', 'src/scripts/group-worker-runtime.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
  },
});
