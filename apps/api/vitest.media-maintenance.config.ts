import { defineConfig } from 'vitest/config';

// Offline only: real routes/services and local socket, mocked DB/storage/auth.
// No global setup, environment secrets, provider calls or database connection.
export default defineConfig({
  test: {
    include: ['src/media/*.test.ts'],
    pool: 'forks', minWorkers: 1, maxWorkers: 1, fileParallelism: false,
  },
});
