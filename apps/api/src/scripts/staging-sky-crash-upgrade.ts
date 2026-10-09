/** Additive Sky Crash upgrade, restricted to the disposable rehearsal database. */
import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantSkyCrashRuntimeTables } from './sky-crash-runtime-grants.js';
import { assertUsdStagingTarget } from './staging-payment-target.js';
const allowed = [
  '20261009010000_sky_crash_practice',
  '20261009010100_sky_crash_dual_tickets',
  '20261009010200_sky_crash_catalog',
];
async function run() {
  assertUsdStagingTarget(process.env);
  const worker = new URL(process.env.SOCIAL_WORKER_DATABASE_URL ?? 'https://invalid'),
    ownerUrl = new URL(process.env.DATABASE_URL!);
  if (
    worker.hostname !== ownerUrl.hostname ||
    worker.pathname !== ownerUrl.pathname ||
    !['postgres:', 'postgresql:'].includes(worker.protocol) ||
    !/^[a-z][a-z0-9_]{1,62}$/.test(worker.username)
  )
    throw Error('WORKER_TARGET_REFUSED');
  const roles = [process.env.PRACTICE_API_ROLE!, worker.username],
    db = new PrismaClient({ log: [] });
  try {
    const [owner] = await db.$queryRaw<
      { allowed: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
    if (!owner?.allowed) throw Error('OWNER_REQUIRED');
    const root = fileURLToPath(new URL('../../../../', import.meta.url)),
      dir = resolve(root, 'packages/database/prisma/migrations');
    const applied = await db.$queryRaw<
      {
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }[]
    >`SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations`;
    if (applied.some((r) => !r.finished_at && !r.rolled_back_at)) throw Error('FAILED_MIGRATION');
    const complete = new Map(
        applied.filter((r) => r.finished_at).map((r) => [r.migration_name, r.checksum])
      ),
      names = readdirSync(dir)
        .filter((n) => /^\d{14}_/.test(n))
        .sort();
    for (const [name, checksum] of complete)
      if (
        !names.includes(name) ||
        createHash('sha256')
          .update(readFileSync(resolve(dir, name, 'migration.sql')))
          .digest('hex') !== checksum
      )
        throw Error('MIGRATION_HISTORY_MISMATCH');
    const pending = names.filter((n) => !complete.has(n));
    if (pending.some((n) => !allowed.includes(n))) throw Error('UNRELATED_PENDING_MIGRATION');
    const apply = process.argv.includes('--apply');
    if (pending.length) {
      if (!apply) throw Error('SKY_CRASH_MIGRATION_NOT_APPLIED');
      execFileSync(
        resolve(root, 'packages/database/node_modules/.bin/prisma'),
        ['migrate', 'deploy', '--schema', resolve(root, 'packages/database/prisma/schema.prisma')],
        { cwd: root, stdio: 'pipe', env: process.env }
      );
    }
    for (const role of roles) {
      const [safe] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role} AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) AS allowed`;
      if (!safe?.allowed) throw Error('RUNTIME_ROLE_REFUSED');
      if (apply) await grantSkyCrashRuntimeTables(db, role);
      const [grants] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT has_column_privilege(${role},'public.sky_crash_rounds','id','UPDATE') AND bool_and(has_table_privilege(${role},'public.'||t,p)) AS allowed FROM (VALUES ('sky_crash_accounts','SELECT'),('sky_crash_accounts','INSERT'),('sky_crash_accounts','UPDATE'),('sky_crash_tickets','SELECT'),('sky_crash_tickets','INSERT'),('sky_crash_tickets','UPDATE'),('sky_crash_rounds','SELECT'),('sky_crash_rounds','INSERT')) AS grants(t,p)`;
      if (!grants?.allowed) throw Error('SKY_CRASH_RUNTIME_GRANTS_MISSING');
    }
    const game = await db.gameDefinition.findUnique({ where: { key: 'sky_crash' } });
    if (!game || game.isActive || game.catalogStatus !== 'COMING_SOON')
      throw Error('FINANCIAL_GATE_INVALID');
    console.log(
      JSON.stringify({
        event: 'SKY_CRASH_STAGING_READY',
        mode: 'PRACTICE',
        migrations: allowed,
        financialPlay: false,
        cryptoPayments: false,
      })
    );
  } finally {
    await db.$disconnect();
  }
}
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const reason = /^[A-Z_]{1,64}$/.test(message) ? message : 'OPERATION_FAILED';
  console.error(JSON.stringify({ event: 'SKY_CRASH_STAGING_REFUSED', reason }));
  process.exitCode = 1;
});
