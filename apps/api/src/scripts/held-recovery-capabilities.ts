import type { Prisma } from '@prisma/client';

/** Required even while financial outcomes are disabled: deposit admission reads
 * the policy, and the nonfinancial case workflow remains available. */
export const HELD_TABLE_CAPABILITIES = [
  ['held_deposit_recovery_policy', 'SELECT'],
  ['held_deposit_cases', 'SELECT'], ['held_deposit_cases', 'INSERT'],
  ['held_deposit_case_events', 'SELECT'], ['held_deposit_case_events', 'INSERT'],
  ['held_deposit_adjudications', 'SELECT'], ['held_deposit_adjudications', 'INSERT'],
  ['held_deposit_reference_claims', 'SELECT'], ['held_deposit_reference_claims', 'INSERT'],
] as const;

// Key UPDATE is deliberately not required; the grant routine protects keys
// followed by foreign keys with column-level rather than table-level UPDATE.
export const HELD_CASE_UPDATE_COLUMNS = [
  'status', 'classification', 'memberDeclaration', 'memberDeclaredAt',
  'assignedAdminId', 'assignedAt', 'updatedAt',
] as const;

/** Metadata reads only. Owner setup can still service historical fixtures;
 * current-release predeploy must pass requireInstalled=true and fail closed. */
export async function verifyHeldRecoveryCapabilities(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>, role: string, requireInstalled: boolean,
): Promise<string[]> {
  const failures: string[] = [];
  for (const [table, privilege] of HELD_TABLE_CAPABILITIES) {
    const [row] = await tx.$queryRaw<{ installed: boolean; granted: boolean | null }[]>`
      SELECT to_regclass(${'public.' + table}) IS NOT NULL AS installed,
        has_table_privilege(${role}, to_regclass(${'public.' + table}), ${privilege}) AS granted`;
    if (!row || (requireInstalled && row.installed !== true)
      || ((requireInstalled || row.installed) && row.granted !== true)) {
      failures.push(`${role} lacks ${privilege} on ${table}, which held-deposit recovery needs`);
    }
  }
  for (const column of HELD_CASE_UPDATE_COLUMNS) {
    const [row] = await tx.$queryRaw<{ installed: boolean; granted: boolean | null }[]>`
      SELECT to_regclass('public.held_deposit_cases') IS NOT NULL AS installed,
        has_column_privilege(${role}, to_regclass('public.held_deposit_cases'), ${column}, 'UPDATE') AS granted`;
    if (!row || (requireInstalled && row.installed !== true)
      || ((requireInstalled || row.installed) && row.granted !== true)) {
      failures.push(`${role} cannot update held_deposit_cases.${column}, which held-deposit recovery needs`);
    }
  }
  return failures;
}
