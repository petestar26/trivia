import { fundAgentInventory } from './inventory-service.js';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { setCountryFlags } from './config-service.js';
import { publishUsdRate } from './usd-config-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder, cancelAgentOrder } from './order-service.js';
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

async function fundedFixture() {
  const f = await fixture();
  const rate = await publishUsdRate(f.admin.id, f.country.id, fixtureUsdPolicy(1));
  await setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: true });
  await fundAgentInventory(f.admin.id, f.agent.id, 100000, randomUUID());
  const args = { agentId: f.agent.id, countryId: f.country.id, paymentAccountId: f.account.id, fiatAmount: 500, idempotencyKey: randomUUID() };
  return { ...f, rate, args };
}
it('serializes the pending-order cap and preserves idempotent retries at the limit', async () => {
  const f = await fundedFixture();
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => createAgentOrder(f.buyer.id, { ...f.args, idempotencyKey: randomUUID() })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  const orders = await prisma.agentOrder.findMany({ where: { userId: f.buyer.id } });
  expect(orders).toHaveLength(3);
  expect((await createAgentOrder(f.buyer.id, { ...f.args, idempotencyKey: orders[0].idempotencyKey })).idempotent).toBe(true);
  expect((await prisma.agentInventory.findUniqueOrThrow({ where: { agentId: f.agent.id } })).reservedBalance).toBe(1500);
});
it('rechecks paused country on submission and settlement, retaining paid reservations', async () => {
  const f = await fundedFixture();
  const { order } = await createAgentOrder(f.buyer.id, f.args);
  await setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: false });
  await expect(submitOrderPayment(f.buyer.id, order.id)).rejects.toThrow(/configuration changed/);
  expect((await prisma.agentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('CREATED');
  await setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: true });
  await submitOrderPayment(f.buyer.id, order.id);
  await setCountryFlags(f.admin.id, f.country.id, { agentPaymentEnabled: false });
  await expect(settleAgentOrder(f.agentUser.id, order.id)).rejects.toThrow(/configuration changed/);
  await expect(cancelAgentOrder(f.buyer.id, order.id)).rejects.toThrow(/cannot be cancelled/);
  expect((await prisma.agentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAYMENT_SUBMITTED');
  expect((await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('ACTIVE');
  expect(await prisma.agentOrderSettlement.count({ where: { orderId: order.id } })).toBe(0);
});
it('concurrent expiry releases inventory once and never creates a customer credit', async () => {
  const f = await fundedFixture();
  const { order } = await createAgentOrder(f.buyer.id, f.args);
  await prisma.agentOrder.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
  const outcomes = await Promise.allSettled([
    cancelAgentOrder(f.buyer.id, order.id, undefined, 'expiry'),
    cancelAgentOrder(f.buyer.id, order.id, undefined, 'expiry'),
  ]);
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect((await prisma.agentOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('EXPIRED');
  expect((await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: order.id } })).status).toBe('RELEASED');
  expect((await prisma.agentInventory.findUniqueOrThrow({ where: { agentId: f.agent.id } })).reservedBalance).toBe(0);
  expect(await prisma.agentOrderSettlement.count({ where: { orderId: order.id } })).toBe(0);
});

// Recovery records external refunds; it must never resurrect a reservation.
it('late payment recovery serializes reports/refunds, binds step-up, and leaves the financial records untouched', async () => {
  const { reportLatePayment, claimLatePayment, recordLatePaymentRefund } = await import('./late-payment-service.js');
  const f = await fundedFixture();
  const { order } = await createAgentOrder(f.buyer.id, f.args);
  await cancelAgentOrder(f.buyer.id, order.id);
  const report = { orderId: order.id, idempotencyKey: randomUUID(), paymentReference: 'IN-'+randomUUID(), paidAmount: 500, paidAt: new Date().toISOString(), description: 'Sent after closure' };
  const reports = await Promise.all([reportLatePayment(f.buyer.id, report), reportLatePayment(f.buyer.id, report)]);
  expect(reports[0].id).toBe(reports[1].id);
  const id = reports[0].id;
  await expect(reportLatePayment(f.agentUser.id, report)).rejects.toThrow(/access/);
  await expect(reportLatePayment(f.buyer.id, {...report,paidAmount:501})).rejects.toThrow(/already exists/);
  await claimLatePayment(f.admin.id,id);
  expect((await claimLatePayment(f.admin.id,id)).id).toBe(id);
  const refund = { idempotencyKey: randomUUID(), verifiedPaymentReference: report.paymentReference, verifiedAmount:500,
    refundReference:'OUT-'+randomUUID(),refundedAt:new Date().toISOString(),resolutionNote:'Verified full return to original payer',verified:true };
  await expect(recordLatePaymentRefund(f.admin.id, 12345,id,refund)).rejects.toThrow(/Step-up/);
  expect(await prisma.latePaymentReferenceClaim.count({where:{caseId:id}})).toBe(0);
  await prisma.stepUpVerification.create({data:{userId:f.admin.id,purpose:`LATE_PAYMENT_REFUND:${id}`,tokenIat:12345,factorType:'TOTP',expiresAt:new Date(Date.now()+60000)}});
  const outcomes=await Promise.all([recordLatePaymentRefund(f.admin.id,12345,id,refund),recordLatePaymentRefund(f.admin.id,12345,id,refund)]);
  expect(outcomes.every(r=>r.status==='REFUNDED')).toBe(true);
  expect(await prisma.latePaymentReferenceClaim.count({where:{caseId:id}})).toBe(2);
  expect(await prisma.auditLog.count({where:{entityId:id,action:'LATE_PAYMENT_EXTERNAL_REFUND_RECORDED'}})).toBe(1);
  expect((await prisma.agentOrder.findUniqueOrThrow({where:{id:order.id}})).status).toBe('CANCELLED');
  expect((await prisma.agentReservation.findUniqueOrThrow({where:{orderId:order.id}})).status).toBe('RELEASED');
  expect(await prisma.agentOrderSettlement.count({where:{orderId:order.id}})).toBe(0);
  expect(await prisma.walletTransaction.count({where:{referenceType:'AGENT_ORDER',referenceId:order.id}})).toBe(0);
  const {order: second}=await createAgentOrder(f.buyer.id,{...f.args,idempotencyKey:randomUUID()});
  await cancelAgentOrder(f.buyer.id,second.id);
  const secondCase=await reportLatePayment(f.buyer.id,{...report,orderId:second.id,idempotencyKey:randomUUID(),paidAt:new Date().toISOString()});
  await claimLatePayment(f.admin.id,secondCase.id);
  const verification=await prisma.stepUpVerification.create({data:{userId:f.admin.id,purpose:`LATE_PAYMENT_REFUND:${secondCase.id}`,tokenIat:12345,factorType:'TOTP',expiresAt:new Date(Date.now()+60000)}});
  await expect(recordLatePaymentRefund(f.admin.id,12345,secondCase.id,{...refund,idempotencyKey:randomUUID(),refundedAt:new Date().toISOString()})).rejects.toThrow(/already recorded/);
  expect((await prisma.stepUpVerification.findUniqueOrThrow({where:{id:verification.id}})).consumedAt).toBeNull();
  expect((await prisma.latePaymentCase.findUniqueOrThrow({where:{id:secondCase.id}})).status).toBe('ASSIGNED');
});

it('settles on-time payment after rate expiry without repricing and rejects late submission', async () => {
  const f = await fundedFixture();
  await publishUsdRate(f.admin.id, f.country.id, {...fixtureUsdPolicy(1), expiresAt: new Date(Date.now() + 6000).toISOString()});
  const {order: paid} = await createAgentOrder(f.buyer.id, {...f.args, idempotencyKey: randomUUID()});
  const {order: late} = await createAgentOrder(f.buyer.id, {...f.args, idempotencyKey: randomUUID()});
  await submitOrderPayment(f.buyer.id, paid.id);
  await prisma.$queryRaw`SELECT 1 AS waited FROM pg_sleep(6)`;
  await publishUsdRate(f.admin.id, f.country.id, {...fixtureUsdPolicy(1), localPerUsd: '2'});
  await expect(submitOrderPayment(f.buyer.id, late.id)).rejects.toMatchObject({statusCode: 409});
  const outcomes = await Promise.allSettled([
    settleAgentOrder(f.agentUser.id, paid.id), settleAgentOrder(f.agentUser.id, paid.id),
  ]);
  expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const completed = await prisma.agentOrder.findUniqueOrThrow({where: {id: paid.id}});
  expect(completed.status).toBe('COMPLETED');
  expect(completed.coinAmount).toBe(paid.coinAmount);
  expect(completed.pricingSnapshot).toEqual(paid.pricingSnapshot);
  expect(await prisma.agentOrderSettlement.count({where: {orderId: paid.id}})).toBe(1);
  expect((await prisma.agentReservation.findUniqueOrThrow({where: {orderId: paid.id}})).status).toBe('CONSUMED');
  expect((await prisma.agentOrder.findUniqueOrThrow({where: {id: late.id}})).status).toBe('CREATED');
  expect(await prisma.agentOrderSettlement.count({where: {orderId: late.id}})).toBe(0);
});

it('supervisor releases a suspended assignee, rejects with a reason, and retries cannot release a new assignment', async () => {
  const {reportLatePayment, claimLatePayment, superviseLatePayment, listLatePayments} = await import('./late-payment-service.js');
  const f = await fundedFixture();
  const supervisor = await prisma.user.create({data: {username: `super_${randomUUID()}`, role: 'SUPER_ADMIN'}});
  const {order} = await createAgentOrder(f.buyer.id, f.args);
  await cancelAgentOrder(f.buyer.id, order.id);
  const row = await reportLatePayment(f.buyer.id, {orderId: order.id, idempotencyKey: randomUUID(), paymentReference:'IN-'+randomUUID(), paidAmount:500, paidAt:new Date().toISOString(), description:'Late transfer'});
  await claimLatePayment(f.admin.id, row.id);
  await prisma.user.update({where:{id:f.admin.id}, data:{status:'SUSPENDED'}});
  const release = {idempotencyKey:randomUUID(), reason:'Previous reviewer is suspended'};
  await expect(superviseLatePayment(f.agentUser.id,row.id,'release',release)).rejects.toThrow(/administrator/);
  const ordinary=await prisma.user.create({data:{username:`ordinary_${randomUUID()}`,role:'ADMIN'}});
  await expect(superviseLatePayment(ordinary.id,row.id,'release',release)).rejects.toThrow(/super administrator/);
  const visible = await listLatePayments(supervisor.id,true);
  expect(visible.some(c=>c.id===row.id)).toBe(true);
  await superviseLatePayment(supervisor.id,row.id,'release',release);
  await claimLatePayment(supervisor.id,row.id);
  // Old request replay must not release a subsequently claimed assignment.
  expect((await superviseLatePayment(supervisor.id,row.id,'release',release)).status).toBe('ASSIGNED');
  const rejection={idempotencyKey:randomUUID(),reason:'Provider could not verify the transfer'};
  const results=await Promise.all([superviseLatePayment(supervisor.id,row.id,'reject',rejection),superviseLatePayment(supervisor.id,row.id,'reject',rejection)]);
  expect(results.every(c=>c.status==='REJECTED')).toBe(true);
  expect(await prisma.auditLog.count({where:{entityId:row.id,action:'LATE_PAYMENT_REJECTED'}})).toBe(1);
  await expect(superviseLatePayment(supervisor.id,row.id,'release',{...release,idempotencyKey:randomUUID()})).rejects.toThrow(/assigned/);
  const member=(await listLatePayments(f.buyer.id))[0];
  expect(member).not.toHaveProperty('assignedAdminId');
  expect(member).not.toHaveProperty('resolutionKey');
  expect(member.resolutionNote).toBe(rejection.reason);
  expect(await prisma.agentOrderSettlement.count({where:{orderId:order.id}})).toBe(0);
});

it('paginates 101 member recovery cases without truncation or duplicate rows', async () => {
  const {listLatePayments}=await import('./late-payment-service.js');
  const f=await fundedFixture();
  const {order}=await createAgentOrder(f.buyer.id,f.args);
  const ids=Array.from({length:101},()=>randomUUID());
  await prisma.agentOrder.createMany({data:ids.map((id,i)=>({...order,id,orderNumber:`PAGE-${id}`,idempotencyKey:randomUUID(),pricingSnapshot:order.pricingSnapshot as any,paymentSnapshot:order.paymentSnapshot as any}))});
  await prisma.latePaymentCase.createMany({data:ids.map(orderId=>({orderId,openedBy:f.buyer.id,idempotencyKey:randomUUID(),paymentReference:'FIXTURE',paidAmount:500,paidAt:new Date(),description:'Pagination fixture'}))});
  const pages=await Promise.all([0,1,2].map(page=>listLatePayments(f.buyer.id,false,{page})));
  expect(pages.map(p=>p.length)).toEqual([50,50,1]);
  expect(new Set(pages.flat().map(c=>c.id)).size).toBe(101);
});

it('records one refund after supervisor releases a suspended reviewer', async () => {
  const {reportLatePayment,claimLatePayment,superviseLatePayment,recordLatePaymentRefund}=await import('./late-payment-service.js');
  const f=await fundedFixture();
  const supervisor=await prisma.user.create({data:{username:`recover_${randomUUID()}`,role:'SUPER_ADMIN'}});
  const {order}=await createAgentOrder(f.buyer.id,f.args);
  await cancelAgentOrder(f.buyer.id,order.id);
  const row=await reportLatePayment(f.buyer.id,{orderId:order.id,idempotencyKey:randomUUID(),paymentReference:'IN-'+randomUUID(),paidAmount:500,paidAt:new Date().toISOString(),description:'Transfer after cancellation'});
  await claimLatePayment(f.admin.id,row.id);
  await prisma.user.update({where:{id:f.admin.id},data:{status:'SUSPENDED'}});
  await superviseLatePayment(supervisor.id,row.id,'release',{idempotencyKey:randomUUID(),reason:'Inactive reviewer'});
  await claimLatePayment(supervisor.id,row.id);
  await prisma.stepUpVerification.create({data:{userId:supervisor.id,purpose:`LATE_PAYMENT_REFUND:${row.id}`,tokenIat:12345,factorType:'TOTP',expiresAt:new Date(Date.now()+60000)}});
  const refund={idempotencyKey:randomUUID(),verifiedPaymentReference:row.paymentReference,verifiedAmount:500,refundReference:'OUT-'+randomUUID(),refundedAt:new Date().toISOString(),resolutionNote:'Verified full external refund',verified:true};
  const results=await Promise.all([recordLatePaymentRefund(supervisor.id,12345,row.id,refund),recordLatePaymentRefund(supervisor.id,12345,row.id,refund)]);
  expect(results.every(c=>c.status==='REFUNDED')).toBe(true);
  expect(await prisma.auditLog.count({where:{entityId:row.id,action:'LATE_PAYMENT_EXTERNAL_REFUND_RECORDED'}})).toBe(1);
  expect(await prisma.agentOrderSettlement.count({where:{orderId:order.id}})).toBe(0);
});

it('admits eight simultaneous members with exact inventory reservations and retry replay', async () => {
  for (let round=0; round<3; round++) {
    const f=await fundedFixture();
    const buyers=await Promise.all(Array.from({length:8},()=>prisma.user.create({data:{username:`parallel_${randomUUID()}`}})));
    const args=buyers.map(()=>({...f.args,idempotencyKey:randomUUID()}));
    const results=await Promise.all(buyers.map((buyer,i)=>createAgentOrder(buyer.id,args[i])));
    expect(new Set(results.map(r=>r.order.id)).size).toBe(8);
    const inventory=await prisma.agentInventory.findUniqueOrThrow({where:{agentId:f.agent.id}});
    const total=results.reduce((n,r)=>n+r.order.coinAmount,0);
    expect(inventory.totalBalance).toBe(100000);
    expect(inventory.reservedBalance).toBe(total);
    expect(await prisma.agentReservation.count({where:{agentId:f.agent.id,status:'ACTIVE'}})).toBe(8);
    expect(await prisma.agentInventoryLedger.count({where:{agentId:f.agent.id,type:'RESERVE'}})).toBe(8);
    const replay=await Promise.all(buyers.map((buyer,i)=>createAgentOrder(buyer.id,args[i])));
    expect(replay.every(r=>r.idempotent)).toBe(true);
    expect((await prisma.agentInventory.findUniqueOrThrow({where:{agentId:f.agent.id}})).reservedBalance).toBe(total);
  }
});
it('rejects only genuine shortfalls without partial orders, reservations or ledger entries', async () => {
  const f=await fundedFixture();
  const buyers=await Promise.all(Array.from({length:8},()=>prisma.user.create({data:{username:`shortfall_${randomUUID()}`}})));
  const outcomes=await Promise.allSettled(buyers.map(buyer=>createAgentOrder(buyer.id,{...f.args,fiatAmount:30000,idempotencyKey:randomUUID()})));
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(3);
  for(const result of outcomes) if(result.status==='rejected') expect(result.reason.message).toMatch(/Insufficient agent inventory/);
  const inventory=await prisma.agentInventory.findUniqueOrThrow({where:{agentId:f.agent.id}});
  expect(inventory.totalBalance).toBe(100000);
  expect(inventory.reservedBalance).toBe(90000);
  expect(await prisma.agentOrder.count({where:{agentId:f.agent.id}})).toBe(3);
  expect(await prisma.agentReservation.count({where:{agentId:f.agent.id}})).toBe(3);
  expect(await prisma.agentInventoryLedger.count({where:{agentId:f.agent.id,type:'RESERVE'}})).toBe(3);
});
