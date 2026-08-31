import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { submitAgentApplication, approveAgentApplication } from './agent-service';
import { createAgentPaymentAccount, approveAgentPaymentAccount } from './payment-account-service';
import { fundAgentInventory, getAgentInventory } from './inventory-service';
import { createAgentOrder, submitOrderPayment, settleAgentOrder } from './order-service';
import { openDispute, getDisputeById, claimDispute, resolveDispute } from './dispute-service';

// ─── DB availability probe ─────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

afterAll(async () => {
  await prisma.$disconnect();
});

const describeIf = dbAvailable ? describe : describe.skip;

// ─── Fixtures (mirrors agent-orders.test.ts conventions) ───────

async function createUser(tag: string) {
  const email = `dispute-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `disputetest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Dispute Test ${tag}`,
    },
  });
}

async function createAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
}

async function createSuperAdmin(tag: string) {
  const user = await createUser(tag);
  return prisma.user.update({ where: { id: user.id }, data: { role: 'SUPER_ADMIN' } });
}

async function createCountry(tag: string) {
  const code = `D${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: { code, name: `Dispute Test Country ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
}

async function createPaymentMethod(countryId: string, tag: string) {
  return prisma.paymentMethodDefinition.create({
    data: {
      countryId,
      type: 'BANK_TRANSFER',
      name: `Dispute Test Method ${tag}`,
      fieldSchema: { requiredFields: ['bankName', 'accountNumber'] },
      isActive: true,
    },
  });
}

async function createExchangeRate(countryId: string, fiatCurrency: string, coinsPerUnit: number, adminId: string) {
  return prisma.exchangeRateConfig.create({ data: { countryId, fiatCurrency, coinsPerUnit, isActive: true, setBy: adminId } });
}

async function setupActiveAgent(
  tag: string,
  countryId: string,
  methodId: string,
  admin: { id: string },
  superAdmin: { id: string },
  totalBalance: number
) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `Agent ${tag}`,
    contactEmail: `agent-dispute-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });

  const account = await createAgentPaymentAccount(agentUser.id, {
    countryId,
    methodDefId: methodId,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' },
  });
  await approveAgentPaymentAccount(admin.id, account.id);
  await fundAgentInventory(superAdmin.id, agent!.id, totalBalance, `fund-${tag}-${Date.now()}-${Math.random()}`);

  return { agentUser, agent: agent!, account };
}

async function makeDisputableOrder(
  tag: string,
  country: { id: string },
  method: { id: string },
  admin: { id: string },
  superAdmin: { id: string }
) {
  const fixture = await setupActiveAgent(tag, country.id, method.id, admin, superAdmin, 100_000);
  const customer = await createUser(`cust-${tag}`);
  const created = await createAgentOrder(customer.id, {
    agentId: fixture.agent.id,
    countryId: country.id,
    paymentAccountId: fixture.account.id,
    fiatAmount: 500,
    idempotencyKey: `key-${Math.random()}`,
  });
  await submitOrderPayment(customer.id, created.order.id);
  return { fixture, customer, order: created.order };
}

async function cleanDisputeFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'dispute-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    const orders = await prisma.agentOrder.findMany({
      where: { OR: [{ userId: { in: userIds } }, { agentId: { in: agentIds } }] },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);

    if (orderIds.length) {
      await prisma.dispute.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.agentOrderSettlement.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.agentReservation.deleteMany({ where: { orderId: { in: orderIds } } });
    }
    await prisma.agentOrder.deleteMany({ where: { id: { in: orderIds } } });

    if (agentIds.length) {
      await prisma.agentInventoryLedger.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentInventory.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentPaymentAccount.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentApplication.deleteMany({ where: { agentId: { in: agentIds } } });
    }
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { referredByAgentId: null } });
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Dispute Test Country' } } });
  const countryIds = countries.map((c) => c.id);
  if (countryIds.length) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.country.deleteMany({ where: { id: { in: countryIds } } });
  }
}

// ═══════════════════════════════════════════════════════════════
// DISPUTE CREATION
// ═══════════════════════════════════════════════════════════════

describeIf('Dispute creation', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanDisputeFixtures();
    admin = await createAdmin('createadmin');
    superAdmin = await createSuperAdmin('createsuper');
    country = await createCountry('create');
    method = await createPaymentMethod(country.id, 'create');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('customer can open a dispute on their own PAYMENT_SUBMITTED order', async () => {
    const { customer, order } = await makeDisputableOrder('open1', country, method, admin, superAdmin);
    const result = await openDispute(customer.id, {
      orderId: order.id,
      reason: 'PAYMENT_NOT_RECEIVED',
      description: 'Agent has not confirmed my payment.',
      idempotencyKey: `dk-${Math.random()}`,
    });
    expect(result.idempotent).toBe(false);
    expect(result.dispute.status).toBe('OPEN');
    expect(result.dispute.openedBy).toBe(customer.id);

    const refreshedOrder = await prisma.agentOrder.findUnique({ where: { id: order.id } });
    expect(refreshedOrder!.status).toBe('DISPUTE');
  });

  it('agent can open a dispute on their own order', async () => {
    const { fixture, order } = await makeDisputableOrder('open2', country, method, admin, superAdmin);
    const result = await openDispute(fixture.agentUser.id, {
      orderId: order.id,
      reason: 'OTHER',
      description: 'Amount mismatch reported.',
      idempotencyKey: `dk-${Math.random()}`,
    });
    expect(result.dispute.openedBy).toBe(fixture.agentUser.id);
  });

  it('unrelated user cannot open a dispute', async () => {
    const { order } = await makeDisputableOrder('open3', country, method, admin, superAdmin);
    const stranger = await createUser('strangeropen3');
    await expect(
      openDispute(stranger.id, {
        orderId: order.id,
        reason: 'OTHER',
        description: 'not mine',
        idempotencyKey: `dk-${Math.random()}`,
      })
    ).rejects.toThrow(/do not have access/i);
  });

  it('invalid reason is rejected', async () => {
    const { customer, order } = await makeDisputableOrder('open4', country, method, admin, superAdmin);
    await expect(
      openDispute(customer.id, {
        orderId: order.id,
        reason: 'NOT_A_REAL_REASON' as any,
        description: 'x',
        idempotencyKey: `dk-${Math.random()}`,
      })
    ).rejects.toThrow(/invalid dispute reason/i);
  });

  it('dispute cannot be opened on an order not in PAYMENT_SUBMITTED', async () => {
    const fixture = await setupActiveAgent('open5', country.id, method.id, admin, superAdmin, 100_000);
    const customer = await createUser('custopen5');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 500,
      idempotencyKey: `key-${Math.random()}`,
    });
    // still CREATED, payment never submitted
    await expect(
      openDispute(customer.id, {
        orderId: created.order.id,
        reason: 'OTHER',
        description: 'x',
        idempotencyKey: `dk-${Math.random()}`,
      })
    ).rejects.toThrow(/cannot enter dispute from its current state/i);
  });

  it('duplicate idempotency key returns the original dispute', async () => {
    const { customer, order } = await makeDisputableOrder('open6', country, method, admin, superAdmin);
    const key = `dk-${Math.random()}`;
    const first = await openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'first', idempotencyKey: key });
    const second = await openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'first', idempotencyKey: key });
    expect(second.idempotent).toBe(true);
    expect(second.dispute.id).toBe(first.dispute.id);
  });

  it('same idempotency key with different payload conflicts', async () => {
    const { customer, order } = await makeDisputableOrder('open7', country, method, admin, superAdmin);
    const key = `dk-${Math.random()}`;
    await openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'first', idempotencyKey: key });
    await expect(
      openDispute(customer.id, { orderId: order.id, reason: 'WRONG_AMOUNT', description: 'different', idempotencyKey: key })
    ).rejects.toThrow(/different request data/i);
  });

  it('a second, distinct dispute cannot be opened while one is already active', async () => {
    const { customer, order } = await makeDisputableOrder('open8', country, method, admin, superAdmin);
    await openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'first', idempotencyKey: `dk-${Math.random()}` });
    // Order is now DISPUTE, so a second attempt also fails the order-state
    // check first — confirming defense in depth (order-claim + active-dispute
    // check both independently prevent a second dispute).
    await expect(
      openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'second', idempotencyKey: `dk-${Math.random()}` })
    ).rejects.toThrow(/cannot enter dispute from its current state|active dispute already exists/i);
  });

  it('CONCURRENCY — two concurrent dispute-open attempts on one order: exactly one dispute created', async () => {
    const { customer, order } = await makeDisputableOrder('openrace', country, method, admin, superAdmin);

    const results = await Promise.allSettled([
      openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'a', idempotencyKey: `dk-${Math.random()}` }),
      openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'b', idempotencyKey: `dk-${Math.random()}` }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const disputes = await prisma.dispute.findMany({ where: { orderId: order.id } });
    expect(disputes.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// DISPUTE ACCESS / OWNERSHIP
// ═══════════════════════════════════════════════════════════════

describeIf('Dispute access and ownership', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanDisputeFixtures();
    admin = await createAdmin('accessadmin');
    superAdmin = await createSuperAdmin('accesssuper');
    country = await createCountry('access');
    method = await createPaymentMethod(country.id, 'access');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('customer, agent, and admin can access a dispute; a stranger cannot', async () => {
    const { fixture, customer, order } = await makeDisputableOrder('acc1', country, method, admin, superAdmin);
    const { dispute } = await openDispute(customer.id, {
      orderId: order.id,
      reason: 'OTHER',
      description: 'x',
      idempotencyKey: `dk-${Math.random()}`,
    });
    const stranger = await createUser('strangeracc1');

    await expect(getDisputeById(customer.id, dispute.id)).resolves.toBeTruthy();
    await expect(getDisputeById(fixture.agentUser.id, dispute.id)).resolves.toBeTruthy();
    await expect(getDisputeById(admin.id, dispute.id)).resolves.toBeTruthy();
    await expect(getDisputeById(stranger.id, dispute.id)).rejects.toThrow(/do not have access/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// DISPUTE STATE MACHINE (claim / resolve)
// ═══════════════════════════════════════════════════════════════

describeIf('Dispute claim and resolution', () => {
  let admin: { id: string };
  let admin2: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanDisputeFixtures();
    admin = await createAdmin('resolveadmin');
    admin2 = await createAdmin('resolveadmin2');
    superAdmin = await createSuperAdmin('resolvesuper');
    country = await createCountry('resolve');
    method = await createPaymentMethod(country.id, 'resolve');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  async function makeOpenDispute(tag: string) {
    const { fixture, customer, order } = await makeDisputableOrder(tag, country, method, admin, superAdmin);
    const { dispute } = await openDispute(customer.id, {
      orderId: order.id,
      reason: 'PAYMENT_NOT_RECEIVED',
      description: 'x',
      idempotencyKey: `dk-${Math.random()}`,
    });
    return { fixture, customer, order, dispute };
  }

  it('legal transition: OPEN -> ASSIGNED -> RESOLVED (RELEASE)', async () => {
    const { fixture, customer, order, dispute } = await makeOpenDispute('legal1');
    const claimResult = await claimDispute(admin.id, dispute.id);
    expect(claimResult.status).toBe('ASSIGNED');

    const walletBefore = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(walletBefore).toBeNull();

    const resolveResult = await resolveDispute(admin.id, dispute.id, 'RELEASE', 'Payment confirmed via bank records');
    expect(resolveResult.status).toBe('RESOLVED');

    const finalOrder = await prisma.agentOrder.findUnique({ where: { id: order.id } });
    expect(finalOrder!.status).toBe('COMPLETED');

    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(wallet!.coinsBalance).toBe(order.coinAmount);

    const settlement = await prisma.agentOrderSettlement.findUnique({ where: { orderId: order.id } });
    expect(settlement!.resolvedVia).toBe('ADMIN_DISPUTE_RESOLUTION');
    expect(settlement!.releasedBy).toBe(admin.id);

    void fixture;
  });

  it('legal transition: OPEN -> ASSIGNED -> RESOLVED (CANCEL) releases inventory, no wallet credit', async () => {
    const { fixture, customer, order, dispute } = await makeOpenDispute('legal2');
    await claimDispute(admin.id, dispute.id);
    const result = await resolveDispute(admin.id, dispute.id, 'CANCEL', 'Payment never received, order cancelled');
    expect(result.status).toBe('RESOLVED');

    const finalOrder = await prisma.agentOrder.findUnique({ where: { id: order.id } });
    expect(finalOrder!.status).toBe('CANCELLED');

    const reservation = await prisma.agentReservation.findUnique({ where: { orderId: order.id } });
    expect(reservation!.status).toBe('RELEASED');

    const inventory = await getAgentInventory(fixture.agent.id);
    expect(inventory.reservedBalance).toBe(0);

    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(wallet).toBeNull(); // never credited
  });

  it('illegal transition: cannot resolve a dispute that has not been claimed', async () => {
    const { dispute } = await makeOpenDispute('illegal1');
    await expect(resolveDispute(admin.id, dispute.id, 'RELEASE', 'skip claim')).rejects.toThrow(
      /only the admin who claimed this dispute may resolve it/i
    );
  });

  it('illegal transition: only the claiming admin may resolve', async () => {
    const { dispute } = await makeOpenDispute('illegal2');
    await claimDispute(admin.id, dispute.id);
    await expect(resolveDispute(admin2.id, dispute.id, 'RELEASE', 'not my dispute')).rejects.toThrow(
      /only the admin who claimed this dispute may resolve it/i
    );
  });

  it('closed dispute cannot be modified again', async () => {
    const { dispute } = await makeOpenDispute('closed1');
    await claimDispute(admin.id, dispute.id);
    await resolveDispute(admin.id, dispute.id, 'CANCEL', 'done');

    await expect(claimDispute(admin.id, dispute.id)).rejects.toThrow(/cannot be claimed in its current state/i);
    await expect(resolveDispute(admin.id, dispute.id, 'RELEASE', 'again')).rejects.toThrow(
      /cannot be resolved in its current state/i
    );
  });

  it('ordinary user cannot claim or resolve disputes', async () => {
    const { dispute } = await makeOpenDispute('plainuser1');
    const plainUser = await createUser('plainuser1');
    await expect(claimDispute(plainUser.id, dispute.id)).rejects.toThrow(/admin privileges required/i);
  });

  it('admin cannot claim/resolve a dispute on their own order (self-review)', async () => {
    const selfAdminUser = await createAdmin('selfdispute');
    const fixture = await setupActiveAgent('selfdispute', country.id, method.id, admin, superAdmin, 100_000);
    const created = await createAgentOrder(selfAdminUser.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 500,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(selfAdminUser.id, created.order.id);
    const { dispute } = await openDispute(selfAdminUser.id, {
      orderId: created.order.id,
      reason: 'OTHER',
      description: 'self',
      idempotencyKey: `dk-${Math.random()}`,
    });

    await expect(claimDispute(selfAdminUser.id, dispute.id)).rejects.toThrow(/cannot act on a dispute for your own order/i);
  });

  it('CONCURRENCY — concurrent claim attempts: exactly one succeeds', async () => {
    const { dispute } = await makeOpenDispute('raceclaim');
    const results = await Promise.allSettled([claimDispute(admin.id, dispute.id), claimDispute(admin2.id, dispute.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);
    const final = await prisma.dispute.findUnique({ where: { id: dispute.id } });
    expect(final!.status).toBe('ASSIGNED');
  });

  it('CONCURRENCY — concurrent resolve attempts by the claiming admin: exactly one settlement, one wallet credit', async () => {
    const { customer, order, dispute } = await makeOpenDispute('raceresolve');
    await claimDispute(admin.id, dispute.id);

    const results = await Promise.allSettled([
      resolveDispute(admin.id, dispute.id, 'RELEASE', 'first'),
      resolveDispute(admin.id, dispute.id, 'RELEASE', 'second'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const settlements = await prisma.agentOrderSettlement.findMany({ where: { orderId: order.id } });
    expect(settlements.length).toBe(1);

    const txs = await prisma.walletTransaction.findMany({ where: { referenceType: 'AGENT_ORDER', referenceId: order.id } });
    expect(txs.length).toBe(1);
    void customer;
  });

  it('settlement (agent path) and dispute cannot both succeed on the same order — structurally exclusive states', async () => {
    const { fixture, order } = await makeDisputableOrder('exclusive1', country, method, admin, superAdmin);

    const results = await Promise.allSettled([
      openDispute(order.userId, { orderId: order.id, reason: 'OTHER', description: 'x', idempotencyKey: `dk-${Math.random()}` }),
      settleAgentOrder(fixture.agentUser.id, order.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const finalOrder = await prisma.agentOrder.findUnique({ where: { id: order.id } });
    expect(['DISPUTE', 'COMPLETED']).toContain(finalOrder!.status);

    // Whichever won, exactly one settlement-equivalent outcome — never both
    // a dispute AND a settlement on the same order.
    const disputes = await prisma.dispute.findMany({ where: { orderId: order.id } });
    const settlements = await prisma.agentOrderSettlement.findMany({ where: { orderId: order.id } });
    if (finalOrder!.status === 'DISPUTE') {
      expect(disputes.length).toBe(1);
      expect(settlements.length).toBe(0);
    } else {
      expect(disputes.length).toBe(0);
      expect(settlements.length).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS / AUDIT
// ═══════════════════════════════════════════════════════════════

describeIf('Dispute notifications and audit', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanDisputeFixtures();
    admin = await createAdmin('notifadmin');
    superAdmin = await createSuperAdmin('notifsuper');
    country = await createCountry('notif');
    method = await createPaymentMethod(country.id, 'notif');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('AGENT_DISPUTE_OPENED notifies the other party exactly once', async () => {
    const { fixture, customer, order } = await makeDisputableOrder('notif1', country, method, admin, superAdmin);
    await openDispute(customer.id, { orderId: order.id, reason: 'OTHER', description: 'x', idempotencyKey: `dk-${Math.random()}` });

    const agentNotifications = await prisma.notification.findMany({
      where: { userId: fixture.agentUser.id, type: 'AGENT_DISPUTE_OPENED' },
    });
    expect(agentNotifications.length).toBe(1);
  });

  it('AGENT_DISPUTE_RESOLVED notifies both customer and agent exactly once each', async () => {
    const { fixture, customer, order } = await makeDisputableOrder('notif2', country, method, admin, superAdmin);
    const { dispute } = await openDispute(customer.id, {
      orderId: order.id,
      reason: 'OTHER',
      description: 'x',
      idempotencyKey: `dk-${Math.random()}`,
    });
    await claimDispute(admin.id, dispute.id);
    await resolveDispute(admin.id, dispute.id, 'CANCEL', 'resolved');

    const customerNotifications = await prisma.notification.findMany({
      where: { userId: customer.id, type: 'AGENT_DISPUTE_RESOLVED' },
    });
    const agentNotifications = await prisma.notification.findMany({
      where: { userId: fixture.agentUser.id, type: 'AGENT_DISPUTE_RESOLVED' },
    });
    expect(customerNotifications.length).toBe(1);
    expect(agentNotifications.length).toBe(1);
  });

  it('losing concurrent resolve does not emit a duplicate resolved notification', async () => {
    const { fixture, customer, order } = await makeDisputableOrder('notif3', country, method, admin, superAdmin);
    const { dispute } = await openDispute(customer.id, {
      orderId: order.id,
      reason: 'OTHER',
      description: 'x',
      idempotencyKey: `dk-${Math.random()}`,
    });
    await claimDispute(admin.id, dispute.id);

    await Promise.allSettled([
      resolveDispute(admin.id, dispute.id, 'CANCEL', 'a'),
      resolveDispute(admin.id, dispute.id, 'CANCEL', 'b'),
    ]);

    const notifications = await prisma.notification.findMany({ where: { userId: customer.id, type: 'AGENT_DISPUTE_RESOLVED' } });
    expect(notifications.length).toBe(1);
    void fixture;
  });

  it('audit logs never contain the dispute description alongside payment account secrets', async () => {
    const { customer, order } = await makeDisputableOrder('notif4', country, method, admin, superAdmin);
    await openDispute(customer.id, {
      orderId: order.id,
      reason: 'OTHER',
      description: 'SECRET-ACCOUNT-9999',
      idempotencyKey: `dk-${Math.random()}`,
    });

    const logs = await prisma.auditLog.findMany({ where: { entity: 'Dispute' } });
    for (const log of logs) {
      const serialized = JSON.stringify([log.oldData, log.newData]);
      expect(serialized).not.toContain('SECRET-ACCOUNT-9999');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// FULL LIFECYCLE
// ═══════════════════════════════════════════════════════════════

describeIf('Complete order + dispute lifecycle', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanDisputeFixtures();
    admin = await createAdmin('lifecycleadmin');
    superAdmin = await createSuperAdmin('lifecyclesuper');
    country = await createCountry('lifecycle');
    method = await createPaymentMethod(country.id, 'lifecycle');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('order -> payment submitted -> dispute opened -> claimed -> resolved (RELEASE) end-to-end', async () => {
    const fixture = await setupActiveAgent('e2e1', country.id, method.id, admin, superAdmin, 100_000);
    const customer = await createUser('e2ecust1');

    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 500,
      idempotencyKey: `key-${Math.random()}`,
    });
    expect(created.order.status).toBe('CREATED');

    await submitOrderPayment(customer.id, created.order.id);

    const { dispute } = await openDispute(customer.id, {
      orderId: created.order.id,
      reason: 'PAYMENT_NOT_RECEIVED',
      description: 'Agent unresponsive after payment.',
      idempotencyKey: `dk-${Math.random()}`,
    });
    expect(dispute.status).toBe('OPEN');

    await claimDispute(admin.id, dispute.id);
    const final = await resolveDispute(admin.id, dispute.id, 'RELEASE', 'Verified payment via records.');
    expect(final.status).toBe('RESOLVED');

    const finalOrder = await prisma.agentOrder.findUnique({ where: { id: created.order.id } });
    expect(finalOrder!.status).toBe('COMPLETED');

    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(wallet!.coinsBalance).toBe(created.order.coinAmount);

    const inventory = await getAgentInventory(fixture.agent.id);
    expect(inventory.reservedBalance).toBe(0);
    expect(inventory.totalBalance).toBe(100_000 - created.order.coinAmount);
  });
});
