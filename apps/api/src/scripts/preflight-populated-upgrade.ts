/**
 * Read-only preflight: reports every record the populated-upgrade migration
 * gate (run_populated_upgrade_gate, see migration 20260923160000) would stop
 * on, without applying any migration and without changing anything. Run
 * this against a copy of production before a deployment to discover and
 * remediate affected records ahead of time.
 *
 * Usage: pnpm --filter api preflight:populated-upgrade
 */
import { prisma } from '@socialplay/database';
import { runPopulatedUpgradePreflight } from '../economy/ledger-invariant-checker.js';

async function main(): Promise<void> {
  const violations = await runPopulatedUpgradePreflight();
  if (violations.length === 0) {
    console.log('Populated-upgrade preflight: no malformed pre-existing ledger data found.');
    return;
  }
  const byCategory = new Map<string, typeof violations>();
  for (const v of violations) {
    const list = byCategory.get(v.category) ?? [];
    list.push(v);
    byCategory.set(v.category, list);
  }
  console.log(`Populated-upgrade preflight: ${violations.length} violation(s) across ${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'}.`);
  console.log('The deployment migration will stop until every one of these is remediated via the');
  console.log('managed-lot-integrity dual-admin review (see apps/api/src/economy/managed-lot-integrity-service.ts).\n');
  for (const [category, list] of byCategory) {
    console.log(`${category} (${list.length}):`);
    for (const v of list) console.log(`  - ${v.id}: ${v.detail}`);
  }
  process.exitCode = 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
