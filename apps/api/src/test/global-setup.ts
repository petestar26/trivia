import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PACKAGE = path.resolve(__dirname, '../../../../packages/database');

/**
 * Vitest globalSetup — runs ONCE before any test file.
 *
 * Applies the repository's own seed so the suite never depends on a database
 * that somebody remembered to seed by hand. The seed is idempotent (fixed
 * uuids + upsert), so running it against an already-seeded database is a
 * no-op and results stay identical across repeated runs.
 *
 * If DATABASE_URL is absent the suites already self-skip via their
 * `dbAvailable` probe, so seeding is skipped too rather than failing the run.
 */
export default function setup(): void {
  if (!process.env.DATABASE_URL) {
    console.log('[global-setup] DATABASE_URL not set — skipping seed (suites will self-skip).');
    return;
  }

  try {
    execFileSync(
      path.join(DB_PACKAGE, 'node_modules/.bin/tsx'),
      [path.join(DB_PACKAGE, 'prisma/seed.ts')],
      { cwd: DB_PACKAGE, stdio: 'inherit', env: process.env }
    );
  } catch (err) {
    // Surface loudly: a failed seed means trivia-dependent suites would fail
    // for an environment reason, which is exactly the ambiguity this setup
    // exists to remove.
    console.error('[global-setup] seed failed — trivia-dependent tests will not be meaningful.');
    throw err;
  }
}
