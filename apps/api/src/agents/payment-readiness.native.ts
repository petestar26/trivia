import { fundAgentInventory } from './inventory-service.js';
import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { setCountryFlags } from './config-service.js';
import { publishUsdRate } from './usd-config-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder, cancelAgentOrder } from './order-service.js';
import { createWithdrawalQuote } from '../withdrawals/quote-service.js';
import { fixtureEtbPolicy } from '../test/payment-policy-fixture.js';
import { createAgentPaymentAccount } from './payment-account-service.js';
import { fixtureIds, recoveryFixture } from '../scripts/staging-recovery-fixture.js';
const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Throwaway database required');
afterAll(() => prisma.$disconnect());
it('seeds an inert synthetic recovery fixture once, preserves its baseline and detects drift', async () => {
  const first = await prisma.$transaction(tx => recoveryFixture(tx, true));
  const retry = await prisma.$transaction(tx => recoveryFixture(tx, true));
  const receiving = await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: fixtureIds.receivingAccount } });
  const pinned = await prisma.agentOrder.findUniqueOrThrow({ where: { id: fixtureIds.order } });
  expect(receiving).toMatchObject({ status: 'APPROVED', approvedRevision: 1, safetyHold: false });
  expect(pinned).toMatchObject({ paymentAccountId: receiving.id, paymentAccountRevision: 1, paymentSnapshot: receiving.accountDetails });
  expect(retry).toEqual(first);
  expect(first).toMatchObject({status:'OPEN', synthetic:true, baselineUnchanged:true, walletCount:0, inventoryCount:0, settlementCount:0, walletEntryCount:0, providerSettlementVerified:false});
  const reviewer = await prisma.user.create({data:{username:`fixture_reviewer_${randomUUID()}`,role:'ADMIN'}});
  const {claimLatePayment} = await import('./late-payment-service.js');
  await claimLatePayment(reviewer.id, fixtureIds.recovery);
  expect(await prisma.$transaction(tx => recoveryFixture(tx, false))).toMatchObject({status:'ASSIGNED',baselineUnchanged:true});
  await expect(prisma.$transaction(async tx => {
    await tx.country.update({where:{id:fixtureIds.country},data:{agentPaymentEnabled:true}});
    return recoveryFixture(tx, false);
  })).rejects.toThrow('SYNTHETIC_FIXTURE_BASELINE_CHANGED');
  expect((await prisma.country.findUniqueOrThrow({where:{id:fixtureIds.country}})).agentPaymentEnabled).toBe(false);
  expect(await prisma.$transaction(tx => recoveryFixture(tx, false))).toMatchObject({baselineUnchanged:true});
  const {recordLatePaymentRefund} = await import('./late-payment-service.js');
  await prisma.stepUpVerification.create({data:{userId:reviewer.id,purpose:`LATE_PAYMENT_REFUND:${fixtureIds.recovery}`,tokenIat:12345,factorType:'TOTP',expiresAt:new Date(Date.now()+60000)}});
  const refund={idempotencyKey:'synthetic-fixture-refund',verifiedPaymentReference:'SYNTHETIC-RECOVERY-20261007-IN',verifiedAmount:100,
    refundReference:'SYNTHETIC-RECOVERY-20261007-OUT',refundedAt:new Date().toISOString(),resolutionNote:'SYNTHETIC ONLY - no provider transfer',verified:true};
  await recordLatePaymentRefund(reviewer.id,12345,fixtureIds.recovery,refund);
  await recordLatePaymentRefund(reviewer.id,12345,fixtureIds.recovery,refund);
  expect(await prisma.$transaction(tx => recoveryFixture(tx, true))).toMatchObject({status:'REFUNDED',baselineUnchanged:true,referenceClaims:2});
  expect(await prisma.auditLog.count({where:{entityId:fixtureIds.recovery,action:'LATE_PAYMENT_EXTERNAL_REFUND_RECORDED'}})).toBe(1);
});
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
  await expect(prisma.exchangeRateConfig.create({
    data: { countryId: f.country.id, fiatCurrency: 'ETB', coinsPerUnit: 0.0096, setBy: f.admin.id },
  })).rejects.toThrow(/Native ETB wallet requires ETB pricing terms/);
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
  await publishUsdRate(f.admin.id, f.country.id, { ...fixtureEtbPolicy(), localPerUsd: '100' });
  await expect(createAgentOrder(f.buyer.id, args)).rejects.toThrow(/Minimum P2P deposit/);
  await expect(
    createWithdrawalQuote(f.buyer.id, { countryId: f.country.id, coinAmount: 384 })
  ).rejects.toThrow(/must exceed/);
});
it('requires a current rate and usable destination, and audits only successful activation', async () => {
  const f = await fixture();
  const rate = await publishUsdRate(f.admin.id, f.country.id, fixtureEtbPolicy());
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
  const rate = await publishUsdRate(f.admin.id, f.country.id, fixtureEtbPolicy());
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
  await expect(reportLatePayment(f.agentUser.id, report)).rejects.toMatchObject({ statusCode: 409 });
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
  await publishUsdRate(f.admin.id, f.country.id, {...fixtureEtbPolicy(), expiresAt: new Date(Date.now() + 6000).toISOString()});
  const {order: paid} = await createAgentOrder(f.buyer.id, {...f.args, idempotencyKey: randomUUID()});
  const {order: late} = await createAgentOrder(f.buyer.id, {...f.args, idempotencyKey: randomUUID()});
  await submitOrderPayment(f.buyer.id, paid.id);
  await prisma.$queryRaw`SELECT 1 AS waited FROM pg_sleep(6)`;
  await publishUsdRate(f.admin.id, f.country.id, {...fixtureEtbPolicy(), localPerUsd: '2'});
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

it('refuses a recovery report on a deposit already cancelled through a resolved dispute', async () => {
  const {openDispute,claimDispute,resolveDispute}=await import('./dispute-service.js');
  const {reportLatePayment}=await import('./late-payment-service.js');
  const f=await fundedFixture();
  const {order}=await createAgentOrder(f.buyer.id,f.args);
  await submitOrderPayment(f.buyer.id,order.id);
  const {dispute}=await openDispute(f.buyer.id,{orderId:order.id,reason:'OTHER',description:'Investigate transfer',idempotencyKey:randomUUID()});
  await claimDispute(f.admin.id,dispute.id);
  await resolveDispute(f.admin.id,dispute.id,'CANCEL','Payment not verified');
  await expect(reportLatePayment(f.buyer.id,{orderId:order.id,idempotencyKey:randomUUID(),paymentReference:'IN-'+randomUUID(),paidAmount:500,paidAt:new Date().toISOString(),description:'Retry as recovery'})).rejects.toMatchObject({statusCode:409});
  expect(await prisma.latePaymentCase.count({where:{orderId:order.id}})).toBe(0);
});

it('legacy evidence conflict rolls back the refund and preserves its step-up authorization', async () => {
  const {reportLatePayment,claimLatePayment,recordLatePaymentRefund}=await import('./late-payment-service.js');
  const f=await fundedFixture();
  const {order}=await createAgentOrder(f.buyer.id,f.args);
  const {order:legacy}=await createAgentOrder(f.buyer.id,{...f.args,idempotencyKey:randomUUID()});
  await cancelAgentOrder(f.buyer.id,order.id);
  const reference='REF-'+randomUUID();
  await prisma.paymentEvidence.create({data:{orderId:legacy.id,submittedBy:f.buyer.id,referenceNumber:` ${reference.toLowerCase()} `,fileBucket:'fixture',fileKey:'fixture',mimeType:'image/png',fileSize:1}});
  const row=await reportLatePayment(f.buyer.id,{orderId:order.id,idempotencyKey:randomUUID(),paymentReference:reference,paidAmount:500,paidAt:new Date().toISOString(),description:'Late transfer'});
  await claimLatePayment(f.admin.id,row.id);
  const proof=await prisma.stepUpVerification.create({data:{userId:f.admin.id,purpose:`LATE_PAYMENT_REFUND:${row.id}`,tokenIat:12345,factorType:'TOTP',expiresAt:new Date(Date.now()+60000)}});
  const refund={idempotencyKey:randomUUID(),verifiedPaymentReference:reference,verifiedAmount:500,refundReference:'OUT-'+randomUUID(),refundedAt:new Date().toISOString(),resolutionNote:'Verified external transfer',verified:true};
  await expect(recordLatePaymentRefund(f.admin.id,12345,row.id,refund)).rejects.toMatchObject({statusCode:409});
  expect((await prisma.stepUpVerification.findUniqueOrThrow({where:{id:proof.id}})).consumedAt).toBeNull();
  expect((await prisma.latePaymentCase.findUniqueOrThrow({where:{id:row.id}})).status).toBe('ASSIGNED');
  expect(await prisma.latePaymentReferenceClaim.count({where:{caseId:row.id}})).toBe(0);
  // The evidence writer and recovery writer share the provider/reference lock.
  const racingReference='RACE-'+randomUUID();
  const outcomes=await Promise.allSettled([
    recordLatePaymentRefund(f.admin.id,12345,row.id,{...refund,idempotencyKey:randomUUID(),verifiedPaymentReference:racingReference}),
    prisma.paymentEvidence.create({data:{orderId:legacy.id,submittedBy:f.buyer.id,referenceNumber:racingReference,fileBucket:'fixture',fileKey:'race',mimeType:'image/png',fileSize:1}}),
  ]);
  expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const evidence=await prisma.paymentEvidence.count({where:{orderId:legacy.id,referenceNumber:racingReference}});
  const claims=await prisma.latePaymentReferenceClaim.count({where:{caseId:row.id,reference:racingReference}});
  expect(evidence+claims).toBe(1);
});

it('canonical runtime grants allow audit append/read but deny every mutation path', async () => {
  const role=`audit_runtime_${randomUUID().replaceAll('-','')}`;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
  try {
    await prisma.$executeRaw`SELECT public.ledger_apply_runtime_grants(${role})`;
    const row=await prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      return tx.auditLog.create({data:{action:'RUNTIME_APPEND_TEST',entity:'Test'}});
    });
    const permissions=await prisma.$queryRaw<Array<{canRead:boolean;canInsert:boolean;canMutate:boolean;columnUpdate:boolean}>>`
      SELECT has_table_privilege(${role},'public.audit_logs','SELECT') AS "canRead",
      has_table_privilege(${role},'public.audit_logs','INSERT') AS "canInsert",
      has_table_privilege(${role},'public.audit_logs','UPDATE,DELETE,TRUNCATE,TRIGGER') AS "canMutate",
      has_any_column_privilege(${role},'public.audit_logs','UPDATE') AS "columnUpdate"`;
    expect(permissions[0]).toEqual({canRead:true,canInsert:true,canMutate:false,columnUpdate:false});
    for(const operation of ['update','delete'] as const) {
      await expect(prisma.$transaction(async tx=>{
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        if(operation==='update') return tx.auditLog.update({where:{id:row.id},data:{action:'TAMPERED'}});
        return tx.auditLog.delete({where:{id:row.id}});
      })).rejects.toThrow();
    }
    expect((await prisma.auditLog.findUniqueOrThrow({where:{id:row.id}})).action).toBe('RUNTIME_APPEND_TEST');
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
});

// Deposit candidate acceptance gaps: real HTTP auth, competing service calls,
// and the existing disposable database runtime-role grant boundary.
async function depositState(f: Awaited<ReturnType<typeof fundedFixture>>) {
  return {
    account: await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: f.account.id } }),
    orders: await prisma.agentOrder.findMany({ where: { agentId: f.agent.id }, orderBy: { id: 'asc' } }),
    reservations: await prisma.agentReservation.findMany({ where: { agentId: f.agent.id }, orderBy: { id: 'asc' } }),
    inventory: await prisma.agentInventory.findUniqueOrThrow({ where: { agentId: f.agent.id } }),
    audits: await prisma.auditLog.count({ where: { entityId: f.account.id } }),
    disputes: await prisma.dispute.findMany({ where: { order: { agentId: f.agent.id } }, orderBy: { id: 'asc' } }),
    inventoryLedger: await prisma.agentInventoryLedger.count({ where: { agentId: f.agent.id } }),
    settlements: await prisma.agentOrderSettlement.count({ where: { order: { agentId: f.agent.id } } }),
    walletEntries: await prisma.walletTransaction.count({ where: { wallet: { userId: f.buyer.id } } }),
  };
}

it('authenticates receiving review and disable routes and rolls back denied requests without touching pinned funds', async () => {
  const { config } = await import('@socialplay/config');
  const trustedHeaders = { origin: new URL(config.FRONTEND_URL).origin };
  const { buildServer } = await import('../server.js');
  const { openDispute } = await import('./dispute-service.js');
  const server = await buildServer();
  try {
    const f = await fundedFixture();
    const other = await fixture();
    const { order } = await createAgentOrder(f.buyer.id, f.args);
    const cookies = (id: string) => ({ sp_access_token: server.jwt.sign({ sub: id, roles: ['USER'] }) });
    const own = `/api/v1/agents/me/payment-accounts/${f.account.id}`;
    const review = `/api/v1/agents/payment-accounts/${f.account.id}`;
    const version = f.account.updatedAt.toISOString();
    const before = await depositState(f);
    // Deliberately separate CSRF/origin rejection from route authorization.
    for (const headers of [{}, { origin: 'https://untrusted-deposit.example.invalid' }]) {
      const denied = await server.inject({ method: 'POST', url: `${own}/disable`,
        headers, cookies: cookies(f.agentUser.id), payload: { expectedUpdatedAt: version } });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).toContain('Untrusted session origin');
      expect(await depositState(f)).toEqual(before);
    }
    for (const suffix of ['approve', 'reject', 'admin-disable']) {
      const payload = { expectedUpdatedAt: version, ...(suffix === 'reject' ? { reviewNote: 'Synthetic rejection' } : {}) };
      expect((await server.inject({ headers: trustedHeaders, method: 'POST', url: `${review}/${suffix}`, payload })).statusCode).toBe(401);
      const wrongRole = await server.inject({ headers: trustedHeaders, method: 'POST', url: `${review}/${suffix}`, payload, cookies: cookies(f.buyer.id) });
      expect(wrongRole.statusCode).toBe(403);
      expect(wrongRole.body).toContain('Permission required: agent:review');
      expect(await depositState(f)).toEqual(before);
    }
    expect((await server.inject({ headers: trustedHeaders, method: 'POST', url: `${own}/disable`, payload: { expectedUpdatedAt: version } })).statusCode).toBe(401);
    const crossAgent = await server.inject({ headers: trustedHeaders, method: 'POST', url: `${own}/disable`, payload: { expectedUpdatedAt: version }, cookies: cookies(other.agentUser.id) });
    expect(crossAgent.statusCode).toBe(403);
    expect(crossAgent.body).toContain('Not your payment account');
    expect(await depositState(f)).toEqual(before);
    const malformed = await server.inject({ headers: trustedHeaders, method: 'POST', url: `${own}/disable`, payload: { expectedUpdatedAt: 'malformed' }, cookies: cookies(f.agentUser.id) });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).toContain('displayed expectedUpdatedAt ISO timestamp is required');
    expect(await depositState(f)).toEqual(before);
    const edit = await server.inject({ headers: trustedHeaders, method: 'PATCH', url: own, cookies: cookies(f.agentUser.id), payload: {
      expectedUpdatedAt: version, countryId: f.country.id, methodDefId: f.method.id, accountDetails: { accountNumber: 'replacement-only' },
    } });
    expect(edit.statusCode, edit.body).toBe(200);
    let current = await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: f.account.id } });
    const edited = await depositState(f);
    expect((await server.inject({ headers: trustedHeaders, method: 'POST', url: `${review}/approve`, cookies: cookies(f.admin.id), payload: { expectedUpdatedAt: version } })).statusCode).toBe(409);
    expect(await depositState(f)).toEqual(edited);
    const approved = await server.inject({ headers: trustedHeaders, method: 'POST', url: `${review}/approve`, cookies: cookies(f.admin.id), payload: { expectedUpdatedAt: current.updatedAt.toISOString() } });
    expect(approved.statusCode, approved.body).toBe(200);
    current = await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: f.account.id } });
    expect(current.approvedRevision).toBe(2);
    await openDispute(f.buyer.id, { orderId: order.id, reason: 'OTHER', description: 'Synthetic safety investigation', idempotencyKey: randomUUID() });
    const disputed = await depositState(f);
    const held = await server.inject({ headers: trustedHeaders, method: 'POST', url: `${review}/admin-disable`, cookies: cookies(f.admin.id), payload: { expectedUpdatedAt: current.updatedAt.toISOString() } });
    expect(held.statusCode, held.body).toBe(200);
    const after = await depositState(f);
    expect(after.orders[0]).toMatchObject({ status: 'DISPUTE', safetyHold: true, paymentAccountRevision: 1, paymentSnapshot: f.account.accountDetails });
    expect(after.disputes).toEqual(disputed.disputes);
    expect(after.inventoryLedger).toBe(before.inventoryLedger);
    expect(after.reservations).toEqual(before.reservations);
    expect(after.inventory).toEqual(before.inventory);
    expect(after.settlements).toBe(0);
    expect(after.walletEntries).toBe(before.walletEntries);
    await expect(cancelAgentOrder(f.buyer.id, order.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(settleAgentOrder(f.agentUser.id, order.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await depositState(f)).toEqual(after);
    for (const endpoint of [`${own}/disable`, `${review}/admin-disable`]) {
      const stale = await server.inject({ headers: trustedHeaders, method: 'POST', url: endpoint, cookies: cookies(endpoint === `${own}/disable` ? f.agentUser.id : f.admin.id), payload: { expectedUpdatedAt: version } });
      expect(stale.statusCode).toBe(409);
      expect(await depositState(f)).toEqual(after);
    }
    // Successful reject and owner-disable also use the actual cookie routes.
    const pending = await prisma.agentPaymentAccount.create({ data: { agentId: f.agent.id, countryId: f.country.id, methodDefId: f.method.id, accountDetails: { accountNumber: 'pending-only' } } });
    const rejected = await server.inject({ headers: trustedHeaders, method: 'POST', url: `/api/v1/agents/payment-accounts/${pending.id}/reject`, cookies: cookies(f.admin.id), payload: { expectedUpdatedAt: pending.updatedAt.toISOString(), reviewNote: 'Synthetic rejection' } });
    expect(rejected.statusCode, rejected.body).toBe(200);
    const rejectedRow = await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: pending.id } });
    const disabled = await server.inject({ headers: trustedHeaders, method: 'POST', url: `/api/v1/agents/me/payment-accounts/${pending.id}/disable`, cookies: cookies(f.agentUser.id), payload: { expectedUpdatedAt: rejectedRow.updatedAt.toISOString() } });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'REJECTED', safetyHold: true });
  } finally { await server.close(); }
});

it('serializes same-millisecond edit/review/disable decisions with exactly one audit and no losing side effects', async () => {
  const { updateAgentPaymentAccount, approveAgentPaymentAccount, disableOwnPaymentAccount } = await import('./payment-account-service.js');
  const f = await fundedFixture();
  await createAgentOrder(f.buyer.id, f.args);
  // A future fixed millisecond forces the monotonic +1ms branch in both JS and SQL.
  const pending = await prisma.agentPaymentAccount.update({ where: { id: f.account.id }, data: { accountDetails: { accountNumber: 'pending' }, updatedAt: new Date('2099-01-01T00:00:00.000Z') } });
  const before = await depositState(f);
  const expectedUpdatedAt = pending.updatedAt.toISOString();
  const results = await Promise.allSettled([
    updateAgentPaymentAccount(f.agentUser.id, f.account.id, { expectedUpdatedAt, countryId: f.country.id, methodDefId: f.method.id, accountDetails: { accountNumber: 'competing-edit' } }),
    approveAgentPaymentAccount(f.admin.id, f.account.id, expectedUpdatedAt),
    disableOwnPaymentAccount(f.agentUser.id, f.account.id, expectedUpdatedAt),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ statusCode: 409 });
  const after = await depositState(f);
  expect(after.account.updatedAt.getTime()).toBe(pending.updatedAt.getTime() + 1);
  expect(after.audits).toBe(before.audits + 1);
  expect(after.inventoryLedger).toBe(before.inventoryLedger);
  expect(after.disputes).toEqual(before.disputes);
  expect(after.inventory).toEqual(before.inventory);
  expect(after.reservations).toEqual(before.reservations);
  expect(after.orders[0]).toMatchObject({ paymentSnapshot: before.orders[0].paymentSnapshot, paymentAccountRevision: 1, status: 'CREATED', safetyHold: after.account.safetyHold });
  expect(after.settlements).toBe(0);
  expect(after.walletEntries).toBe(before.walletEntries);
  await expect(disableOwnPaymentAccount(f.agentUser.id, f.account.id, expectedUpdatedAt)).rejects.toMatchObject({ statusCode: 409 });
  expect(await depositState(f)).toEqual(after);
});

it('serializes service order admission and safety disable without an unheld surviving order', async () => {
  const { disableOwnPaymentAccount } = await import('./payment-account-service.js');
  const f = await fundedFixture();
  const before = await depositState(f);
  const results = await Promise.allSettled([
    createAgentOrder(f.buyer.id, f.args),
    disableOwnPaymentAccount(f.agentUser.id, f.account.id, f.account.updatedAt.toISOString()),
  ]);
  expect(results[1].status).toBe('fulfilled');
  const after = await depositState(f);
  expect(after.account.safetyHold).toBe(true);
  if (results[0].status === 'fulfilled') {
    expect(after.orders).toHaveLength(1);
    expect(after.orders[0]).toMatchObject({ safetyHold: true, status: 'CREATED', paymentAccountRevision: 1, paymentSnapshot: f.account.accountDetails });
    expect(after.reservations[0].status).toBe('ACTIVE');
    expect(after.inventory.reservedBalance).toBe(after.orders[0].coinAmount);
  } else {
    expect(after.orders).toHaveLength(0);
    expect(after.reservations).toHaveLength(0);
    expect(after.inventory).toEqual(before.inventory);
  }
  expect(after.settlements).toBe(0);
  expect(after.walletEntries).toBe(before.walletEntries);
});

it('serializes expiry versus safety disable: either one release precedes the hold or the reservation remains frozen', async () => {
  const { disableOwnPaymentAccount } = await import('./payment-account-service.js');
  const f = await fundedFixture();
  const { order } = await createAgentOrder(f.buyer.id, f.args);
  await prisma.agentOrder.update({ where: { id: order.id }, data: { createdAt: new Date(Date.now() - 3600000) } });
  const before = await depositState(f);
  const results = await Promise.allSettled([
    cancelAgentOrder(f.buyer.id, order.id, undefined, 'expiry'),
    disableOwnPaymentAccount(f.agentUser.id, f.account.id, f.account.updatedAt.toISOString()),
  ]);
  expect(results[1].status).toBe('fulfilled');
  const after = await depositState(f);
  expect(after.account.safetyHold).toBe(true);
  expect(after.orders[0]).toMatchObject({ paymentSnapshot: before.orders[0].paymentSnapshot, paymentAccountRevision: 1 });
  if (results[0].status === 'fulfilled') {
    expect(after.orders[0].status).toBe('EXPIRED');
    expect(after.reservations[0].status).toBe('RELEASED');
    expect(after.inventory.reservedBalance).toBe(0);
  } else {
    expect(results[0].reason).toMatchObject({ statusCode: 409 });
    expect(after.orders[0]).toMatchObject({ status: 'CREATED', safetyHold: true });
    expect(after.reservations).toEqual(before.reservations);
    expect(after.inventory).toEqual(before.inventory);
  }
  expect(after.settlements).toBe(0);
  expect(after.walletEntries).toBe(before.walletEntries);
});

it('keeps restricted runtime and owner maintenance behind immutable destination and hold guards', async () => {
  const { disableOwnPaymentAccount } = await import('./payment-account-service.js');
  const { runLedgerInvariantCheckInTransaction } = await import('../economy/ledger-invariant-checker.js');
  const f = await fundedFixture();
  const { order } = await createAgentOrder(f.buyer.id, f.args);
  await disableOwnPaymentAccount(f.agentUser.id, f.account.id, f.account.updatedAt.toISOString());
  const before = await depositState(f);
  const role = `deposit_runtime_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  try {
    // Existing supported grant function; no hand-picked grant substitutes.
    await prisma.$executeRawUnsafe(`SELECT public.ledger_apply_runtime_grants('${role}')`);
    const runtimeRead = await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      return tx.$queryRawUnsafe<Array<{ actor: string; id: string }>>(`SELECT current_user::text AS actor,id FROM public.agent_payment_accounts WHERE id='${f.account.id}'`);
    });
    expect(runtimeRead).toEqual([{ actor: role, id: f.account.id }]);
    const statements = [
      `UPDATE public.agent_orders SET "paymentSnapshot"='{}' WHERE id='${order.id}'`,
      `UPDATE public.agent_payment_account_revisions SET "accountDetails"='{}' WHERE "accountId"='${f.account.id}'`,
      `UPDATE public.agent_orders SET "safetyHold"=false WHERE id='${order.id}'`,
      `UPDATE public.agent_payment_accounts SET "safetyHold"=false WHERE id='${f.account.id}'`,
      `UPDATE public.agent_reservations SET status='RELEASED' WHERE "orderId"='${order.id}'`,
    ];
    for (const statement of statements) {
      await expect(prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
        await tx.$executeRawUnsafe(statement);
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      })).rejects.toThrow();
      expect(await depositState(f)).toEqual(before);
    }
    await expect(prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${role}"`);
      await tx.$executeRawUnsafe('ALTER TABLE public.agent_orders DISABLE TRIGGER deposit_order_destination');
    })).rejects.toThrow();
    // Owner data maintenance cannot silently bypass the same frozen record guards.
    for (const statement of statements.slice(0, 4)) await expect(prisma.$executeRawUnsafe(statement)).rejects.toThrow();
    expect(await depositState(f)).toEqual(before);
    const scan = await prisma.$transaction(tx => runLedgerInvariantCheckInTransaction(tx, null, false), { timeout: 120000 });
    expect(scan.violations.filter(v => v.invariant.startsWith('I3'))).toEqual([]);
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
});

it('executes authenticated deposit review and competing disables on a separate non-owner Prisma pool', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { join } = await import('node:path');
  const f = await fundedFixture();
  const other = await fixture();
  const { order } = await createAgentOrder(f.buyer.id, f.args);
  await prisma.agentPaymentAccount.update({ where: { id: f.account.id }, data: { accountDetails: { accountNumber: 'runtime-review-only' } } });
  const role = `deposit_http_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const password = randomUUID();
  await prisma.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  try {
    await prisma.$executeRawUnsafe(`GRANT CONNECT, TEMPORARY ON DATABASE playqube_scheduled_throwaway TO "${role}"`);
    await prisma.$executeRawUnsafe(`SELECT public.ledger_apply_runtime_grants('${role}')`);
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    runtimeUrl.username = role; runtimeUrl.password = password;
    runtimeUrl.search = '';
    runtimeUrl.searchParams.set('connection_limit', '2');
    runtimeUrl.searchParams.set('connect_timeout', '30');
    // Whitelist child configuration: no owner URL, NODE_OPTIONS/preload, .env,
    // alternate datasource, or inherited globals. Engine paths may refer only
    // to already installed compatible engines; this never downloads one.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, NODE_ENV: 'test', LOG_PRETTY: 'false', LOG_LEVEL: 'fatal',
      DATABASE_URL: runtimeUrl.toString(), SCHEDULED_NATIVE_DB_ACK: 'throwaway',
      JWT_ACCESS_SECRET: 'isolated-deposit-runtime-access1', JWT_REFRESH_SECRET: 'isolated-deposit-runtime-refresh',
      FRONTEND_URL: 'http://localhost:5173', CORS_ORIGIN: 'http://localhost:5173',
    };
    for (const key of ['PRISMA_QUERY_ENGINE_LIBRARY', 'PRISMA_QUERY_ENGINE_BINARY', 'LD_LIBRARY_PATH']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const input = { role, adminId: f.admin.id, buyerId: f.buyer.id, agentUserId: f.agentUser.id,
      otherAgentUserId: other.agentUser.id, accountId: f.account.id, agentId: f.agent.id, orderId: order.id };
    const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
    // No owner pool remains open while the child loads or executes the API.
    await prisma.$disconnect();
    const child = spawnSync(join(apiRoot, 'node_modules/.bin/tsx'),
      [join(apiRoot, 'src/test/deposit-runtime-http-harness.ts'), JSON.stringify(input)],
      { cwd: apiRoot, env, encoding: 'utf8', timeout: 120000 });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    const line = child.stdout.split('\n').find(s => s.startsWith('{"depositRuntimeHttp":"passed"'));
    expect(line, child.stdout).toBeTruthy();
    const result = JSON.parse(line!);
    expect(result.requests).toBe(6);
    expect(result.identity).toEqual({ current: role, session: role, super: false, bypass: false, ownerMember: false, ownerReach: false });
    expect(result.finalIdentity).toEqual(result.identity);
    // Owner reconnects only after the child has exited, for independent observation/cleanup.
    expect(await prisma.agentOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      safetyHold: true, status: 'CREATED', paymentAccountRevision: 1, paymentSnapshot: f.account.accountDetails,
    });
    expect(await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: order.id } })).toMatchObject({ status: 'ACTIVE' });
  } finally {
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
    await prisma.$executeRawUnsafe(`DROP ROLE "${role}"`);
  }
}, 180000);
