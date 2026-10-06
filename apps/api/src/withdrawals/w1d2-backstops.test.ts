import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL(
    '../../../../packages/database/prisma/migrations/20260904030000_w1d2_withdrawal_lifecycle_backstops/migration.sql',
    import.meta.url
  )
);
const sql = readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ');

const requiredChecks: Record<string, string[]> = {
  withdrawal_settlements_outcome_refund_coherence_check: [
    `"outcome" = 'COMPLETED' AND "refundWalletTransactionId" IS NULL`,
    `"outcome" = 'CANCELLED'`,
    `"refundWalletTransactionId" IS NOT NULL`,
    `"resolvedVia" = 'ADMIN_DISPUTE_RESOLUTION'`,
    `"disputeId" IS NOT NULL`,
  ],
  withdrawal_holds_status_metadata_coherence_check: [
    `"status" = 'ACTIVE'`,
    `"status" = 'CONSUMED'`,
    `"status" = 'REFUNDED'`,
    `"consumedAt" IS NOT NULL`,
    `"releasedAt" IS NOT NULL`,
    `"refundWalletTransactionId" IS NOT NULL`,
  ],
  withdrawal_reservations_status_metadata_coherence_check: [
    `"status" = 'ACTIVE'`,
    `"status" = 'RELEASED'`,
    `"status" = 'CONSUMED'`,
    `"releasedAt" IS NOT NULL`,
    `"consumedAt" IS NOT NULL`,
  ],
  withdrawal_disputes_status_metadata_coherence_check: [
    `"status" = 'OPEN'`,
    `"status" = 'ASSIGNED'`,
    `"status" = 'RESOLVED'`,
    `"assignedAdminId" IS NOT NULL`,
    `"resolution" IS NOT NULL`,
    `"resolvedBy" = "assignedAdminId"`,
  ],
  withdrawal_disputes_chronology_check: [
    `"assignedAt" >= "openedAt"`,
    `"resolvedAt" >= "assignedAt"`,
  ],
  withdrawal_submissions_admin_verified_timestamp_check: [
    `"source" <> 'ADMIN_VERIFIED' OR "paymentOccurredAt" IS NOT NULL`,
  ],
  withdrawal_settlements_positive_amounts_check: [`"coinAmount" > 0 AND "fiatAmount" > 0`],
  withdrawals_coin_amount_upper_bound_check: [`"coinAmount" <= 1000000000`],
  withdrawal_holds_coin_amount_upper_bound_check: [`"coinAmount" <= 1000000000`],
  withdrawal_settlements_coin_amount_upper_bound_check: [`"coinAmount" <= 1000000000`],
  withdrawals_terminal_timestamp_coherence_check: [
    `"status" <> 'DISPUTED' OR "disputedAt" IS NOT NULL`,
    `"status" <> 'COMPLETED' OR "completedAt" IS NOT NULL`,
    `"status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL`,
  ],
  agent_fiat_liquidity_ledger_terminal_arithmetic_check: [
    `"type" NOT IN ('RELEASE', 'CONSUME')`,
    `"reservedAfter" = "reservedBefore" - "amount"`,
    `"type" = 'RELEASE' AND "totalAfter" = "totalBefore"`,
    `"type" = 'CONSUME' AND "totalAfter" = "totalBefore" - "amount"`,
  ],
};

function addedCheck(name: string): string {
  const match = sql.match(new RegExp(`ADD CONSTRAINT "${name}" CHECK \\(([\\s\\S]*?)\\) NOT VALID;`));
  expect(match, `${name} must be added as CHECK (...) NOT VALID`).not.toBeNull();
  return match![1];
}

describe('W-1D2 lifecycle backstop migration contract', () => {
  it('adds every required predicate as a NOT VALID check', () => {
    for (const [name, fragments] of Object.entries(requiredChecks)) {
      const predicate = addedCheck(name);
      for (const fragment of fragments) expect(predicate, `${name}: ${fragment}`).toContain(fragment);
    }
  });

  it('validates every required check exactly once', () => {
    for (const name of Object.keys(requiredChecks)) {
      const validations = sql.match(new RegExp(`VALIDATE CONSTRAINT "${name}";`, 'g')) ?? [];
      expect(validations, name).toHaveLength(1);
    }
  });
});
