import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Real service functions with an explicitly mocked database/inventory boundary.
// The alias permits isolated unit tests before Prisma generation; no native
// engine is downloaded, initialized or substituted by this configuration.
export default defineConfig({
  resolve: {
    alias: {
      '@socialplay/database': fileURLToPath(
        new URL('../../packages/database/src/index.ts', import.meta.url)
      ),
    },
  },
  test: {
    include: ['src/agents/deposit-p1-regression.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    env: { NODE_ENV: 'test', LOG_PRETTY: 'false' },
  },
});
