import { defineConfig } from 'vitest/config';
export default defineConfig({ test: {
  include: ['src/agents/order-lifecycle.test.ts', 'src/agents/etb-service-boundaries.test.ts', 'src/agents/usd-pricing.test.ts', 'src/agents/etb-pricing.test.ts', 'src/agents/etb-payment-requirements.test.ts'],
  fileParallelism: false, pool: 'forks', minWorkers: 1, maxWorkers: 1,
  env: { NODE_ENV: 'test', LOG_PRETTY: 'false', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused', JWT_ACCESS_SECRET: 'synthetic-etb-access-secret-only', JWT_REFRESH_SECRET: 'synthetic-etb-refresh-secret-only' },
} });
