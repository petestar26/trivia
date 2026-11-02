import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: { '@socialplay/database': fileURLToPath(new URL('../../packages/database/src/index.ts', import.meta.url)), '@socialplay/config': fileURLToPath(new URL('../../packages/config/src/index.ts', import.meta.url)) } }, test: { include: ['src/routes/auth-phone.test.ts', 'src/routes/auth-cookie.test.ts'], pool: 'forks', fileParallelism: false, minWorkers: 1, maxWorkers: 1, env: { NODE_ENV: 'test' } } });
