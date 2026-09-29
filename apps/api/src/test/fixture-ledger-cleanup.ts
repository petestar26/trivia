import { Prisma } from '@prisma/client';
import { prisma } from '@socialplay/database';

// Test files have long-standing deleteMany fixture teardown. The production
// financial journal is append-only, so those deletes need a test-only bridge.
// Nothing here runs in the application or outside this scratch Vitest config.
const expectedDatabase = process.env.TEST_LEDGER_DB_NAME;
let checkedDatabase = false;

async function assertThrowawayDatabase(): Promise<void> {
  if (checkedDatabase) return;
  if (!expectedDatabase || !/^playqube_[a-z0-9_]+_throwaway$/.test(expectedDatabase)) {
    throw new Error('TEST_LEDGER_DB_NAME must name an explicit playqube_*_throwaway database');
  }
  const targetHost = new URL(process.env.DATABASE_URL ?? '').hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(targetHost)) {
    throw new Error('Fixture cleanup requires a loopback PostgreSQL server');
  }
  const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  if (rows[0]?.name !== expectedDatabase) {
    throw new Error(`Fixture cleanup refused for database ${rows[0]?.name ?? '<unknown>'}`);
  }
  checkedDatabase = true;
}

function idsFromUserFilter(filter: unknown): string[] {
  if (typeof filter === 'string') return [filter];
  if (!filter || typeof filter !== 'object') return [];
  const selector = filter as { in?: unknown; equals?: unknown };
  if (typeof selector.equals === 'string') return [selector.equals];
  return Array.isArray(selector.in)
    ? selector.in.filter((value): value is string => typeof value === 'string')
    : [];
}

async function affectedUserIds(model: string, where: unknown): Promise<string[]> {
  const selector = where && typeof where === 'object'
    ? where as Record<string, unknown> : {};
  if (model === 'User') return idsFromUserFilter(selector.id);
  if (selector.userId !== undefined) return idsFromUserFilter(selector.userId);
  if (model === 'WalletTransaction') {
    if (selector.walletId !== undefined) {
      const walletIds = idsFromUserFilter(selector.walletId);
      if (!walletIds.length) return [];
      const wallets = await prisma.wallet.findMany({
        where: { id: { in: walletIds } }, select: { userId: true },
      });
      return wallets.map((wallet) => wallet.userId);
    }
  }
  throw new Error(`Unscoped ${model} fixture purge refused`);
}

async function purgeFixtureFinancialHistory(userIds: string[]): Promise<void> {
  const unique = [...new Set(userIds)];
  if (!unique.length) return;
  await assertThrowawayDatabase();
  await prisma.$transaction(async (tx) => {
    // SET LOCAL is automatically restored by COMMIT/ROLLBACK. Only this
    // teardown transaction skips append-only/FK triggers; ordinary test
    // transactions still exercise every production ledger constraint.
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    const ids = Prisma.join(unique);
    // Only the synthetic TP-* orders created by mintTestPurchasedCoins belong
    // to this fixture bridge. Remove their entire settled witness graph before
    // legacy test teardown attempts to delete the buyer User row.
    const fixtureAgents = await tx.$queryRaw<{ agentId: string; agentUserId: string }[]>`
      SELECT DISTINCT a."id" AS "agentId", a."userId" AS "agentUserId"
      FROM "agent_orders" o JOIN "agents" a ON a."id"=o."agentId"
      WHERE o."userId" IN (${ids}) AND o."orderNumber" LIKE 'TP-%'
    `;
    await tx.$executeRaw`
      DELETE FROM "agent_order_settlements" WHERE "orderId" IN
        (SELECT "id" FROM "agent_orders" WHERE "userId" IN (${ids}) AND "orderNumber" LIKE 'TP-%')
    `;
    await tx.$executeRaw`
      DELETE FROM "agent_reservations" WHERE "orderId" IN
        (SELECT "id" FROM "agent_orders" WHERE "userId" IN (${ids}) AND "orderNumber" LIKE 'TP-%')
    `;
    await tx.$executeRaw`
      DELETE FROM "agent_orders" WHERE "userId" IN (${ids}) AND "orderNumber" LIKE 'TP-%'
    `;
    if (fixtureAgents.length) {
      const agentIds = Prisma.join(fixtureAgents.map((row) => row.agentId));
      const agentUserIds = Prisma.join(fixtureAgents.map((row) => row.agentUserId));
      await tx.$executeRaw`DELETE FROM "agents" WHERE "id" IN (${agentIds})`;
      await tx.$executeRaw`DELETE FROM "users" WHERE "id" IN (${agentUserIds})`;
    }
    // Coin adjustment approvals are append-only and name the adjusted user.
    await tx.$executeRaw`DELETE FROM "admin_adjustment_approvals" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "coin_lot_entries" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "coin_allocations" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "legacy_balance_reviews" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "coin_provenance" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "economic_operations" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "coin_ledger_accounts" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "user_kyc_verifications" WHERE "userId" IN (${ids})`;
    await tx.$executeRaw`DELETE FROM "wallet_transactions" WHERE "userId" IN (${ids})`;
    // Committed game sessions are append-only replay records too.
    await tx.$executeRaw`DELETE FROM "game_sessions" WHERE "userId" IN (${ids})`;
  });
}

/** Deleting a challenge would SET NULL its sessions' challengeId, an update
 * the session immutability guard refuses: remove those sessions first. */
async function purgeFixtureChallengeSessions(where: unknown): Promise<void> {
  const challenges = await prisma.gameChallenge.findMany({
    where: where as Prisma.GameChallengeWhereInput, select: { id: true, challengerId: true, challengedId: true },
  });
  if (!challenges.length) return;
  await assertThrowawayDatabase();
  const challengeIds = Prisma.join(challenges.map((challenge) => challenge.id));
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRaw`DELETE FROM "game_sessions" WHERE "challengeId" IN (${challengeIds})`;
  });
}

prisma.$use(async (params, next) => {
  if (params.model === 'AgentOrderSettlement' && params.action === 'deleteMany') {
    const where = params.args?.where as Record<string, unknown> | undefined;
    if (!where || (!where.orderId && !where.order)) {
      throw new Error('Unscoped AgentOrderSettlement fixture purge refused');
    }
    await assertThrowawayDatabase();
    const rows = await prisma.agentOrderSettlement.findMany({
      where: params.args?.where, select: { id: true },
    });
    if (!rows.length) return { count: 0 };
    const settlementIds = Prisma.join(rows.map((row) => row.id));
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      return { count: await tx.$executeRaw`
        DELETE FROM "agent_order_settlements" WHERE "id" IN (${settlementIds})
      ` };
    });
  }
  if (params.action === 'deleteMany' && params.model === 'GameChallenge') {
    await purgeFixtureChallengeSessions(params.args?.where);
  }
  if (params.action === 'deleteMany' &&
      ['WalletTransaction', 'CoinAllocation', 'CoinProvenance', 'User', 'GameSession'].includes(params.model ?? '')) {
    const userIds = await affectedUserIds(params.model!, params.args?.where);
    await purgeFixtureFinancialHistory(userIds);
  }
  return next(params);
});
