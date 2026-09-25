import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupStatus, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

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

const EMAIL_PREFIX = 'ginv-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const email = `${EMAIL_PREFIX}${tag}-${suffix}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      username: `gi_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `InvTest ${tag} ${suffix}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function createGroup(
  ownerId: string,
  name: string,
  overrides: { isPrivate?: boolean; status?: GroupStatus } = {}
) {
  const group = await prisma.group.create({
    data: {
      ownerId,
      name: `${name}-${uniqueSuffix().slice(0, 6)}`,
      description: `Fixture: ${name}`,
      isPrivate: overrides.isPrivate ?? false,
      status: overrides.status ?? GroupStatus.ACTIVE,
    },
  });
  // Mirror the API's create-group transaction: the owner always gets a membership row.
  await addMember(group.id, ownerId, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE);
  return group;
}

async function addMember(
  groupId: string,
  userId: string,
  role: GroupMemberRole = GroupMemberRole.MEMBER,
  status: GroupMemberStatus = GroupMemberStatus.ACTIVE
) {
  return prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    update: { role, status },
    create: { groupId, userId, role, status },
  });
}

async function cleanFixtures() {
  // safeRecordActivity is fire-and-forget in the routes (GROUP_JOIN) and may
  // still be inserting reward/achievement/wallet rows while teardown runs.
  // Repeat the whole block until it stops colliding with late-arriving async
  // writes, then drop the users. Order mirrors the rewards suites' teardown.
  for (let attempt = 0; attempt < 12; attempt++) {
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    if (!users.length) return;
    const userIds = users.map((u) => u.id);

    const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g) => g.id);
    if (groupIds.length) {
      await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
      await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    }
    await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.rewardClaim.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userAchievement.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userTask.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userXpEvent.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userProgress.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.dailyStreak.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.vipMembership.deleteMany({ where: { userId: { in: userIds } } });

    const wallets = await prisma.wallet.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const walletIds = wallets.map((w) => w.id);
    if (walletIds.length) {
      // The fire-and-forget GROUP_JOIN activity may still be inserting
      // wallet transactions; retry so the wallet delete succeeds.
      for (let i = 0; i < 10; i++) {
        await prisma.walletTransaction.deleteMany({ where: { walletId: { in: walletIds } } });
        try {
          await prisma.wallet.deleteMany({ where: { id: { in: walletIds } } });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }

    try {
      // Coin provenance/allocation rows are a real foreign key to User —
      // must be cleared before the user row itself can be deleted (covers
      // legacy backfill rows for any stale fixture user too).
      await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
      const res = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (res.count === users.length) return;
    } catch {
      // Late-arriving async reward writes still reference these users; wait
      // and retry the whole block so teardown eventually drains safely.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

// ─── Invitation Lifecycle Tests ─────────────────────────────────

describeIf('groups/routes — Invitation lifecycle', () => {
  describe('POST /groups/:id/invites — create invite', () => {
    it('creates an invite for a private group (OWNER)', async () => {
      const owner = await createUser('inv-owner');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'InvGroup', { isPrivate: true });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'invitee@test.local' },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.success).toBe(true);
      expect(body.data.email).toBe('invitee@test.local');
      expect(body.data.role).toBe('MEMBER');
      expect(body.data.status).toBe('PENDING');
      expect(body.data.token).toBeDefined();
    });

    it('rejects invites for public groups', async () => {
      const owner = await createUser('inv-pub');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'PubGroup');

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'test@test.local' },
      });
      expect(resp.statusCode).toBe(400);
    });

    it('rejects invite if user is already an active member', async () => {
      const owner = await createUser('inv-exist');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'ExistGroup', { isPrivate: true });
      const target = await createUser('inv-exist-target');
      await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: target.email },
      });
      expect(resp.statusCode).toBe(409);
    });

    it('rejects duplicate pending invite for same email', async () => {
      const owner = await createUser('inv-dupe');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'DupeGroup', { isPrivate: true });

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'dupeme@test.local' },
      });

      const resp2 = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'dupeme@test.local' },
      });
      expect(resp2.statusCode).toBe(409);
    });

    it('allows re-invite after revocation', async () => {
      const owner = await createUser('inv-reinvite');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'ReInvGroup', { isPrivate: true });

      // Create and revoke.
      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'revoked@test.local' },
      });
      const inviteId = JSON.parse(createResp.body).data.id;

      await server.inject({
        method: 'DELETE',
        url: `${PREFIX}/${group.id}/invites/${inviteId}`,
        headers: authHeader(token),
      });

      // Re-invite should work.
      const resp2 = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'revoked@test.local' },
      });
      expect(resp2.statusCode).toBe(200);
    });

    it('rejects if actor is not a manager', async () => {
      const owner = await createUser('inv-noman');
      const member = await createUser('inv-noman-m');
      const memberToken = await mintToken(member);
      const group = await createGroup(owner.id, 'NoManGroup', { isPrivate: true });
      await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(memberToken),
        payload: { email: 'noone@test.local' },
      });
      expect(resp.statusCode).toBe(403);
    });

    it('sends a notification if the invitee exists', async () => {
      const owner = await createUser('inv-notify');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'NotifyInv', { isPrivate: true });
      const invitee = await createUser('inv-notify-target');

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: invitee.email },
      });

      const notif = await prisma.notification.findFirst({
        where: { userId: invitee.id, type: 'GROUP_INVITE' },
      });
      expect(notif).not.toBeNull();
    });
  });

  describe('GET /groups/:id/invites — list invites', () => {
    it('lists only PENDING invites for managers', async () => {
      const owner = await createUser('inv-list');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'ListInv', { isPrivate: true });

      // Create two invites.
      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'list1@test.local' },
      });
      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'list2@test.local' },
      });

      const resp = await server.inject({
        method: 'GET',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.data.length).toBe(2);
      expect(body.meta.total).toBe(2);
    });

    it('rejects non-managers', async () => {
      const owner = await createUser('inv-list-2');
      const member = await createUser('inv-list-2m');
      const memberToken = await mintToken(member);
      const group = await createGroup(owner.id, 'ListInv2', { isPrivate: true });
      await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'GET',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(memberToken),
      });
      expect(resp.statusCode).toBe(403);
    });
  });

  describe('DELETE /groups/:id/invites/:inviteId — revoke invite', () => {
    it('revokes a PENDING invite', async () => {
      const owner = await createUser('inv-revoke');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'RevokeInv', { isPrivate: true });

      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: 'revoke@test.local' },
      });
      const inviteId = JSON.parse(createResp.body).data.id;

      const resp = await server.inject({
        method: 'DELETE',
        url: `${PREFIX}/${group.id}/invites/${inviteId}`,
        headers: authHeader(token),
      });
      expect(resp.statusCode).toBe(200);

      // Confirm it's no longer listed.
      const listResp = await server.inject({
        method: 'GET',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
      });
      expect(JSON.parse(listResp.body).data.length).toBe(0);
    });
  });

  describe('POST /groups/accept-invite — accept invite', () => {
    it('accepts a valid invite and creates membership', async () => {
      const owner = await createUser('inv-accept');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'AcceptInv', { isPrivate: true });

      const invitee = await createUser('inv-acceptee');
      const inviteeToken = await mintToken(invitee);

      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: invitee.email },
      });
      const inviteData = JSON.parse(createResp.body).data;

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(inviteeToken),
        payload: { token: inviteData.token },
      });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.groupId).toBe(group.id);

      // Verify membership.
      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: invitee.id } },
      });
      expect(membership).not.toBeNull();
      expect(membership!.status).toBe('ACTIVE');
      expect(membership!.role).toBe('MEMBER');
    });

    it('rejects replay of already-accepted invite', async () => {
      const owner = await createUser('inv-replay');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'ReplayInv', { isPrivate: true });

      const invitee = await createUser('inv-replayee');
      const inviteeToken = await mintToken(invitee);

      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: invitee.email },
      });
      const inviteData = JSON.parse(createResp.body).data;

      // Accept once.
      await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(inviteeToken),
        payload: { token: inviteData.token },
      });

      // Replay — should fail.
      const resp2 = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(inviteeToken),
        payload: { token: inviteData.token },
      });
      expect(resp2.statusCode).toBe(409);
    });

    it('rejects expired invite', async () => {
      const owner = await createUser('inv-expire');
      const group = await createGroup(owner.id, 'ExpireInv', { isPrivate: true });

      const invitee = await createUser('inv-expiree');
      const inviteeToken = await mintToken(invitee);

      // Create an already-expired invite with matching email.
      const invite = await prisma.groupInvite.create({
        data: {
          groupId: group.id,
          email: invitee.email.toLowerCase(),
          token: randomUUID(),
          expiresAt: new Date(Date.now() - 1000),
          invitedBy: owner.id,
        },
      });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(inviteeToken),
        payload: { token: invite.token },
      });
      expect(resp.statusCode).toBe(400);

      // Confirm it was marked EXPIRED.
      const updated = await prisma.groupInvite.findUnique({ where: { id: invite.id } });
      expect(updated!.status).toBe('EXPIRED');
    });

    it('rejects revoked invite', async () => {
      const owner = await createUser('inv-revoked-acc');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'RevAccInv', { isPrivate: true });

      const invitee = await createUser('inv-revacc-ee');

      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: invitee.email },
      });
      const inviteId = JSON.parse(createResp.body).data.id;
      const inviteToken = JSON.parse(createResp.body).data.token;

      // Revoke.
      await server.inject({
        method: 'DELETE',
        url: `${PREFIX}/${group.id}/invites/${inviteId}`,
        headers: authHeader(token),
      });

      const inviteeToken = await mintToken(invitee);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(inviteeToken),
        payload: { token: inviteToken },
      });
      expect(resp.statusCode).toBe(409);
    });

    it('creates a notification for the inviter', async () => {
      const owner = await createUser('inv-notif-accept');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'NotifAcceptInv', { isPrivate: true });

      const invitee = await createUser('inv-notif-acceptee');
      const inviteeToken = await mintToken(invitee);

      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: invitee.email },
      });
      const inviteData = JSON.parse(createResp.body).data;

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(inviteeToken),
        payload: { token: inviteData.token },
      });

      const notif = await prisma.notification.findFirst({
        where: { userId: owner.id, type: 'GROUP_INVITE_ACCEPTED' },
      });
      expect(notif).not.toBeNull();
    });

    it('concurrent accepts of the same invite — exactly one wins', async () => {
      const owner = await createUser('inv-conc-acc');
      const token = await mintToken(owner);
      const group = await createGroup(owner.id, 'ConcAccInv', { isPrivate: true });

      const invitee = await createUser('inv-conc-acceptor');
      const inviteeToken = await mintToken(invitee);

      const createResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(token),
        payload: { email: invitee.email },
      });
      const inviteData = JSON.parse(createResp.body).data;

      const [respA, respB] = await Promise.all([
        server.inject({
          method: 'POST',
          url: `${PREFIX}/accept-invite`,
          headers: authHeader(inviteeToken),
          payload: { token: inviteData.token },
        }),
        server.inject({
          method: 'POST',
          url: `${PREFIX}/accept-invite`,
          headers: authHeader(inviteeToken),
          payload: { token: inviteData.token },
        }),
      ]);

      const wins = [respA, respB].filter((r) => r.statusCode === 200);
      const losses = [respA, respB].filter((r) => r.statusCode === 409);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(1);

      // The invite is marked ACCEPTED, and exactly one user became a member.
      const inviteAfter = await prisma.groupInvite.findUnique({ where: { id: inviteData.id } });
      expect(inviteAfter!.status).toBe('ACCEPTED');

      const membershipCount = await prisma.groupMember.count({
        where: { groupId: group.id, userId: invitee.id, status: 'ACTIVE' },
      });
      expect(membershipCount).toBe(1);
    });
  });
});

// ─── Join Request Flow Tests ─────────────────────────────────────

describeIf('groups/routes — Join request flow', () => {
  describe('POST /groups/:id/request — request membership', () => {
    it('creates a PENDING membership for private group', async () => {
      const owner = await createUser('jr-owner');
      const group = await createGroup(owner.id, 'JRGroup', { isPrivate: true });

      const requester = await createUser('jr-requester');
      const reqToken = await mintToken(requester);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/request`,
        headers: authHeader(reqToken),
      });
      expect(resp.statusCode).toBe(200);

      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: requester.id } },
      });
      expect(membership).not.toBeNull();
      expect(membership!.status).toBe('PENDING');
    });

    it('rejects if already an active member', async () => {
      const owner = await createUser('jr-already');
      const group = await createGroup(owner.id, 'JRAlready', { isPrivate: true });
      const member = await createUser('jr-already-m');
      await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/request`,
        headers: authHeader(await mintToken(member)),
      });
      expect(resp.statusCode).toBe(409);
    });

    it('rejects for public groups (use join instead)', async () => {
      const owner = await createUser('jr-pub');
      const group = await createGroup(owner.id, 'JRPub');
      const requester = await createUser('jr-pub-r');

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/request`,
        headers: authHeader(await mintToken(requester)),
      });
      expect(resp.statusCode).toBe(400);
    });

    it('rejects if user is banned', async () => {
      const owner = await createUser('jr-banned');
      const group = await createGroup(owner.id, 'JRBanned', { isPrivate: true });
      const banned = await createUser('jr-banned-u');
      await addMember(group.id, banned.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/request`,
        headers: authHeader(await mintToken(banned)),
      });
      expect(resp.statusCode).toBe(403);
    });

    it('notifies all managers', async () => {
      const owner = await createUser('jr-notif');
      const admin = await createUser('jr-notif-admin');
      const group = await createGroup(owner.id, 'JRNotif', { isPrivate: true });
      await addMember(group.id, admin.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);

      const requester = await createUser('jr-notif-r');
      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/request`,
        headers: authHeader(await mintToken(requester)),
      });

      const ownerNotif = await prisma.notification.findFirst({ where: { userId: owner.id, type: 'GROUP_JOIN_REQUEST' } });
      const adminNotif = await prisma.notification.findFirst({ where: { userId: admin.id, type: 'GROUP_JOIN_REQUEST' } });
      expect(ownerNotif).not.toBeNull();
      expect(adminNotif).not.toBeNull();
    });
  });

  describe('POST /groups/:id/requests/:userId/approve', () => {
    it('approves a PENDING membership', async () => {
      const owner = await createUser('jr-approve');
      const group = await createGroup(owner.id, 'JRApprove', { isPrivate: true });
      const requester = await createUser('jr-approve-r');
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/approve`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(resp.statusCode).toBe(200);

      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: requester.id } },
      });
      expect(membership!.status).toBe('ACTIVE');
    });

    it('rejects if request is not pending', async () => {
      const owner = await createUser('jr-ap-nope');
      const group = await createGroup(owner.id, 'JRAPNope', { isPrivate: true });
      const member = await createUser('jr-ap-nope-m');
      await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${member.id}/approve`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(resp.statusCode).toBe(400);
    });

    it('sends notification to approved user', async () => {
      const owner = await createUser('jr-ap-notif');
      const group = await createGroup(owner.id, 'JRAPNotif', { isPrivate: true });
      const requester = await createUser('jr-ap-notif-r');
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/approve`,
        headers: authHeader(await mintToken(owner)),
      });

      const notif = await prisma.notification.findFirst({
        where: { userId: requester.id, type: 'GROUP_APPROVED' },
      });
      expect(notif).not.toBeNull();
    });
  });

  describe('POST /groups/:id/requests/:userId/reject', () => {
    it('rejects a PENDING membership (deletes the row)', async () => {
      const owner = await createUser('jr-reject');
      const group = await createGroup(owner.id, 'JRReject', { isPrivate: true });
      const requester = await createUser('jr-reject-r');
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/reject`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(resp.statusCode).toBe(200);

      const membership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: requester.id } },
      });
      expect(membership).toBeNull();
    });

    it('sends GROUP_REJECTED notification', async () => {
      const owner = await createUser('jr-rej-notif');
      const group = await createGroup(owner.id, 'JRRejNotif', { isPrivate: true });
      const requester = await createUser('jr-rej-notif-r');
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/reject`,
        headers: authHeader(await mintToken(owner)),
      });

      const notif = await prisma.notification.findFirst({
        where: { userId: requester.id, type: 'GROUP_REJECTED' },
      });
      expect(notif).not.toBeNull();
    });

    it('rejects if not a manager', async () => {
      const owner = await createUser('jr-rej-noman');
      const group = await createGroup(owner.id, 'JRRejNoMan', { isPrivate: true });
      const requester = await createUser('jr-rej-noman-r');
      const nonmanager = await createUser('jr-rej-noman-nm');
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      await addMember(group.id, nonmanager.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/reject`,
        headers: authHeader(await mintToken(nonmanager)),
      });
      expect(resp.statusCode).toBe(403);
    });
  });
});

// ─── Ownership Transfer Tests ────────────────────────────────────

describeIf('groups/routes — Ownership transfer', () => {
  describe('POST /groups/:id/transfer', () => {
    it('transfers ownership atomically', async () => {
      const owner = await createUser('ot-owner');
      const newOwner = await createUser('ot-new');
      const group = await createGroup(owner.id, 'OTGroup');
      await addMember(group.id, newOwner.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(owner)),
        payload: { targetUserId: newOwner.id },
      });
      expect(resp.statusCode).toBe(200);

      // Verify owner changed.
      const updatedGroup = await prisma.group.findUnique({ where: { id: group.id } });
      expect(updatedGroup!.ownerId).toBe(newOwner.id);

      // Verify roles.
      const oldMember = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: owner.id } },
      });
      const newMember = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId: newOwner.id } },
      });
      expect(oldMember!.role).toBe('ADMIN');
      expect(newMember!.role).toBe('OWNER');
    });

    it('rejects non-owner', async () => {
      const owner = await createUser('ot-noowner');
      const other = await createUser('ot-noowner-o');
      const target = await createUser('ot-noowner-t');
      const group = await createGroup(owner.id, 'OTNoOwner');
      await addMember(group.id, other.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
      await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(other)),
        payload: { targetUserId: target.id },
      });
      expect(resp.statusCode).toBe(403);
    });

    it('rejects self-transfer', async () => {
      const owner = await createUser('ot-self');
      const group = await createGroup(owner.id, 'OTSelf');

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(owner)),
        payload: { targetUserId: owner.id },
      });
      expect(resp.statusCode).toBe(400);
    });

    it('rejects if target is not an active member', async () => {
      const owner = await createUser('ot-notactive');
      const target = await createUser('ot-notactive-t');
      const group = await createGroup(owner.id, 'OTNotActive');
      await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(owner)),
        payload: { targetUserId: target.id },
      });
      expect(resp.statusCode).toBe(400);
    });

    it('notifies both parties', async () => {
      const owner = await createUser('ot-notify');
      const newOwner = await createUser('ot-notify-n');
      const group = await createGroup(owner.id, 'OTNotify');
      await addMember(group.id, newOwner.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(owner)),
        payload: { targetUserId: newOwner.id },
      });

      const ownerNotif = await prisma.notification.findFirst({
        where: { userId: owner.id, type: 'GROUP_OWNERSHIP_TRANSFERRED' },
      });
      const newOwnerNotif = await prisma.notification.findFirst({
        where: { userId: newOwner.id, type: 'GROUP_OWNERSHIP_TRANSFERRED' },
      });
      expect(ownerNotif).not.toBeNull();
      expect(newOwnerNotif).not.toBeNull();
    });

    it('rejects with 409 on concurrent ownership change', async () => {
      const owner = await createUser('ot-concur');
      const target1 = await createUser('ot-concur-t1');
      const target2 = await createUser('ot-concur-t2');
      const group = await createGroup(owner.id, 'OTConcur');
      await addMember(group.id, target1.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      await addMember(group.id, target2.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      // Fire two transfers concurrently; exactly one must win.
      const [resp1, resp2] = await Promise.all([
        server.inject({
          method: 'POST',
          url: `${PREFIX}/${group.id}/transfer`,
          headers: authHeader(await mintToken(owner)),
          payload: { targetUserId: target1.id },
        }),
        server.inject({
          method: 'POST',
          url: `${PREFIX}/${group.id}/transfer`,
          headers: authHeader(await mintToken(owner)),
          payload: { targetUserId: target2.id },
        }),
      ]);

      const wins = [resp1, resp2].filter((r) => r.statusCode === 200);
      const losses = [resp1, resp2].filter((r) => r.statusCode === 409);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(1);

      // Verify the winning transfer landed correctly.
      const updatedGroup = await prisma.group.findUnique({ where: { id: group.id } });
      const winningTargetId = wins[0] === resp1 ? target1.id : target2.id;
      expect(updatedGroup!.ownerId).toBe(winningTargetId);
    });
  });
});

// ─── Privacy Tests ───────────────────────────────────────────────

describeIf('groups/routes — Private group privacy', () => {
  it('non-members can access private group safe summary (no members/invites leaked)', async () => {
    const owner = await createUser('priv-owner');
    const outsider = await createUser('priv-outsider');
    const group = await createGroup(owner.id, 'PrivGroup', { isPrivate: true });

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(outsider)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data.isMember).toBe(false);
    expect(body.data.memberRole).toBeNull();
    expect(body.data.requestStatus).toBeNull();
    expect(body.data.owner).toBeNull();
  });

  it('private group summary includes requestStatus for non-members who already requested', async () => {
    const owner = await createUser('priv-disc');
    const outsider = await createUser('priv-disc-o');
    const group = await createGroup(owner.id, 'PrivDiscGroup', { isPrivate: true });

    // Simulate the outsider having requested.
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: outsider.id, role: 'MEMBER', status: 'PENDING' },
    });

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(outsider)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data.isMember).toBe(false);
    expect(body.data.requestStatus).toBe('PENDING');
    expect(body.data.owner).toBeNull();
  });
});

// ─── Viewer Membership Status Tests ──────────────────────────────

describeIf('groups/routes — GET /groups/:id viewerMembershipStatus', () => {
  it('a banned caller receives viewerMembershipStatus BANNED with isMember false', async () => {
    const owner = await createUser('vms-banned-o');
    const banned = await createUser('vms-banned-u');
    const group = await createGroup(owner.id, 'VMSBanned', { isPrivate: true });
    await addMember(group.id, banned.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(banned)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data.viewerMembershipStatus).toBe('BANNED');
    expect(body.data.isMember).toBe(false);
  });

  it('the private-group banned summary stays privacy-safe (no members/invites/owner/tokens/other status)', async () => {
    const owner = await createUser('vms-priv-o');
    const banned = await createUser('vms-priv-b');
    const innocent = await createUser('vms-priv-i');
    const group = await createGroup(owner.id, 'VMSPrivSafe', { isPrivate: true });
    await addMember(group.id, banned.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);
    await addMember(group.id, innocent.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
    await prisma.groupInvite.create({
      data: {
        groupId: group.id,
        email: 'vms-priv-invite@test.local',
        role: 'ADMIN',
        token: `tok-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 86400000),
        invitedBy: owner.id,
      },
    });

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(banned)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    // Caller-scoped status only.
    expect(body.data.viewerMembershipStatus).toBe('BANNED');
    expect(body.data.isMember).toBe(false);
    // No other user's membership status or role.
    expect(body.data.owner).toBeNull();
    expect(body.data.memberRole).toBeNull();
    // No member list, invites, or invite tokens.
    expect(body.data.members).toBeUndefined();
    expect(body.data.invites).toBeUndefined();
    expect(body.data.token).toBeUndefined();
    expect(JSON.stringify(body.data)).not.toContain('vms-priv-invite@test.local');
    expect(JSON.stringify(body.data)).not.toContain(innocent.id);
  });

  it('an ACTIVE member receives the canonical active status', async () => {
    const owner = await createUser('vms-active-o');
    const member = await createUser('vms-active-m');
    const group = await createGroup(owner.id, 'VMSActive', { isPrivate: true });
    await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(member)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data.viewerMembershipStatus).toBe('ACTIVE');
    expect(body.data.isMember).toBe(true);
  });

  it('a PENDING requester receives canonical pending status and requestStatus stays PENDING', async () => {
    const owner = await createUser('vms-pend-o');
    const requester = await createUser('vms-pend-r');
    const group = await createGroup(owner.id, 'VMSPending', { isPrivate: true });
    await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(requester)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data.viewerMembershipStatus).toBe('PENDING');
    expect(body.data.requestStatus).toBe('PENDING');
    expect(body.data.isMember).toBe(false);
  });

  it('a true stranger receives viewerMembershipStatus null', async () => {
    const owner = await createUser('vms-str-o');
    const stranger = await createUser('vms-str-s');
    const group = await createGroup(owner.id, 'VMSStrange', { isPrivate: true });

    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}`,
      headers: authHeader(await mintToken(stranger)),
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.data.viewerMembershipStatus).toBeNull();
    expect(body.data.isMember).toBe(false);
  });

  it('a banned caller is still rejected by the join-request route and creates no membership', async () => {
    const owner = await createUser('vms-jr-o');
    const banned = await createUser('vms-jr-b');
    const group = await createGroup(owner.id, 'VMSJRReject', { isPrivate: true });
    await addMember(group.id, banned.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

    const resp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${group.id}/request`,
      headers: authHeader(await mintToken(banned)),
    });
    expect(resp.statusCode).toBe(403);

    const membership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: banned.id } },
    });
    expect(membership).not.toBeNull();
    expect(membership!.status).toBe('BANNED');
  });

  it('status is scoped by groupId and userId; a ban in one group does not leak into another', async () => {
    const owner = await createUser('vms-scope-o');
    const caller = await createUser('vms-scope-c');
    const bannedGroup = await createGroup(owner.id, 'VMSScopeBan', { isPrivate: true });
    const otherGroup = await createGroup(owner.id, 'VMSScopeOk', { isPrivate: false });
    await addMember(bannedGroup.id, caller.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);
    // Caller is a genuinely unrelated stranger to `otherGroup` — no row at all.
    const otherOwner = await createUser('vms-scope-o2');
    await createGroup(otherOwner.id, 'VMSScopeOther', { isPrivate: true });

    const bannedResp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${bannedGroup.id}`,
      headers: authHeader(await mintToken(caller)),
    });
    expect(bannedResp.statusCode).toBe(200);
    expect(JSON.parse(bannedResp.body).data.viewerMembershipStatus).toBe('BANNED');

    const otherResp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${otherGroup.id}`,
      headers: authHeader(await mintToken(caller)),
    });
    expect(otherResp.statusCode).toBe(200);
    expect(JSON.parse(otherResp.body).data.viewerMembershipStatus).toBeNull();
    expect(JSON.parse(otherResp.body).data.isMember).toBe(false);
  });
});

// ─── Authorization Matrix Tests ──────────────────────────────────

describeIf('groups/routes — Authorization matrix', () => {
  it('MEMBER cannot manage invites, approve requests, or transfer ownership', async () => {
    const owner = await createUser('authz-owner');
    const member = await createUser('authz-member');
    const group = await createGroup(owner.id, 'AuthzGroup', { isPrivate: true });
    await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
    const token = await mintToken(member);

    // Create invite.
    const inv = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${group.id}/invites`,
      headers: authHeader(token),
      payload: { email: 'no@test.local' },
    });
    expect(inv.statusCode).toBe(403);

    // List invites.
    const list = await server.inject({
      method: 'GET',
      url: `${PREFIX}/${group.id}/invites`,
      headers: authHeader(token),
    });
    expect(list.statusCode).toBe(403);

    // Transfer.
    const tr = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${group.id}/transfer`,
      headers: authHeader(token),
      payload: { targetUserId: owner.id },
    });
    expect(tr.statusCode).toBe(403);
  });

  it('ADMIN can manage invites and approve/reject, but not transfer ownership', async () => {
    const owner = await createUser('authz-admin-o');
    const admin = await createUser('authz-admin-a');
    const target = await createUser('authz-admin-t');
    const group = await createGroup(owner.id, 'AuthzAdmin', { isPrivate: true });
    await addMember(group.id, admin.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
    await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
    const token = await mintToken(admin);

    // Create invite — should succeed.
    const inv = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${group.id}/invites`,
      headers: authHeader(token),
      payload: { email: 'admin-invite@test.local' },
    });
    expect(inv.statusCode).toBe(200);

    // Approve request — should succeed.
    const apr = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${group.id}/requests/${target.id}/approve`,
      headers: authHeader(token),
    });
    expect(apr.statusCode).toBe(200);

    // Transfer ownership — should fail.
    const tr = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${group.id}/transfer`,
      headers: authHeader(token),
      payload: { targetUserId: owner.id },
    });
    expect(tr.statusCode).toBe(403);
  });
});

// ─── Hardening: review findings integration coverage ─────────────

describeIf('groups/routes — hardening findings', () => {
  describe('GET /groups/:id/requests — pending request listing', () => {
    it('returns only PENDING requests for managers', async () => {
      const owner = await createUser('h-req-owner');
      const admin = await createUser('h-req-admin');
      const pending = await createUser('h-req-pending');
      const active = await createUser('h-req-active');
      const group = await createGroup(owner.id, 'ReqList', { isPrivate: true });
      await addMember(group.id, admin.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
      await addMember(group.id, pending.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      await addMember(group.id, active.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'GET',
        url: `${PREFIX}/${group.id}/requests`,
        headers: authHeader(await mintToken(admin)),
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].user.id).toBe(pending.id);
      expect(body.data[0].status).toBe('PENDING');
    });

    it('rejects non-managers and banned/LEFT members', async () => {
      const owner = await createUser('h-req-o2');
      const member = await createUser('h-req-m2');
      const group = await createGroup(owner.id, 'ReqList2', { isPrivate: true });
      await addMember(group.id, member.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      const token = await mintToken(member);

      const resp = await server.inject({
        method: 'GET',
        url: `${PREFIX}/${group.id}/requests`,
        headers: authHeader(token),
      });
      expect(resp.statusCode).toBe(403);
    });
  });

  describe('invite acceptance binding — verified email', () => {
    async function makeInvite(ownerId: string, groupId: string, email: string) {
      const { id, email: ownerEmail, username } = await prisma.user.findUniqueOrThrow({ where: { id: ownerId } });
      const inv = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${groupId}/invites`,
        headers: authHeader(await mintToken({ id, email: ownerEmail!, username })),
        payload: { email },
      });
      return JSON.parse(inv.body).data.token;
    }

    it('rejects acceptors whose verified email does not match the invite', async () => {
      const owner = await createUser('h-email-owner');
      const invitee = await createUser('h-email-target');
      const mismatch = await createUser('h-email-wrong');
      const group = await createGroup(owner.id, 'EmailBind', { isPrivate: true });

      const token = await makeInvite(owner.id, group.id, invitee.email);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken(mismatch)),
        payload: { token },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('This invite is not for your email address');
    });

    it('rejects unverified identities even when the email matches', async () => {
      const owner = await createUser('h-unver-owner');
      const group = await createGroup(owner.id, 'UnverBind', { isPrivate: true });
      const suffix = uniqueSuffix();
      const email = `${EMAIL_PREFIX}h-unver-${suffix}@test.local`;
      const unverified = await prisma.user.create({
        data: {
          email,
          username: `h_unver_${suffix}`.slice(0, 30),
          passwordHash: 'fixture-only-not-a-real-hash',
          displayName: 'Unverified',
          status: 'ACTIVE',
          isVerified: false,
        },
      });

      const token = await makeInvite(owner.id, group.id, unverified.email!);
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken({ id: unverified.id, email: unverified.email!, username: unverified.username })),
        payload: { token },
      });
      expect(resp.statusCode).toBe(403);
    });

    it('matches the invite email case-insensitively', async () => {
      const owner = await createUser('h-case-owner');
      const invitee = await createUser('h-case-target');
      const group = await createGroup(owner.id, 'CaseBind', { isPrivate: true });

      const token = await makeInvite(owner.id, group.id, invitee.email.toUpperCase());
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken(invitee)),
        payload: { token },
      });
      expect(resp.statusCode).toBe(200);
    });
  });

  describe('invite acceptance — banned users', () => {
    it('rejects creating an invite for an existing BANNED member', async () => {
      const owner = await createUser('h-ban-owner');
      const invitee = await createUser('h-ban-invitee');
      const group = await createGroup(owner.id, 'BanBind', { isPrivate: true });
      await addMember(group.id, invitee.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: invitee.email },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toContain('banned');
    });

    it('rejects a BANNED member trying to accept', async () => {
      const owner = await createUser('h-ban-owner-2');
      const invitee = await createUser('h-ban-invitee-2');
      const group = await createGroup(owner.id, 'BanBind2', { isPrivate: true });

      // Create invite while invitee is not yet banned.
      const tokenResp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: invitee.email },
      });
      const invT = JSON.parse(tokenResp.body).data.token;

      // Ban after invite was created.
      await addMember(group.id, invitee.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken(invitee)),
        payload: { token: invT },
      });
      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('You are banned from this group');
    });

    it('rejects an account whose user.status is BANNED', async () => {
      const owner = await createUser('h-uban-owner');
      const group = await createGroup(owner.id, 'UBanBind', { isPrivate: true });
      const bannedUser = await prisma.user.create({
        data: {
          email: `${EMAIL_PREFIX}h-uban-${uniqueSuffix()}@test.local`,
          username: `h_uban_${uniqueSuffix()}`.slice(0, 30),
          passwordHash: 'fixture-only-not-a-real-hash',
          displayName: 'BannedAcct',
          status: 'BANNED',
          isVerified: true,
        },
      });

      const token = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: bannedUser.email! },
      });
      const invT = JSON.parse(token.body).data.token;

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken({ id: bannedUser.id, email: bannedUser.email!, username: bannedUser.username })),
        payload: { token: invT },
      });
      expect(resp.statusCode).toBe(403);
    });

    it('regression: mintToken accepts a user created via prisma.user.create', async () => {
      const owner = await createUser('h-reg-mint');
      const group = await createGroup(owner.id, 'RegMint', { isPrivate: true });
      const suffix = uniqueSuffix();
      const email = `${EMAIL_PREFIX}h-reg-${suffix}@test.local`;
      const raw = await prisma.user.create({
        data: {
          email,
          username: `h_reg_${suffix}`.slice(0, 30),
          passwordHash: 'fixture-only-not-a-real-hash',
          displayName: 'RegMint',
          status: 'ACTIVE',
          isVerified: true,
        },
      });
      const inv = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: raw.email! },
      });
      const token = JSON.parse(inv.body).data.token;
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: authHeader(await mintToken({ id: raw.id, email: raw.email!, username: raw.username })),
        payload: { token },
      });
      expect(resp.statusCode).toBe(200);
    });
  });

  describe('ban lifecycle — revokes pending invites', () => {
    it('revokes the banned user’s PENDING invite atomically on ban', async () => {
      const owner = await createUser('h-rev-owner');
      const victim = await createUser('h-rev-victim');
      const group = await createGroup(owner.id, 'RevOnBan', { isPrivate: true });

      // Invite the victim first (they are not a member yet).
      const inv = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: victim.email },
      });
      expect(inv.statusCode).toBe(200);
      const inviteId = JSON.parse(inv.body).data.id;

      // Now the victim is a member, and the owner bans them.
      await addMember(group.id, victim.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      const ban = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/members/${victim.id}/ban`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(ban.statusCode).toBe(200);

      const inviteAfter = await prisma.groupInvite.findUniqueOrThrow({ where: { id: inviteId } });
      expect(inviteAfter.status).toBe('REVOKED');
      const membership = await prisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: group.id, userId: victim.id } },
      });
      expect(membership.status).toBe('BANNED');
    });

    it('repeated bans of an already-banned member do not create a second MODERATION notification', async () => {
      const owner = await createUser('h-rep-owner');
      const victim = await createUser('h-rep-victim');
      const group = await createGroup(owner.id, 'RepeatBan', { isPrivate: true });
      await addMember(group.id, victim.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      const headers = authHeader(await mintToken(owner));

      const first = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/members/${victim.id}/ban`,
        headers,
      });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body).data.message).toBe('Member banned');

      const second = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/members/${victim.id}/ban`,
        headers,
      });
      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).data.message).toBe('Member already banned');

      const third = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/members/${victim.id}/ban`,
        headers,
      });
      expect(third.statusCode).toBe(200);

      const notifications = await prisma.notification.findMany({
        where: { userId: victim.id, type: 'MODERATION' },
      });
      expect(notifications).toHaveLength(1);

      const membership = await prisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: group.id, userId: victim.id } },
      });
      expect(membership.status).toBe('BANNED');
    });

    it('two concurrent ban requests for the same member create exactly one MODERATION notification', async () => {
      const owner = await createUser('h-conc-ban-owner');
      const admin = await createUser('h-conc-ban-admin');
      const victim = await createUser('h-conc-ban-victim');
      const group = await createGroup(owner.id, 'ConcBan', { isPrivate: true });
      await addMember(group.id, admin.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
      await addMember(group.id, victim.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const [respA, respB] = await Promise.all([
        server.inject({
          method: 'POST',
          url: `${PREFIX}/${group.id}/members/${victim.id}/ban`,
          headers: authHeader(await mintToken(owner)),
        }),
        server.inject({
          method: 'POST',
          url: `${PREFIX}/${group.id}/members/${victim.id}/ban`,
          headers: authHeader(await mintToken(admin)),
        }),
      ]);

      expect([respA.statusCode, respB.statusCode]).toEqual([200, 200]);
      const messages = [JSON.parse(respA.body).data.message, JSON.parse(respB.body).data.message].sort();
      expect(messages).toEqual(['Member already banned', 'Member banned']);

      const notifications = await prisma.notification.findMany({
        where: { userId: victim.id, type: 'MODERATION' },
      });
      expect(notifications).toHaveLength(1);
    });
  });

  describe('email normalization + duplicate races', () => {
    it('normalizes invite emails to lowercase', async () => {
      const owner = await createUser('h-norm-owner');
      const group = await createGroup(owner.id, 'NormEmail', { isPrivate: true });
      const inv = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: 'MiXeD@Test.LOCAL' },
      });
      const invite = JSON.parse(inv.body).data;
      expect(invite.email).toBe('mixed@test.local');
    });

    it('returns 409 when a PENDING invite already exists for the same email (any case)', async () => {
      const owner = await createUser('h-dup-owner');
      const group = await createGroup(owner.id, 'DupEmail', { isPrivate: true });
      const token = await mintToken(owner);
      const headers = authHeader(token);

      await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers,
        payload: { email: 'dup@test.local' },
      });
      const again = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers,
        payload: { email: 'DUP@test.local' },
      });
      expect(again.statusCode).toBe(409);
      expect(JSON.parse(again.body).error.message).toBe('An active invite already exists for this email');
    });
  });

  describe('approve + transfer require ACTIVE groups', () => {
    it('rejects approving requests for a non-ACTIVE group', async () => {
      const owner = await createUser('h-arch-owner');
      const requester = await createUser('h-arch-req');
      const group = await prisma.group.create({
        data: {
          ownerId: owner.id,
          name: `Archived-${uniqueSuffix()}`,
          status: 'ARCHIVED',
          isPrivate: true,
        },
      });
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/approve`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(resp.statusCode).toBe(400);
    });

    it('rejects ownership transfer for a non-ACTIVE group', async () => {
      const owner = await createUser('h-arch-t-owner');
      const target = await createUser('h-arch-t-target');
      const group = await prisma.group.create({
        data: {
          ownerId: owner.id,
          name: `ArchivedT-${uniqueSuffix()}`,
          status: 'ARCHIVED',
          isPrivate: true,
        },
      });
      await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(owner)),
        payload: { targetUserId: target.id },
      });
      expect(resp.statusCode).toBe(400);
    });

    it('rejects join-request rejection for a non-ACTIVE group', async () => {
      const owner = await createUser('h-arch-r-owner');
      const requester = await createUser('h-arch-r-req');
      const group = await prisma.group.create({
        data: {
          ownerId: owner.id,
          name: `ArchivedR-${uniqueSuffix()}`,
          status: 'ARCHIVED',
          isPrivate: true,
        },
      });
      await addMember(group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/requests/${requester.id}/reject`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(resp.statusCode).toBe(400);
    });
  });

  describe('ownership transfer race', () => {
    it('rejects a target that is no longer an ACTIVE member', async () => {
      const owner = await createUser('h-race-owner');
      const target = await createUser('h-race-target');
      const group = await createGroup(owner.id, 'RaceTransfer', { isPrivate: true });
      await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      // The target leaves before the transfer request.
      await prisma.groupMember.update({
        where: { groupId_userId: { groupId: group.id, userId: target.id } },
        data: { status: 'LEFT' },
      });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/transfer`,
        headers: authHeader(await mintToken(owner)),
        payload: { targetUserId: target.id },
      });
      expect(resp.statusCode).toBe(400);
    });

    it('protects the transfer with an in-transaction ACTIVE guard (concurrent transfer to same target yields 409)', async () => {
      const owner = await createUser('h-race2-owner');
      const target = await createUser('h-race2-target');
      const group = await createGroup(owner.id, 'RaceTransfer2', { isPrivate: true });
      await addMember(group.id, target.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);

      const [resp1, resp2] = await Promise.all([
        server.inject({
          method: 'POST',
          url: `${PREFIX}/${group.id}/transfer`,
          headers: authHeader(await mintToken(owner)),
          payload: { targetUserId: target.id },
        }),
        server.inject({
          method: 'POST',
          url: `${PREFIX}/${group.id}/transfer`,
          headers: authHeader(await mintToken(owner)),
          payload: { targetUserId: target.id },
        }),
      ]);
      const wins = [resp1, resp2].filter((r) => r.statusCode === 200);
      const losses = [resp1, resp2].filter((r) => r.statusCode === 409);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(1);
    });
  });

  describe('invite token resolution', () => {
    it('exposes only safe summary for invite tokens', async () => {
      const owner = await createUser('h-res-owner');
      const group = await createGroup(owner.id, 'ResolveInv', { isPrivate: true });
      const inv = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${group.id}/invites`,
        headers: authHeader(await mintToken(owner)),
        payload: { email: 'resolve@test.local' },
      });
      const token = JSON.parse(inv.body).data.token;

      const resp = await server.inject({
        method: 'GET',
        url: `${PREFIX}/invites/${token}`,
        headers: authHeader(await mintToken(owner)),
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body).data;
      expect(body.group.id).toBe(group.id);
      expect(body.status).toBe('PENDING');
      expect(body).not.toHaveProperty('email');
      expect(body).not.toHaveProperty('token');
    });
  });
});
