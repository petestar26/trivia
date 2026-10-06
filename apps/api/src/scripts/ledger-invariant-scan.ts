/**
 * Ledger invariant scan for the upgrade runbook (step 6: after migrating,
 * before any writer restarts).
 *
 *   pnpm --filter api scan:ledger-invariants [--json]
 *   node apps/api/dist/scripts/ledger-invariant-scan.js [--json]
 *
 * Runs every runtime invariant (I0-I16) exactly as the platform does, inside
 * one SERIALIZABLE transaction that is always rolled back: it records no
 * invariant run and therefore opens no platform gate. Like the preflight it
 * reads only DATABASE_URL, loads no .env file and never prints the
 * connection string or its credentials.
 * Exit codes: 0 every invariant holds, 1 violations found, 2 could not evaluate.
 */
import { PrismaClient } from '@prisma/client';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import type { LedgerViolation } from '../economy/ledger-invariant-checker.js';
import { redactSecrets } from '../economy/ledger-upgrade-preflight.js';

const USAGE = 'usage: ledger-invariant-scan [--json]  (reads DATABASE_URL from the environment)';

class ScanRolledBack extends Error {
  constructor(readonly violations: LedgerViolation[]) { super('scan rolled back'); }
}

async function scan(client: PrismaClient): Promise<LedgerViolation[]> {
  try {
    await client.$transaction(async (tx) => {
      const run = await runLedgerInvariantCheckInTransaction(tx, null, false);
      throw new ScanRolledBack(run.violations);
    }, { isolationLevel: 'Serializable', timeout: 600_000, maxWait: 30_000 });
  } catch (error) {
    if (error instanceof ScanRolledBack) return error.violations;
    throw error;
  }
  throw new Error('the invariant scan did not roll back');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === '--help' || arg === '-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const unknown = args.find((arg) => arg !== '--json');
  if (unknown) {
    process.stderr.write(`unknown argument ${unknown}\n${USAGE}\n`);
    return 2;
  }
  const json = args.includes('--json');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('Ledger invariant scan could not evaluate: DATABASE_URL is not set in the environment.\n');
    return 2;
  }
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  try {
    const violations = await scan(client);
    if (json) {
      process.stdout.write(`${JSON.stringify({ passed: violations.length === 0, violations }, null, 2)}\n`);
    } else if (violations.length === 0) {
      process.stdout.write('Ledger invariant scan (rolled back, nothing recorded): every invariant holds.\n');
    } else {
      process.stdout.write(`Ledger invariant scan (rolled back, nothing recorded): ${violations.length} invariant(s) violated.\n`);
      for (const violation of violations) {
        process.stdout.write(`  ${violation.invariant}: ${violation.count} [${violation.sample.join(', ')}]\n`);
      }
      process.stdout.write('Do not restart any writer. Escalate per docs/deployment/ledger-upgrade-gate.md.\n');
    }
    return violations.length === 0 ? 0 : 1;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
    process.stderr.write(`Ledger invariant scan could not evaluate the database: ${redactSecrets(message, databaseUrl)}\n`);
    return 2;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 2; });
