// Native PostgreSQL tests for held-deposit recovery. Synthetic data on an
// acknowledged loopback throwaway database only; no external service is used.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import type { Prisma } from '@prisma/client';
import { approveExistingMemberAgent } from './admin-account-service.js';
import { fundAgentInventory, getAgentInventory } from './inventory-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder, cancelAgentOrder, sweepExpiredAgentOrders } from './order-service.js';
import { openDispute } from './dispute-service.js';
import { disableOwnPaymentAccount } from './payment-account-service.js';
import { getPaymentRoom } from './payment-room-service.js';
import { reportLatePayment } from './late-payment-service.js';
import { publishUsdRate } from './usd-config-service.js';
import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import { nextTestCountryCode } from '../test/financial-policy-fixtures.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';
import {
  adjudicateHeldDeposit, claimHeldCase, declareHeldPayment, getHeldCase, heldAdjudicationPurpose,
  listHeldCases, markHeldCaseUnknown, releaseHeldCase, reassignHeldCase,
} from './held-deposit-recovery-service.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/playqube_scheduled_throwaway'
    || process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway') throw Error('Disposable local database required');

type Policy = { unpaid?: boolean; credit?: boolean; ret?: boolean; exception?: number };
/** Owner-only switch. Tests run as the throwaway database owner. */
async function setPolicy(p: Policy) {
  const on = Boolean(p.unpaid || p.credit || p.ret || p.exception);
  await prisma.$executeRaw`UPDATE held_deposit_recovery_policy SET "unpaidReleaseEnabled"=${p.unpaid ?? false},
    "coinCreditEnabled"=${p.credit ?? false}, "externalReturnEnabled"=${p.ret ?? false},
    "admissionExceptionMax"=${p.exception ?? 0},
    "approvedBy"=${on ? 'synthetic-test-approval' : null}, "approvalReference"=${on ? 'TEST-ONLY' : null}`;
}
beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='held_recovery_untrusted')
    THEN CREATE ROLE held_recovery_untrusted NOLOGIN; END IF; END $$`);
  await prisma.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO held_recovery_untrusted');
  await prisma.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO held_recovery_untrusted');
});
beforeEach(() => setPolicy({}));
afterAll(async () => {
  await setPolicy({});
  await prisma.$executeRawUnsafe('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM held_recovery_untrusted');
  await prisma.$executeRawUnsafe('REVOKE ALL ON SCHEMA public FROM held_recovery_untrusted');
  await prisma.$disconnect();
});

const settled = <T>(promise: Promise<T>) => promise.then(
  (value) => ({ ok: true as const, value }), (error) => ({ ok: false as const, error }));
const ref = (prefix: string) => `${prefix}-${randomUUID().slice(0, 13)}`.toUpperCase();
const TOKEN_IAT = 1_800_000_000;
// Prisma swallows errors raised at COMMIT, so tests run the deferred check explicitly.
const CHECK_NOW = 'SET CONSTRAINTS public.held_deposit_adjudication_complete IMMEDIATE';

async function world() {
  const tag = randomUUID();
  const user = (name: string, role?: 'ADMIN' | 'SUPER_ADMIN') =>
    prisma.user.create({ data: { username: `held_${name}_${tag}`, ...(role ? { role } : {}) } });
  const admin = await user('admin', 'ADMIN');
  const main = await user('main', 'SUPER_ADMIN');
  const otherMain = await user('main2', 'SUPER_ADMIN');
  const member = await user('member');
  const agentUser = await prisma.user.create({ data: { username: `held_agent_${tag}`, email: `${tag}@fixture.invalid` } });
  const country = await prisma.country.create({
    data: { code: await nextTestCountryCode(), name: 'Held recovery fixture', currencyCode: 'ETB', isActive: true, agentPaymentEnabled: true },
  });
  const agent = await approveExistingMemberAgent(admin.id, { email: agentUser.email!, displayName: 'Fixture agent', countryId: country.id });
  const method = await prisma.paymentMethodDefinition.create({
    data: { countryId: country.id, type: 'BANK_TRANSFER', name: `Fixture bank ${tag}`, isActive: true, fieldSchema: { requiredFields: ['accountNumber'] } },
  });
  await publishUsdRate(admin.id, country.id, fixtureEtbPolicy());
  await fundAgentInventory(admin.id, agent.agentId, 100000, randomUUID());
  const newAccount = () => prisma.agentPaymentAccount.create({
    data: { agentId: agent.agentId, countryId: country.id, methodDefId: method.id, status: 'APPROVED', accountDetails: { accountNumber: `TEST-ONLY-${randomUUID().slice(0, 8)}` } },
  });
  return { admin, main, otherMain, member, agentUser, agentId: agent.agentId, country, method, newAccount };
}
type World = Awaited<ReturnType<typeof world>>;

/** A real order, optionally advanced, then put on hold by the agent's own disable. */
async function heldOrder(w: World, stage: 'CREATED' | 'PAYMENT_SUBMITTED' | 'DISPUTE' = 'PAYMENT_SUBMITTED', buyerId = w.member.id) {
  const account = await w.newAccount();
  const { order } = await createAgentOrder(buyerId, {
    agentId: w.agentId, countryId: w.country.id, paymentAccountId: account.id, fiatAmount: 5000, idempotencyKey: randomUUID(),
  });
  if (stage !== 'CREATED') await submitOrderPayment(buyerId, order.id);
  if (stage === 'DISPUTE') await openDispute(buyerId, { orderId: order.id, reason: 'OTHER', description: 'Synthetic payment problem, no external transfer.', idempotencyKey: randomUUID() });
  const current = await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: account.id } });
  await disableOwnPaymentAccount(w.agentUser.id, account.id, current.updatedAt.toISOString());
  return { ...(await prisma.agentOrder.findUniqueOrThrow({ where: { id: order.id } })), accountId: account.id };
}
async function stepUp(userId: string, orderId: string, overrides: Partial<Prisma.StepUpVerificationUncheckedCreateInput> = {}) {
  return prisma.stepUpVerification.create({ data: {
    userId, purpose: heldAdjudicationPurpose(orderId), factorType: 'TOTP', tokenIat: TOKEN_IAT,
    verifiedAt: new Date(), expiresAt: new Date(Date.now() + 300_000), ...overrides,
  } });
}
const evidence = [{ kind: 'BANK_STATEMENT' as const, reference: 'SYNTHETIC-STATEMENT-1', description: 'Synthetic statement line, test only.' }];
const base = (expectedCaseVersion: number) => ({
  idempotencyKey: randomUUID(), expectedCaseVersion, reason: 'Synthetic adjudication reason for tests.', evidence, verified: true as const,
});
const received = (version: number, fiatAmount = 5000) => ({
  outcome: 'VERIFIED_PAYMENT_RECEIVED' as const, ...base(version),
  verifiedPaymentReference: ref('PAY'), verifiedAmount: fiatAmount, verifiedPaidAt: new Date().toISOString(),
});
const returned = (version: number) => ({
  outcome: 'VERIFIED_EXTERNAL_RETURN' as const, ...base(version),
  verifiedPaymentReference: ref('PAY'), verifiedAmount: 5000, verifiedPaidAt: new Date().toISOString(),
  returnReference: ref('RET'), returnedAmount: 5000, returnedAt: new Date().toISOString(),
});
const unpaid = (version: number) => ({ outcome: 'VERIFIED_UNPAID' as const, ...base(version) });
async function ready(w: World, orderId: string, admin = w.main) {
  const claim = await claimHeldCase(admin.id, orderId);
  await stepUp(admin.id, orderId);
  return claim!.version;
}
async function snapshot(w: World, orderId: string) {
  const [order, reservation, settlements, wallet, inventory, credits] = [
    await prisma.agentOrder.findUniqueOrThrow({ where: { id: orderId } }),
    await prisma.agentReservation.findUniqueOrThrow({ where: { orderId } }),
    await prisma.agentOrderSettlement.count({ where: { orderId } }),
    await prisma.wallet.findUnique({ where: { userId: w.member.id }, select: { coinsBalance: true } }),
    await getAgentInventory(w.agentId),
    await prisma.walletTransaction.count({ where: { referenceId: orderId } }),
  ];
  return { status: order.status, safetyHold: order.safetyHold, paymentSnapshot: order.paymentSnapshot, revision: order.paymentAccountRevision,
    reservation: reservation.status, settlements, coins: wallet?.coinsBalance ?? 0, total: inventory!.totalBalance, reserved: inventory!.reservedBalance, credits };
}
/** The agent's reserved balance always equals the sum of its ACTIVE reservations. */
async function expectInventoryConsistent(w: World) {
  const inventory = await getAgentInventory(w.agentId);
  const active = await prisma.agentReservation.aggregate({ where: { agentId: w.agentId, status: 'ACTIVE' }, _sum: { amount: true } });
  expect(inventory!.reservedBalance).toBe(active._sum.amount ?? 0);
  expect(inventory!.totalBalance).toBeGreaterThanOrEqual(inventory!.reservedBalance);
}

describe('existing fail-closed protections are preserved', () => {
  it('keeps every existing path closed for a held order and never clears the hold', async () => {
    const w = await world();
    const order = await heldOrder(w);
    const before = await snapshot(w, order.id);
    expect(before).toMatchObject({ status: 'PAYMENT_SUBMITTED', safetyHold: true, reservation: 'ACTIVE' });
    await expect(settleAgentOrder(w.agentUser.id, order.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(cancelAgentOrder(w.admin.id, order.id, undefined, 'staff', 'synthetic')).rejects.toMatchObject({ statusCode: 409 });
    for (const sql of [
      `UPDATE agent_orders SET "safetyHold"=false WHERE id='${order.id}'`,
      `UPDATE agent_orders SET status='CANCELLED' WHERE id='${order.id}'`,
      `UPDATE agent_orders SET status='COMPLETED' WHERE id='${order.id}'`,
      `UPDATE agent_orders SET "paymentSnapshot"='{"accountNumber":"ATTACKER"}' WHERE id='${order.id}'`,
      `UPDATE agent_reservations SET status='RELEASED' WHERE "orderId"='${order.id}'`,
      `UPDATE agent_reservations SET status='CONSUMED' WHERE "orderId"='${order.id}'`,
      `UPDATE agent_payment_accounts SET "safetyHold"=false WHERE id='${order.accountId}'`,
    ]) await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await snapshot(w, order.id)).toEqual(before);
  });

  it('ships disabled: with no approved policy every outcome is refused and nothing moves', async () => {
    const w = await world();
    const order = await heldOrder(w);
    const before = await snapshot(w, order.id);
    for (const build of [received, returned]) {
      const version = await ready(w, order.id);
      await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, build(version))).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(await snapshot(w, order.id)).toEqual(before);
    expect(await prisma.heldDepositAdjudication.count({ where: { orderId: order.id } })).toBe(0);
    // The confirmation was not consumed by a refused decision.
    expect(await prisma.stepUpVerification.count({ where: { userId: w.main.id, purpose: heldAdjudicationPurpose(order.id), consumedAt: null } })).toBe(2);
  });

  it('lets only the database owner change policy, and requires a recorded approval', async () => {
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE held_recovery_untrusted');
      await tx.$executeRawUnsafe(`UPDATE held_deposit_recovery_policy SET "coinCreditEnabled"=true, "approvedBy"='x', "approvalReference"='y'`);
    })).rejects.toThrow(/database owner/);
    await expect(prisma.$executeRawUnsafe('UPDATE held_deposit_recovery_policy SET "coinCreditEnabled"=true')).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('DELETE FROM held_deposit_recovery_policy')).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe('INSERT INTO held_deposit_recovery_policy (id) VALUES (true)')).rejects.toThrow();
    const [policy] = await prisma.$queryRaw<Array<Record<string, unknown>>>`SELECT * FROM held_deposit_recovery_policy`;
    expect(policy).toMatchObject({ unpaidReleaseEnabled: false, coinCreditEnabled: false, externalReturnEnabled: false, admissionExceptionMax: 0 });
  });
});

describe('authorization', () => {
  it('admits only an assigned, non-party main administrator with a fresh case-specific confirmation', async () => {
    await setPolicy({ credit: true, ret: true, unpaid: true });
    const w = await world();
    const order = await heldOrder(w);
    const other = await heldOrder(w);
    const before = await snapshot(w, order.id);
    // Ordinary administrators see the queue but neither case detail nor decisions.
    expect((await listHeldCases(w.admin.id)).canAdjudicate).toBe(false);
    for (const actor of [w.admin, w.member, w.agentUser]) {
      await expect(claimHeldCase(actor.id, order.id)).rejects.toMatchObject({ statusCode: 403 });
      await expect(getHeldCase(actor.id, order.id)).rejects.toMatchObject({ statusCode: 403 });
      await expect(adjudicateHeldDeposit(actor.id, TOKEN_IAT, order.id, received(1))).rejects.toMatchObject({ statusCode: 403 });
    }
    await expect(listHeldCases(w.member.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(listHeldCases(w.agentUser.id)).rejects.toMatchObject({ statusCode: 403 });
    // Unassigned main administrator.
    await stepUp(w.main.id, order.id);
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(1))).rejects.toMatchObject({ statusCode: 403 });
    const version = (await claimHeldCase(w.main.id, order.id))!.version;
    // Another main administrator cannot decide a case assigned to someone else.
    await stepUp(w.otherMain.id, order.id);
    await expect(adjudicateHeldDeposit(w.otherMain.id, TOKEN_IAT, order.id, received(version))).rejects.toMatchObject({ statusCode: 403 });
    await expect(claimHeldCase(w.otherMain.id, order.id)).rejects.toMatchObject({ statusCode: 409 });
    // Stale view of the case.
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version - 1))).rejects.toMatchObject({ statusCode: 409 });
    // Wrong token instance, a confirmation for another order, and an expired one.
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT + 1, order.id, received(version))).rejects.toMatchObject({ statusCode: 403 });
    await prisma.stepUpVerification.updateMany({ where: { userId: w.main.id, purpose: heldAdjudicationPurpose(order.id) }, data: { consumedAt: new Date() } });
    await stepUp(w.main.id, other.id);
    await stepUp(w.main.id, order.id, { expiresAt: new Date(Date.now() - 1000) });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version))).rejects.toMatchObject({ statusCode: 403, message: expect.stringMatching(/Step-up/) });
    // A demoted or suspended administrator loses authority immediately.
    await stepUp(w.main.id, order.id);
    await prisma.user.update({ where: { id: w.main.id }, data: { role: 'ADMIN' } });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version))).rejects.toMatchObject({ statusCode: 403 });
    await prisma.user.update({ where: { id: w.main.id }, data: { role: 'SUPER_ADMIN', status: 'SUSPENDED' } });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version))).rejects.toMatchObject({ statusCode: 403 });
    await prisma.user.update({ where: { id: w.main.id }, data: { status: 'ACTIVE' } });
    expect(await snapshot(w, order.id)).toEqual(before);
    expect(await prisma.heldDepositAdjudication.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('refuses a main administrator who is a party to the order, in the service and in the database', async () => {
    await setPolicy({ credit: true });
    const w = await world();
    const buyerMain = await prisma.user.create({ data: { username: `held_partymain_${randomUUID()}`, role: 'SUPER_ADMIN' } });
    const order = await heldOrder(w, 'PAYMENT_SUBMITTED', buyerMain.id);
    await expect(claimHeldCase(buyerMain.id, order.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(getHeldCase(buyerMain.id, order.id)).rejects.toMatchObject({ statusCode: 403 });
    // Even a fabricated assignment cannot get past the database trigger.
    const reservation = await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: order.id } });
    await prisma.heldDepositCase.create({ data: { orderId: order.id } });
    await prisma.heldDepositCase.update({ where: { orderId: order.id }, data: { status: 'ASSIGNED', assignedAdminId: buyerMain.id, assignedAt: new Date() } });
    const confirmation = await stepUp(buyerMain.id, order.id, { consumedAt: new Date() });
    await expect(prisma.heldDepositAdjudication.create({ data: {
      orderId: order.id, id: randomUUID(), outcome: 'VERIFIED_PAYMENT_RECEIVED', adminId: buyerMain.id, idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64), stepUpId: confirmation.id, caseVersion: 2, orderStatusBefore: 'PAYMENT_SUBMITTED', reservationId: reservation.id,
      coinAmount: order.coinAmount, fiatAmount: order.fiatAmount, reason: 'Synthetic direct insert.', evidence,
      verifiedPaymentReference: ref('PAY'), verifiedAmount: order.fiatAmount, verifiedPaidAt: new Date(), authorizedTxid: 0n,
    } })).rejects.toThrow(/party to the order/);
  });

  it('never exposes reasons, evidence or the trail to members, agents or ordinary administrators', async () => {
    await setPolicy({ ret: true });
    const w = await world();
    const order = await heldOrder(w, 'DISPUTE');
    const version = await ready(w, order.id);
    await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, returned(version));
    for (const actor of [w.member, w.agentUser, w.admin]) {
      const room = JSON.stringify(await getPaymentRoom(actor.id, 'deposit', order.id));
      expect(room).not.toMatch(/Synthetic adjudication reason|SYNTHETIC-STATEMENT|BANK_STATEMENT|requestHash|stepUpId/);
    }
    expect(JSON.stringify(await listHeldCases(w.admin.id))).not.toMatch(/Synthetic adjudication reason|SYNTHETIC-STATEMENT|accountNumber/);
    expect((await getPaymentRoom(w.member.id, 'deposit', order.id)).heldCase).toMatchObject({ state: 'RESOLVED_EXTERNAL_RETURN_RECORDED' });
    expect((await getPaymentRoom(w.agentUser.id, 'deposit', order.id)).heldCase).toMatchObject({ state: 'RESOLVED_EXTERNAL_RETURN_RECORDED', memberDeclaration: null });
    // The audit log carries the decision but not the evidence.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'HeldDepositCase', entityId: order.id, action: 'HELD_DEPOSIT_ADJUDICATED' } });
    expect(JSON.stringify(log.newData)).not.toMatch(/SYNTHETIC-STATEMENT|Synthetic adjudication reason/);
    const detail = await getHeldCase(w.main.id, order.id);
    expect(detail.adjudication).toMatchObject({ outcome: 'VERIFIED_EXTERNAL_RETURN', reason: 'Synthetic adjudication reason for tests.' });
    expect(detail.order.paymentSnapshot).toEqual(order.paymentSnapshot);
  });
});

describe('outcomes', () => {
  it('verified payment received: consumes the reservation, credits Coins once and writes one settlement witness', async () => {
    await setPolicy({ credit: true });
    const w = await world();
    const order = await heldOrder(w, 'PAYMENT_SUBMITTED');
    const before = await snapshot(w, order.id);
    const version = await ready(w, order.id);
    const args = received(version);
    const first = await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, args);
    expect(first).toMatchObject({ outcome: 'VERIFIED_PAYMENT_RECEIVED', orderStatus: 'COMPLETED', agentReservation: 'CONSUMED',
      coinsCredited: order.coinAmount, externalReturnRecorded: false, idempotent: false });
    const after = await snapshot(w, order.id);
    expect(after).toMatchObject({ status: 'COMPLETED', safetyHold: true, reservation: 'CONSUMED', settlements: 1,
      coins: before.coins + order.coinAmount, total: before.total - order.coinAmount, reserved: before.reserved - order.coinAmount });
    expect(after.paymentSnapshot).toEqual(before.paymentSnapshot);
    expect(after.revision).toBe(before.revision);
    const settlement = await prisma.agentOrderSettlement.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(settlement).toMatchObject({ coinAmount: order.coinAmount, releasedBy: w.main.id });
    // Retries with the same key and payload return the original result and move nothing.
    for (let i = 0; i < 3; i++) {
      expect(await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, args)).toEqual({ ...first, idempotent: true });
    }
    expect(await snapshot(w, order.id)).toEqual(after);
    // A different key, a changed payload or a second outcome all fail.
    await stepUp(w.main.id, order.id);
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, { ...args, idempotencyKey: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, { ...args, reason: 'A different synthetic reason.' })).rejects.toMatchObject({ statusCode: 409 });
    await setPolicy({ credit: true, ret: true });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, returned(version))).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot(w, order.id)).toEqual(after);
    expect(await prisma.heldDepositAdjudication.count({ where: { orderId: order.id } })).toBe(1);
    // Trail, audit and notifications were committed with the result.
    const events = await prisma.heldDepositCaseEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['OPENED', 'CLAIMED', 'ADJUDICATED']);
    expect(await prisma.auditLog.count({ where: { entity: 'HeldDepositCase', entityId: order.id, action: 'HELD_DEPOSIT_ADJUDICATED' } })).toBe(1);
    for (const userId of [w.member.id, w.agentUser.id])
      expect(await prisma.notification.count({ where: { userId, type: 'SYSTEM', data: { path: ['orderId'], equals: order.id } } })).toBe(1);
    expect((await getPaymentRoom(w.member.id, 'deposit', order.id)).heldCase).toMatchObject({ state: 'RESOLVED_COINS_CREDITED' });
    await expectInventoryConsistent(w);
  });

  it('verified external return: records the return, releases only the agent reservation and issues no Coin', async () => {
    await setPolicy({ ret: true, credit: true });
    const w = await world();
    const order = await heldOrder(w, 'DISPUTE');
    const before = await snapshot(w, order.id);
    const version = await ready(w, order.id);
    const args = returned(version);
    const outcome = await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, args);
    expect(outcome).toMatchObject({ orderStatus: 'CANCELLED', agentReservation: 'RELEASED', coinsCredited: 0, externalReturnRecorded: true });
    expect(await snapshot(w, order.id)).toMatchObject({ status: 'CANCELLED', safetyHold: true, reservation: 'RELEASED', settlements: 0,
      coins: before.coins, credits: before.credits, total: before.total, reserved: before.reserved - order.coinAmount });
    expect(await prisma.dispute.count({ where: { orderId: order.id, status: { not: 'RESOLVED' } } })).toBe(0);
    expect(await prisma.dispute.findFirstOrThrow({ where: { orderId: order.id } })).toMatchObject({ resolution: 'CANCEL', resolvedBy: w.main.id });
    expect(await prisma.heldDepositReferenceClaim.count({ where: { orderId: order.id } })).toBe(2);
    // The same transfer cannot back a second decision, as payment or as return.
    for (const reuse of [{ verifiedPaymentReference: args.verifiedPaymentReference }, { verifiedPaymentReference: args.returnReference },
      { returnReference: args.verifiedPaymentReference }]) {
      const second = await heldOrder(w, 'PAYMENT_SUBMITTED');
      const v = await ready(w, second.id);
      const beforeSecond = await snapshot(w, second.id);
      await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, second.id, { ...returned(v), ...reuse })).rejects.toMatchObject({ statusCode: 409 });
      expect(await snapshot(w, second.id)).toEqual(beforeSecond);
    }
    // No parallel late-payment record for a decided order (service and database).
    await expect(reportLatePayment(w.member.id, { orderId: order.id, idempotencyKey: randomUUID(), paymentReference: ref('LATE'),
      paidAmount: 5000, paidAt: new Date().toISOString(), description: 'Synthetic late report.' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(prisma.latePaymentCase.create({ data: { orderId: order.id, openedBy: w.member.id, idempotencyKey: randomUUID(),
      paymentReference: ref('LATE'), paidAmount: 5000, paidAt: new Date(), description: 'Synthetic direct insert.' } })).rejects.toThrow();
    await expectInventoryConsistent(w);
  });

  it('verified unpaid: needs the member\'s own declaration and is never inferred from silence', async () => {
    await setPolicy({ unpaid: true });
    const w = await world();
    const order = await heldOrder(w, 'CREATED');
    const before = await snapshot(w, order.id);
    let version = await ready(w, order.id);
    // No declaration, no screenshots, payment window long gone: still not "unpaid".
    await prisma.$executeRawUnsafe(`UPDATE agent_orders SET "createdAt" = "createdAt" - interval '3 days' WHERE id='${order.id}'`);
    expect(await sweepExpiredAgentOrders()).toMatchObject({ failed: 0 });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, unpaid(version))).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot(w, order.id)).toEqual(before);
    // Only the member may declare, and only about their own order.
    await expect(declareHeldPayment(w.agentUser.id, order.id, { declaration: 'NOT_PAID' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(declareHeldPayment(w.main.id, order.id, { declaration: 'NOT_PAID' })).rejects.toMatchObject({ statusCode: 403 });
    expect(await declareHeldPayment(w.member.id, order.id, { declaration: 'NOT_PAID' })).toMatchObject({ memberDeclaration: 'NOT_PAID' });
    // The declaration changed the case, so the earlier view is stale.
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, unpaid(version))).rejects.toMatchObject({ statusCode: 409 });
    version = (await claimHeldCase(w.main.id, order.id))!.version;
    const outcome = await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, unpaid(version));
    expect(outcome).toMatchObject({ orderStatus: 'CANCELLED', agentReservation: 'RELEASED', coinsCredited: 0, externalReturnRecorded: false });
    expect(await snapshot(w, order.id)).toMatchObject({ status: 'CANCELLED', safetyHold: true, reservation: 'RELEASED', settlements: 0,
      coins: before.coins, credits: before.credits, total: before.total, reserved: before.reserved - order.coinAmount });
    expect(await prisma.heldDepositReferenceClaim.count({ where: { orderId: order.id } })).toBe(0);
    await expectInventoryConsistent(w);
  });

  it('keeps uncertain cases held: claimed payments, retractions and amount mismatches are never resolved as unpaid', async () => {
    await setPolicy({ unpaid: true, credit: true, ret: true });
    const w = await world();
    // Marked paid: cannot be declared or adjudicated unpaid.
    const submitted = await heldOrder(w, 'PAYMENT_SUBMITTED');
    await expect(declareHeldPayment(w.member.id, submitted.id, { declaration: 'NOT_PAID' })).rejects.toMatchObject({ statusCode: 409 });
    let version = await ready(w, submitted.id);
    const before = await snapshot(w, submitted.id);
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, submitted.id, unpaid(version))).rejects.toMatchObject({ statusCode: 409 });
    // Partial or excess payments and partial returns stay under investigation.
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, submitted.id, received(version, 4999))).rejects.toMatchObject({ statusCode: 409 });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, submitted.id, { ...returned(version), returnedAmount: 4000 })).rejects.toMatchObject({ statusCode: 409 });
    const marked = await markHeldCaseUnknown(w.main.id, submitted.id, { expectedCaseVersion: version, note: 'Synthetic: bank confirmation pending.' });
    expect(marked).toMatchObject({ status: 'ASSIGNED', classification: 'PAYMENT_CLAIMED_UNKNOWN' });
    expect(await snapshot(w, submitted.id)).toEqual(before);
    expect((await getPaymentRoom(w.member.id, 'deposit', submitted.id)).heldCase).toMatchObject({ state: 'UNDER_REVIEW' });
    // "I paid" can replace "I did not pay", never the reverse.
    const created = await heldOrder(w, 'CREATED');
    await declareHeldPayment(w.member.id, created.id, { declaration: 'NOT_PAID' });
    await declareHeldPayment(w.member.id, created.id, { declaration: 'PAID' });
    await expect(declareHeldPayment(w.member.id, created.id, { declaration: 'NOT_PAID' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(prisma.$executeRawUnsafe(`UPDATE held_deposit_cases SET "memberDeclaration"='NOT_PAID' WHERE "orderId"='${created.id}'`)).rejects.toThrow(/cannot be withdrawn/);
    version = await ready(w, created.id);
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, created.id, unpaid(version))).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot(w, created.id)).toMatchObject({ status: 'CREATED', reservation: 'ACTIVE', safetyHold: true });
    // Handing a case back changes nothing financial and invalidates the old view.
    const released = await releaseHeldCase(w.main.id, created.id, { expectedCaseVersion: version, note: 'Synthetic hand-back for another reviewer.' });
    expect(released).toMatchObject({ status: 'OPEN' });
    await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, created.id, received(version))).rejects.toMatchObject({ statusCode: 403 });
    expect((await claimHeldCase(w.otherMain.id, created.id))!.status).toBe('ASSIGNED');
  });
});

describe('database-enforced integrity', () => {
  it('makes records immutable and rejects an adjudication that commits without its complete effect', async () => {
    await setPolicy({ credit: true, ret: true });
    const w = await world();
    const order = await heldOrder(w);
    const version = await ready(w, order.id);
    const before = await snapshot(w, order.id);
    const reservation = await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: order.id } });
    const confirmation = await stepUp(w.main.id, order.id, { consumedAt: new Date() });
    const direct = (overrides: Record<string, unknown> = {}) => ({
      orderId: order.id, id: randomUUID(), outcome: 'VERIFIED_PAYMENT_RECEIVED', adminId: w.main.id, idempotencyKey: randomUUID(),
      requestHash: 'b'.repeat(64), stepUpId: confirmation.id, caseVersion: version, orderStatusBefore: 'PAYMENT_SUBMITTED', reservationId: reservation.id,
      coinAmount: order.coinAmount, fiatAmount: order.fiatAmount, reason: 'Synthetic direct insert.', evidence,
      verifiedPaymentReference: ref('PAY'), verifiedAmount: order.fiatAmount, verifiedPaidAt: new Date(), authorizedTxid: 0n, ...overrides,
    });
    // Authorisation alone, with no effect, cannot commit.
    await expect(prisma.heldDepositAdjudication.create({ data: direct() })).rejects.toThrow(/without its order outcome/);
    // A half-applied decision cannot commit either.
    await expect(prisma.$transaction(async (tx) => {
      await tx.heldDepositAdjudication.create({ data: direct() });
      await tx.$executeRawUnsafe(`UPDATE agent_orders SET status='COMPLETED' WHERE id='${order.id}'`);
      await tx.$executeRawUnsafe(CHECK_NOW);
    })).rejects.toThrow(/without its reservation outcome/);
    // The gate opens only for the outcome's own effects.
    await expect(prisma.$transaction(async (tx) => {
      await tx.heldDepositAdjudication.create({ data: direct() });
      await tx.$executeRawUnsafe(`UPDATE agent_orders SET status='CANCELLED' WHERE id='${order.id}'`);
    })).rejects.toThrow(/safety hold/);
    await expect(prisma.$transaction(async (tx) => {
      await tx.heldDepositAdjudication.create({ data: direct() });
      await tx.$executeRawUnsafe(`UPDATE agent_reservations SET status='RELEASED' WHERE "orderId"='${order.id}'`);
    })).rejects.toThrow(/safety hold/);
    // Forged authority markers, amounts, confirmations and states are refused.
    for (const [overrides, message] of [
      [{ coinAmount: order.coinAmount + 1 }, /immutable amounts/], [{ orderStatusBefore: 'CREATED' }, /Order state changed/],
      [{ caseVersion: version + 5 }, /Case changed/], [{ stepUpId: randomUUID() }, /fresh case-specific confirmation/],
      [{ adminId: w.otherMain.id }, /assigned main administrator/], [{ adminId: w.admin.id }, /main administrator/],
      [{ reservationId: randomUUID() }, /reservation is not active/],
      [{ verifiedPaidAt: new Date(Date.now() + 86_400_000) }, /cannot be in the future/],
    ] as const) await expect(prisma.heldDepositAdjudication.create({ data: direct(overrides) })).rejects.toThrow(message);
    await expect(prisma.heldDepositReferenceClaim.create({ data: { methodId: order.paymentMethodDefId, reference: ref('PAY'), orderId: order.id, kind: 'PAYMENT' } })).rejects.toThrow();
    await expect(prisma.heldDepositCase.update({ where: { orderId: order.id }, data: { status: 'RESOLVED', classification: 'VERIFIED_PAYMENT_RECEIVED' } })).rejects.toThrow(/only by its adjudication/);
    expect(await snapshot(w, order.id)).toEqual(before);
    expect(await prisma.heldDepositAdjudication.count({ where: { orderId: order.id } })).toBe(0);

    // After a real decision, nothing about it can be changed or removed, and
    // its authority does not extend to any later transaction or other order.
    await stepUp(w.main.id, order.id);
    await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version));
    const otherOrder = await heldOrder(w);
    for (const sql of [
      `UPDATE held_deposit_adjudications SET outcome='VERIFIED_EXTERNAL_RETURN' WHERE "orderId"='${order.id}'`,
      `DELETE FROM held_deposit_adjudications WHERE "orderId"='${order.id}'`, 'TRUNCATE held_deposit_adjudications CASCADE',
      `UPDATE held_deposit_case_events SET detail='{}' WHERE "orderId"='${order.id}'`, `DELETE FROM held_deposit_case_events WHERE "orderId"='${order.id}'`,
      `DELETE FROM held_deposit_reference_claims WHERE "orderId"='${order.id}'`, `DELETE FROM held_deposit_cases WHERE "orderId"='${order.id}'`,
      `UPDATE held_deposit_cases SET status='OPEN' WHERE "orderId"='${order.id}'`,
      `UPDATE agent_orders SET status='CANCELLED' WHERE id='${order.id}'`, `UPDATE agent_orders SET "safetyHold"=false WHERE id='${order.id}'`,
      `UPDATE agent_orders SET status='COMPLETED' WHERE id='${otherOrder.id}'`, `UPDATE agent_reservations SET status='CONSUMED' WHERE "orderId"='${otherOrder.id}'`,
    ]) await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await snapshot(w, order.id)).toMatchObject({ status: 'COMPLETED', settlements: 1, safetyHold: true });
    expect(await snapshot(w, otherOrder.id)).toMatchObject({ status: 'PAYMENT_SUBMITTED', reservation: 'ACTIVE', safetyHold: true });
  });

  it('refuses the documented rollback once any adjudication exists', async () => {
    await setPolicy({ ret: true });
    const w = await world();
    const order = await heldOrder(w);
    await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, returned(await ready(w, order.id)));
    await setPolicy({});
    const script = readFileSync(new URL('../../../../docs/operations/held-deposit-recovery-rollback.sql', import.meta.url), 'utf8');
    const guard = script.slice(script.indexOf('DO $$'), script.indexOf('END $$;') + 'END $$;'.length);
    expect(guard).toMatch(/held_deposit_adjudications/);
    await expect(prisma.$executeRawUnsafe(guard)).rejects.toThrow(/adjudications exist and must be preserved/);
  });

  it('shares one transfer-reference namespace with late-payment recovery', async () => {
    await setPolicy({ ret: true });
    const w = await world();
    const order = await heldOrder(w);
    const version = await ready(w, order.id);
    const args = returned(version);
    await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, args);
    // A late-payment claim cannot reuse a reference an adjudication already holds,
    // and an adjudication cannot reuse one a late-payment case holds.
    const lateCaseId = randomUUID();
    await expect(prisma.$executeRaw`INSERT INTO late_payment_reference_claims ("methodId",reference,"caseId",kind)
      VALUES (${order.paymentMethodDefId},${args.verifiedPaymentReference},${lateCaseId},'PAYMENT')`).rejects.toThrow(/held-deposit adjudication/);
    expect(await prisma.heldDepositReferenceClaim.count({ where: { orderId: order.id } })).toBe(2);
  });
});

describe('concurrency and idempotency', () => {
  it('lets exactly one of two conflicting simultaneous decisions win', async () => {
    await setPolicy({ credit: true, ret: true });
    const w = await world();
    const order = await heldOrder(w);
    const before = await snapshot(w, order.id);
    const version = await ready(w, order.id);
    await stepUp(w.main.id, order.id);
    const results = await Promise.all([
      settled(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version))),
      settled(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, returned(version))),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: { statusCode: 409 } });
    const after = await snapshot(w, order.id);
    const credited = results[0].ok;
    expect(after).toMatchObject(credited
      ? { status: 'COMPLETED', reservation: 'CONSUMED', settlements: 1, coins: before.coins + order.coinAmount }
      : { status: 'CANCELLED', reservation: 'RELEASED', settlements: 0, coins: before.coins });
    expect(await prisma.heldDepositAdjudication.count({ where: { orderId: order.id } })).toBe(1);
    await expectInventoryConsistent(w);
  });

  it('collapses eight simultaneous retries of one decision into one credit', async () => {
    await setPolicy({ credit: true });
    const w = await world();
    const order = await heldOrder(w);
    const before = await snapshot(w, order.id);
    const version = await ready(w, order.id);
    const args = received(version);
    const results = await Promise.all(Array.from({ length: 8 }, () => settled(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, args))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => r.ok && r.value!.adjudicationId)).size).toBe(1);
    expect(results.filter((r) => r.ok && !r.value!.idempotent)).toHaveLength(1);
    expect(await snapshot(w, order.id)).toMatchObject({ settlements: 1, coins: before.coins + order.coinAmount,
      total: before.total - order.coinAmount, reserved: before.reserved - order.coinAmount });
    expect(await prisma.stepUpVerification.count({ where: { userId: w.main.id, purpose: heldAdjudicationPurpose(order.id), consumedAt: { not: null } } })).toBe(1);
    await expectInventoryConsistent(w);
  });

  it('races agent disable against payment submission, then adjudicates whichever state the hold froze', async () => {
    await setPolicy({ credit: true, unpaid: true });
    const w = await world();
    for (let round = 0; round < 4; round++) {
      const account = await w.newAccount();
      const { order } = await createAgentOrder(w.member.id, { agentId: w.agentId, countryId: w.country.id, paymentAccountId: account.id, fiatAmount: 5000, idempotencyKey: randomUUID() });
      const [disable, submit] = await Promise.all([
        settled(disableOwnPaymentAccount(w.agentUser.id, account.id, account.updatedAt.toISOString())),
        settled(submitOrderPayment(w.member.id, order.id)),
      ]);
      expect(disable.ok).toBe(true);
      const frozen = await snapshot(w, order.id);
      // The order is held with its reservation intact, in exactly the state the race produced.
      expect(frozen).toMatchObject({ safetyHold: true, reservation: 'ACTIVE', settlements: 0, status: submit.ok ? 'PAYMENT_SUBMITTED' : 'CREATED' });
      const version = await ready(w, order.id);
      // A decision that assumed the other state is refused by the database's state check.
      await expect(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, unpaid(version)))
        .rejects.toMatchObject({ statusCode: 409 });
      await adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version));
      expect(await snapshot(w, order.id)).toMatchObject({ status: 'COMPLETED', reservation: 'CONSUMED', settlements: 1 });
      await expectInventoryConsistent(w);
      await cancelAgentOrder(w.member.id, order.id).catch(() => undefined);
    }
  });

  it('waits behind an in-flight account disable and then decides on the committed state', async () => {
    await setPolicy({ credit: true });
    const w = await world();
    const order = await heldOrder(w);
    const version = await ready(w, order.id);
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // Holds the receiving account row exactly as a concurrent disable would.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM agent_payment_accounts WHERE id=${order.accountId} FOR UPDATE`;
      locked();
      await gate;
    }, { timeout: 30_000 });
    await isLocked;
    const decision = settled(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, received(version)));
    await waitForBlockedBackends(1, { queryLike: '%agent_payment_accounts%' });
    // Still parked on the account lock: nothing has been decided or moved.
    expect(await prisma.heldDepositAdjudication.count({ where: { orderId: order.id } })).toBe(0);
    release();
    await holder;
    expect(await decision).toMatchObject({ ok: true, value: { orderStatus: 'COMPLETED' } });
    await expectInventoryConsistent(w);
  });

  it('races adjudication against agent settlement, member cancel and the expiry sweep without a double effect', async () => {
    await setPolicy({ credit: true, ret: true });
    const w = await world();
    const order = await heldOrder(w);
    await prisma.$executeRawUnsafe(`UPDATE agent_orders SET "createdAt" = "createdAt" - interval '2 days' WHERE id='${order.id}'`).catch(() => undefined);
    const before = await snapshot(w, order.id);
    const version = await ready(w, order.id);
    const [decision, settle, cancel, sweep] = await Promise.all([
      settled(adjudicateHeldDeposit(w.main.id, TOKEN_IAT, order.id, returned(version))),
      settled(settleAgentOrder(w.agentUser.id, order.id)),
      settled(cancelAgentOrder(w.member.id, order.id)),
      settled(sweepExpiredAgentOrders()),
    ]);
    expect(decision.ok).toBe(true);
    expect(settle.ok).toBe(false);
    expect(cancel.ok).toBe(false);
    expect(sweep.ok).toBe(true);
    expect(await snapshot(w, order.id)).toMatchObject({ status: 'CANCELLED', reservation: 'RELEASED', settlements: 0,
      coins: before.coins, total: before.total, reserved: before.reserved - order.coinAmount });
    expect(await prisma.agentInventoryLedger.count({ where: { orderId: order.id, type: { in: ['RELEASE_UNUSED', 'CONSUME_ON_SETTLEMENT'] } } })).toBe(1);
    await expectInventoryConsistent(w);
  });
});

describe('order limit and monitoring', () => {
  it('keeps held unpaid orders inside the limit by default and bounds the approved exception', async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) await heldOrder(w, 'CREATED');
    const fresh = async () => {
      const account = await w.newAccount();
      return createAgentOrder(w.member.id, { agentId: w.agentId, countryId: w.country.id, paymentAccountId: account.id, fiatAmount: 5000, idempotencyKey: randomUUID() });
    };
    // Default policy: no exception. Held orders still occupy the limit.
    await expect(fresh()).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/safety hold/) });
    // Approved exception of 2: exactly two more orders, never unlimited.
    await setPolicy({ exception: 2 });
    await fresh();
    await fresh();
    await expect(fresh()).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.agentOrder.count({ where: { userId: w.member.id, status: 'CREATED' } })).toBe(5);
    // The exception itself is capped by the database.
    await expect(prisma.$executeRawUnsafe(`UPDATE held_deposit_recovery_policy SET "admissionExceptionMax"=4, "approvedBy"='x', "approvalReference"='y'`)).rejects.toThrow();
    // Held cases stay visible with their own bounded figures.
    const queue = await listHeldCases(w.admin.id);
    expect(queue.monitoring.openHeldOrders).toBeGreaterThanOrEqual(3);
    expect(queue.monitoring.maxOpenHeldPerMember).toBeGreaterThanOrEqual(3);
    expect(queue.monitoring.reservedCoins).toBeGreaterThanOrEqual(3 * 5000);
    expect(queue.monitoring.oldestHeldAt).toBeInstanceOf(Date);
    await expectInventoryConsistent(w);
  });
});


describe('audited nonfinancial reassignment', () => {
  for (const prior of ['ACTIVE', 'SUSPENDED', 'DEMOTED'] as const) {
    it(`takes over a ${prior} assignee without changing financial state or hold`, async () => {
      const w = await world(), order = await heldOrder(w);
      const claim = await claimHeldCase(w.main.id, order.id);
      if (prior === 'SUSPENDED') await prisma.user.update({ where: { id: w.main.id }, data: { status: 'SUSPENDED' } });
      if (prior === 'DEMOTED') await prisma.user.update({ where: { id: w.main.id }, data: { role: 'ADMIN' } });
      const before = await snapshot(w, order.id);
      const args = { expectedCaseVersion: claim!.version, note: 'Previous administrator is unavailable; taking responsibility.' };
      const result = await reassignHeldCase(w.otherMain.id, order.id, args);
      expect(result).toMatchObject({ status: 'ASSIGNED', version: claim!.version + 1 });
      expect(await snapshot(w, order.id)).toEqual(before);
      expect(await prisma.heldDepositCase.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ assignedAdminId: w.otherMain.id, classification: 'UNREVIEWED' });
      const events = await prisma.heldDepositCaseEvent.findMany({ where: { orderId: order.id, actorId: w.otherMain.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'CLAIMED', caseVersion: result!.version, detail: { action: 'REASSIGNED', previousAdminId: w.main.id, assignedAdminId: w.otherMain.id, note: args.note } });
      expect(await prisma.auditLog.count({ where: { entityId: order.id, action: 'HELD_DEPOSIT_CASE_REASSIGNED' } })).toBe(1);
      await expect(reassignHeldCase(w.otherMain.id, order.id, args)).rejects.toThrow();
      await expect(markHeldCaseUnknown(w.main.id, order.id, { expectedCaseVersion: result!.version, note: 'Old assignee cannot decide this case.' })).rejects.toThrow();
      expect(await snapshot(w, order.id)).toEqual(before);
    });
  }
  it('rejects non-main staff, inactive actors, parties, short reasons and stale versions atomically', async () => {
    const w = await world(), order = await heldOrder(w);
    const claim = await claimHeldCase(w.main.id, order.id);
    const args = { expectedCaseVersion: claim!.version, note: 'Assigned administrator is unavailable.' };
    const before = await snapshot(w, order.id);
    for (const actor of [w.admin.id, w.member.id, w.agentUser.id]) {
      await expect(reassignHeldCase(actor, order.id, args)).rejects.toThrow();
    }
    for (const actor of [w.member.id, w.agentUser.id]) {
      await prisma.user.update({ where: { id: actor }, data: { role: 'SUPER_ADMIN' } });
      await expect(reassignHeldCase(actor, order.id, args)).rejects.toThrow();
    }
    await prisma.user.update({ where: { id: w.otherMain.id }, data: { status: 'SUSPENDED' } });
    await expect(reassignHeldCase(w.otherMain.id, order.id, args)).rejects.toThrow();
    await prisma.user.update({ where: { id: w.otherMain.id }, data: { status: 'ACTIVE' } });
    await expect(reassignHeldCase(w.otherMain.id, order.id, { ...args, note: 'short' })).rejects.toThrow();
    await expect(reassignHeldCase(w.otherMain.id, order.id, { ...args, expectedCaseVersion: args.expectedCaseVersion + 1 })).rejects.toThrow();
    expect(await snapshot(w, order.id)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { entityId: order.id, action: 'HELD_DEPOSIT_CASE_REASSIGNED' } })).toBe(0);
    expect((await prisma.heldDepositCase.findUniqueOrThrow({ where: { orderId: order.id } })).version).toBe(args.expectedCaseVersion);
  });
  it('allows exactly one of competing expected-version takeovers', async () => {
    const w = await world(), order = await heldOrder(w);
    const third = await prisma.user.create({ data: { username: `third_${randomUUID()}`, role: 'SUPER_ADMIN' } });
    const claim = await claimHeldCase(w.main.id, order.id);
    const args = { expectedCaseVersion: claim!.version, note: 'Assigned administrator unavailable; taking case.' };
    const before = await snapshot(w, order.id);
    const results = await Promise.all([settled(reassignHeldCase(w.otherMain.id, order.id, args)), settled(reassignHeldCase(third.id, order.id, args))]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { entityId: order.id, action: 'HELD_DEPOSIT_CASE_REASSIGNED' } })).toBe(1);
    expect(await snapshot(w, order.id)).toEqual(before);
  });
});


it('serializes takeover against the prior assignee decision and refuses takeover of an open case', async () => {
  const w = await world(), order = await heldOrder(w);
  const claim = await claimHeldCase(w.main.id, order.id);
  const args = { expectedCaseVersion: claim!.version, note: 'Administrator unavailable; synthetic concurrency check.' };
  const before = await snapshot(w, order.id);
  const results = await Promise.all([
    settled(reassignHeldCase(w.otherMain.id, order.id, args)),
    settled(markHeldCaseUnknown(w.main.id, order.id, args)),
  ]);
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(await snapshot(w, order.id)).toEqual(before);
  const current = await prisma.heldDepositCase.findUniqueOrThrow({ where: { orderId: order.id } });
  expect(current.version).toBe(claim!.version + 1);
  await releaseHeldCase(current.assignedAdminId!, order.id, { ...args, expectedCaseVersion: current.version });
  const released = await prisma.heldDepositCase.findUniqueOrThrow({ where: { orderId: order.id } });
  await expect(reassignHeldCase(w.otherMain.id, order.id, { ...args, expectedCaseVersion: released.version })).rejects.toThrow();
  expect(await snapshot(w, order.id)).toEqual(before);
});
