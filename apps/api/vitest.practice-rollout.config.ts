import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'src/providers/softaggregator/*.test.ts',
      'src/practice-activation/provision.test.ts',
      'src/games/practice-worker/runtime.test.ts',
      'src/games/trivia-practice/routes.test.ts',
      'src/games/game-practice-availability.test.ts',
    ],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30000,
  },
});
