/**
 * Owner-run setup of the ledger's runtime trust boundary, after every deploy
 * that applied migrations (docs/deployment/ledger-upgrade-gate.md, "Database
 * roles and the approval key"):
 *
 *   pnpm --filter api ledger:runtime-access [--json]
 *   node apps/api/dist/scripts/ledger-runtime-access.js [--json]
 *
 * Reads only the environment (no .env file):
 *   LEDGER_OWNER_DATABASE_URL    the owner (migration) credential; never the
 *                                API's or the worker's DATABASE_URL
 *   LEDGER_RUNTIME_ROLE          the role the API and the worker connect as
 *   LEDGER_APPROVAL_SIGNING_KEY  the API's approval signing key (hex)
 *   LEDGER_APPROVAL_KEY_ID       its ID (default "primary")
 * In one transaction it installs the approval key (idempotent; a different
 * secret under an installed key ID is refused), applies
 * ledger_apply_runtime_grants() (which also removes, or refuses, any way for
 * the runtime role to create objects in the schemas where code running as
 * the owner resolves names, and refuses while any other role outside the
 * owner's trust can create there or owns objects there; the runtime role
 * also loses UPDATE on every key other tables follow by cascade) and
 * verifies the result. It never prints a connection string, a password or
 * the key.
 * Exit codes: 0 applied and verified, 1 refused or not verified, 2 could not run.
 */
import { PrismaClient } from '@prisma/client';
import { redactSecrets } from '../economy/ledger-upgrade-preflight.js';

const USAGE = 'usage: ledger-runtime-access [--json]  (reads LEDGER_OWNER_DATABASE_URL, LEDGER_RUNTIME_ROLE, '
  + 'LEDGER_APPROVAL_SIGNING_KEY and LEDGER_APPROVAL_KEY_ID from the environment)';

/** What the runtime role must never be able to do, and what it needs. */
const DENIED: [table: string, privilege: string][] = [
  ['admin_adjustment_approvals', 'INSERT'], ['admin_adjustment_approvals', 'UPDATE'], ['admin_adjustment_approvals', 'DELETE'],
  ['ledger_approval_assertions', 'INSERT'], ['ledger_approval_assertions', 'UPDATE'], ['ledger_approval_assertions', 'DELETE'],
  ['ledger_approval_keys', 'SELECT'], ['ledger_approval_keys', 'INSERT'], ['ledger_approval_keys', 'UPDATE'],
  ['ledger_approval_keys', 'DELETE'],
  ['economic_operations', 'UPDATE'], ['economic_operations', 'DELETE'],
  ['coin_lot_entries', 'UPDATE'], ['coin_lot_entries', 'DELETE'],
  ['wallet_transactions', 'UPDATE'], ['wallet_transactions', 'DELETE'],
  ['legacy_balance_reviews', 'UPDATE'], ['legacy_balance_reviews', 'DELETE'],
  ['wallets', 'DELETE'], ['coin_provenance', 'DELETE'], ['users', 'DELETE'],
  ['game_rules', 'INSERT'], ['game_rules', 'UPDATE'], ['game_rules', 'DELETE'],
  ['_prisma_migrations', 'INSERT'], ['_prisma_migrations', 'UPDATE'], ['_prisma_migrations', 'DELETE'],
];
const DENIED_USER_COLUMNS = ['role', 'status'];
const REQUIRED: [table: string, privilege: string][] = [
  ['users', 'INSERT'], ['economic_operations', 'INSERT'], ['coin_lot_entries', 'INSERT'],
  ['wallet_transactions', 'INSERT'], ['game_sessions', 'INSERT'], ['admin_adjustment_approvals', 'SELECT'],
];
/** Columns the API updates on tables whose key other tables follow by cascade (so UPDATE is column-level there). */
const REQUIRED_UPDATE_COLUMNS: [table: string, column: string][] = [
  ['wallets', 'coinsBalance'], ['wallets', 'gamePointsBalance'], ['agent_orders', 'status'], ['coin_provenance', 'state'],
];

interface Report {
  applied: boolean;
  runtimeRole: string;
  approvalKeyId: string;
  failures: string[];
}

class NotVerified extends Error {
  constructor(readonly failures: string[]) { super('runtime access not verified'); }
}

/** A refusal ledger_apply_runtime_grants raises (SQLSTATE 42501); its transaction changed nothing. */
function grantsRefusal(error: unknown): string | null {
  const e = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } } | null;
  if (e?.code !== 'P2010' || e.meta?.code !== '42501') return null;
  return String(e.meta.message ?? '').replace(/^ERROR:\s*/, '');
}

async function apply(client: PrismaClient, role: string, keyId: string, keyHex: string): Promise<string[]> {
  try {
    await client.$transaction(async (tx) => {
      const [who] = await tx.$queryRaw<{ isOwner: boolean; sameRole: boolean }[]>`
        SELECT pg_has_role(current_user, c."relowner", 'MEMBER') AS "isOwner", current_user = ${role} AS "sameRole"
        FROM pg_class c WHERE c."oid" = to_regclass('economic_operations')`;
      if (!who) throw new NotVerified(['the ledger schema is not installed: apply the migrations first']);
      if (!who.isOwner) throw new NotVerified(['LEDGER_OWNER_DATABASE_URL does not connect as the owner of the ledger tables']);
      if (who.sameRole) throw new NotVerified(['LEDGER_RUNTIME_ROLE is the owner credential\'s own role']);

      await tx.$executeRaw`SELECT "ledger_install_approval_key"(${keyId}, decode(${keyHex}, 'hex'))`;
      await tx.$executeRaw`SELECT "ledger_apply_runtime_grants"(${role})`;

      const failures: string[] = [];
      for (const [table, privilege] of DENIED) {
        const [row] = await tx.$queryRaw<{ granted: boolean | null }[]>`
          SELECT CASE WHEN to_regclass(${table}) IS NULL THEN NULL
                      ELSE has_table_privilege(${role}, to_regclass(${table}), ${privilege}) END AS "granted"`;
        if (row?.granted) failures.push(`${role} still holds ${privilege} on ${table}`);
      }
      for (const column of DENIED_USER_COLUMNS) {
        const [row] = await tx.$queryRaw<{ granted: boolean }[]>`
          SELECT has_column_privilege(${role}, 'users', ${column}, 'UPDATE') AS "granted"`;
        if (row?.granted) failures.push(`${role} can still change users.${column}`);
      }
      // The approval functions run as the owner and resolve names in this
      // schema: the runtime role must not be able to create anything there
      // (the grants function refuses when it cannot remove such a privilege).
      const [schema] = await tx.$queryRaw<{ create: boolean }[]>`
        SELECT has_schema_privilege(${role}, 'public', 'CREATE') AS "create"`;
      if (schema?.create) failures.push(`${role} can still create objects in schema public`);
      // No key another table follows by cascade: a cascade, and the triggers
      // it fires, run as the owner of the referencing table. Checked for the
      // runtime role and for every role it can become: has_column_privilege
      // sees only inherited privileges, and a membership usable by SET ROLE
      // alone (NOINHERIT), direct or transitive, is one pg_has_role MEMBER
      // still reports (PostgreSQL 13 and later).
      const cascadeKeys = await tx.$queryRaw<{ key: string; via: string }[]>`
        SELECT DISTINCT c.confrelid::regclass::text || '.' || a.attname::text AS "key", m.rolname::text AS "via"
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
        JOIN pg_roles m ON pg_has_role(${role}, m.oid, 'MEMBER')
        WHERE c.contype = 'f' AND c.confupdtype IN ('c', 'n', 'd')
          AND has_column_privilege(m.oid, c.confrelid, a.attname::text, 'UPDATE')
        ORDER BY 1, 2`;
      for (const { key, via } of cascadeKeys) {
        failures.push(via === role ? `${role} can still change ${key}, a key other tables follow by cascade`
          : `${role} can still change ${key} as ${via}, a role it can become, a key other tables follow by cascade`);
      }
      for (const [table, column] of REQUIRED_UPDATE_COLUMNS) {
        const [row] = await tx.$queryRaw<{ granted: boolean }[]>`
          SELECT has_column_privilege(${role}, to_regclass(${table}), ${column}, 'UPDATE') AS "granted"`;
        if (!row?.granted) failures.push(`${role} cannot update ${table}.${column}, which the API needs`);
      }
      for (const [table, privilege] of REQUIRED) {
        const [row] = await tx.$queryRaw<{ granted: boolean }[]>`
          SELECT has_table_privilege(${role}, to_regclass(${table}), ${privilege}) AS "granted"`;
        if (!row?.granted) failures.push(`${role} lacks ${privilege} on ${table}, which the API needs`);
      }
      const [key] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM "ledger_approval_keys" WHERE "keyId" = ${keyId} AND "retiredAt" IS NULL) AS "active"`;
      if (!key?.active) failures.push(`approval key ${keyId} is retired: install a new key ID`);
      if (failures.length > 0) throw new NotVerified(failures);
    }, { timeout: 60_000, maxWait: 30_000 });
  } catch (error) {
    if (error instanceof NotVerified) return error.failures;
    const refusal = grantsRefusal(error);
    if (refusal) return [refusal];
    throw error;
  }
  return [];
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
  const ownerUrl = process.env.LEDGER_OWNER_DATABASE_URL;
  const role = process.env.LEDGER_RUNTIME_ROLE;
  const keyHex = process.env.LEDGER_APPROVAL_SIGNING_KEY;
  const keyId = process.env.LEDGER_APPROVAL_KEY_ID || 'primary';
  const missing = [
    !ownerUrl && 'LEDGER_OWNER_DATABASE_URL',
    !role && 'LEDGER_RUNTIME_ROLE',
    !keyHex && 'LEDGER_APPROVAL_SIGNING_KEY',
  ].filter(Boolean);
  if (missing.length > 0) {
    process.stderr.write(`Ledger runtime access could not run: ${missing.join(', ')} not set in the environment.\n`);
    return 2;
  }
  if (!/^(?:[0-9a-fA-F]{2}){32,64}$/.test(keyHex!)) {
    process.stderr.write('Ledger runtime access could not run: LEDGER_APPROVAL_SIGNING_KEY must be 32-64 bytes as hex (64-128 characters).\n');
    return 2;
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    process.stderr.write('Ledger runtime access could not run: LEDGER_APPROVAL_KEY_ID must be 1-64 characters of [A-Za-z0-9._-].\n');
    return 2;
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === ownerUrl) {
    process.stderr.write('Ledger runtime access refused: DATABASE_URL is the owner credential. '
      + 'The API and the worker must connect as the runtime role.\n');
    return 1;
  }

  const client = new PrismaClient({ datasourceUrl: ownerUrl, log: [] });
  const redact = (text: string) => redactSecrets(text, ownerUrl).split(keyHex!).join('[redacted]');
  try {
    const failures = await apply(client, role!, keyId, keyHex!.toLowerCase());
    const report: Report = { applied: failures.length === 0, runtimeRole: role!, approvalKeyId: keyId, failures };
    if (json) {
      process.stdout.write(`${redact(JSON.stringify(report, null, 2))}\n`);
    } else if (report.applied) {
      process.stdout.write(redact(`Ledger runtime access: approval key ${keyId} installed; ${role} holds data access only `
        + '(no approvals, assertions, signing key, migration history, user role or status, and no rewriting '
        + 'of financial history). Verified.\n'));
    } else {
      process.stdout.write(redact(`Ledger runtime access NOT verified; nothing was changed:\n${
        failures.map((failure) => `  ${failure}\n`).join('')}`));
    }
    return report.applied ? 0 : 1;
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .split('\n').map((line) => line.trim()).filter(Boolean).join(' ');
    process.stderr.write(`Ledger runtime access could not run; nothing was changed: ${redact(message)}\n`);
    return 2;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  const key = process.env.LEDGER_APPROVAL_SIGNING_KEY;
  let message = redactSecrets(String((error as Error)?.message ?? error), process.env.LEDGER_OWNER_DATABASE_URL);
  if (key) message = message.split(key).join('[redacted]');
  process.stderr.write(`Ledger runtime access could not run; nothing was changed: ${message.slice(0, 500)}\n`);
  process.exitCode = 2;
});
