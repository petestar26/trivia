/** Child-only disposable native harness. No owner URL, SET ROLE, or fixture setup. */
import assert from 'node:assert/strict';
import type { InjectOptions } from 'fastify';

async function main() {
  const input = JSON.parse(process.argv[2]);
  const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.pathname, '/playqube_scheduled_throwaway');
  assert.equal(process.env.SCHEDULED_NATIVE_DB_ACK, 'throwaway');
  assert.equal(url.username, input.role);
  assert.equal(process.env.LEDGER_OWNER_DATABASE_URL, undefined);
  assert.equal(process.env.DIRECT_URL, undefined);
  assert.equal(process.env.NODE_OPTIONS, undefined);
  assert.equal((globalThis as any).prisma, undefined);
  const { prisma } = await import('@socialplay/database');
  const { config } = await import('@socialplay/config');
  assert.equal(config.DATABASE_URL, process.env.DATABASE_URL);
  assert.equal((globalThis as any).prisma, prisma);
  const identity = async () => {
    const rows = await prisma.$queryRaw<Array<{ current: string; session: string; super: boolean; bypass: boolean; ownerMember: boolean; ownerReach: boolean }>>`
      SELECT current_user::text AS current, session_user::text AS session,
        r.rolsuper AS super, r.rolbypassrls AS bypass,
        (pg_has_role(r.oid,(SELECT datdba FROM pg_database WHERE datname=current_database()),'MEMBER') OR
          EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind IN ('r','p') AND pg_has_role(r.oid,c.relowner,'MEMBER'))) AS "ownerMember",
        EXISTS (SELECT 1 FROM public.ledger_role_reach(r.oid) reach JOIN pg_roles reachable ON reachable.oid=reach.role_id
          WHERE reachable.rolsuper OR reachable.rolbypassrls OR reachable.oid IN
            (SELECT c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p'))) AS "ownerReach"
      FROM pg_roles r WHERE r.rolname=current_user`;
    assert.deepEqual(rows, [{ current: input.role, session: input.role, super: false, bypass: false, ownerMember: false, ownerReach: false }]);
    return rows[0];
  };
  const state = async () => ({
    account: await prisma.agentPaymentAccount.findUniqueOrThrow({ where: { id: input.accountId } }),
    order: await prisma.agentOrder.findUniqueOrThrow({ where: { id: input.orderId } }),
    reservation: await prisma.agentReservation.findUniqueOrThrow({ where: { orderId: input.orderId } }),
    inventory: await prisma.agentInventory.findUniqueOrThrow({ where: { agentId: input.agentId } }),
    audits: await prisma.auditLog.count({ where: { entityId: input.accountId } }),
    settlements: await prisma.agentOrderSettlement.count({ where: { orderId: input.orderId } }),
    walletEntries: await prisma.walletTransaction.count({ where: { wallet: { userId: input.buyerId } } }),
  });
  const initialIdentity = await identity();
  const { buildServer } = await import('../server.js');
  const server = await buildServer();
  let requests = 0;
  const request = async (actor: string, path: string, payload: InjectOptions['payload']) => {
    await identity();
    const response = await server.inject({ method: 'POST', url: `/api/v1/agents/${path}`,
      headers: { origin: new URL(config.FRONTEND_URL).origin },
      cookies: { sp_access_token: server.jwt.sign({ sub: actor, roles: ['USER'] }) }, payload });
    requests++;
    await identity();
    return response;
  };
  try {
    const before = await state();
    const review = `payment-accounts/${input.accountId}`;
    const own = `me/payment-accounts/${input.accountId}/disable`;
    const payload = { expectedUpdatedAt: before.account.updatedAt.toISOString() };
    const wrongRole = await request(input.buyerId, `${review}/approve`, payload);
    assert.equal(wrongRole.statusCode, 403, wrongRole.body);
    assert.match(wrongRole.body, /Permission required: agent:review/);
    const crossAgent = await request(input.otherAgentUserId, own, payload);
    assert.equal(crossAgent.statusCode, 403, crossAgent.body);
    assert.match(crossAgent.body, /Not your payment account/);
    assert.deepEqual(await state(), before);
    const approval = await request(input.adminId, `${review}/approve`, payload);
    assert.equal(approval.statusCode, 200, approval.body);
    const approved = await state();
    assert.equal(approved.account.approvedRevision, 2);
    assert.deepEqual(approved.order, before.order);
    assert.deepEqual(approved.reservation, before.reservation);
    assert.deepEqual(approved.inventory, before.inventory);
    assert.equal(approved.audits, before.audits + 1);
    const stale = await request(input.adminId, `${review}/admin-disable`, payload);
    assert.equal(stale.statusCode, 409, stale.body);
    assert.deepEqual(await state(), approved);
    // Two authenticated decisions use the same version on the genuine runtime pool.
    const current = { expectedUpdatedAt: approved.account.updatedAt.toISOString() };
    const outcomes = await Promise.all([
      request(input.agentUserId, own, current),
      request(input.adminId, `${review}/admin-disable`, current),
    ]);
    assert.deepEqual(outcomes.map(r => r.statusCode).sort(), [200, 409], outcomes.map(r => r.body).join('\n'));
    const after = await state();
    assert.equal(after.account.safetyHold, true);
    assert.equal(after.order.safetyHold, true);
    assert.equal(after.order.status, before.order.status);
    assert.deepEqual(after.order.paymentSnapshot, before.order.paymentSnapshot);
    assert.equal(after.order.paymentAccountRevision, before.order.paymentAccountRevision);
    assert.deepEqual(after.reservation, before.reservation);
    assert.deepEqual(after.inventory, before.inventory);
    assert.equal(after.audits, approved.audits + 1);
    assert.equal(after.settlements, before.settlements);
    assert.equal(after.walletEntries, before.walletEntries);
    console.log(JSON.stringify({ depositRuntimeHttp: 'passed', requests, identity: initialIdentity, finalIdentity: await identity() }));
  } finally {
    await server.close();
    await prisma.$disconnect();
  }
}
main().catch(error => {
  // Only synthetic fixture values are used. Never emit environment/connection URLs.
  console.error(JSON.stringify({ depositRuntimeHttp: 'failed', name: error?.name, message: String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database-url]') }));
  process.exitCode = 1;
});
