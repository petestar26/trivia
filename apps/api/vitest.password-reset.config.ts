import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'src/auth/password-reset.native.ts',
      'src/ws/access.test.ts',
      'src/routes/auth-cookie.test.ts',
      'src/routes/auth-phone.test.ts',
      'src/routes/auth-google.test.ts',
      'src/plugins/cookie-origin.test.ts',
    ],
    fileParallelism: false,
    pool: 'forks',
    minWorkers: 1,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      LOG_PRETTY: 'false',
      JWT_ACCESS_SECRET: 'isolated-recovery-access-test-secret',
      JWT_REFRESH_SECRET: 'isolated-recovery-refresh-test-secret',
    },
  },
});
