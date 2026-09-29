/**
 * Read-only ledger upgrade preflight (see economy/ledger-upgrade-preflight.ts).
 *
 *   pnpm --filter api preflight:ledger-upgrade [--json] [--limit N]
 *   node apps/api/dist/scripts/ledger-upgrade-preflight.js [--json] [--limit N]
 *
 * Configuration is the ordinary process environment: only DATABASE_URL is
 * read, no .env file is loaded, and the application configuration (with its
 * secrets) is never imported. The connection string and its credentials are
 * never printed. Exit codes: 0 clean, 1 anomalies found, 2 could not evaluate.
 */
import { PrismaClient } from '@prisma/client';
import {
  formatPreflightReport, preflightExitCode, redactSecrets, runLedgerUpgradePreflight,
} from '../economy/ledger-upgrade-preflight.js';

const USAGE = 'usage: ledger-upgrade-preflight [--json] [--limit N]  (reads DATABASE_URL from the environment)';

function parseArgs(argv: string[]): { json: boolean; limit: number; help: boolean } | string {
  let json = false;
  let limit = 50;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--limit') {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1) return '--limit needs a positive whole number';
      limit = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') help = true;
    else return `unknown argument ${arg}\n${USAGE}`;
  }
  return { json, limit, help };
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (typeof options === 'string') {
    process.stderr.write(`${options}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('Ledger upgrade preflight could not evaluate: DATABASE_URL is not set in the environment.\n');
    return 2;
  }
  const client = new PrismaClient({ datasourceUrl: databaseUrl, log: [] });
  try {
    const report = await runLedgerUpgradePreflight(client);
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatPreflightReport(report, options.limit));
    return preflightExitCode(report);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
    process.stderr.write(`Ledger upgrade preflight could not evaluate the database: ${redactSecrets(message, databaseUrl)}\n`);
    return 2;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 2; });
