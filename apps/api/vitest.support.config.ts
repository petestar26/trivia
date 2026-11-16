import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/support/*.test.ts', 'src/scripts/member-experience-readiness.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
  },
});
