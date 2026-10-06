/** Additive Crash Point upgrade, restricted to the disposable rehearsal database. */
import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertUsdStagingTarget } from './staging-payment-target.js';
const allowed = [
  '20261006190000_crash_point_practice',
  '20261006190100_crash_point_catalog',
  '20261006210000_crash_point_dual_tickets',
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
      if (!apply) throw Error('CRASH_MIGRATION_NOT_APPLIED');
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
      if (apply) {
        await db.$executeRawUnsafe(
          `GRANT SELECT,INSERT,UPDATE ON public.crash_point_accounts,public.crash_point_tickets TO "${role}"`
        );
        await db.$executeRawUnsafe(`GRANT SELECT,INSERT ON public.crash_point_rounds TO "${role}"`);
      }
      const [grants] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT bool_and(has_table_privilege(${role},'public.'||t,p)) AS allowed FROM (VALUES ('crash_point_accounts','SELECT'),('crash_point_accounts','INSERT'),('crash_point_accounts','UPDATE'),('crash_point_tickets','SELECT'),('crash_point_tickets','INSERT'),('crash_point_tickets','UPDATE'),('crash_point_rounds','SELECT'),('crash_point_rounds','INSERT')) AS grants(t,p)`;
      if (!grants?.allowed) throw Error('CRASH_RUNTIME_GRANTS_MISSING');
    }
    const game = await db.gameDefinition.findUnique({ where: { key: 'crash_point' } });
    if (!game || game.isActive || game.catalogStatus !== 'COMING_SOON')
      throw Error('FINANCIAL_GATE_INVALID');
    console.log(
      JSON.stringify({
        event: 'CRASH_POINT_STAGING_READY',
        mode: 'PRACTICE',
        migrations: allowed,
        financialPlay: false,
      })
    );
  } finally {
    await db.$disconnect();
  }
}
run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '';
  const reason = /^[A-Z_]{1,64}$/.test(message) ? message : 'OPERATION_FAILED';
  console.error(JSON.stringify({ event: 'CRASH_POINT_STAGING_REFUSED', reason }));
  process.exitCode = 1;
});
