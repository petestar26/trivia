import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { credentialDb } from '../agents/credential-database.js';
import { approveExistingMemberAgent } from '../agents/admin-account-service.js';
import { suspendAgent, reactivateAgent } from '../agents/agent-service.js';
import {
  adminAccountDetails,
  adminAgents,
  agentOverview,
  setMemberAccountStatus,
} from './service.js';
import { changeOwnPassword } from '../auth/change-password.js';
import { hashPassword, verifyPassword } from '../utils/auth.js';

const url = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/playqube_scheduled_throwaway' ||
  process.env.SCHEDULED_NATIVE_DB_ACK !== 'throwaway'
)
  throw Error('Disposable local database required');
const password = 'Disposable-Staff-Password!42';
async function fixture() {
  const tag = randomUUID();
  const admin = await prisma.user.create({
    data: { username: `staff_admin_${tag}`, role: 'ADMIN' },
  });
  const member = await prisma.user.create({
    data: {
      username: `staff_member_${tag}`,
      email: `${tag}@example.test`,
      passwordHash: await hashPassword(password),
    },
  });
  const country = await prisma.country.create({
    data: { code: tag.slice(0, 8), name: 'Staff fixture', currencyCode: 'ETB', isActive: true },
  });
  return {
    admin,
    member,
    country,
    input: { email: member.email!, displayName: 'Existing fixture member', countryId: country.id },
  };
}
afterAll(async () => {
  await prisma.$disconnect();
  await credentialDb.$disconnect();
});

it('approves an existing member once, preserves credentials and wallet, and rejects client-selected roles', async () => {
  const f = await fixture();
  await prisma.wallet.create({ data: { userId: f.member.id } });
  const attempts = await Promise.allSettled(
    [1, 2].map(() => approveExistingMemberAgent(credentialDb, f.admin.id, f.input))
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await prisma.agent.count({ where: { userId: f.member.id } })).toBe(1);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: f.member.id },
    include: { agentAccountSetup: true, wallet: true },
  });
  expect(user.role).toBe('USER');
  expect(user.status).toBe('ACTIVE');
  expect(user.passwordHash).toBe(f.member.passwordHash);
  expect(user.tokenVersion).toBe(f.member.tokenVersion);
  expect(user.agentAccountSetup).toBeNull();
  expect(user.wallet?.coinsBalance).toBe(0);
  const agent = await prisma.agent.findUniqueOrThrow({ where: { userId: user.id } });
  expect(
    await prisma.agentApplication.count({ where: { agentId: agent.id, status: 'APPROVED' } })
  ).toBe(1);
  expect(
    await prisma.auditLog.count({
      where: { entityId: agent.id, action: 'ADMIN_EXISTING_MEMBER_AGENT_APPROVED' },
    })
  ).toBe(1);
  await expect(
    approveExistingMemberAgent(credentialDb, f.admin.id, { ...f.input, role: 'ADMIN' })
  ).rejects.toMatchObject({ statusCode: 400 });
});

it('rejects non-admin enrollment, inactive members/countries, staff identities and unknown email', async () => {
  const f = await fixture();
  await expect(approveExistingMemberAgent(credentialDb, f.member.id, f.input)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(
    approveExistingMemberAgent(credentialDb, f.admin.id, { ...f.input, email: `${randomUUID()}@example.test` })
  ).rejects.toMatchObject({ statusCode: 404 });
  await prisma.user.update({ where: { id: f.member.id }, data: { status: 'SUSPENDED' } });
  await expect(approveExistingMemberAgent(credentialDb, f.admin.id, f.input)).rejects.toMatchObject({
    statusCode: 400,
  });
  await prisma.user.update({
    where: { id: f.member.id },
    data: { status: 'ACTIVE', role: 'ADMIN' },
  });
  await expect(approveExistingMemberAgent(credentialDb, f.admin.id, f.input)).rejects.toMatchObject({
    statusCode: 400,
  });
  await prisma.user.update({ where: { id: f.member.id }, data: { role: 'USER' } });
  await prisma.country.update({ where: { id: f.country.id }, data: { isActive: false } });
  await expect(approveExistingMemberAgent(credentialDb, f.admin.id, f.input)).rejects.toMatchObject({
    statusCode: 400,
  });
  expect(await prisma.agent.count({ where: { userId: f.member.id } })).toBe(0);
});

it('returns scoped agent operations and safe account details without creating a wallet', async () => {
  const f = await fixture();
  const agent = await approveExistingMemberAgent(credentialDb, f.admin.id, f.input);
  const overview = await agentOverview(f.member.id);
  expect(overview.agent.id).toBe(agent.agentId);
  expect(overview.inventory.available).toBe(0);
  expect(overview.setup).toMatchObject({
    countryActive: true,
    paymentsEnabled: false,
    approvedAccounts: 0,
    rateReady: false,
  });
  expect(overview.recentDeposits).toEqual([]);
  const detail = await adminAccountDetails(f.admin.id, f.member.id);
  expect(detail.wallet).toBeNull();
  expect(detail.canChangeStatus).toBe(true);
  expect(JSON.stringify(detail)).not.toContain('passwordHash');
  expect(JSON.stringify(detail)).not.toContain('credentialHash');
  expect(JSON.stringify(detail)).not.toContain('providerSubject');
  expect(await prisma.wallet.count({ where: { userId: f.member.id } })).toBe(0);
  const list = await adminAgents(f.admin.id, { q: f.member.email, page: 1 });
  expect(list.rows.map((r) => r.id)).toEqual([agent.agentId]);
  await expect(adminAgents(f.admin.id, { page: 0 })).rejects.toMatchObject({ statusCode: 400 });
  await expect(adminAccountDetails(f.member.id, f.admin.id)).rejects.toMatchObject({
    statusCode: 403,
  });
  await expect(agentOverview(f.admin.id)).rejects.toMatchObject({ statusCode: 403 });
});

it('rejects stale agent changes and blocks suspended agents from their workspace', async () => {
  const f = await fixture();
  const agent = await approveExistingMemberAgent(credentialDb, f.admin.id, f.input);
  const before = await prisma.agent.findUniqueOrThrow({ where: { id: agent.agentId } });
  await expect(
    suspendAgent(f.admin.id, agent.agentId, 'Fixture review', {
      expectedUpdatedAt: new Date(0).toISOString(),
    })
  ).rejects.toMatchObject({ statusCode: 409 });
  await suspendAgent(f.admin.id, agent.agentId, 'Fixture review', {
    expectedUpdatedAt: before.updatedAt.toISOString(),
  });
  await expect(agentOverview(f.member.id)).rejects.toMatchObject({ statusCode: 403 });
  await reactivateAgent(f.admin.id, agent.agentId);
  expect((await agentOverview(f.member.id)).agent.status).toBe('ACTIVE');
});

it('moderates only ordinary members with a fresh version and preserves financial history', async () => {
  const f = await fixture();
  await prisma.session.create({
    data: {
      userId: f.member.id,
      refreshToken: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const input = {
    status: 'SUSPENDED',
    reason: 'Fixture moderation review',
    expectedUpdatedAt: f.member.updatedAt.toISOString(),
  };
  const attempts = await Promise.allSettled(
    [1, 2].map(() => setMemberAccountStatus(credentialDb, f.admin.id, f.member.id, input))
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const paused = await prisma.user.findUniqueOrThrow({ where: { id: f.member.id } });
  expect(paused.status).toBe('SUSPENDED');
  expect(paused.role).toBe('USER');
  expect(paused.passwordHash).toBe(f.member.passwordHash);
  expect(paused.tokenVersion).toBe(f.member.tokenVersion);
  expect(await prisma.session.count({ where: { userId: f.member.id } })).toBe(0);
  expect(
    await prisma.auditLog.count({
      where: { entityId: f.member.id, action: 'ADMIN_MEMBER_SUSPENDED' },
    })
  ).toBe(1);
  expect(await prisma.walletTransaction.count({ where: { userId: f.member.id } })).toBe(0);
  await setMemberAccountStatus(credentialDb, f.admin.id, f.member.id, {
    ...input,
    status: 'ACTIVE',
    expectedUpdatedAt: paused.updatedAt.toISOString(),
  });
  await expect(setMemberAccountStatus(credentialDb, f.admin.id, f.admin.id, input)).rejects.toMatchObject({
    statusCode: 403,
  });
  await prisma.user.update({ where: { id: f.member.id }, data: { role: 'ADMIN' } });
  await expect(setMemberAccountStatus(credentialDb, f.admin.id, f.member.id, input)).rejects.toMatchObject({
    statusCode: 403,
  });
});

it('changes an authenticated password only with current proof and revokes prior sessions', async () => {
  const f = await fixture();
  const newPassword = 'New-Staff-Private!53';
  await prisma.session.create({
    data: {
      userId: f.member.id,
      refreshToken: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await expect(
    changeOwnPassword(credentialDb, f.member.id, { currentPassword: 'wrong', newPassword })
  ).rejects.toMatchObject({ statusCode: 401 });
  await expect(
    changeOwnPassword(credentialDb, f.member.id, { currentPassword: password, newPassword: password })
  ).rejects.toMatchObject({ statusCode: 400 });
  const attempts = await Promise.allSettled(
    [1, 2].map(() => changeOwnPassword(credentialDb, f.member.id, { currentPassword: password, newPassword }))
  );
  expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const updated = await prisma.user.findUniqueOrThrow({ where: { id: f.member.id } });
  expect(updated.role).toBe('USER');
  expect(updated.tokenVersion).toBe(f.member.tokenVersion + 1);
  expect(await verifyPassword(newPassword, updated.passwordHash!)).toBe(true);
  expect(await prisma.session.count({ where: { userId: f.member.id } })).toBe(0);
  const audit = await prisma.auditLog.findMany({
    where: { entityId: f.member.id, action: 'ACCOUNT_PASSWORD_CHANGED' },
  });
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(newPassword);
});
