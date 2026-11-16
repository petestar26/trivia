import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/routes/auth-reset-cutover.test.ts', 'src/routes/auth-cookie.test.ts', 'src/routes/auth-phone.test.ts', 'src/routes/auth-google.test.ts'], fileParallelism: false, pool: 'forks', minWorkers: 1, maxWorkers: 1, env: { LOG_PRETTY: 'false' } } });
