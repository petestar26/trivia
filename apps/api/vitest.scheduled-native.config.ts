import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/agents/*.native.ts', 'src/groups/*.native.ts', 'src/economy/reward-coins.native.ts', 'src/games/scheduled/*.native.ts', 'src/games/economics/*.native.ts', 'src/games/group-pvp/*.native.ts', 'src/gift-collection/*.native.ts', 'src/ledger/ledger-upgrade.migration.test.ts'],
    fileParallelism: false, pool: 'forks', minWorkers: 1, maxWorkers: 1,
    testTimeout: 120_000, hookTimeout: 120_000,
    env: { LOG_PRETTY: 'false' },
  },
});
