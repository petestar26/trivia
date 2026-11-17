// Native ETB policy proof. Synthetic data only in an explicitly acknowledged fresh loopback database.
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const selected = vi.hoisted(() => ({ client: null as any }));
vi.mock('@socialplay/database', async () => {
  const actual =
    await vi.importActual<typeof import('@socialplay/database')>('@socialplay/database');
  const proxy = new Proxy(
    {},
    {
      get(_t, n) {
        const v = selected.client[n];
        return typeof v === 'function' ? v.bind(selected.client) : v;
      },
    }
  );
  return { ...actual, prisma: proxy, default: proxy };
});
import { approveExistingMemberAgent } from './admin-account-service.js';
import { fundAgentInventory, reserveInventory } from './inventory-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder } from './order-service.js';
import { publishUsdRate } from './usd-config-service.js';
import { priceAcceptedDeposit } from './usd-pricing.js';
import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import {
  nextTestCountryCode,
  activateTestWithdrawalPolicy,
} from '../test/financial-policy-fixtures.js';
import { fundAgentFiatLiquidity } from '../withdrawals/liquidity-service.js';
import { createUserPayoutAccount } from '../withdrawals/payout-account-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import { createWithdrawal } from '../withdrawals/withdrawal-service.js';
import {
  applyRuntimeAccess,
  verifyRuntimeAccessReadOnly,
} from '../scripts/ledger-runtime-access.js';
const u = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  u.hostname !== '127.0.0.1' ||
  u.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.ETB_NATIVE_DB_ACK !== 'fresh-synthetic'
)
  throw Error('Fresh acknowledged loopback database required');
const owner = new PrismaClient({ datasourceUrl: u.toString(), log: [] });
const role = 'etb_runtime_' + randomBytes(5).toString('hex'),
  password = randomBytes(24).toString('hex'),
  key = randomBytes(32).toString('hex');
let runtime: PrismaClient;
beforeAll(async () => {
  selected.client = owner;
  await owner.$executeRawUnsafe(
    `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`
  );
  const r = new URL(u);
  r.username = role;
  r.password = password;
  runtime = new PrismaClient({ datasourceUrl: r.toString(), log: [] });
});
beforeEach(() => {
  selected.client = owner;
});
afterAll(async () => {
  selected.client = owner;
  await owner.platformGate.updateMany({
    where: { key: 'WITHDRAWAL_CREATE' },
    data: { enabled: false },
  });
  await runtime?.$disconnect();
  await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
  await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
  await owner.$disconnect();
  vi.unstubAllEnvs();
});
async function world(balance = 1_000_000) {
  const tag = randomUUID();
  const admin = await owner.user.create({ data: { username: 'etb_admin_' + tag, role: 'ADMIN' } }),
    buyer = await owner.user.create({ data: { username: 'etb_buyer_' + tag } }),
    agentUser = await owner.user.create({
      data: { username: 'etb_agent_' + tag, email: tag + '@example.invalid' },
    });
  const country = await owner.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Synthetic ETB boundary',
      currencyCode: 'ETB',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
  const agent = await approveExistingMemberAgent(admin.id, {
    email: agentUser.email!,
    displayName: 'Synthetic agent',
    countryId: country.id,
  });
  const method = await owner.paymentMethodDefinition.create({
    data: {
      countryId: country.id,
      type: 'BANK_TRANSFER',
      name: 'Synthetic bank',
      isActive: true,
      fieldSchema: { requiredFields: ['accountNumber'] },
    },
  });
  const account = await owner.agentPaymentAccount.create({
    data: {
      agentId: agent.agentId,
      countryId: country.id,
      methodDefId: method.id,
      status: 'APPROVED',
      accountDetails: { accountNumber: 'SYNTHETIC-NO-REAL-ACCOUNT' },
    },
  });
  const policy = { ...fixtureEtbPolicy(), localPerUsd: '20' };
  const rate = await publishUsdRate(admin.id, country.id, policy);
  await fundAgentInventory(admin.id, agent.agentId, balance, randomUUID());
  return {
    admin,
    buyer,
    agentUser,
    agentId: agent.agentId,
    country,
    method,
    account,
    rate,
    policy,
    args: (fiatAmount = 10000) => ({
      agentId: agent.agentId,
      countryId: country.id,
      paymentAccountId: account.id,
      fiatAmount,
      idempotencyKey: randomUUID(),
    }),
  };
}
type World = Awaited<ReturnType<typeof world>>;
const counts = async () => ({
  orders: await owner.agentOrder.count(),
  reservations: await owner.agentReservation.count(),
  settlements: await owner.agentOrderSettlement.count(),
  wallet: await owner.walletTransaction.count(),
  quotes: await owner.withdrawalQuote.count(),
  withdrawals: await owner.withdrawal.count(),
});
async function fundedWithdrawalWorld() {
  const w = await world();
  await activateTestWithdrawalPolicy(w.country.id, w.admin.id);
  await fundAgentFiatLiquidity(w.admin.id, w.agentId, 'ETB', 500000n, randomUUID());
  const { order } = await createAgentOrder(w.buyer.id, w.args(100000));
  await submitOrderPayment(w.buyer.id, order.id);
  await settleAgentOrder(w.agentUser.id, order.id);
  const payout = await createUserPayoutAccount(w.buyer.id, {
    countryId: w.country.id,
    methodDefId: w.method.id,
    accountDetails: { accountNumber: 'SYNTHETIC-PAYOUT' },
  });
  return { ...w, payout };
}
it('persists inclusive deposit100 and withdrawal500, rejects99.99 and499.99 without writes', async () => {
  const w = await world();
  const before = await counts();
  await expect(createAgentOrder(w.buyer.id, w.args(9999))).rejects.toThrow('100 ETB');
  await expect(
    createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 49999 })
  ).rejects.toThrow('500 ETB');
  expect(await counts()).toEqual(before);
  const { order } = await createAgentOrder(w.buyer.id, w.args());
  expect(order.coinAmount).toBe(10000);
  expect(
    (await owner.agentReservation.findUniqueOrThrow({ where: { orderId: order.id } })).amount
  ).toBe(10000);
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  expect(q).toMatchObject({ coinAmount: 50000, fiatAmount: 50000n });
});
it('settles new100 at150ETB/USD once without the old300ETB floor', async () => {
  const w = await world();
  await publishUsdRate(w.admin.id, w.country.id, { ...w.policy, localPerUsd: '150' });
  const { order } = await createAgentOrder(w.buyer.id, w.args());
  const before = order.pricingSnapshot;
  await submitOrderPayment(w.buyer.id, order.id);
  await settleAgentOrder(w.agentUser.id, order.id);
  expect(
    (await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).coinsBalance
  ).toBe(10000);
  expect(
    (await owner.agentOrder.findUniqueOrThrow({ where: { id: order.id } })).pricingSnapshot
  ).toEqual(before);
  expect(await owner.agentOrderSettlement.count({ where: { orderId: order.id } })).toBe(1);
});
it('preserves pre-cutover50ETB accepted order settlement and idempotent replay without rewriting snapshot', async () => {
  const w = await world();
  const args = w.args(5000);
  const old = priceAcceptedDeposit(w.policy as any, 5000, w.policy);
  expect(old.snapshot).not.toHaveProperty('p2pMinimumPolicy');
  const order = await owner.$transaction(async (tx) => {
    const row = await tx.agentOrder.create({
      data: {
        orderNumber: 'SYNTHETIC-LEGACY-' + randomUUID(),
        userId: w.buyer.id,
        agentId: w.agentId,
        countryId: w.country.id,
        paymentMethodDefId: w.method.id,
        paymentAccountId: w.account.id,
        paymentSnapshot: w.account.accountDetails!,
        fiatAmount: 5000,
        fiatCurrency: 'ETB',
        exchangeRateConfigId: w.rate.id,
        exchangeRateValue: w.rate.coinsPerUnit,
        coinAmount: 5000,
        pricingSnapshot: old.snapshot,
        status: 'CREATED',
        idempotencyKey: args.idempotencyKey,
      },
    });
    const reservation = await tx.agentReservation.create({
      data: { orderId: row.id, agentId: w.agentId, amount: 5000, status: 'ACTIVE' },
    });
    await reserveInventory(tx, w.agentId, 5000, row.id, reservation.id);
    return row;
  });
  expect((await createAgentOrder(w.buyer.id, args)).idempotent).toBe(true);
  await submitOrderPayment(w.buyer.id, order.id);
  await settleAgentOrder(w.agentUser.id, order.id);
  const after = await owner.agentOrder.findUniqueOrThrow({ where: { id: order.id } });
  expect(after.pricingSnapshot).toEqual(order.pricingSnapshot);
  expect(after.status).toBe('COMPLETED');
  const settledCounts = await counts();
  expect((await createAgentOrder(w.buyer.id, args)).idempotent).toBe(true);
  await expect(settleAgentOrder(w.agentUser.id, order.id)).rejects.toThrow('current state');
  expect(await counts()).toEqual(settledCounts);
  expect(
    (await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).coinsBalance
  ).toBe(5000);
});
it('consumes new500 withdrawal quote exactly once under concurrent replay', async () => {
  const w = await fundedWithdrawalWorld();
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  const args = { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() };
  await Promise.all([
    createWithdrawal(w.buyer.id, args, 1000),
    createWithdrawal(w.buyer.id, args, 1000),
  ]);
  expect(await owner.withdrawal.count({ where: { userId: w.buyer.id } })).toBe(1);
  expect(
    (await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).coinsBalance
  ).toBe(50000);
  expect((await owner.withdrawalQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe(
    'CONSUMED'
  );
});
it('consumes an unchanged valid legacy100ETB withdrawal quote below the new500 floor', async () => {
  const w = await fundedWithdrawalWorld();
  const snapshot = {
    ...w.policy,
    direction: 'withdrawal',
    usdNumerator: '10000',
    usdDenominator: '2000',
    coinAmount: 10000,
    fiatMinor: '10000',
    rounding: 'FLOOR',
  };
  const q = await owner.withdrawalQuote.create({
    data: {
      userId: w.buyer.id,
      countryId: w.country.id,
      fiatCurrency: 'ETB',
      coinAmount: 10000,
      fiatAmount: 10000n,
      exchangeRateConfigId: w.rate.id,
      exchangeRateValue: w.rate.coinsPerUnit,
      requestHash: 'synthetic-old-quote-' + randomUUID(),
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60000),
      pricingSnapshot: snapshot,
    },
  });
  await createWithdrawal(
    w.buyer.id,
    { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() },
    1000
  );
  expect(
    (await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).coinsBalance
  ).toBe(90000);
  expect(
    (await owner.withdrawalQuote.findUniqueOrThrow({ where: { id: q.id } })).pricingSnapshot
  ).toEqual(snapshot);
});
it('rolls back deposit and reservation on genuine inventory shortfall', async () => {
  const w = await world(9999);
  const before = await counts();
  await expect(createAgentOrder(w.buyer.id, w.args())).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(
    (await owner.agentInventory.findUniqueOrThrow({ where: { agentId: w.agentId } }))
      .reservedBalance
  ).toBe(0);
});
it('serializes concurrent exact100 deposits at the three-order limit and replays one identity', async () => {
  const w = await world();
  const requests = Array.from({ length: 5 }, () => w.args());
  const result = await Promise.allSettled(
    requests.map((args) => createAgentOrder(w.buyer.id, args))
  );
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
  expect(await owner.agentOrder.count({ where: { userId: w.buyer.id } })).toBe(3);
  expect(
    (await owner.agentInventory.findUniqueOrThrow({ where: { agentId: w.agentId } }))
      .reservedBalance
  ).toBe(30000);
  const index = result.findIndex((r) => r.status === 'fulfilled');
  expect((await createAgentOrder(w.buyer.id, requests[index])).idempotent).toBe(true);
});
it('restricted runtime enforces boundaries and missing-policy permission fails without partial admission', async () => {
  const w = await world();
  expect(await applyRuntimeAccess(owner, role, 'synthetic-etb', key)).toEqual([]);
  expect(await verifyRuntimeAccessReadOnly(runtime, role)).toEqual([]);
  selected.client = runtime;
  await expect(createAgentOrder(w.buyer.id, w.args(9999))).rejects.toThrow('100 ETB');
  const { order } = await createAgentOrder(w.buyer.id, w.args());
  expect(order.coinAmount).toBe(10000);
  await expect(
    createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 49999 })
  ).rejects.toThrow('500 ETB');
  expect(
    (await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 }))
      .coinAmount
  ).toBe(50000);
  const before = await counts();
  await owner.$executeRawUnsafe(`REVOKE SELECT ON held_deposit_recovery_policy FROM "${role}"`);
  try {
    await expect(createAgentOrder(w.buyer.id, w.args())).rejects.toThrow();
    expect(await counts()).toEqual(before);
  } finally {
    expect(await applyRuntimeAccess(owner, role, 'synthetic-etb', key)).toEqual([]);
    selected.client = owner;
  }
});
it('withdrawal insufficient balance leaves quote, wallet and liquidity unchanged', async () => {
  const w = await fundedWithdrawalWorld();
  const q = await createWithdrawalQuote(w.buyer.id, {
    countryId: w.country.id,
    coinAmount: 150000,
  });
  const before = await counts(),
    wallet = await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } }),
    liquidity = await owner.agentFiatLiquidity.findUniqueOrThrow({
      where: { agentId_fiatCurrency: { agentId: w.agentId, fiatCurrency: 'ETB' } },
    });
  await expect(
    createWithdrawal(
      w.buyer.id,
      { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() },
      1000
    )
  ).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).toEqual(wallet);
  expect(
    await owner.agentFiatLiquidity.findUniqueOrThrow({
      where: { agentId_fiatCurrency: { agentId: w.agentId, fiatCurrency: 'ETB' } },
    })
  ).toEqual(liquidity);
  expect((await owner.withdrawalQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe(
    'ACTIVE'
  );
});
it('country pause after exact500 quote blocks consumption without debit', async () => {
  const w = await fundedWithdrawalWorld();
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  await owner.country.update({ where: { id: w.country.id }, data: { agentPaymentEnabled: false } });
  const before = await counts(),
    wallet = await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } });
  await expect(
    createWithdrawal(
      w.buyer.id,
      { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() },
      1000
    )
  ).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).toEqual(wallet);
  expect((await owner.withdrawalQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe(
    'ACTIVE'
  );
});
it('another member cannot consume an exact500 quote', async () => {
  const w = await fundedWithdrawalWorld();
  const q = await createWithdrawalQuote(w.buyer.id, { countryId: w.country.id, coinAmount: 50000 });
  const other = await owner.user.create({ data: { username: 'etb_other_' + randomUUID() } });
  const before = await counts();
  await expect(
    createWithdrawal(
      other.id,
      { quoteId: q.id, payoutAccountId: w.payout.id, idempotencyKey: randomUUID() },
      1000
    )
  ).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect((await owner.withdrawalQuote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe(
    'ACTIVE'
  );
});
it('restricted application connection settles exact100 under canonical signed approval', async () => {
  const w = await world();
  await publishUsdRate(w.admin.id, w.country.id, { ...w.policy, localPerUsd: '150' });
  expect(await applyRuntimeAccess(owner, role, 'synthetic-etb', key)).toEqual([]);
  vi.stubEnv('LEDGER_APPROVAL_SIGNING_KEY', key);
  vi.stubEnv('LEDGER_APPROVAL_KEY_ID', 'synthetic-etb');
  vi.stubEnv('LEDGER_RUNTIME_ROLE', role);
  selected.client = runtime;
  try {
    const { order } = await createAgentOrder(w.buyer.id, w.args());
    await submitOrderPayment(w.buyer.id, order.id);
    await settleAgentOrder(w.agentUser.id, order.id);
    expect(
      (await owner.wallet.findUniqueOrThrow({ where: { userId: w.buyer.id } })).coinsBalance
    ).toBe(10000);
    expect(await owner.agentOrderSettlement.count({ where: { orderId: order.id } })).toBe(1);
  } finally {
    selected.client = owner;
    vi.unstubAllEnvs();
  }
});
