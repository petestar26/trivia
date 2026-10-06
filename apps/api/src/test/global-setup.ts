import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Test-only secrets the database-backed suites need. They must be disposable
 * values generated for the throwaway test environment, never production
 * secrets. Without them the TOTP step-up and the signed ledger approvals fail
 * closed by design, which would otherwise surface as dozens of unrelated
 * failures (and silently skipped assertions) instead of one clear error.
 */
export const REQUIRED_TEST_SECRETS: Record<string, RegExp> = {
  SECURITY_TOTP_ENCRYPTION_KEY: /^[0-9a-fA-F]{64}$/,
  LEDGER_APPROVAL_SIGNING_KEY: /^(?:[0-9a-fA-F]{2}){32,64}$/,
};

export function missingTestSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(REQUIRED_TEST_SECRETS)
    .filter(([name, format]) => !format.test(env[name] ?? ''))
    .map(([name]) => name);
}

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
 *
 * Invoked via `pnpm --filter @socialplay/database db:seed` rather than a
 * hardcoded `packages/database/node_modules/.bin/tsx` path. pnpm resolves the
 * package's own script and binary itself, so this works regardless of
 * hoisting layout, pnpm version, or OS — a direct `.bin` path is not
 * guaranteed to exist there (observed ENOENT on a Windows pnpm layout).
 */
export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.log('[global-setup] DATABASE_URL not set — skipping seed (suites will self-skip).');
    return;
  }
  const missing = missingTestSecrets(process.env);
  if (missing.length) {
    throw new Error(`[global-setup] the test environment lacks ${missing.join(', ')}. Set disposable, test-only `
      + 'values (for example `openssl rand -hex 32` for each) before running the database suites.');
  }

  try {
    execFileSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@socialplay/database', 'db:seed'],
      { cwd: REPO_ROOT, stdio: 'inherit', env: process.env }
    );
  } catch (err) {
    // Surface loudly: a failed seed means trivia-dependent suites would fail
    // for an environment reason, which is exactly the ambiguity this setup
    // exists to remove.
    console.error('[global-setup] seed failed — trivia-dependent tests will not be meaningful.');
    throw err;
  }

  // Acting as the database owner (as the deploy procedure does), install the
  // disposable approval-signing key so signed ledger approvals verify.
  const owner = new PrismaClient({ log: [] });
  try {
    await owner.$executeRawUnsafe(`SELECT "ledger_install_approval_key"($1, decode($2, 'hex'))`,
      process.env.LEDGER_APPROVAL_KEY_ID ?? 'primary', process.env.LEDGER_APPROVAL_SIGNING_KEY);
  } finally {
    await owner.$disconnect();
  }
}
