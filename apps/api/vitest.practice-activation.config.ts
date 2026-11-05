import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/practice-activation/provision.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
