import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/agents/etb-requirements.native.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 120000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      LOG_PRETTY: 'false',
      JWT_ACCESS_SECRET: 'synthetic-etb-native-access-only',
      JWT_REFRESH_SECRET: 'synthetic-etb-native-refresh-only',
    },
  },
});
