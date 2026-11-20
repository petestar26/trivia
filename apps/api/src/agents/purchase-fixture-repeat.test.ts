// Regression: the purchase fixture must be callable repeatedly in one database.
//
// v7-derived-typefix-1 gave every fixture purchase's receiving method the same
// name on the shared ZLP test country. The second call in a database then hit
// the (countryId, type, name) unique key, failing the native payments and Play
// Together suites. Each call must instead create its own approved receiving
// destination, credit exactly once, and leave the uniqueness rule intact.
//
// Native PostgreSQL test: like the other financial suites, it fails hard when
// the database is unreachable rather than reporting a skipped green run.
import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { mintTestPurchasedCoins } from '../test/financial-policy-fixtures.js';

try {
  await prisma.$queryRaw`SELECT 1`;
} catch (err) {
  throw new Error(
    'Purchase fixture regression requires a reachable Postgres database: ' + (err as Error)?.message
  );
}

afterAll(async () => {
  await prisma.$disconnect();
});

async function recipient() {
  const tag = randomUUID().replaceAll('-', '').slice(0, 14);
  return prisma.user.create({
    data: {
      email: `purchase-fixture-${tag}@test.local`,
      username: `pfx_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: 'Purchase fixture regression',
    },
  });
}

describe('mintTestPurchasedCoins called repeatedly in one database', () => {
  it('creates a distinct approved receiving destination for every call', async () => {
    const first = await recipient();
    const second = await recipient();
    const scopes = [randomUUID(), randomUUID(), randomUUID()];

    // Same recipient twice, then another recipient: all share the ZLP country.
    await mintTestPurchasedCoins(first.id, 1_000, scopes[0]);
    await mintTestPurchasedCoins(first.id, 2_000, scopes[1]);
    await mintTestPurchasedCoins(second.id, 3_000, scopes[2]);

    const orders = await prisma.agentOrder.findMany({ where: { id: { in: scopes } } });
    expect(orders).toHaveLength(3);
    expect(new Set(orders.map((o) => o.paymentMethodDefId)).size).toBe(3);
    expect(new Set(orders.map((o) => o.paymentAccountId)).size).toBe(3);

    const methods = await prisma.paymentMethodDefinition.findMany({
      where: { id: { in: orders.map((o) => o.paymentMethodDefId) } },
      include: { country: { select: { code: true } } },
    });
    expect(methods).toHaveLength(3);
    expect(new Set(methods.map((m) => m.name)).size).toBe(3);
    for (const method of methods) {
      expect(method.country.code).toBe('ZLP');
      expect(method.type).toBe('BANK_TRANSFER');
      expect(method.name.startsWith('Synthetic receiving method ')).toBe(true);
    }

    for (const order of orders) {
      // The receiving-destination trigger accepted the order and stamped the
      // approved revision it was created against.
      expect(order.status).toBe('COMPLETED');
      expect(order.paymentAccountRevision).toBe(1);
      expect(order.safetyHold).toBe(false);
      const account = await prisma.agentPaymentAccount.findUniqueOrThrow({
        where: { id: order.paymentAccountId },
      });
      expect(account).toMatchObject({
        status: 'APPROVED',
        approvedRevision: 1,
        safetyHold: false,
        agentId: order.agentId,
        countryId: order.countryId,
        methodDefId: order.paymentMethodDefId,
      });
      const revisions = await prisma.agentPaymentAccountRevision.findMany({
        where: { accountId: account.id },
      });
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        revision: 1,
        agentId: order.agentId,
        countryId: order.countryId,
        methodDefId: order.paymentMethodDefId,
      });
    }

    // Each call credited exactly once.
    const wallets = await prisma.wallet.findMany({
      where: { userId: { in: [first.id, second.id] } },
    });
    const balance = (userId: string) => wallets.find((w) => w.userId === userId)?.coinsBalance;
    expect(balance(first.id)).toBe(3_000);
    expect(balance(second.id)).toBe(3_000);
  });

  it('keeps the (country, type, name) uniqueness rule for payment methods', async () => {
    const user = await recipient();
    const scope = randomUUID();
    await mintTestPurchasedCoins(user.id, 500, scope);
    const order = await prisma.agentOrder.findUniqueOrThrow({ where: { id: scope } });
    const method = await prisma.paymentMethodDefinition.findUniqueOrThrow({
      where: { id: order.paymentMethodDefId },
    });

    await expect(
      prisma.paymentMethodDefinition.create({
        data: {
          countryId: method.countryId,
          type: method.type,
          name: method.name,
          fieldSchema: { requiredFields: [] },
        },
      })
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await prisma.paymentMethodDefinition.count({
        where: { countryId: method.countryId, type: method.type, name: method.name },
      })
    ).toBe(1);
  });
});
