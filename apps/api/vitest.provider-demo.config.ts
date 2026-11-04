import { defineConfig } from 'vitest/config';

// Isolated integration boundary: never run database global setup or fixtures.
export default defineConfig({
  test: {
    include: ['src/providers/softaggregator/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
  },
});
