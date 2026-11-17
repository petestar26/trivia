// Synthetic native proof; never accepts a remote or unacknowledged database.
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
const selected = vi.hoisted(() => ({ client: null as any }));
vi.mock('@socialplay/database', async () => {
  const actual = await vi.importActual<typeof import('@socialplay/database')>('@socialplay/database');
  const proxy = new Proxy({}, { get(_target, name) {
    const value = selected.client[name];
    return typeof value === 'function' ? value.bind(selected.client) : value;
  } });
  return { ...actual, prisma: proxy, default: proxy };
});
import { applyRuntimeAccess, verifyRuntimeAccessReadOnly } from './ledger-runtime-access.js';
import { HELD_CASE_UPDATE_COLUMNS, HELD_TABLE_CAPABILITIES, verifyHeldRecoveryCapabilities } from './held-recovery-capabilities.js';
import { approveExistingMemberAgent } from '../agents/admin-account-service.js';
import { fundAgentInventory } from '../agents/inventory-service.js';
import { createAgentOrder } from '../agents/order-service.js';
import { disableOwnPaymentAccount } from '../agents/payment-account-service.js';
import { claimHeldCase, reassignHeldCase } from '../agents/held-deposit-recovery-service.js';
import { publishUsdRate } from '../agents/usd-config-service.js';
import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import { nextTestCountryCode } from '../test/financial-policy-fixtures.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/playqube_scheduled_throwaway'
  || process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') throw Error('Acknowledged loopback throwaway required');
const owner = new PrismaClient({ datasourceUrl: url.toString(), log: [] });
const role = `held_runtime_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let runtime: PrismaClient;
const key = '24'.repeat(32);
const runtimePassword = randomBytes(24).toString('hex');
const setup = () => applyRuntimeAccess(owner, role, 'primary', key);
beforeAll(async () => {
  selected.client = owner;
  await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = runtimePassword;
  runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString(), log: [] });
});
afterAll(async () => {
  await runtime?.$disconnect();
  selected.client = owner;
  await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
  await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
  await owner.$disconnect();
});

it('requires post-migration grants, then verifies canonical restricted-runtime privileges', async () => {
  expect(await verifyHeldRecoveryCapabilities(runtime, role, true)).not.toEqual([]);
  expect(await setup()).toEqual([]);
  expect(await verifyRuntimeAccessReadOnly(runtime, role)).toEqual([]);
  const [identity] = await runtime.$queryRaw<any[]>`SELECT current_user, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls
    FROM pg_roles WHERE rolname=current_user`;
  expect(identity).toEqual({ current_user: role, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
});

it('admits a synthetic deposit as runtime; missing policy SELECT blocks readiness and rolls admission back', async () => {
  expect(await setup()).toEqual([]);
  selected.client = owner;
  const tag = randomUUID();
  const admin = await owner.user.create({ data: { username: `guard_admin_${tag}`, role: 'ADMIN' } });
  const buyer = await owner.user.create({ data: { username: `guard_buyer_${tag}` } });
  const agentUser = await owner.user.create({ data: { username: `guard_agent_${tag}`, email: `${tag}@fixture.invalid` } });
  const country = await owner.country.create({ data: { code: await nextTestCountryCode(), name: 'Synthetic runtime guard', currencyCode: 'ETB', isActive: true, agentPaymentEnabled: true } });
  const agent = await approveExistingMemberAgent(admin.id, { email: agentUser.email!, displayName: 'Synthetic agent', countryId: country.id });
  const method = await owner.paymentMethodDefinition.create({ data: { countryId: country.id, type: 'BANK_TRANSFER', name: 'Synthetic bank', isActive: true, fieldSchema: { requiredFields: ['accountNumber'] } } });
  await publishUsdRate(admin.id, country.id, fixtureEtbPolicy());
  await fundAgentInventory(admin.id, agent.agentId, 100000, randomUUID());
  const account = await owner.agentPaymentAccount.create({ data: { agentId: agent.agentId, countryId: country.id, methodDefId: method.id, status: 'APPROVED', accountDetails: { accountNumber: 'SYNTHETIC-NOT-A-REAL-ACCOUNT' } } });
  const args = () => ({ agentId: agent.agentId, countryId: country.id, paymentAccountId: account.id, fiatAmount: 10000, idempotencyKey: randomUUID() });
  selected.client = runtime;
  const admitted = await createAgentOrder(buyer.id, args());
  expect(admitted.order.status).toBe('CREATED');
  const counts = () => owner.$queryRaw<any[]>`SELECT
    (SELECT count(*)::int FROM agent_orders) AS orders,
    (SELECT count(*)::int FROM agent_reservations) AS reservations,
    (SELECT count(*)::int FROM agent_order_settlements) AS settlements,
    (SELECT count(*)::int FROM wallet_transactions) AS wallet_entries`;
  const before = await counts();
  await owner.$executeRawUnsafe(`REVOKE SELECT ON public.held_deposit_recovery_policy FROM "${role}"`);
  try {
    expect(await verifyRuntimeAccessReadOnly(runtime, role)).toContain(`${role} lacks SELECT on held_deposit_recovery_policy, which held-deposit recovery needs`);
    await expect(createAgentOrder(buyer.id, args())).rejects.toThrow();
    expect(await counts()).toEqual(before);
  } finally { expect(await setup()).toEqual([]); }
  expect(await verifyRuntimeAccessReadOnly(runtime, role)).toEqual([]);
  expect((await createAgentOrder(buyer.id, args())).order.status).toBe('CREATED');
  selected.client = owner;
  const previous = await owner.user.create({ data: { username: `previous_${tag}`, role: 'SUPER_ADMIN' } });
  const replacement = await owner.user.create({ data: { username: `replacement_${tag}`, role: 'SUPER_ADMIN' } });
  const currentAccount = await owner.agentPaymentAccount.findUniqueOrThrow({ where: { id: account.id } });
  await disableOwnPaymentAccount(agentUser.id, account.id, currentAccount.updatedAt.toISOString());
  const claim = await claimHeldCase(previous.id, admitted.order.id);
  const financial = async () => ({
    counts: await counts(),
    order: await owner.agentOrder.findUniqueOrThrow({ where: { id: admitted.order.id } }),
    reservation: await owner.agentReservation.findUniqueOrThrow({ where: { orderId: admitted.order.id } }),
    inventory: await owner.agentInventory.findUniqueOrThrow({ where: { agentId: agent.agentId } }),
  });
  const heldBefore = await financial();
  selected.client = runtime;
  const takeover = await reassignHeldCase(replacement.id, admitted.order.id, {
    expectedCaseVersion: claim!.version, note: 'Previous administrator unavailable; synthetic restricted-runtime test.',
  });
  expect(takeover!.version).toBe(claim!.version + 1);
  expect(await financial()).toEqual(heldBefore);
  expect(await owner.auditLog.count({ where: { entityId: admitted.order.id, action: 'HELD_DEPOSIT_CASE_REASSIGNED' } })).toBe(1);

});

it('detects each missing effective table and mutable-column capability in PostgreSQL', async () => {
  expect(await setup()).toEqual([]);
  for (const [table, privilege] of HELD_TABLE_CAPABILITIES) {
    await owner.$executeRawUnsafe(`REVOKE ${privilege} ON public."${table}" FROM "${role}"`);
    try { expect(await verifyHeldRecoveryCapabilities(runtime, role, true)).toContain(`${role} lacks ${privilege} on ${table}, which held-deposit recovery needs`); }
    finally { expect(await setup()).toEqual([]); }
  }
  for (const column of HELD_CASE_UPDATE_COLUMNS) {
    // Remove the effective table grant first; revoking a column alone cannot
    // override table-level UPDATE. Regrant the non-target columns explicitly.
    await owner.$executeRawUnsafe(`REVOKE UPDATE ON public.held_deposit_cases FROM "${role}"`);
    const columns = HELD_CASE_UPDATE_COLUMNS.filter(c => c !== column).map(c => `"${c}"`).join(',');
    await owner.$executeRawUnsafe(`GRANT UPDATE (${columns}) ON public.held_deposit_cases TO "${role}"`);
    await owner.$executeRawUnsafe(`REVOKE UPDATE ("${column}") ON public.held_deposit_cases FROM "${role}"`);
    try { expect(await verifyHeldRecoveryCapabilities(runtime, role, true)).toContain(`${role} cannot update held_deposit_cases.${column}, which held-deposit recovery needs`); }
    finally { expect(await setup()).toEqual([]); }
  }
});
