import { defineConfig } from 'vitest/config';

// These tests use real HTTP servers and injected worker functions, without a
// database. Keep the integration suite's seeding/ledger cleanup out of them.
export default defineConfig({test:{
  include:['src/routes/workspaces.test.ts','src/scripts/staging-payment-admin.test.ts','src/agents/payment-admin-routes.test.ts','src/agents/payment-setup.test.ts','src/scripts/staging-usd-payment-upgrade.test.ts','src/agents/usd-migration.test.ts','src/agents/usd-pricing.test.ts','src/worker.test.ts','src/plugins/jwt-boundary.test.ts','src/plugins/rate-limit-identity.test.ts','src/scripts/group-worker-runtime.test.ts','src/routes/storage.test.ts','src/routes/wallet-options.test.ts','src/middleware/current-permission.test.ts'],
  fileParallelism:false,pool:'forks',minWorkers:1,maxWorkers:1,testTimeout:30000,
  env:{NODE_ENV:'test',LOG_PRETTY:'false',DATABASE_URL:'postgresql://unused@127.0.0.1/unused',
    JWT_ACCESS_SECRET:'disposable-review-access-secret-for-tests',JWT_REFRESH_SECRET:'disposable-review-refresh-secret-for-tests'},
}});
