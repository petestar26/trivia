import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { setCountryFlags } from './config-service.js';
import { publishUsdRate } from './usd-config-service.js';
import { createAgentOrder } from './order-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import { fixtureUsdPolicy } from '../test/payment-policy-fixture.js';
import { createAgentPaymentAccount } from './payment-account-service.js';
const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Throwaway database required');
afterAll(() => prisma.$disconnect());
async function fixture() {
  const tag = randomUUID();
  const admin = await prisma.user.create({ data: { username: `adm_${tag}`, role: 'ADMIN' } });
  const buyer = await prisma.user.create({ data: { username: `buy_${tag}` } });
  const agentUser = await prisma.user.create({ data: { username: `agt_${tag}` } });
  const country = await prisma.country.create({
    data: { code: tag.slice(0, 8), name: 'Readiness fixture', currencyCode: 'ETB', isActive: true },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: agentUser.id,
      countryId: country.id,
      status: 'ACTIVE',
      displayName: 'Fixture',
      contactEmail: 'fixture@example.test',
    },
  });
  const method = await prisma.paymentMethodDefinition.create({
    data: {
      countryId: country.id,
      type: 'MOBILE_PAYMENT',
      name: 'Fixture method',
      fieldSchema: { requiredFields: ['accountNumber'] },
      isActive: true,
    },
  });
  const account = await prisma.agentPaymentAccount.create({
    data: {
      agentId: agent.id,
      countryId: country.id,
      methodDefId: method.id,
      status: 'APPROVED',
      accountDetails: { accountNumber: 'fixture-only' },
    },
  });
  return { admin, buyer, agentUser, country, agent, method, account };
}
it('rejects legacy activation and under-floor payments without writing orders, quotes or reservations', async () => {
  const f = await fixture();
  await prisma.exchangeRateConfig.create({
    data: { countryId: f.country.id, fiatCurrency: 'ETB', coinsPerUnit: 0.0096, setBy: f.admin.id },
  });
  await expect(
    setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: true })
  ).rejects.toThrow(/USD pricing/);
  // Simulate old externally-enabled configuration: admission independently fails closed.
  await prisma.country.update({ where: { id: f.country.id }, data: { agentPaymentEnabled: true } });
  const args = {
    agentId: f.agent.id,
    countryId: f.country.id,
    paymentAccountId: f.account.id,
    fiatAmount: 10000,
    idempotencyKey: randomUUID(),
  };
  await expect(createAgentOrder(f.buyer.id, args)).rejects.toThrow(/USD pricing/);
  await expect(
    createWithdrawalQuote(f.buyer.id, { countryId: f.country.id, coinAmount: 100 })
  ).rejects.toThrow(/USD pricing/);
  expect(await prisma.agentOrder.count({ where: { userId: f.buyer.id } })).toBe(0);
  expect(await prisma.withdrawalQuote.count({ where: { userId: f.buyer.id } })).toBe(0);
  expect(await prisma.agentReservation.count({ where: { agentId: f.agent.id } })).toBe(0);
  await publishUsdRate(f.admin.id, f.country.id, { ...fixtureUsdPolicy(1), localPerUsd: '100' });
  await expect(createAgentOrder(f.buyer.id, args)).rejects.toThrow(/Minimum P2P deposit/);
  await expect(
    createWithdrawalQuote(f.buyer.id, { countryId: f.country.id, coinAmount: 384 })
  ).rejects.toThrow(/must exceed/);
});
it('requires a current rate and usable destination, and audits only successful activation', async () => {
  const f = await fixture();
  const rate = await publishUsdRate(f.admin.id, f.country.id, fixtureUsdPolicy(1));
  await prisma.agentPaymentAccount.update({
    where: { id: f.account.id },
    data: { status: 'REJECTED' },
  });
  await expect(
    setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: true })
  ).rejects.toThrow(/approved receiving account/);
  expect(
    await prisma.auditLog.count({
      where: { entityId: f.country.id, action: 'AGENT_CONFIG_COUNTRY_UPDATED' },
    })
  ).toBe(0);
  await prisma.agentPaymentAccount.update({
    where: { id: f.account.id },
    data: { status: 'APPROVED' },
  });
  expect(
    (await setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: true }))
      .agentPaymentEnabled
  ).toBe(true);
  await prisma.exchangeRateConfig.update({ where: { id: rate.id }, data: { isActive: false } });
  expect(
    (await setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: false }))
      .agentPaymentEnabled
  ).toBe(false);
  await expect(
    setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: true })
  ).rejects.toThrow(/No active/);
});
it('rejects cross-country receiving accounts and suspended users', async () => {
  const f = await fixture();
  const other = await prisma.country.create({
    data: {
      code: randomUUID().slice(0, 8),
      name: 'Other fixture',
      currencyCode: 'ETB',
      isActive: true,
    },
  });
  await expect(
    createAgentPaymentAccount(f.agentUser.id, {
      countryId: other.id,
      methodDefId: f.method.id,
      accountDetails: { accountNumber: 'fixture' },
    })
  ).rejects.toThrow(/match/);
  await prisma.user.update({ where: { id: f.agentUser.id }, data: { status: 'SUSPENDED' } });
  await expect(
    createAgentPaymentAccount(f.agentUser.id, {
      countryId: f.country.id,
      methodDefId: f.method.id,
      accountDetails: { accountNumber: 'fixture' },
    })
  ).rejects.toThrow(/active user/);
});
