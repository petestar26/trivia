import { prisma } from '@socialplay/database';
import { runLedgerInvariantCheckInTransaction } from './ledger-invariant-checker.js';

/**
 * Test-only database bootstrap. It records a genuine DB invariant scan and
 * opens only the three G0 gates needed by API integration tests. It never
 * asserts that the full API suite or mutation suite has passed, and cannot
 * target a non-test database.
 */
export async function bootstrapLedgerTestGates(): Promise<string> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Ledger test gate bootstrap requires NODE_ENV=test');
  }
  let hostname: string;
  try {
    hostname = new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    throw new Error('Ledger test gate bootstrap requires a database URL');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('Ledger test gate bootstrap requires loopback PostgreSQL');
  }
  return prisma.$transaction(async (tx) => {
    const database = (await tx.$queryRaw`SELECT current_database() AS name`) as { name: string }[];
    const databaseName = database[0]?.name ?? '';
    const namedLedgerTest = /^ledger_test(?:_|$)/.test(databaseName);
    const namedThrowaway = /^playqube_[a-z0-9_]+_throwaway$/.test(databaseName) &&
      process.env.TEST_LEDGER_DB_NAME === databaseName;
    if (!namedLedgerTest && !namedThrowaway) {
      throw new Error('Ledger test gate bootstrap requires a ledger_test database or the exact named throwaway database');
    }
    const keys = ['BONUS_GRANT', 'CASINO_PLAY', 'WITHDRAWAL_CREATE'];
    await tx.$queryRaw`
      SELECT "key" FROM "platform_gates" WHERE "key" IN
        ('BONUS_GRANT','CASINO_PLAY','WITHDRAWAL_CREATE')
      ORDER BY "key" FOR UPDATE
    `;
    await tx.$executeRawUnsafe(`LOCK TABLE
      "wallets", "wallet_transactions", "coin_provenance", "coin_lot_entries",
      "economic_operations", "coin_ledger_accounts", "legacy_balance_reviews",
      "withdrawal_holds", "country_jurisdictions", "country_casino_policies",
      "game_sessions" IN SHARE MODE`);
    const run = await runLedgerInvariantCheckInTransaction(tx, null, false);
    if (!run.passed) {
      throw new Error(`Ledger test DB invariant scan failed: ${JSON.stringify(run.violations)}`);
    }
    for (const key of keys) {
      await tx.platformGate.update({ where: { key }, data: {
        enabled: true, lastInvariantRunId: run.runId, changedBy: 'TEST_BOOTSTRAP',
        changedAt: new Date(),
      } });
    }
    return run.runId;
  }, { isolationLevel: 'Serializable', timeout: 120_000 });
}
