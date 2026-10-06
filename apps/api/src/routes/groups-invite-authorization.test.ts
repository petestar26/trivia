import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// An invitation grants its role on acceptance, so POST /:id/invites must
// obey the same ceiling as PATCH /members/:userId/role: only the OWNER may
// hand out ADMIN. Otherwise an ADMIN can mint an ADMIN invite and escalate
// a peer past what the direct role-change route allows.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and groups-invites-membership.test.ts already issues ~87
// requests against a ceiling of 100.

const PREFIX = `${config.API_PREFIX}/groups`;

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures();
  if (server) await server.close();
  await prisma.$disconnect();
});

const EMAIL_PREFIX = 'ginvauth-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `ia_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `InvAuth ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function cleanFixtures() {
  // Accepted invites start fire-and-forget GROUP_JOIN activity. Its XP,
  // achievement and wallet writes can arrive during teardown, so retry this
  // fixture-scoped block until those writes drain (as sibling invite suites do).
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true },
    });
    if (!users.length) return;
    const userIds = users.map((u) => u.id);
    try {
      const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
      const groupIds = groups.map((g) => g.id);
      if (groupIds.length) {
        await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
        await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
      }
      await prisma.groupInvite.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
      await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      if (groupIds.length) await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
      await prisma.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.userAchievement.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.userTask.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.userXpEvent.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.userProgress.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.dailyStreak.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.vipMembership.deleteMany({ where: { userId: { in: userIds } } });
      // The test-only bridge removes append-only ledger rows for these users.
      await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
      const deleted = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (deleted.count === users.length) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Group invitation fixture cleanup did not drain: ${String(lastError)}`);
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

async function fixture(tag: string) {
  const owner = await createUser(`${tag}-own`);
  const admin = await createUser(`${tag}-adm`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `InvAuth-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.createMany({
    data: [
      { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
      { groupId: group.id, userId: admin.id, role: GroupMemberRole.ADMIN, status: GroupMemberStatus.ACTIVE },
    ],
  });
  return { group, owner, admin };
}

function inviteeEmail(tag: string) {
  return `${EMAIL_PREFIX}invitee-${tag}-${uniqueSuffix()}@test.local`;
}

async function createInvite(
  groupId: string,
  actor: { id: string; email: string; username: string },
  payload: { email: string; role?: string }
) {
  return server.inject({
    method: 'POST',
    url: `${PREFIX}/${groupId}/invites`,
    headers: authHeader(await mintToken(actor)),
    payload,
  });
}

describeIf('groups/routes — invitation role authorization', () => {
  describe('ADMIN ceiling matches the role-change route', () => {
    it('an OWNER may create an ADMIN invitation', async () => {
      const f = await fixture('owner-admin');
      const resp = await createInvite(f.group.id, f.owner, { email: inviteeEmail('oa'), role: 'ADMIN' });

      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.role).toBe('ADMIN');
    });

    it('an ADMIN may NOT create an ADMIN invitation', async () => {
      const f = await fixture('admin-admin');
      const email = inviteeEmail('aa');
      const resp = await createInvite(f.group.id, f.admin, { email, role: 'ADMIN' });

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('Only the owner can assign admin roles');
      // Rejected before any row is written.
      expect(await prisma.groupInvite.count({ where: { email } })).toBe(0);
    });

    it('mirrors PATCH /members/:userId/role, which also refuses ADMIN-grants-ADMIN', async () => {
      const f = await fixture('parity');
      const member = await createUser('parity-mem');
      await prisma.groupMember.create({
        data: {
          groupId: f.group.id,
          userId: member.id,
          role: GroupMemberRole.MEMBER,
          status: GroupMemberStatus.ACTIVE,
        },
      });

      const roleResp = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${f.group.id}/members/${member.id}/role`,
        headers: authHeader(await mintToken(f.admin)),
        payload: { role: 'ADMIN' },
      });
      const inviteResp = await createInvite(f.group.id, f.admin, { email: inviteeEmail('parity'), role: 'ADMIN' });

      expect(roleResp.statusCode).toBe(403);
      expect(inviteResp.statusCode).toBe(403);
      expect(JSON.parse(inviteResp.body).error.message).toBe(JSON.parse(roleResp.body).error.message);
    });
  });

  describe('unchanged invitation rules', () => {
    it('an ADMIN may still invite a MEMBER', async () => {
      const f = await fixture('admin-member');
      const resp = await createInvite(f.group.id, f.admin, { email: inviteeEmail('am'), role: 'MEMBER' });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.role).toBe('MEMBER');
    });

    it('an ADMIN may still invite a MODERATOR', async () => {
      const f = await fixture('admin-mod');
      const resp = await createInvite(f.group.id, f.admin, { email: inviteeEmail('amod'), role: 'MODERATOR' });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.role).toBe('MODERATOR');
    });

    it('an ADMIN may still invite with the default role', async () => {
      const f = await fixture('admin-default');
      const resp = await createInvite(f.group.id, f.admin, { email: inviteeEmail('ad') });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.role).toBe('MEMBER');
    });

    it('a non-manager still cannot invite at all', async () => {
      const f = await fixture('nonmanager');
      const member = await createUser('nm-mem');
      await prisma.groupMember.create({
        data: {
          groupId: f.group.id,
          userId: member.id,
          role: GroupMemberRole.MEMBER,
          status: GroupMemberStatus.ACTIVE,
        },
      });
      const resp = await createInvite(f.group.id, member, { email: inviteeEmail('nm'), role: 'MEMBER' });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('Insufficient permissions');
    });
  });

  describe('an authorized ADMIN invitation is still redeemable end to end', () => {
    it('an OWNER-issued ADMIN invite can be accepted and confers ADMIN', async () => {
      const f = await fixture('accept');
      const invitee = await createUser('accept-invitee');

      const created = await createInvite(f.group.id, f.owner, { email: invitee.email, role: 'ADMIN' });
      expect(created.statusCode).toBe(200);
      const inviteToken = JSON.parse(created.body).data.token as string;
      expect(inviteToken).toBeTruthy();

      const accepted = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken(invitee)),
        payload: { token: inviteToken },
      });
      expect(accepted.statusCode).toBe(200);

      const membership = await prisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: f.group.id, userId: invitee.id } },
      });
      expect(membership.role).toBe('ADMIN');
      expect(membership.status).toBe('ACTIVE');

      // The escalation ceiling still holds for the newly minted ADMIN.
      const escalation = await createInvite(f.group.id, invitee, { email: inviteeEmail('escalate'), role: 'ADMIN' });
      expect(escalation.statusCode).toBe(403);
    });
  });
});
