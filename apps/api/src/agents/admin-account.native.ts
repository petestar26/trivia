import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { prisma as owner, PrismaClient } from '@socialplay/database';
const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('./credential-database.js', () => ({
  get credentialDb() {
    return state.db;
  },
}));
import {
  createAdminAgent,
  activateAdminAgent,
  reissueAgentPassword,
  listPendingAgentAccounts,
} from './admin-account-service.js';
import { verifyPassword } from '../utils/auth.js';
const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw new Error('Throwaway database required');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const role = `agent_onboarding_${suffix}`;
let adminId: string, countryId: string;
const temp = 'DisposableFixture!42',
  fresh = 'PrivateFixture!43';
beforeAll(async () => {
  adminId = (await owner.user.create({ data: { username: `admin_${suffix}`, role: 'ADMIN' } })).id;
  countryId = (
    await owner.country.create({
      data: {
        code: suffix.slice(0, 8),
        name: 'Disposable fixture',
        currencyCode: 'ETB',
        isActive: true,
      },
    })
  ).id;
  const password = randomUUID();
  await owner.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`);
  await owner.$executeRawUnsafe(
    `GRANT SELECT, INSERT ON public.users, public.user_auth_identities, public.agents, public.agent_applications, public.agent_account_setups, public.audit_logs TO "${role}"`
  );
  await owner.$executeRawUnsafe(`GRANT SELECT ON public.countries TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT UPDATE ("passwordHash") ON public.users TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT UPDATE (name) ON public.countries TO "${role}"`);
  await owner.$executeRawUnsafe(`GRANT UPDATE ON public.agent_account_setups TO "${role}"`);
  await owner.$executeRawUnsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await owner.$executeRaw`SELECT public.ledger_apply_runtime_grants(${role})`;
  const [capability] = await owner.$queryRaw<{ allowed: boolean }[]>`
    SELECT has_function_privilege(${role}, 'public.activate_provisioned_agent(text,text,text)', 'EXECUTE') AS allowed`;
  expect(capability.allowed).toBe(true);
  const runtimeUrl = new URL(url);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  state.db = new PrismaClient({ datasources: { db: { url: runtimeUrl.toString() } }, log: [] });
});
afterAll(async () => {
  await state.db?.$disconnect();
  await owner.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
  await owner.$executeRawUnsafe(`DROP ROLE "${role}"`);
  await owner.$disconnect();
});
function input(tag: string) {
  return {
    username: `ag_${tag}_${suffix}`,
    email: `${tag}_${suffix}@fixture.invalid`,
    countryId,
    displayName: 'Fixture Agent',
    temporaryPassword: temp,
  };
}
it('creates separate agents without sessions or balances, safely rejects duplicate and elevated account requests', async () => {
  const args = input('create');
  const result = await createAdminAgent(adminId, args);
  expect(JSON.stringify(result)).not.toContain(temp);
  const user = await owner.user.findUniqueOrThrow({
    where: { id: result.userId },
    include: { agentAccountSetup: true },
  });
  expect(user).toMatchObject({ role: 'USER', status: 'PENDING_VERIFICATION', passwordHash: null });
  expect(await verifyPassword(temp, user.agentAccountSetup!.credentialHash!)).toBe(true);
  expect(await owner.session.count({ where: { userId: user.id } })).toBe(0);
  expect(await owner.wallet.count({ where: { userId: user.id } })).toBe(0);
  expect(await owner.agentPaymentAccount.count({ where: { agentId: result.agentId } })).toBe(0);
  await expect(createAdminAgent(adminId, args)).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    createAdminAgent(adminId, { ...input('role'), role: 'ADMIN' })
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(createAdminAgent(user.id, input('unauthorized'))).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(await owner.user.count({ where: { username: args.username } })).toBe(1);
  const safe = await listPendingAgentAccounts(adminId);
  expect(JSON.stringify(safe)).not.toContain('credentialHash');
});
it('allows exactly one activation through the restricted role and preserves normal status protection', async () => {
  const args = input('race');
  const result = await createAdminAgent(adminId, args);
  await expect(
    state.db.user.update({ where: { id: result.userId }, data: { status: 'ACTIVE' } })
  ).rejects.toThrow();
  await expect(
    activateAdminAgent({ email: args.email, temporaryPassword: 'incorrect', newPassword: fresh })
  ).rejects.toMatchObject({ statusCode: 401 });
  await expect(
    activateAdminAgent({ email: args.email, temporaryPassword: temp, newPassword: temp })
  ).rejects.toMatchObject({ statusCode: 400 });
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      activateAdminAgent({ email: args.email, temporaryPassword: temp, newPassword: fresh })
    )
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const user = await owner.user.findUniqueOrThrow({
    where: { id: result.userId },
    include: { agentAccountSetup: true },
  });
  expect(user).toMatchObject({
    role: 'USER',
    status: 'ACTIVE',
    agentAccountSetup: { credentialHash: null },
  });
  expect(await verifyPassword(fresh, user.passwordHash!)).toBe(true);
  expect(await owner.session.count({ where: { userId: user.id } })).toBe(0);
  await expect(
    reissueAgentPassword(adminId, user.id, { temporaryPassword: temp })
  ).rejects.toMatchObject({ statusCode: 409 });
});
it('rejects expired credentials; reissue invalidates the original and permits activation once', async () => {
  const args = input('expired');
  const result = await createAdminAgent(adminId, args);
  await owner.agentAccountSetup.update({
    where: { userId: result.userId },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    activateAdminAgent({ email: args.email, temporaryPassword: temp, newPassword: fresh })
  ).rejects.toMatchObject({ statusCode: 401 });
  const replacement = 'ReplacementFixture!44';
  await reissueAgentPassword(adminId, result.userId, { temporaryPassword: replacement });
  await expect(
    activateAdminAgent({ email: args.email, temporaryPassword: temp, newPassword: fresh })
  ).rejects.toMatchObject({ statusCode: 401 });
  await activateAdminAgent({
    email: args.email,
    temporaryPassword: replacement,
    newPassword: fresh,
  });
});
it('fails closed on suspended admin, inactive country and multibyte passwords exceeding bcrypt capacity', async () => {
  await owner.user.update({ where: { id: adminId }, data: { status: 'SUSPENDED' } });
  await expect(createAdminAgent(adminId, input('suspended'))).rejects.toMatchObject({
    statusCode: 403,
  });
  await owner.user.update({ where: { id: adminId }, data: { status: 'ACTIVE' } });
  await owner.country.update({ where: { id: countryId }, data: { isActive: false } });
  await expect(createAdminAgent(adminId, input('inactive'))).rejects.toMatchObject({
    statusCode: 400,
  });
  await owner.country.update({ where: { id: countryId }, data: { isActive: true } });
  await expect(
    createAdminAgent(adminId, { ...input('bytes'), temporaryPassword: 'Aa1!' + 'é'.repeat(35) })
  ).rejects.toMatchObject({ statusCode: 400 });
});
