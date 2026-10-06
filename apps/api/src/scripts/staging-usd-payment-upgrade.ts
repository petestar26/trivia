/** Additive upgrade for the already-authorized disposable staging database only. */
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MIGRATIONS = [
  '20261004120000_usd_payment_pricing',
  '20261004121000_usd_pricing_guard_paths',
  '20261004122000_usd_activation_guard_path',
  '20261005130000_admin_agent_onboarding',
];

import { assertUsdStagingTarget } from './staging-payment-target.js';
export { assertUsdStagingTarget } from './staging-payment-target.js';

export async function runUsdStagingUpgrade(apply: boolean) {
  assertUsdStagingTarget(process.env);
  const db = new PrismaClient({ log: [] });
  try {
    const [owner] = await db.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid=d.datdba
        WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
    if (!owner?.allowed) throw new Error('DATABASE_OWNER_REQUIRED');
    const root = fileURLToPath(new URL('../../../../', import.meta.url));
    const migrations = resolve(root, 'packages/database/prisma/migrations');
    const applied = await db.$queryRaw<
      Array<{
        migration_name: string;
        checksum: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
      }>
    >`
      SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations`;
    if (applied.some((r) => !r.finished_at && !r.rolled_back_at))
      throw new Error('FAILED_MIGRATION_REQUIRES_REVIEW');
    const complete = new Map(
      applied.filter((r) => r.finished_at).map((r) => [r.migration_name, r.checksum])
    );
    const names = readdirSync(migrations)
      .filter((n) => /^\d{14}_/.test(n))
      .sort();
    for (const [name, checksum] of complete) {
      if (
        !names.includes(name) ||
        createHash('sha256')
          .update(readFileSync(resolve(migrations, name, 'migration.sql')))
          .digest('hex') !== checksum
      ) {
        throw new Error('MIGRATION_HISTORY_MISMATCH');
      }
    }
    const pending = names.filter((n) => !complete.has(n));
    if (pending.some((n) => !MIGRATIONS.includes(n)))
      throw new Error('UNRELATED_PENDING_MIGRATION');
    if (apply && pending.length) {
      execFileSync(
        resolve(root, 'packages/database/node_modules/.bin/prisma'),
        ['migrate', 'deploy', '--schema', resolve(root, 'packages/database/prisma/schema.prisma')],
        { cwd: root, stdio: 'pipe', env: process.env }
      );
    } else if (pending.length) throw new Error('USD_MIGRATION_NOT_APPLIED');
    const role = process.env.PRACTICE_API_ROLE!; // Identifier validated before connecting.
    if (apply) {
      await db.$executeRawUnsafe(
        `GRANT EXECUTE ON FUNCTION public.activate_provisioned_agent(text,text,text) TO "${role}"`
      );
      await db.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE ON public.agent_account_setups TO "${role}"`
      );
      // Only new configuration surfaces. Existing role and credentials remain unchanged.
      await db.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE ON public.coin_packages TO "${role}"`
      );
      // Countries use column-specific UPDATE grants to protect cascade keys.
      await db.$executeRawUnsafe(
        `GRANT UPDATE ("usdPricingEnabled") ON public.countries TO "${role}"`
      );
    }
    const [access] = await db.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT pg_catalog.has_table_privilege(${role}, 'public.coin_packages', 'SELECT')
        AND pg_catalog.has_table_privilege(${role}, 'public.coin_packages', 'INSERT')
        AND pg_catalog.has_table_privilege(${role}, 'public.coin_packages', 'UPDATE')
        AND pg_catalog.has_column_privilege(${role}, 'public.countries', 'usdPricingEnabled', 'UPDATE') AS allowed`;
    if (!access?.allowed) throw new Error('PACKAGE_RUNTIME_GRANTS_MISSING');
    const [onboarding] = await db.$queryRaw<
      Array<{ allowed: boolean }>
    >`SELECT pg_catalog.has_table_privilege(${role}, 'public.agent_account_setups', 'SELECT') AND pg_catalog.has_table_privilege(${role}, 'public.agent_account_setups', 'INSERT') AND pg_catalog.has_table_privilege(${role}, 'public.agent_account_setups', 'UPDATE') AND pg_catalog.has_function_privilege(${role}, 'public.activate_provisioned_agent(text,text,text)', 'EXECUTE') AS allowed`;
    if (!onboarding?.allowed) throw new Error('AGENT_ONBOARDING_GRANTS_MISSING');
    const [schema] = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM information_schema.columns WHERE table_schema='public' AND
      ((table_name='countries' AND column_name='usdPricingEnabled') OR
       (table_name='exchange_rate_configs' AND column_name='pricingPolicy') OR
       (table_name IN ('agent_orders','withdrawal_quotes','withdrawals') AND column_name='pricingSnapshot'))`;
    if (schema?.count !== 5n) throw new Error('USD_SCHEMA_INCOMPLETE');
    console.log(
      JSON.stringify({
        status: 'USD_STAGING_SCHEMA_VERIFIED',
        migrations: MIGRATIONS,
        applied: apply,
        enabledPaymentCountries: await db.country.count({
          where: { isActive: true, agentPaymentEnabled: true },
        }),
        packages: await db.coinPackage.count(),
      })
    );
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--apply', '--verify'].includes(mode ?? '')) {
    console.error('Use --apply or --verify');
    process.exitCode = 1;
  } else {
    runUsdStagingUpgrade(mode === '--apply').catch(() => {
      // Driver/CLI messages can contain connection strings; never emit them.
      console.error(
        'USD staging upgrade refused or failed; inspect the migration state with the owner.'
      );
      process.exitCode = 1;
    });
  }
}
