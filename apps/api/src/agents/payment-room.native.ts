import { randomUUID } from 'node:crypto';
import { credentialDb } from './credential-database.js';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { approveExistingMemberAgent } from './admin-account-service.js';
import { fundAgentInventory } from './inventory-service.js';
import {
  createAgentOrder,
  submitOrderPayment,
  settleAgentOrder,
  cancelAgentOrder,
} from './order-service.js';
import { openDispute, claimDispute, resolveDispute } from './dispute-service.js';
import {
  getPaymentRoom,
  postPaymentMessage,
  getPaymentAttachment,
} from './payment-room-service.js';
import { reportLatePayment, listLatePayments } from './late-payment-service.js';
import { publishUsdRate } from './usd-config-service.js';
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
} from '../withdrawals/withdrawal-service.js';
import {
  openPartyWithdrawalDispute,
  claimWithdrawalDispute,
  resolveWithdrawalDispute,
  confirmWithdrawalReceipt,
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
async function fixture(withdraw = false) {
  const tag = randomUUID();
  const admin = await prisma.user.create({
    data: { username: `room_admin_${tag}`, role: 'ADMIN' },
  });
  const member = await prisma.user.create({ data: { username: `room_member_${tag}` } });
  const outsider = await prisma.user.create({ data: { username: `room_outsider_${tag}` } });
  const agentUser = await prisma.user.create({
    data: { username: `room_agent_${tag}`, email: `${tag}@fixture.invalid` },
  });
  const country = await prisma.country.create({
    data: {
      code: await nextTestCountryCode(),
      name: 'Payment room fixture',
      currencyCode: 'ETB',
      isActive: true,
      agentPaymentEnabled: true,
    },
  });
  const agent = await approveExistingMemberAgent(credentialDb, admin.id, {
    email: agentUser.email!,
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
  const account = await prisma.agentPaymentAccount.create({
    data: {
      agentId: agent.agentId,
      countryId: country.id,
      methodDefId: method.id,
      status: 'APPROVED',
      accountDetails: { accountNumber: 'TEST-ONLY-123456' },
    },
  });
  await publishUsdRate(admin.id, country.id, fixtureEtbPolicy());
  await fundAgentInventory(admin.id, agent.agentId, 50000, randomUUID());
  const orderArgs = {
    agentId: agent.agentId,
    countryId: country.id,
    paymentAccountId: account.id,
    fiatAmount: 5000,
    idempotencyKey: randomUUID(),
  };
  const { order } = await createAgentOrder(member.id, orderArgs);
  const f = {
    admin,
    member,
    outsider,
    agentUser,
    agentId: agent.agentId,
    country,
    method,
    order,
    orderArgs,
  };
  if (!withdraw) return { ...f, withdrawal: null, payoutAccountId: null };
  await submitOrderPayment(member.id, order.id);
  await settleAgentOrder(agentUser.id, order.id);
  await activateTestWithdrawalPolicy(country.id, admin.id);
  await fundAgentFiatLiquidity(admin.id, agent.agentId, 'ETB', 10000n, randomUUID());
  const destination = await createUserPayoutAccount(member.id, {
    countryId: country.id,
    methodDefId: method.id,
    accountDetails: { accountNumber: 'MEMBER-TEST-98765' },
  });
  const quote = await createWithdrawalQuote(member.id, { countryId: country.id, coinAmount: 1000 });
  await createWithdrawal(
    member.id,
    { quoteId: quote.id, payoutAccountId: destination.id, idempotencyKey: randomUUID() },
    1000
  );
  const withdrawal = await prisma.withdrawal.findFirstOrThrow({ where: { userId: member.id } });
  return { ...f, withdrawal, payoutAccountId: destination.id };
}
const appeal = () => ({
  reason: 'OTHER' as const,
  description: 'Synthetic payment problem, no external transfer.',
  idempotencyKey: randomUUID(),
});
it('shows private immutable order terms only to the two parties or support', async () => {
  const f = await fixture();
  expect(await getPaymentRoom(f.member.id, 'deposit', f.order.id)).toMatchObject({
    role: 'member',
    coinAmount: 5000,
    fiatAmount: '5000',
    hold: { status: 'ACTIVE' },
    actions: { appeal: true, markPaid: true, release: false },
  });
  expect(await getPaymentRoom(f.agentUser.id, 'deposit', f.order.id)).toMatchObject({
    role: 'agent',
    actions: { appeal: true, markPaid: false },
  });
  expect((await getPaymentRoom(f.admin.id, 'deposit', f.order.id)).paymentSnapshot).toBeNull();
  await expect(getPaymentRoom(f.outsider.id, 'deposit', f.order.id)).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(await prisma.wallet.findUnique({ where: { userId: f.member.id } })).toBeNull();
});
it('deduplicates messages and keeps receipt bytes private, durable and immutable', async () => {
  const f = await fixture(),
    args = {
      body: 'Transfer receipt for this order',
      idempotencyKey: randomUUID(),
      attachment: {
        name: 'receipt.png',
        mimeType: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      },
    };
  const [one, two] = await Promise.all([
    postPaymentMessage(f.member.id, 'deposit', f.order.id, args),
    postPaymentMessage(f.member.id, 'deposit', f.order.id, args),
  ]);
  expect(one.message.id).toBe(two.message.id);
  expect(await prisma.paymentOrderMessage.count({ where: { orderId: f.order.id } })).toBe(1);
  const room = await getPaymentRoom(f.agentUser.id, 'deposit', f.order.id);
  expect(JSON.stringify(room)).not.toContain(args.attachment.base64);
  expect(room.messages[0].role).toBe('member');
  expect(
    (await getPaymentAttachment(f.agentUser.id, 'deposit', f.order.id, one.message.id))
      .attachmentBytes?.length
  ).toBeGreaterThan(12);
  await expect(
    getPaymentAttachment(f.outsider.id, 'deposit', f.order.id, one.message.id)
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    postPaymentMessage(f.member.id, 'deposit', f.order.id, { ...args, body: 'changed' })
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    postPaymentMessage(f.member.id, 'deposit', f.order.id, {
      body: 'fake',
      idempotencyKey: randomUUID(),
      attachment: {
        name: 'fake.png',
        mimeType: 'image/png',
        base64: Buffer.from('<html>unsafe attachment</html>').toString('base64'),
      },
    })
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(
    prisma.paymentOrderMessage.update({ where: { id: one.message.id }, data: { body: 'tampered' } })
  ).rejects.toThrow(/append-only/);
});
it('allows either deposit party to appeal before marking paid and preserves reserved funds', async () => {
  for (const party of ['member', 'agentUser'] as const) {
    const f = await fixture(),
      args = { ...appeal(), orderId: f.order.id };
    const { dispute } = await openDispute(f[party].id, args);
    await expect(cancelAgentOrder(f.member.id, f.order.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(submitOrderPayment(f.member.id, f.order.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect((await getPaymentRoom(f.member.id, 'deposit', f.order.id)).hold.status).toBe('ACTIVE');
    await expect(
      postPaymentMessage(f.admin.id, 'deposit', f.order.id, {
        body: 'Unclaimed review',
        idempotencyKey: randomUUID(),
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await claimDispute(f.admin.id, dispute.id);
    await postPaymentMessage(f.admin.id, 'deposit', f.order.id, {
      body: 'Reviewing both parties',
      idempotencyKey: randomUUID(),
    });
    await resolveDispute(f.admin.id, dispute.id, 'RELEASE', 'Synthetic evidence reviewed');
    expect(
      (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
    ).toBe(5000);
    await expect(
      resolveDispute(f.admin.id, dispute.id, 'RELEASE', 'Duplicate')
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.agentOrderSettlement.count({ where: { orderId: f.order.id } })).toBe(1);
  }
});
it('shows agent-reported late payments to both parties without crediting a wallet', async () => {
  const f = await fixture();
  await cancelAgentOrder(f.member.id, f.order.id);
  await reportLatePayment(f.agentUser.id, {
    orderId: f.order.id,
    idempotencyKey: randomUUID(),
    paymentReference: `SYNTHETIC-${randomUUID()}`,
    paidAmount: 5000,
    paidAt: new Date().toISOString(),
    description: 'Synthetic late transfer report',
  });
  expect(await listLatePayments(f.member.id)).toHaveLength(1);
  expect(await listLatePayments(f.agentUser.id)).toHaveLength(1);
  expect(await listLatePayments(f.outsider.id)).toHaveLength(0);
  expect((await getPaymentRoom(f.member.id, 'deposit', f.order.id)).recovery?.status).toBe('OPEN');
  expect(await prisma.wallet.findUnique({ where: { userId: f.member.id } })).toBeNull();
});
it('supports both withdrawal parties in every held phase and refunds once through independent review', async () => {
  for (const phase of ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED'])
    for (const party of ['member', 'agentUser'] as const) {
      const f = await fixture(true),
        id = f.withdrawal!.id;
      if (phase !== 'HELD') await claimPayout(f.agentUser.id, id, { idempotencyKey: randomUUID() });
      if (phase === 'PAYMENT_SUBMITTED')
        await submitPayment(f.agentUser.id, id, {
          idempotencyKey: randomUUID(),
          referenceNumber: `SYNTHETIC-${randomUUID()}`,
        });
      const args = appeal();
      const { dispute } = await openPartyWithdrawalDispute(f[party].id, id, args);
      expect((await openPartyWithdrawalDispute(f[party].id, id, args)).idempotent).toBe(true);
      expect((await getPaymentRoom(f.member.id, 'withdrawal', id)).hold.status).toBe('ACTIVE');
      await expect(
        cancelHeldWithdrawal(f.member.id, id, { idempotencyKey: randomUUID() })
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        confirmWithdrawalReceipt(f.member.id, id, { idempotencyKey: randomUUID() })
      ).rejects.toMatchObject({ statusCode: 409 });
      await claimWithdrawalDispute(f.admin.id, dispute.id, { idempotencyKey: randomUUID() });
      const resolution = {
        outcome: 'CANCELLED' as const,
        resolutionNote: 'Synthetic evidence: no transfer, return hold',
        idempotencyKey: randomUUID(),
      };
      await resolveWithdrawalDispute(f.admin.id, dispute.id, resolution);
      await resolveWithdrawalDispute(f.admin.id, dispute.id, resolution);
      expect(
        (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
      ).toBe(5000);
      expect(await prisma.withdrawalSettlement.count({ where: { withdrawalId: id } })).toBe(1);
    }
});
it('requires verified transfer details before completing a pre-payment withdrawal appeal', async () => {
  const f = await fixture(true),
    id = f.withdrawal!.id;
  await expect(openPartyWithdrawalDispute(f.outsider.id, id, appeal())).rejects.toMatchObject({
    statusCode: 403,
  });
  const { dispute } = await openPartyWithdrawalDispute(f.agentUser.id, id, appeal());
  await claimWithdrawalDispute(f.admin.id, dispute.id, { idempotencyKey: randomUUID() });
  const resolution = {
    outcome: 'COMPLETED' as const,
    resolutionNote: 'Synthetic transfer verified',
    idempotencyKey: randomUUID(),
  };
  await expect(resolveWithdrawalDispute(f.admin.id, dispute.id, resolution)).rejects.toMatchObject({
    statusCode: 400,
  });
  await resolveWithdrawalDispute(f.admin.id, dispute.id, {
    ...resolution,
    adminVerifiedPayment: {
      referenceNumber: `SYNTHETIC-${randomUUID()}`,
      paymentOccurredAt: new Date(),
    },
  });
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
  ).toBe(4000);
  expect(
    (await prisma.withdrawalHold.findUniqueOrThrow({ where: { withdrawalId: id } })).status
  ).toBe('CONSUMED');
});
it('serializes appeal against release without double-crediting or dropping a hold', async () => {
  const f = await fixture();
  await submitOrderPayment(f.member.id, f.order.id);
  const results = await Promise.allSettled([
    openDispute(f.member.id, { ...appeal(), orderId: f.order.id }),
    settleAgentOrder(f.agentUser.id, f.order.id),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const order = await prisma.agentOrder.findUniqueOrThrow({ where: { id: f.order.id } }),
    hold = await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: f.order.id } });
  expect(hold.status).toBe(order.status === 'COMPLETED' ? 'CONSUMED' : 'ACTIVE');
  expect(await prisma.agentOrderSettlement.count({ where: { orderId: f.order.id } })).toBe(
    order.status === 'COMPLETED' ? 1 : 0
  );
});

it('blocks suspended agents on new deposits and withdrawals without reserving or debiting', async () => {
  const f = await fixture(true);
  await cancelHeldWithdrawal(f.member.id, f.withdrawal!.id, { idempotencyKey: randomUUID() });
  await prisma.user.update({ where: { id: f.agentUser.id }, data: { status: 'SUSPENDED' } });
  const before = await prisma.agentInventory.findUniqueOrThrow({ where: { agentId: f.agentId } });
  await expect(
    createAgentOrder(f.member.id, { ...f.orderArgs, idempotencyKey: randomUUID() })
  ).rejects.toMatchObject({ statusCode: 409 });
  const quote = await createWithdrawalQuote(f.member.id, {
    countryId: f.country.id,
    coinAmount: 1000,
  });
  await expect(
    createWithdrawal(
      f.member.id,
      { quoteId: quote.id, payoutAccountId: f.payoutAccountId!, idempotencyKey: randomUUID() },
      1000
    )
  ).rejects.toThrow(/agent|liquidity/i);
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
  ).toBe(5000);
  expect(await prisma.withdrawal.count({ where: { userId: f.member.id } })).toBe(1);
  expect(await prisma.agentInventory.findUniqueOrThrow({ where: { agentId: f.agentId } })).toEqual(
    before
  );
  await expect(getPaymentRoom(f.agentUser.id, 'deposit', f.order.id)).rejects.toMatchObject({
    statusCode: 403,
  });
});
it('keeps cross-order retries separate and paginates tied-time messages without exposing another order', async () => {
  const f = await fixture();
  const { order: second } = await createAgentOrder(f.member.id, {
    ...f.orderArgs,
    idempotencyKey: randomUUID(),
  });
  const key = randomUUID();
  const attempts = await Promise.allSettled(
    [f.order.id, second.id].map((id) =>
      postPaymentMessage(f.member.id, 'deposit', id, { body: 'test', idempotencyKey: key })
    )
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(
    attempts
      .filter((r) => r.status === 'rejected')
      .map((r) => (r as PromiseRejectedResult).reason.statusCode)
  ).toEqual([409]);
  const now = new Date();
  await prisma.paymentOrderMessage.createMany({
    data: Array.from({ length: 55 }, (_, i) => ({
      orderId: f.order.id,
      authorId: f.member.id,
      authorRole: 'member',
      body: `Message ${i}`,
      idempotencyKey: randomUUID(),
      requestHash: 'synthetic',
      createdAt: now,
    })),
  });
  const first = await getPaymentRoom(f.member.id, 'deposit', f.order.id);
  const secondPage = await getPaymentRoom(f.agentUser.id, 'deposit', f.order.id, first.nextCursor!);
  expect(first.messages).toHaveLength(50);
  expect(new Set([...first.messages, ...secondPage.messages].map((m) => m.id)).size).toBe(
    await prisma.paymentOrderMessage.count({ where: { orderId: f.order.id } })
  );
  await expect(
    getPaymentRoom(f.member.id, 'deposit', second.id, first.nextCursor!)
  ).rejects.toMatchObject({ statusCode: 400 });
});
it('runtime can append payment evidence but cannot edit, delete, truncate or replace its guard', async () => {
  const f = await fixture(),
    role = `payment_room_runtime_${randomUUID().replaceAll('-', '')}`;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
  try {
    await prisma.$executeRaw`SELECT public.ledger_apply_runtime_grants(${role})`;
    const row = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      return tx.paymentOrderMessage.create({
        data: {
          orderId: f.order.id,
          authorId: f.member.id,
          authorRole: 'member',
          body: 'Durable evidence',
          idempotencyKey: randomUUID(),
          requestHash: 'synthetic',
        },
      });
    });
    const [rights] = await prisma.$queryRaw<
      { read: boolean; append: boolean; mutate: boolean; columnUpdate: boolean }[]
    >`SELECT has_table_privilege(${role},'public.payment_order_messages','SELECT') AS read,has_table_privilege(${role},'public.payment_order_messages','INSERT') AS append,has_table_privilege(${role},'public.payment_order_messages','UPDATE,DELETE,TRUNCATE,TRIGGER') AS mutate,has_any_column_privilege(${role},'public.payment_order_messages','UPDATE') AS "columnUpdate"`;
    expect(rights).toEqual({ read: true, append: true, mutate: false, columnUpdate: false });
    for (const sql of [
      'DELETE FROM public.payment_order_messages',
      'TRUNCATE public.payment_order_messages',
    ]) {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
          await tx.$executeRawUnsafe(sql);
        })
      ).rejects.toThrow(/permission denied/);
    }
    expect(
      (await prisma.paymentOrderMessage.findUniqueOrThrow({ where: { id: row.id } })).body
    ).toBe('Durable evidence');
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
});
it('serves private rooms, cookie-authenticated receipts and appeals through the actual HTTP routes', async () => {
  const { buildServer } = await import('../server.js');
  const server = await buildServer();
  try {
    const f = await fixture(true);
    const token = (id: string) => server.jwt.sign({ sub: id, roles: ['USER'] });
    const headers = (id: string) => ({ authorization: `Bearer ${token(id)}` });
    const base = `/api/v1/payment-orders/withdrawal/${f.withdrawal!.id}`;
    expect((await server.inject({ url: base })).statusCode).toBe(401);
    expect((await server.inject({ url: base, headers: headers(f.outsider.id) })).statusCode).toBe(
      403
    );
    const room = await server.inject({ url: base, headers: headers(f.member.id) });
    expect(room.statusCode).toBe(200);
    expect(room.headers['cache-control']).toBe('private, no-store');
    expect(room.json().data.actions.appeal).toBe(true);
    const message = await server.inject({
      url: `${base}/messages`,
      method: 'POST',
      headers: headers(f.member.id),
      payload: {
        body: 'HTTP receipt',
        idempotencyKey: randomUUID(),
        attachment: {
          name: 'receipt.png',
          mimeType: 'image/png',
          base64:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
        },
      },
    });
    expect(message.statusCode).toBe(201);
    const receipt = message.json().data.attachment.url;
    const allowed = await server.inject({
      url: receipt,
      cookies: { sp_access_token: token(f.agentUser.id) },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['content-type']).toBe('image/png');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['cache-control']).toBe('private, no-store');
    expect(allowed.headers['content-disposition']).toContain('attachment');
    expect(
      (await server.inject({ url: receipt, headers: headers(f.outsider.id) })).statusCode
    ).toBe(403);
    const appealResponse = await server.inject({
      url: `/api/v1/withdrawals/${f.withdrawal!.id}/appeal`,
      method: 'POST',
      headers: headers(f.agentUser.id),
      payload: appeal(),
    });
    expect(appealResponse.statusCode).toBe(201);
    expect((await getPaymentRoom(f.member.id, 'withdrawal', f.withdrawal!.id)).status).toBe(
      'DISPUTED'
    );
    expect(
      await prisma.notification.count({
        where: {
          userId: f.agentUser.id,
          title: 'New withdrawal assigned',
          data: { path: ['withdrawalId'], equals: f.withdrawal!.id },
        },
      })
    ).toBe(1);
  } finally {
    await server.close();
  }
});
it('automatically expires only unpaid deposits and escalates overdue payouts once without releasing funds', async () => {
  const { sweepExpiredAgentOrders } = await import('./order-service.js');
  const { sweepWithdrawalTimeouts } = await import('../withdrawals/timeout-service.js');
  const d = await fixture();
  await prisma.agentOrder.update({
    where: { id: d.order.id },
    data: { createdAt: new Date(Date.now() - 16 * 60_000) },
  });
  await sweepExpiredAgentOrders();
  expect((await prisma.agentOrder.findUniqueOrThrow({ where: { id: d.order.id } })).status).toBe(
    'EXPIRED'
  );
  expect(
    (await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: d.order.id } })).status
  ).toBe('RELEASED');
  const f = await fixture(true);
  const id = f.withdrawal!.id;
  await claimPayout(f.agentUser.id, id, { idempotencyKey: randomUUID() });
  await prisma.withdrawal.update({
    where: { id },
    data: { paymentSubmissionDeadlineAt: new Date(Date.now() - 1000) },
  });
  await sweepWithdrawalTimeouts();
  await sweepWithdrawalTimeouts();
  expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id } })).status).toBe('DISPUTED');
  expect(
    (await prisma.withdrawalHold.findUniqueOrThrow({ where: { withdrawalId: id } })).status
  ).toBe('ACTIVE');
  expect(
    (await prisma.wallet.findUniqueOrThrow({ where: { userId: f.member.id } })).coinsBalance
  ).toBe(4000);
  expect(await prisma.withdrawalDispute.count({ where: { withdrawalId: id } })).toBe(1);
  expect(
    await prisma.notification.count({
      where: {
        userId: { in: [f.member.id, f.agentUser.id] },
        title: 'Payment appeal opened',
        data: { path: ['withdrawalId'], equals: id },
      },
    })
  ).toBe(2);
});
