/**
 * Fail closed before starting a deployment with an owner database credential.
 * The API receives only DATABASE_URL and never prints it or its credentials.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { verifyRuntimeAccessReadOnly } from './ledger-runtime-access.js';

type IdentityRow = {
  role: string;
  session_role: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  key_read: boolean | null;
  migration_insert: boolean | null;
  migration_update: boolean | null;
  migration_delete: boolean | null;
};

/** A read-only check; no environment variable can grant privileges here. */
export async function verifyLedgerRuntimeIdentity(
  db: Prisma.TransactionClient,
  expectedRole: string,
  verifyAccess = verifyRuntimeAccessReadOnly,
): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z_0-9]{0,62}$/.test(expectedRole)) {
    throw new Error('runtime identity verification failed');
  }
  const rows = await db.$queryRawUnsafe<IdentityRow[]>(`
    SELECT current_user AS role, session_user AS session_role, r.rolsuper, r.rolbypassrls,
           pg_catalog.has_any_column_privilege(current_user, 'public.ledger_approval_keys', 'SELECT') AS key_read,
           pg_catalog.has_any_column_privilege(current_user, 'public._prisma_migrations', 'INSERT') AS migration_insert,
           pg_catalog.has_any_column_privilege(current_user, 'public._prisma_migrations', 'UPDATE') AS migration_update,
           pg_catalog.has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') AS migration_delete
    FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`);
  const row = rows[0];
  if (rows.length !== 1 || row.role !== expectedRole || row.session_role !== expectedRole
    || row.rolsuper !== false
    || row.rolbypassrls !== false || row.key_read !== false
    || row.migration_insert !== false || row.migration_update !== false
    || row.migration_delete !== false) {
    throw new Error('runtime identity verification failed');
  }
  // The owner-run grants setup checks all reachable roles, object owners and
  // denied table, column, function and schema rights. Reuse those read-only
  // checks so a post-setup membership/grant change cannot evade predeploy.
  if ((await verifyAccess(db, expectedRole)).length > 0) {
    throw new Error('runtime identity verification failed');
  }
}

async function main(): Promise<number> {
  if (process.argv.length !== 2 || !process.env.DATABASE_URL) {
    process.stderr.write('Runtime identity verification failed.\n');
    return 1;
  }
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [] });
  try {
    await db.$transaction((tx) => verifyLedgerRuntimeIdentity(tx, process.env.LEDGER_RUNTIME_ROLE ?? 'playqube_app'),
      { isolationLevel: 'RepeatableRead', timeout: 60_000 });
    process.stdout.write('Runtime identity verified.\n');
    return 0;
  } catch {
    process.stderr.write('Runtime identity verification failed.\n');
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
