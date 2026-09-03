import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@socialplay/database';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service';
import {
  fundAgentFiatLiquidity,
  adjustAgentFiatLiquidity,
  getAgentFiatLiquidity,
  listAgentFiatLiquidity,
  getAgentFiatLiquidityLedger,
} from './liquidity-service';

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
  const email = `liq-${tag}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email,
      username: `liqtest_${tag}`,
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Liquidity Test ${tag}`,
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
  const code = `L${tag}`.slice(0, 8).toUpperCase();
  const existing = await prisma.country.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.country.create({
    data: {
      code,
      name: `Liquidity Test Country ${tag}`,
      currencyCode: 'USD',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
}

/** Bare ACTIVE agent — no payment account, no coin inventory. Liquidity is
 * independent of both, and this keeps fixtures minimal for this file. */
async function createActiveAgent(tag: string, countryId: string, admin: { id: string }) {
  const agentUser = await createUser(`agent-${tag}`);
  const { application } = await submitAgentApplication(agentUser.id, {
    countryId,
    displayName: `Liquidity Agent ${tag}`,
    contactEmail: `liq-agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.id, undefined);
  const agent = await prisma.agent.findUnique({ where: { userId: agentUser.id } });
  return agent!;
}

async function cleanLiquidityFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'liq-' } } });
  const userIds = users.map((u) => u.id);

  if (userIds.length) {
    const agents = await prisma.agent.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const agentIds = agents.map((a) => a.id);

    if (agentIds.length) {
      await prisma.agentFiatLiquidityLedger.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentFiatLiquidity.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agentApplication.deleteMany({ where: { agentId: { in: agentIds } } });
      await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    }
  }

  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.country.deleteMany({ where: { code: { startsWith: 'L' }, name: { startsWith: 'Liquidity Test Country' } } });
}

describeIf('withdrawals/liquidity-service', () => {
  it('funds a fresh (agent, currency) bucket and records an INITIAL_FUNDING ledger row', async () => {
    await cleanLiquidityFixtures();
    const tag = `fund-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    const before = await getAgentFiatLiquidity(agent.id, 'USD');
    expect(before.exists).toBe(false);
    expect(before.totalBalance).toBe(0n);

    const liquidity = await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 500_000n, `key-${tag}`);
    expect(liquidity!.totalBalance).toBe(500_000n);
    expect(liquidity!.reservedBalance).toBe(0n);

    const after = await getAgentFiatLiquidity(agent.id, 'USD');
    expect(after.exists).toBe(true);
    expect(after.totalBalance).toBe(500_000n);
    expect(after.available).toBe(500_000n);

    const ledger = await getAgentFiatLiquidityLedger(agent.id, 'USD');
    expect(ledger).toHaveLength(1);
    expect(ledger[0].type).toBe('INITIAL_FUNDING');
    expect(ledger[0].amount).toBe(500_000n);
  });

  it('keeps two currencies for the same agent as independent buckets', async () => {
    await cleanLiquidityFixtures();
    const tag = `multi-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `key-usd-${tag}`);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'EUR', 200_000n, `key-eur-${tag}`);

    const usd = await getAgentFiatLiquidity(agent.id, 'USD');
    const eur = await getAgentFiatLiquidity(agent.id, 'EUR');
    expect(usd.totalBalance).toBe(100_000n);
    expect(eur.totalBalance).toBe(200_000n);

    const all = await listAgentFiatLiquidity(agent.id);
    expect(all).toHaveLength(2);
  });

  it('rejects funding the same (agent, currency) bucket twice', async () => {
    await cleanLiquidityFixtures();
    const tag = `double-fund-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `key-a-${tag}`);
    await expect(
      fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 50_000n, `key-b-${tag}`)
    ).rejects.toThrow(/already exists/);
  });

  it('is idempotent: replaying the same funding idempotencyKey does not double-credit', async () => {
    await cleanLiquidityFixtures();
    const tag = `idem-fund-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    const key = `key-${tag}`;

    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, key);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, key);

    const liquidity = await getAgentFiatLiquidity(agent.id, 'USD');
    expect(liquidity.totalBalance).toBe(100_000n);
    const ledger = await getAgentFiatLiquidityLedger(agent.id, 'USD');
    expect(ledger).toHaveLength(1);
  });

  it('requires PLATFORM admin to fund and rejects a plain user', async () => {
    await cleanLiquidityFixtures();
    const tag = `auth-fund-${Date.now()}`;
    const admin = await createAdmin(tag);
    const plainUser = await createUser(`${tag}-plain`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    await expect(
      fundAgentFiatLiquidity(plainUser.id, agent.id, 'USD', 100_000n, `key-${tag}`)
    ).rejects.toThrow(/Admin privileges required/);
  });

  it('credits an existing bucket via adjustment and records ADMIN_ADJUSTMENT with correct sign', async () => {
    await cleanLiquidityFixtures();
    const tag = `adj-credit-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);

    const updated = await adjustAgentFiatLiquidity(
      superAdmin.id,
      agent.id,
      'USD',
      50_000n,
      'manual top-up',
      `adj-${tag}`
    );
    expect(updated!.totalBalance).toBe(150_000n);

    const ledger = await getAgentFiatLiquidityLedger(agent.id, 'USD');
    const adjustment = ledger.find((l) => l.type === 'ADMIN_ADJUSTMENT');
    expect(adjustment!.amount).toBe(50_000n);
    expect(adjustment!.totalBefore).toBe(100_000n);
    expect(adjustment!.totalAfter).toBe(150_000n);
  });

  it('debits an existing bucket via a negative adjustment', async () => {
    await cleanLiquidityFixtures();
    const tag = `adj-debit-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);

    const updated = await adjustAgentFiatLiquidity(
      superAdmin.id,
      agent.id,
      'USD',
      -30_000n,
      'correcting an over-funding',
      `adj-${tag}`
    );
    expect(updated!.totalBalance).toBe(70_000n);
  });

  it('rejects an adjustment that would take totalBalance negative', async () => {
    await cleanLiquidityFixtures();
    const tag = `adj-neg-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);

    await expect(
      adjustAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', -200_000n, 'too much', `adj-${tag}`)
    ).rejects.toThrow(/negative/);

    const liquidity = await getAgentFiatLiquidity(agent.id, 'USD');
    expect(liquidity.totalBalance).toBe(100_000n); // unchanged
  });

  it('rejects an adjustment that would take totalBalance below reservedBalance', async () => {
    await cleanLiquidityFixtures();
    const tag = `adj-reserved-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);

    // Simulate an active reservation directly (the reserve/consume path
    // belongs to withdrawal creation, out of scope for this service —
    // this only proves the adjustment-side invariant holds against it).
    await prisma.agentFiatLiquidity.update({
      where: { agentId_fiatCurrency: { agentId: agent.id, fiatCurrency: 'USD' } },
      data: { reservedBalance: 80_000n },
    });

    await expect(
      adjustAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', -30_000n, 'would eat reserved funds', `adj-${tag}`)
    ).rejects.toThrow(/reservedBalance/);
  });

  it('requires SUPER_ADMIN (not just ADMIN) to adjust an existing bucket', async () => {
    await cleanLiquidityFixtures();
    const tag = `auth-adj-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);

    await expect(
      adjustAgentFiatLiquidity(admin.id, agent.id, 'USD', 10_000n, 'plain admin should not be able to do this', `adj-${tag}`)
    ).rejects.toThrow(/SUPER_ADMIN/);
  });

  it('is idempotent: replaying the same adjustment idempotencyKey does not double-apply', async () => {
    await cleanLiquidityFixtures();
    const tag = `idem-adj-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);
    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);
    const key = `adj-${tag}`;

    await adjustAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 25_000n, 'top-up', key);
    await adjustAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 25_000n, 'top-up', key);

    const liquidity = await getAgentFiatLiquidity(agent.id, 'USD');
    expect(liquidity.totalBalance).toBe(125_000n); // not 150_000n
  });

  it('rejects an adjustment against a currency with no bucket yet', async () => {
    await cleanLiquidityFixtures();
    const tag = `no-bucket-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    await expect(
      adjustAgentFiatLiquidity(superAdmin.id, agent.id, 'EUR', 10_000n, 'no bucket exists', `adj-${tag}`)
    ).rejects.toThrow(/no fiat liquidity/);
  });

  it('never touches AgentInventory or AgentInventoryLedger', async () => {
    await cleanLiquidityFixtures();
    const tag = `no-inventory-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 100_000n, `fund-${tag}`);
    await adjustAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 20_000n, 'top-up', `adj-${tag}`);

    const inventory = await prisma.agentInventory.findUnique({ where: { agentId: agent.id } });
    expect(inventory).toBeNull();
    const inventoryLedgerCount = await prisma.agentInventoryLedger.count({ where: { agentId: agent.id } });
    expect(inventoryLedgerCount).toBe(0);
  });

  it('returns BigInt fiat values that JSON.stringify handles via an explicit serializer, not a native crash check', async () => {
    // Native JSON.stringify on a raw BigInt throws — this documents the
    // DTO contract any future route layer must follow: convert BigInt
    // fields to strings before serializing, never pass them through
    // untouched. This test asserts the service returns real BigInts (so a
    // route-layer serializer has a clear, typed field to convert) and that
    // the conversion those callers must perform is well-defined.
    await cleanLiquidityFixtures();
    const tag = `bigint-${Date.now()}`;
    const admin = await createAdmin(tag);
    const superAdmin = await createSuperAdmin(`${tag}-super`);
    const country = await createCountry(tag);
    const agent = await createActiveAgent(tag, country.id, admin);

    const liquidity = await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', 500_000n, `key-${tag}`);
    expect(typeof liquidity!.totalBalance).toBe('bigint');

    const dto = { ...liquidity, totalBalance: liquidity!.totalBalance.toString(), reservedBalance: liquidity!.reservedBalance.toString() };
    expect(() => JSON.stringify(dto)).not.toThrow();
    expect(JSON.parse(JSON.stringify(dto)).totalBalance).toBe('500000');
  });
});
