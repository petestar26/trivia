import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: Object.fromEntries(
  ['config', 'database', 'shared'].map((name) => [`@socialplay/${name}`, fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url))])
) }, test: {
  include: ['src/routes/auth-cookie.test.ts'], pool: 'forks', minWorkers: 1, maxWorkers: 1,
} });
