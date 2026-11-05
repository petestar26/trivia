import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { approveExistingMemberAgent } from '../agents/admin-account-service.js';
import { fundAgentInventory } from '../agents/inventory-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder } from '../agents/order-service.js';
import { publishUsdRate } from '../agents/usd-config-service.js';
import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import {
  activateTestWithdrawalPolicy,
  nextTestCountryCode,
} from '../test/financial-policy-fixtures.js';
import { fundAgentFiatLiquidity } from '../withdrawals/liquidity-service.js';
import { createUserPayoutAccount } from '../withdrawals/payout-account-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import {
  createWithdrawal,
  claimPayout,
  submitPayment,
  cancelHeldWithdrawal,
  getAssignedWithdrawal,
} from '../withdrawals/withdrawal-service.js';
import {
  confirmWithdrawalReceipt,
  openUserWithdrawalDispute,
  claimWithdrawalDispute,
  resolveWithdrawalDispute,
} from '../withdrawals/dispute-service.js';
const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Disposable local database required');
afterAll(async () => {
  await prisma.platformGate.updateMany({
    where: { key: 'WITHDRAWAL_CREATE' },
    data: { enabled: false },
  });
  await prisma.$disconnect();
});
async function fixture() {
  const tag = randomUUID();
  const admin = await prisma.user.create({
    data: { username: `flow_admin_${tag}`, role: 'ADMIN' },
  });
  const member = await prisma.user.create({ data: { username: `flow_member_${tag}` } });
  const staff = await prisma.user.create({
    data: { username: `flow_agent_${tag}`, email: `${tag}@fixture.invalid` },
  });
  const country = await prisma.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Staff payment fixture',
      currencyCode: 'ETB',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
  const approved = await approveExistingMemberAgent(admin.id, {
    email: staff.email!,
    displayName: 'Fixture agent',
    countryId: country.id,
  });
  const method = await prisma.paymentMethodDefinition.create({
    data: {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: 'Fixture bank',
      isActive: true,
      fieldSchema: { requiredFields: ['accountNumber'] },
    },
  });
  const receiving = await prisma.agentPaymentAccount.create({
    data: {
      agentId: approved.agentId,
      countryId: country.id,
      methodDefId: method.id,
      status: 'APPROVED',
      accountDetails: { accountNumber: 'TEST-ONLY' },
    },
  });
  await publishUsdRate(admin.id, country.id, fixtureEtbPolicy());
  await activateTestWithdrawalPolicy(country.id, admin.id);
  await fundAgentInventory(admin.id, approved.agentId, 5000, randomUUID());
  await fundAgentFiatLiquidity(admin.id, approved.agentId, 'ETB', 10000n, randomUUID());
  const { order } = await createAgentOrder(member.id, {
    agentId: approved.agentId,
    countryId: country.id,
    paymentAccountId: receiving.id,
    fiatAmount: 5000,
    idempotencyKey: randomUUID(),
  });
  await submitOrderPayment(member.id, order.id);
  await settleAgentOrder(staff.id, order.id);
  const destination = await createUserPayoutAccount(member.id, {
    countryId: country.id,
    methodDefId: method.id,
    accountDetails: { accountNumber: 'MEMBER-TEST-ONLY' },
  });
  const quote = await createWithdrawalQuote(member.id, { countryId: country.id, coinAmount: 1000 });
  const args = { quoteId: quote.id, payoutAccountId: destination.id, idempotencyKey: randomUUID() };
  await createWithdrawal(member.id, args, 1000);
  const withdrawal = await prisma.withdrawal.findFirstOrThrow({ where: { userId: member.id, idempotencyKey: args.idempotencyKey } });
  return { admin, member, staff, agentId: approved.agentId, withdrawal, args };
}
it('completes a native Birr deposit and withdrawal once through separate member and agent actions', async () => {
  const f = await fixture();
  const id = f.withdrawal.id;
  expect(f.withdrawal.fiatAmount).toBe(1000n);
  expect(f.withdrawal.coinAmount).toBe(1000);
  expect((await createWithdrawal(f.member.id, f.args, 1000)).idempotent).toBe(true);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
  ).toBe(4000);
  await expect(getAssignedWithdrawal(f.admin.id, id)).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    claimPayout(f.member.id, id, { idempotencyKey: randomUUID() })
  ).rejects.toMatchObject({ statusCode: 403 });
  await claimPayout(f.staff.id, id, { idempotencyKey: randomUUID() });
  const submission = {
    idempotencyKey: randomUUID(),
    referenceNumber: `SYNTHETIC-${randomUUID()}`,
    note: 'Local test, no transfer',
  };
  await submitPayment(f.staff.id, id, submission);
  expect((await submitPayment(f.staff.id, id, submission)).idempotent).toBe(true);
  await expect(
    confirmWithdrawalReceipt(f.staff.id, id, { idempotencyKey: randomUUID() })
  ).rejects.toMatchObject({ statusCode: 403 });
  const confirm = { idempotencyKey: randomUUID() };
  await Promise.all([
    confirmWithdrawalReceipt(f.member.id, id, confirm),
    confirmWithdrawalReceipt(f.member.id, id, confirm),
  ]);
  expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
  expect(await prisma.withdrawalSettlement.count({ where: { withdrawalId: id } })).toBe(1);
  expect(
    await prisma.agentFiatLiquidity.findUniqueOrThrow({
      where: { agentId_fiatCurrency: { agentId: f.agentId, fiatCurrency: 'ETB' } },
    })
  ).toMatchObject({ totalBalance: 9000n, reservedBalance: 0n });
});
it('cancels a held payout once and returns the member balance without releasing twice', async () => {
  const f = await fixture();
  const key = { idempotencyKey: randomUUID() };
  await Promise.all([
    cancelHeldWithdrawal(f.member.id, f.withdrawal.id, key),
    cancelHeldWithdrawal(f.member.id, f.withdrawal.id, key),
  ]);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
  ).toBe(5000);
  expect(
    (await prisma.withdrawal.findUniqueOrThrow({ where: { id: f.withdrawal.id } })).status
  ).toBe('CANCELLED');
  expect(
    await prisma.agentFiatLiquidity.findUniqueOrThrow({
      where: { agentId_fiatCurrency: { agentId: f.agentId, fiatCurrency: 'ETB' } },
    })
  ).toMatchObject({ totalBalance: 10000n, reservedBalance: 0n });
});
it('routes a contested payout to an administrator and preserves an exact refund on replay', async () => {
  const f = await fixture(),
    id = f.withdrawal.id;
  await claimPayout(f.staff.id, id, { idempotencyKey: randomUUID() });
  await submitPayment(f.staff.id, id, {
    idempotencyKey: randomUUID(),
    referenceNumber: `SYNTHETIC-${randomUUID()}`,
  });
  const opened = await openUserWithdrawalDispute(f.member.id, id, {
    reason: 'FIAT_NOT_RECEIVED',
    description: 'Synthetic disputed transfer',
    idempotencyKey: randomUUID(),
  });
  const dispute = await prisma.withdrawalDispute.findFirstOrThrow({ where: { withdrawalId: id } });
  expect(opened).toBeDefined();
  await expect(
    claimWithdrawalDispute(f.staff.id, dispute.id, { idempotencyKey: randomUUID() })
  ).rejects.toMatchObject({ statusCode: 403 });
  await claimWithdrawalDispute(f.admin.id, dispute.id, { idempotencyKey: randomUUID() });
  const resolution = {
    outcome: 'CANCELLED' as const,
    resolutionNote: 'Test evidence confirms no external payment',
    idempotencyKey: randomUUID(),
  };
  await resolveWithdrawalDispute(f.admin.id, dispute.id, resolution);
  expect((await resolveWithdrawalDispute(f.admin.id, dispute.id, resolution)).idempotent).toBe(
    true
  );
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
  ).toBe(5000);
  expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
});
