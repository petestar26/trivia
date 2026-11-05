export default {
  test: {
    include: ['src/games/trivia-practice/*.test.ts'],
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
  },
};
