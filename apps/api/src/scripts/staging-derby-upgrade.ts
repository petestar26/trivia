/** Additive Thunder Derby upgrade, restricted to the disposable rehearsal database. */
import { PrismaClient } from '@prisma/client';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grantDerbyRuntimeTables } from './derby-runtime-grants.js';
import { assertUsdStagingTarget } from './staging-payment-target.js';
const allowed = ['20261009120000_thunder_derby_practice'];
export async function runDerbyStagingUpgrade(env: NodeJS.ProcessEnv = process.env, apply = false) {
  assertUsdStagingTarget(env);
  const worker = new URL(env.SOCIAL_WORKER_DATABASE_URL ?? 'https://invalid'),
    ownerUrl = new URL(env.DATABASE_URL!);
  if (
    worker.hostname !== ownerUrl.hostname ||
    worker.pathname !== ownerUrl.pathname ||
    (worker.port || '5432') !== (ownerUrl.port || '5432') ||
    !['postgres:', 'postgresql:'].includes(worker.protocol) ||
    !/^[a-z][a-z0-9_]{1,62}$/.test(worker.username)
  )
    throw Error('WORKER_TARGET_REFUSED');
  const roles = [env.PRACTICE_API_ROLE!, worker.username],
    db = new PrismaClient({ log: [], datasources: { db: { url: env.DATABASE_URL } } });
  try {
    const [owner] = await db.$queryRaw<
      { allowed: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
    if (!owner?.allowed) throw Error('OWNER_REQUIRED');
    for (const role of roles) {
      const [safe] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${role} AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) AS allowed`;
      if (!safe?.allowed) throw Error('RUNTIME_ROLE_REFUSED');
    }
    const game = await db.gameDefinition.findUnique({ where: { key: 'thunder_derby_3d' } });
    if (
      !game ||
      game.isActive ||
      game.catalogStatus !== 'COMING_SOON' ||
      game.mode !== 'WAGER' ||
      game.wagerCurrency !== 'COINS' ||
      game.rewardCurrency !== 'COINS'
    )
      throw Error('FINANCIAL_GATE_INVALID');
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

    if (pending.length) {
      if (!apply) throw Error('DERBY_MIGRATION_NOT_APPLIED');
      execFileSync(
        resolve(root, 'packages/database/node_modules/.bin/prisma'),
        ['migrate', 'deploy', '--schema', resolve(root, 'packages/database/prisma/schema.prisma')],
        { cwd: root, stdio: 'pipe', env }
      );
    }
    for (const role of roles) {
      if (apply) await grantDerbyRuntimeTables(db, role);
      const [grants] = await db.$queryRaw<
        { allowed: boolean }[]
      >`SELECT has_column_privilege(${role},'public.derby_rounds','id','UPDATE') AND bool_and(has_table_privilege(${role},'public.'||t,p)) AS allowed FROM (VALUES ('derby_accounts','SELECT'),('derby_accounts','INSERT'),('derby_accounts','UPDATE'),('derby_tickets','SELECT'),('derby_tickets','INSERT'),('derby_tickets','UPDATE'),('derby_rounds','SELECT'),('derby_rounds','INSERT')) AS grants(t,p)`;
      if (!grants?.allowed) throw Error('DERBY_RUNTIME_GRANTS_MISSING');
    }
    console.log(
      JSON.stringify({
        event: 'DERBY_STAGING_READY',
        mode: 'PRACTICE',
        migrations: allowed,
        activationPerformed: false,
      })
    );
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  runDerbyStagingUpgrade(process.env, process.argv.includes('--apply')).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    const reason = /^[A-Z_]{1,64}$/.test(message) ? message : 'OPERATION_FAILED';
    console.error(JSON.stringify({ event: 'DERBY_STAGING_REFUSED', reason }));
    process.exitCode = 1;
  });
