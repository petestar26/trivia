import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { submitAgentApplication, approveAgentApplication } from './agent-service';
import { createAgentPaymentAccount, approveAgentPaymentAccount } from './payment-account-service';
import { fundAgentInventory, adjustAgentInventory, getAgentInventory, getAgentInventoryLedger } from './inventory-service';
import {
  createAgentOrder,
  getAgentOrderById,
  submitOrderPayment,
  cancelAgentOrder,
  settleAgentOrder,
} from './order-service';

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

// ─── Fixtures ──────────────────────────────────────────────────

async function createUser(tag: string) {
  const email = `order-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `ordertest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Order Test ${tag}`,
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
  const code = `O${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Order Test Country ${tag}`,
      currencyCode: 'USD',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
}

async function createPaymentMethod(countryId: string, tag: string) {
  return prisma.paymentMethodDefinition.create({
    data: {
      countryId,
      type: 'BANK_TRANSFER',
      name: `Order Test Method ${tag}`,
      fieldSchema: { requiredFields: ['bankName', 'accountNumber'] },
      isActive: true,
    },
  });
}

async function createExchangeRate(countryId: string, fiatCurrency: string, coinsPerUnit: number, adminId: string) {
  return prisma.exchangeRateConfig.create({
    data: { countryId, fiatCurrency, coinsPerUnit, isActive: true, setBy: adminId },
  });
}

/**
 * Full happy-path setup: an ACTIVE agent, with one APPROVED payment
 * account, and funded inventory — the precondition nearly every order
 * test needs. superAdmin is a SUPER_ADMIN used for funding/adjusting.
 */
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
    contactEmail: `agent-order-${tag}@test.local`,
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

async function cleanOrderFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'order-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    if (agentIds.length) {
      await prisma.agentOrderSettlement.deleteMany({ where: { order: { agentId: { in: agentIds } } } });
      await prisma.agentReservation.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentOrder.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentInventoryLedger.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentInventory.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentPaymentAccount.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentApplication.deleteMany({ where: { agentId: { in: agentIds } } });
    }
    await prisma.agentOrder.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.updateMany({ where: { id: { in: userIds } }, data: { referredByAgentId: null } });
    await prisma.agent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }

  const countries = await prisma.country.findMany({ where: { name: { startsWith: 'Order Test Country' } } });
  const countryIds = countries.map((c) => c.id);
  if (countryIds.length) {
    await prisma.exchangeRateConfig.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.paymentMethodDefinition.deleteMany({ where: { countryId: { in: countryIds } } });
    await prisma.country.deleteMany({ where: { id: { in: countryIds } } });
  }
}

// ═══════════════════════════════════════════════════════════════
// ORDER CREATION
// ═══════════════════════════════════════════════════════════════

describeIf('Agent order creation', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };
  let agentFixture: Awaited<ReturnType<typeof setupActiveAgent>>;

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('createadmin');
    superAdmin = await createSuperAdmin('createsuper');
    country = await createCountry('create');
    method = await createPaymentMethod(country.id, 'create');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
    agentFixture = await setupActiveAgent('create1', country.id, method.id, admin, superAdmin, 100_000);
  });

  function args(overrides: Partial<Parameters<typeof createAgentOrder>[1]> = {}) {
    return {
      agentId: agentFixture.agent.id,
      countryId: country.id,
      paymentAccountId: agentFixture.account.id,
      fiatAmount: 500,
      idempotencyKey: `key-${Math.random()}`,
      ...overrides,
    };
  }

  it('1. authenticated customer can create a valid order', async () => {
    const customer = await createUser('cust1');
    const result = await createAgentOrder(customer.id, args());
    expect(result.idempotent).toBe(false);
    expect(result.order.status).toBe('CREATED');
    expect(result.order.coinAmount).toBe(5000); // floor(500 * 10)
    expect(result.order.fiatCurrency).toBe(country.currencyCode);
    expect(result.order.orderNumber).toMatch(/^AG-\d{6}$/);
  });

  it('3. invalid country is rejected', async () => {
    const customer = await createUser('cust3');
    // createAgentOrder validates the agent/country RELATIONSHIP before it
    // loads the country row, so a bogus countryId is rejected by the
    // agent-country guard rather than the "Invalid country" lookup guard.
    // The assertion below matches the guard that actually fires first —
    // the order is still rejected, which is what this test exists to prove.
    // (The "Invalid country" branch is unreachable via this input because a
    // countryId that no country owns can never equal the agent's countryId.)
    await expect(createAgentOrder(customer.id, args({ countryId: 'not-a-real-country' }))).rejects.toThrow(
      /does not serve the selected country/i
    );
  });

  it('4. invalid payment method (via invalid payment account) is rejected', async () => {
    const customer = await createUser('cust4');
    await expect(createAgentOrder(customer.id, args({ paymentAccountId: 'not-a-real-account' }))).rejects.toThrow(
      /invalid payment account/i
    );
  });

  it('5. country/payment-method mismatch is rejected', async () => {
    const otherCountry = await createCountry('create-other');
    const customer = await createUser('cust5');
    await expect(createAgentOrder(customer.id, args({ countryId: otherCountry.id }))).rejects.toThrow(
      /does not serve the selected country|does not belong to the selected country/i
    );
  });

  it('6. invalid amount is rejected', async () => {
    const customer = await createUser('cust6');
    await expect(createAgentOrder(customer.id, args({ fiatAmount: 0 }))).rejects.toThrow(/positive integer/i);
    await expect(createAgentOrder(customer.id, args({ fiatAmount: -5 }))).rejects.toThrow(/positive integer/i);
  });

  it('6b. amount outside agent min/max bounds is rejected', async () => {
    const boundedAgent = await setupActiveAgent('bounded', country.id, method.id, admin, superAdmin, 100_000);
    await prisma.agent.update({ where: { id: boundedAgent.agent.id }, data: { minOrderAmount: 100, maxOrderAmount: 1000 } });
    const customer = await createUser('cust6b');

    await expect(
      createAgentOrder(customer.id, {
        agentId: boundedAgent.agent.id,
        countryId: country.id,
        paymentAccountId: boundedAgent.account.id,
        fiatAmount: 50,
        idempotencyKey: `key-${Math.random()}`,
      })
    ).rejects.toThrow(/minimum order amount/i);

    await expect(
      createAgentOrder(customer.id, {
        agentId: boundedAgent.agent.id,
        countryId: country.id,
        paymentAccountId: boundedAgent.account.id,
        fiatAmount: 5000,
        idempotencyKey: `key-${Math.random()}`,
      })
    ).rejects.toThrow(/maximum order amount/i);
  });

  it('8. ineligible Agent cannot receive order (not ACTIVE)', async () => {
    const pendingAgentUser = await createUser('agent-pending8');
    await submitAgentApplication(pendingAgentUser.id, {
      countryId: country.id,
      displayName: 'Pending Agent',
      contactEmail: 'agent-order-pending8@test.local',
    });
    const pendingAgent = await prisma.agent.findUnique({ where: { userId: pendingAgentUser.id } });

    const customer = await createUser('cust8');
    await expect(
      createAgentOrder(customer.id, {
        agentId: pendingAgent!.id,
        countryId: country.id,
        paymentAccountId: agentFixture.account.id,
        fiatAmount: 500,
        idempotencyKey: `key-${Math.random()}`,
      })
    ).rejects.toThrow(/not currently accepting orders/i);
  });

  it('customer cannot order against their own agent account', async () => {
    const selfAgent = await setupActiveAgent('self9', country.id, method.id, admin, superAdmin, 100_000);
    await expect(
      createAgentOrder(selfAgent.agentUser.id, {
        agentId: selfAgent.agent.id,
        countryId: country.id,
        paymentAccountId: selfAgent.account.id,
        fiatAmount: 500,
        idempotencyKey: `key-${Math.random()}`,
      })
    ).rejects.toThrow(/cannot create an order against your own agent/i);
  });

  it('9. duplicate idempotency key returns the original result', async () => {
    const customer = await createUser('cust9');
    const a = args();
    const first = await createAgentOrder(customer.id, a);
    const second = await createAgentOrder(customer.id, a);
    expect(second.idempotent).toBe(true);
    expect(second.order.id).toBe(first.order.id);

    const orders = await prisma.agentOrder.findMany({ where: { userId: customer.id, idempotencyKey: a.idempotencyKey } });
    expect(orders.length).toBe(1);
  });

  it('10. same idempotency key with different payload conflicts, original unchanged', async () => {
    const customer = await createUser('cust10');
    const key = `key-${Math.random()}`;
    const first = await createAgentOrder(customer.id, args({ idempotencyKey: key, fiatAmount: 500 }));

    await expect(createAgentOrder(customer.id, args({ idempotencyKey: key, fiatAmount: 999 }))).rejects.toThrow(
      /different request data/i
    );

    const stillOriginal = await prisma.agentOrder.findUnique({ where: { id: first.order.id } });
    expect(stillOriginal!.fiatAmount).toBe(500);
  });

  it('CONCURRENCY Race A — two concurrent requests, same user + idempotency key: exactly one order', async () => {
    const customer = await createUser('custRaceA');
    const a = args();

    const results = await Promise.allSettled([
      createAgentOrder(customer.id, a),
      createAgentOrder(customer.id, a),
      createAgentOrder(customer.id, a),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(fulfilled.length).toBe(3); // idempotent replays all succeed, returning the same order
    const orderIds = new Set(fulfilled.map((r) => r.value.order.id));
    expect(orderIds.size).toBe(1);

    const genuineCreations = fulfilled.filter((r) => r.value.idempotent === false);
    expect(genuineCreations.length).toBe(1);

    const orders = await prisma.agentOrder.findMany({ where: { userId: customer.id, idempotencyKey: a.idempotencyKey } });
    expect(orders.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// INVENTORY / RESERVATION
// ═══════════════════════════════════════════════════════════════

describeIf('Agent inventory reservation', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('invadmin');
    superAdmin = await createSuperAdmin('invsuper');
    country = await createCountry('inv');
    method = await createPaymentMethod(country.id, 'inv');
    await createExchangeRate(country.id, country.currencyCode, 1, admin.id);
  });

  it('11-13. valid reservation succeeds; reservedBalance increases; totalBalance unchanged by reservation', async () => {
    const fixture = await setupActiveAgent('res1', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('rescust1');

    const before = await getAgentInventory(fixture.agent.id);
    expect(before.totalBalance).toBe(1000);
    expect(before.reservedBalance).toBe(0);

    const result = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 300,
      idempotencyKey: `key-${Math.random()}`,
    });

    const after = await getAgentInventory(fixture.agent.id);
    expect(after.totalBalance).toBe(1000); // unchanged by reservation
    expect(after.reservedBalance).toBe(result.order.coinAmount);
    expect(after.available).toBe(1000 - result.order.coinAmount);
  });

  it('12. insufficient inventory is rejected', async () => {
    const fixture = await setupActiveAgent('res2', country.id, method.id, admin, superAdmin, 100);
    const customer = await createUser('rescust2');

    await expect(
      createAgentOrder(customer.id, {
        agentId: fixture.agent.id,
        countryId: country.id,
        paymentAccountId: fixture.account.id,
        fiatAmount: 1000, // coinAmount = 1000 at rate 1, exceeds 100 total
        idempotencyKey: `key-${Math.random()}`,
      })
    ).rejects.toThrow(/insufficient agent inventory/i);

    // Rejected reservation must not create a partial order.
    const orders = await prisma.agentOrder.findMany({ where: { agentId: fixture.agent.id, userId: customer.id } });
    expect(orders.length).toBe(0);
  });

  it('15. reservation creates the required ledger record', async () => {
    const fixture = await setupActiveAgent('res3', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('rescust3');
    const result = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 200,
      idempotencyKey: `key-${Math.random()}`,
    });

    const ledger = await getAgentInventoryLedger(fixture.agent.id);
    const reserveEntry = ledger.find((l) => l.type === 'RESERVE' && l.orderId === result.order.id);
    expect(reserveEntry).toBeTruthy();
    expect(reserveEntry!.amount).toBe(result.order.coinAmount);
    expect(reserveEntry!.reservedAfter - reserveEntry!.reservedBefore).toBe(result.order.coinAmount);
  });

  it('16-17. duplicate reservation is prevented (reservation is 1:1 with order, never independently created)', async () => {
    const fixture = await setupActiveAgent('res4', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('rescust4');
    const result = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 200,
      idempotencyKey: `key-${Math.random()}`,
    });

    const reservations = await prisma.agentReservation.findMany({ where: { orderId: result.order.id } });
    expect(reservations.length).toBe(1);
  });

  it('CONCURRENCY Race C — concurrent orders cannot oversubscribe inventory', async () => {
    const fixture = await setupActiveAgent('res5', country.id, method.id, admin, superAdmin, 100); // exactly 100 coins available
    const custA = await createUser('rescustA');
    const custB = await createUser('rescustB');

    const results = await Promise.allSettled([
      createAgentOrder(custA.id, {
        agentId: fixture.agent.id,
        countryId: country.id,
        paymentAccountId: fixture.account.id,
        fiatAmount: 60, // coinAmount 60
        idempotencyKey: `key-${Math.random()}`,
      }),
      createAgentOrder(custB.id, {
        agentId: fixture.agent.id,
        countryId: country.id,
        paymentAccountId: fixture.account.id,
        fiatAmount: 60, // coinAmount 60 — 60+60=120 > 100 total
        idempotencyKey: `key-${Math.random()}`,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // At most one of the two conflicting reservations can succeed.
    expect(fulfilled.length).toBeLessThanOrEqual(1);

    const inventory = await getAgentInventory(fixture.agent.id);
    expect(inventory.reservedBalance).toBeLessThanOrEqual(inventory.totalBalance);
    expect(inventory.reservedBalance).toBeLessThanOrEqual(60);
  });
});

// ═══════════════════════════════════════════════════════════════
// SETTLEMENT
// ═══════════════════════════════════════════════════════════════

describeIf('Agent order settlement', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('setadmin');
    superAdmin = await createSuperAdmin('setsuper');
    country = await createCountry('set');
    method = await createPaymentMethod(country.id, 'set');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  async function makeSubmittedOrder(tag: string) {
    const fixture = await setupActiveAgent(`set-${tag}`, country.id, method.id, admin, superAdmin, 100_000);
    const customer = await createUser(`setcust-${tag}`);
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

  it('24. valid settlement succeeds', async () => {
    const { fixture, customer, order } = await makeSubmittedOrder('valid');
    const result = await settleAgentOrder(fixture.agentUser.id, order.id);
    expect(result.status).toBe('COMPLETED');

    const wallet = await prisma.wallet.findUnique({ where: { userId: customer.id } });
    expect(wallet!.coinsBalance).toBe(order.coinAmount);
  });

  it('25. settlement from an invalid order state is rejected', async () => {
    const fixture = await setupActiveAgent('set-invalid', country.id, method.id, admin, superAdmin, 100_000);
    const customer = await createUser('setcust-invalid');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 500,
      idempotencyKey: `key-${Math.random()}`,
    });
    // never submitted payment — still CREATED
    await expect(settleAgentOrder(fixture.agentUser.id, created.order.id)).rejects.toThrow(
      /cannot be settled in its current state/i
    );
  });

  it('26. settlement creates exactly one AgentOrderSettlement', async () => {
    const { fixture, order } = await makeSubmittedOrder('onesettlement');
    await settleAgentOrder(fixture.agentUser.id, order.id);
    const settlements = await prisma.agentOrderSettlement.findMany({ where: { orderId: order.id } });
    expect(settlements.length).toBe(1);
    expect(settlements[0].resolvedVia).toBe('AGENT_RELEASE');
    expect(settlements[0].releasedBy).toBe(fixture.agentUser.id);
  });

  it('27-28. settlement updates inventory and creates required ledger entries', async () => {
    const { fixture, order } = await makeSubmittedOrder('inventory');
    const before = await getAgentInventory(fixture.agent.id);
    await settleAgentOrder(fixture.agentUser.id, order.id);
    const after = await getAgentInventory(fixture.agent.id);

    expect(after.totalBalance).toBe(before.totalBalance - order.coinAmount);
    expect(after.reservedBalance).toBe(before.reservedBalance - order.coinAmount);

    const ledger = await getAgentInventoryLedger(fixture.agent.id);
    const consumeEntry = ledger.find((l) => l.type === 'CONSUME_ON_SETTLEMENT' && l.orderId === order.id);
    expect(consumeEntry).toBeTruthy();
    expect(consumeEntry!.amount).toBe(order.coinAmount);
  });

  it('29. settlement performs the wallet credit exactly once', async () => {
    const { fixture, customer, order } = await makeSubmittedOrder('walletonce');
    await settleAgentOrder(fixture.agentUser.id, order.id);
    const txs = await prisma.walletTransaction.findMany({
      where: { referenceType: 'AGENT_ORDER', referenceId: order.id },
    });
    expect(txs.length).toBe(1);
    expect(txs[0].amount).toBe(order.coinAmount);
    expect(txs[0].ledgerType).toBe('CREDIT');
    void customer;
  });

  it('30. duplicate settlement is rejected (idempotent-safe, not double-applied)', async () => {
    const { fixture, order } = await makeSubmittedOrder('duplicate');
    await settleAgentOrder(fixture.agentUser.id, order.id);
    await expect(settleAgentOrder(fixture.agentUser.id, order.id)).rejects.toThrow(
      /cannot be settled in its current state/i
    );

    const settlements = await prisma.agentOrderSettlement.findMany({ where: { orderId: order.id } });
    expect(settlements.length).toBe(1);
  });

  it('agent cannot settle another agent\'s order', async () => {
    const { order } = await makeSubmittedOrder('crossagent');
    const otherAgentFixture = await setupActiveAgent('otheragent', country.id, method.id, admin, superAdmin, 100_000);
    await expect(settleAgentOrder(otherAgentFixture.agentUser.id, order.id)).rejects.toThrow(/not your order/i);
  });

  it('CONCURRENCY Race E — concurrent settlements: exactly one settlement, one wallet credit', async () => {
    const { fixture, order } = await makeSubmittedOrder('raceE');

    const results = await Promise.allSettled([
      settleAgentOrder(fixture.agentUser.id, order.id),
      settleAgentOrder(fixture.agentUser.id, order.id),
      settleAgentOrder(fixture.agentUser.id, order.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const settlements = await prisma.agentOrderSettlement.findMany({ where: { orderId: order.id } });
    expect(settlements.length).toBe(1);

    const txs = await prisma.walletTransaction.findMany({ where: { referenceType: 'AGENT_ORDER', referenceId: order.id } });
    expect(txs.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// CANCELLATION / RELEASE
// ═══════════════════════════════════════════════════════════════

describeIf('Agent order cancellation (customer-initiated release)', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('canceladmin');
    superAdmin = await createSuperAdmin('cancelsuper');
    country = await createCountry('cancel');
    method = await createPaymentMethod(country.id, 'cancel');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('cancellation releases the reservation and restores available inventory', async () => {
    const fixture = await setupActiveAgent('cancel1', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('cancelcust1');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    const beforeCancel = await getAgentInventory(fixture.agent.id);
    expect(beforeCancel.reservedBalance).toBe(created.order.coinAmount);

    const result = await cancelAgentOrder(customer.id, created.order.id);
    expect(result.status).toBe('CANCELLED');

    const afterCancel = await getAgentInventory(fixture.agent.id);
    expect(afterCancel.reservedBalance).toBe(0);
    expect(afterCancel.totalBalance).toBe(1000); // release never touches totalBalance

    const reservation = await prisma.agentReservation.findUnique({ where: { orderId: created.order.id } });
    expect(reservation!.status).toBe('RELEASED');

    const ledger = await getAgentInventoryLedger(fixture.agent.id);
    const releaseEntry = ledger.find((l) => l.type === 'RELEASE_UNUSED' && l.orderId === created.order.id);
    expect(releaseEntry).toBeTruthy();
  });

  it('cancellation is rejected once payment has been submitted', async () => {
    const fixture = await setupActiveAgent('cancel2', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('cancelcust2');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(customer.id, created.order.id);

    await expect(cancelAgentOrder(customer.id, created.order.id)).rejects.toThrow(
      /cannot be cancelled in its current state/i
    );
  });

  it('customer cannot cancel another customer\'s order', async () => {
    const fixture = await setupActiveAgent('cancel3', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('cancelcust3');
    const stranger = await createUser('cancelstranger3');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    await expect(cancelAgentOrder(stranger.id, created.order.id)).rejects.toThrow(/not your order/i);
  });

  it('CONCURRENCY Race F — concurrent cancels release inventory exactly once', async () => {
    const fixture = await setupActiveAgent('cancel4', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('cancelcust4');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    const results = await Promise.allSettled([
      cancelAgentOrder(customer.id, created.order.id),
      cancelAgentOrder(customer.id, created.order.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const inventory = await getAgentInventory(fixture.agent.id);
    expect(inventory.reservedBalance).toBe(0); // released exactly once, not double-released negative
  });

  it('CONCURRENCY Race H — incompatible transitions (cancel vs submit-payment) from the same state: only one wins', async () => {
    const fixture = await setupActiveAgent('cancel5', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('cancelcust5');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    const results = await Promise.allSettled([
      cancelAgentOrder(customer.id, created.order.id),
      submitOrderPayment(customer.id, created.order.id),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(1);

    const final = await prisma.agentOrder.findUnique({ where: { id: created.order.id } });
    expect(['CANCELLED', 'PAYMENT_SUBMITTED']).toContain(final!.status);
  });
});

// ═══════════════════════════════════════════════════════════════
// ADMIN INVENTORY FUNDING / ADJUSTMENT
// ═══════════════════════════════════════════════════════════════

describeIf('Admin inventory funding and adjustment', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string };

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('fundadmin');
    superAdmin = await createSuperAdmin('fundsuper');
    country = await createCountry('fund');
  });

  async function makeBareAgent(tag: string) {
    const user = await createUser(`bare-${tag}`);
    const { application } = await submitAgentApplication(user.id, {
      countryId: country.id,
      displayName: `Bare Agent ${tag}`,
      contactEmail: `bare-order-${tag}@test.local`,
    });
    await approveAgentApplication(admin.id, application.id, undefined);
    const agent = await prisma.agent.findUnique({ where: { userId: user.id } });
    return { user, agent: agent! };
  }

  it('platform admin can fund an agent\'s inventory for the first time', async () => {
    const { agent } = await makeBareAgent('fund1');
    const result = await fundAgentInventory(admin.id, agent.id, 5000, `fund-key-${Math.random()}`);
    expect(result!.totalBalance).toBe(5000);
    expect(result!.reservedBalance).toBe(0);
  });

  it('31. authorized SUPER_ADMIN can perform the defined adjustment', async () => {
    const { agent } = await makeBareAgent('fund2');
    await fundAgentInventory(admin.id, agent.id, 1000, `fund-key-${Math.random()}`);
    const result = await adjustAgentInventory(superAdmin.id, agent.id, 500, 'top-up', `adj-key-${Math.random()}`);
    expect(result!.totalBalance).toBe(1500);
  });

  it('32. ordinary admin cannot perform SUPER_ADMIN-only adjustment', async () => {
    const { agent } = await makeBareAgent('fund3');
    await fundAgentInventory(admin.id, agent.id, 1000, `fund-key-${Math.random()}`);
    await expect(
      adjustAgentInventory(admin.id, agent.id, 100, 'unauthorized attempt', `adj-key-${Math.random()}`)
    ).rejects.toThrow(/super_admin privileges required/i);
  });

  it('33. ordinary user cannot adjust or fund inventory', async () => {
    const { agent } = await makeBareAgent('fund4');
    const plainUser = await createUser('plain4');
    await expect(fundAgentInventory(plainUser.id, agent.id, 1000, `fund-key-${Math.random()}`)).rejects.toThrow(
      /admin privileges required/i
    );
    await expect(
      adjustAgentInventory(plainUser.id, agent.id, 100, 'no', `adj-key-${Math.random()}`)
    ).rejects.toThrow(/super_admin privileges required/i);
  });

  it('34. agent cannot adjust their own or another agent\'s inventory', async () => {
    const { agent, user } = await makeBareAgent('fund5');
    await fundAgentInventory(admin.id, agent.id, 1000, `fund-key-${Math.random()}`);
    await expect(
      adjustAgentInventory(user.id, agent.id, 100, 'self attempt', `adj-key-${Math.random()}`)
    ).rejects.toThrow(/super_admin privileges required/i);
  });

  it('35. adjustment records performedByAdminId', async () => {
    const { agent } = await makeBareAgent('fund6');
    await fundAgentInventory(admin.id, agent.id, 1000, `fund-key-${Math.random()}`);
    await adjustAgentInventory(superAdmin.id, agent.id, -100, 'correction', `adj-key-${Math.random()}`);
    const ledger = await getAgentInventoryLedger(agent.id);
    const adjustment = ledger.find((l) => l.type === 'ADMIN_ADJUSTMENT');
    expect(adjustment!.performedByAdminId).toBe(superAdmin.id);
    expect(adjustment!.reason).toBe('correction');
  });

  it('36. funding and adjustment each create the required ledger entry', async () => {
    const { agent } = await makeBareAgent('fund7');
    await fundAgentInventory(admin.id, agent.id, 1000, `fund-key-${Math.random()}`);
    await adjustAgentInventory(superAdmin.id, agent.id, 200, 'reason', `adj-key-${Math.random()}`);
    const ledger = await getAgentInventoryLedger(agent.id);
    expect(ledger.some((l) => l.type === 'INITIAL_ALLOCATION')).toBe(true);
    expect(ledger.some((l) => l.type === 'ADMIN_ADJUSTMENT')).toBe(true);
  });

  it('37. adjustment cannot violate the inventory invariant (deduction below reservedBalance rejected)', async () => {
    const { agent, user } = await makeBareAgent('fund8');
    await fundAgentInventory(admin.id, agent.id, 1000, `fund-key-${Math.random()}`);

    // Reserve 400 via a real order so reservedBalance is genuinely non-zero.
    const methodForFund8 = await createPaymentMethod(country.id, 'fund8');
    await createExchangeRate(country.id, 'USD', 1, admin.id);
    const account = await createAgentPaymentAccount(user.id, {
      countryId: country.id,
      methodDefId: methodForFund8.id,
      accountDetails: { bankName: 'X', accountNumber: 'Y' },
    });
    await approveAgentPaymentAccount(admin.id, account.id);
    const customer = await createUser('fund8customer');
    await createAgentOrder(customer.id, {
      agentId: agent.id,
      countryId: country.id,
      paymentAccountId: account.id,
      fiatAmount: 400,
      idempotencyKey: `key-${Math.random()}`,
    });

    const inventory = await getAgentInventory(agent.id);
    expect(inventory.reservedBalance).toBe(400);

    await expect(
      adjustAgentInventory(superAdmin.id, agent.id, -700, 'would violate invariant', `adj-key-${Math.random()}`)
    ).rejects.toThrow(/below reservedBalance/i);
  });

  it('admin cannot fund or adjust their own agent inventory (self-review protection)', async () => {
    const selfAdminUser = await createSuperAdmin('selffund');
    const { application } = await submitAgentApplication(selfAdminUser.id, {
      countryId: country.id,
      displayName: 'Self Admin Agent',
      contactEmail: 'self-admin-agent@test.local',
    });
    await approveAgentApplication(admin.id, application.id, undefined);
    const selfAgent = await prisma.agent.findUnique({ where: { userId: selfAdminUser.id } });

    await expect(
      fundAgentInventory(selfAdminUser.id, selfAgent!.id, 1000, `fund-key-${Math.random()}`)
    ).rejects.toThrow(/cannot fund or adjust your own agent/i);
  });

  it('funding is idempotent via idempotencyKey', async () => {
    const { agent } = await makeBareAgent('fund9');
    const key = `fund-key-${Math.random()}`;
    await fundAgentInventory(admin.id, agent.id, 1000, key);
    await fundAgentInventory(admin.id, agent.id, 1000, key); // replay
    const inventory = await getAgentInventory(agent.id);
    expect(inventory.totalBalance).toBe(1000); // not double-funded
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTHORIZATION / OWNERSHIP
// ═══════════════════════════════════════════════════════════════

describeIf('Agent order authorization / ownership', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('authoadmin');
    superAdmin = await createSuperAdmin('authosuper');
    country = await createCountry('autho');
    method = await createPaymentMethod(country.id, 'autho');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('38. customer cannot access another customer\'s order', async () => {
    const fixture = await setupActiveAgent('autho1', country.id, method.id, admin, superAdmin, 1000);
    const owner = await createUser('authoowner1');
    const stranger = await createUser('authostranger1');
    const created = await createAgentOrder(owner.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    await expect(getAgentOrderById(stranger.id, created.order.id)).rejects.toThrow(/do not have access/i);
    // Owner, the order's own agent, and an admin all retain access.
    await expect(getAgentOrderById(owner.id, created.order.id)).resolves.toBeTruthy();
    await expect(getAgentOrderById(fixture.agentUser.id, created.order.id)).resolves.toBeTruthy();
    await expect(getAgentOrderById(admin.id, created.order.id)).resolves.toBeTruthy();
  });

  it('40. agent cannot manipulate another Agent\'s inventory via settlement', async () => {
    const fixtureA = await setupActiveAgent('autho2a', country.id, method.id, admin, superAdmin, 1000);
    const fixtureB = await setupActiveAgent('autho2b', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('authocust2');
    const created = await createAgentOrder(customer.id, {
      agentId: fixtureA.agent.id,
      countryId: country.id,
      paymentAccountId: fixtureA.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(customer.id, created.order.id);

    await expect(settleAgentOrder(fixtureB.agentUser.id, created.order.id)).rejects.toThrow(/not your order/i);

    const inventoryB = await getAgentInventory(fixtureB.agent.id);
    expect(inventoryB.reservedBalance).toBe(0); // untouched
  });

  it('42. caller cannot bypass service authorization using route parameters (agentId is never trusted from body for ownership)', async () => {
    // settleAgentOrder resolves the acting Agent from actorUserId, never
    // from a client-supplied agentId — there is no parameter through which
    // a caller could claim to be a different agent.
    const fixtureA = await setupActiveAgent('autho3a', country.id, method.id, admin, superAdmin, 1000);
    const fixtureB = await setupActiveAgent('autho3b', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('authocust3');
    const created = await createAgentOrder(customer.id, {
      agentId: fixtureA.agent.id,
      countryId: country.id,
      paymentAccountId: fixtureA.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(customer.id, created.order.id);

    // fixtureB's own user attempts to settle fixtureA's order — resolved via
    // fixtureB's OWN agent identity, which structurally cannot match.
    await expect(settleAgentOrder(fixtureB.agentUser.id, created.order.id)).rejects.toThrow(/not your order/i);
  });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════

describeIf('Agent order notifications', () => {
  let admin: { id: string };
  let superAdmin: { id: string };
  let country: { id: string; currencyCode: string };
  let method: { id: string };

  beforeAll(async () => {
    await cleanOrderFixtures();
    admin = await createAdmin('notifadmin2');
    superAdmin = await createSuperAdmin('notifsuper2');
    country = await createCountry('notif2');
    method = await createPaymentMethod(country.id, 'notif2');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
  });

  it('43. AGENT_ORDER_CREATED is emitted to the agent exactly once', async () => {
    const fixture = await setupActiveAgent('notifcreate', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('notifcust1');
    await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    const notifications = await prisma.notification.findMany({
      where: { userId: fixture.agentUser.id, type: 'AGENT_ORDER_CREATED' },
    });
    expect(notifications.length).toBe(1);
  });

  it('AGENT_PAYMENT_SUBMITTED notifies the agent', async () => {
    const fixture = await setupActiveAgent('notifsubmit', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('notifcust2');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(customer.id, created.order.id);

    const notifications = await prisma.notification.findMany({
      where: { userId: fixture.agentUser.id, type: 'AGENT_PAYMENT_SUBMITTED' },
    });
    expect(notifications.length).toBe(1);
  });

  it('AGENT_COINS_RELEASED notifies the customer', async () => {
    const fixture = await setupActiveAgent('notifrelease', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('notifcust3');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(customer.id, created.order.id);
    await settleAgentOrder(fixture.agentUser.id, created.order.id);

    const notifications = await prisma.notification.findMany({
      where: { userId: customer.id, type: 'AGENT_COINS_RELEASED' },
    });
    expect(notifications.length).toBe(1);
  });

  it('44. losing concurrent settlement does not emit a duplicate AGENT_COINS_RELEASED notification', async () => {
    const fixture = await setupActiveAgent('notifrace', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('notifcust4');
    const created = await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });
    await submitOrderPayment(customer.id, created.order.id);

    await Promise.allSettled([
      settleAgentOrder(fixture.agentUser.id, created.order.id),
      settleAgentOrder(fixture.agentUser.id, created.order.id),
    ]);

    const notifications = await prisma.notification.findMany({
      where: { userId: customer.id, type: 'AGENT_COINS_RELEASED' },
    });
    expect(notifications.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// REGRESSION
// ═══════════════════════════════════════════════════════════════

describeIf('Phase E regression — unrelated systems untouched', () => {
  it('order creation does not touch unrelated wallet balances of uninvolved users', async () => {
    const bystander = await createUser('bystander');
    const before = await prisma.wallet.findUnique({ where: { userId: bystander.id } });
    expect(before).toBeNull();

    const admin = await createAdmin('regressionadmin');
    const superAdmin = await createSuperAdmin('regressionsuper');
    const country = await createCountry('regression2');
    const method = await createPaymentMethod(country.id, 'regression2');
    await createExchangeRate(country.id, country.currencyCode, 10, admin.id);
    const fixture = await setupActiveAgent('regression2', country.id, method.id, admin, superAdmin, 1000);
    const customer = await createUser('regressioncust2');
    await createAgentOrder(customer.id, {
      agentId: fixture.agent.id,
      countryId: country.id,
      paymentAccountId: fixture.account.id,
      fiatAmount: 50,
      idempotencyKey: `key-${Math.random()}`,
    });

    const after = await prisma.wallet.findUnique({ where: { userId: bystander.id } });
    expect(after).toBeNull();
  });
});
