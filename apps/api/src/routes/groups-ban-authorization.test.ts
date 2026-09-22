import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupStatus, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// Authorization surface of POST /groups/:id/members/:userId/ban.
//
// This lives in its own file rather than alongside the other group tests on
// purpose: the API registers a GLOBAL rate limit of
// RATE_LIMIT_MAX_REQUESTS (100) per RATE_LIMIT_WINDOW_MS (60s), keyed by IP,
// and every `server.inject` in a file shares one budget because they share
// one server instance. groups-invites-membership.test.ts already issues ~87
// requests, so adding this suite there pushed it past the ceiling and made
// an unrelated test return 429. A separate file gets a fresh server, and
// therefore a fresh budget.
//
// Each case below pins exactly one guard in the route, so removing any single
// guard turns at least one of these red.

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

const EMAIL_PREFIX = 'gban-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `gb_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `BanTest ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
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

async function createGroup(ownerId: string, name: string, status: GroupStatus = GroupStatus.ACTIVE) {
  const group = await prisma.group.create({
    data: { ownerId, name: `${name}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status },
  });
  await addMember(group.id, ownerId, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE);
  return group;
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (!userIds.length) return;
  const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
  const groupIds = groups.map((g) => g.id);
  if (groupIds.length) {
    await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
  }
  await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  if (groupIds.length) await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  // Coin provenance/allocation rows are a real foreign key to User —
  // must be cleared before the user row itself can be deleted. Covers
  // both rows this run created AND legacy backfill rows for any stale
  // fixture user left behind by a prior interrupted run (same id set).
  await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

type Actor = { id: string; email: string; username: string };

describeIf('groups/routes — ban authorization', () => {
  async function banFixture(tag: string) {
    const owner = await createUser(`${tag}-own`);
    const admin = await createUser(`${tag}-adm`);
    const moderator = await createUser(`${tag}-mod`);
    const member = await createUser(`${tag}-mem`);
    const victim = await createUser(`${tag}-vic`);
    const outsider = await createUser(`${tag}-out`);
    const group = await createGroup(owner.id, `BanAuthz${tag}`);
    await addMember(group.id, admin.id, GroupMemberRole.ADMIN);
    await addMember(group.id, moderator.id, GroupMemberRole.MODERATOR);
    await addMember(group.id, member.id, GroupMemberRole.MEMBER);
    await addMember(group.id, victim.id, GroupMemberRole.MEMBER);
    return { owner, admin, moderator, member, victim, outsider, group };
  }

  async function ban(groupId: string, targetUserId: string, actor: Actor | null) {
    return server.inject({
      method: 'POST',
      url: `${PREFIX}/${groupId}/members/${targetUserId}/ban`,
      ...(actor ? { headers: authHeader(await mintToken(actor)) } : {}),
    });
  }

  const membershipOf = (groupId: string, userId: string) =>
    prisma.groupMember.findUniqueOrThrow({ where: { groupId_userId: { groupId, userId } } });

  const moderationCount = (userId: string) =>
    prisma.notification.count({ where: { userId, type: 'MODERATION' } });

  describe('rejected actors', () => {
    it('rejects an unauthenticated ban with 401 and leaves the membership untouched', async () => {
      const { group, victim } = await banFixture('unauth');

      const resp = await ban(group.id, victim.id, null);

      expect(resp.statusCode).toBe(401);
      expect((await membershipOf(group.id, victim.id)).status).toBe('ACTIVE');
      expect(await moderationCount(victim.id)).toBe(0);
    });

    it('rejects a plain MEMBER actor with 403', async () => {
      const { group, member, victim } = await banFixture('member');

      const resp = await ban(group.id, victim.id, member);

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('Insufficient permissions');
      expect((await membershipOf(group.id, victim.id)).status).toBe('ACTIVE');
      expect(await moderationCount(victim.id)).toBe(0);
    });

    it('rejects a MODERATOR actor with 403 — moderators are not managers', async () => {
      const { group, moderator, victim } = await banFixture('mod');

      const resp = await ban(group.id, victim.id, moderator);

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('Insufficient permissions');
      expect((await membershipOf(group.id, victim.id)).status).toBe('ACTIVE');
      expect(await moderationCount(victim.id)).toBe(0);
    });

    it('rejects an unrelated authenticated user who is not a member with 403', async () => {
      const { group, outsider, victim } = await banFixture('outsider');

      const resp = await ban(group.id, victim.id, outsider);

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('You are not a member of this group');
      expect((await membershipOf(group.id, victim.id)).status).toBe('ACTIVE');
      expect(await moderationCount(victim.id)).toBe(0);
    });
  });

  describe('rejected targets and group state', () => {
    it('rejects self-ban with 400 even for an authorized manager', async () => {
      const { group, admin } = await banFixture('self');

      const resp = await ban(group.id, admin.id, admin);

      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('You cannot ban yourself');
      expect((await membershipOf(group.id, admin.id)).status).toBe('ACTIVE');
      expect(await moderationCount(admin.id)).toBe(0);
    });

    it('rejects banning the group owner with 403', async () => {
      const { group, admin, owner } = await banFixture('owner');

      const resp = await ban(group.id, owner.id, admin);

      expect(resp.statusCode).toBe(403);
      expect(JSON.parse(resp.body).error.message).toBe('You cannot ban the owner of the group');
      const membership = await membershipOf(group.id, owner.id);
      expect(membership.status).toBe('ACTIVE');
      expect(membership.role).toBe('OWNER');
      expect(await moderationCount(owner.id)).toBe(0);
    });

    it('returns 404 when the target is not a member of the group', async () => {
      const { group, owner, outsider } = await banFixture('nomember');

      const resp = await ban(group.id, outsider.id, owner);

      expect(resp.statusCode).toBe(404);
      expect(JSON.parse(resp.body).error.message).toBe('User is not a member of this group');
      expect(await moderationCount(outsider.id)).toBe(0);
    });

    it('rejects a ban in a non-ACTIVE (archived) group with 400', async () => {
      const owner = await createUser('arch-own');
      const victim = await createUser('arch-vic');
      const group = await createGroup(owner.id, 'ArchivedBan', GroupStatus.ARCHIVED);
      await addMember(group.id, victim.id, GroupMemberRole.MEMBER);

      const resp = await ban(group.id, victim.id, owner);

      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('Group is not active');
      expect((await membershipOf(group.id, victim.id)).status).toBe('ACTIVE');
      expect(await moderationCount(victim.id)).toBe(0);
    });
  });

  describe('authorized managers', () => {
    it('allows an OWNER to ban an active member: 200, BANNED row, exactly one notification', async () => {
      const { group, owner, victim } = await banFixture('ownerok');

      const resp = await ban(group.id, victim.id, owner);

      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.message).toBe('Member banned');
      expect((await membershipOf(group.id, victim.id)).status).toBe('BANNED');
      expect(await moderationCount(victim.id)).toBe(1);
    });

    it('allows an ADMIN to ban an active member: 200, BANNED row, exactly one notification', async () => {
      const { group, admin, victim } = await banFixture('adminok');

      const resp = await ban(group.id, victim.id, admin);

      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).data.message).toBe('Member banned');
      expect((await membershipOf(group.id, victim.id)).status).toBe('BANNED');
      expect(await moderationCount(victim.id)).toBe(1);
    });
  });

  describe('idempotency — one state transition, one notification', () => {
    it('a replayed ban performs no second state transition: updatedAt is untouched', async () => {
      const { group, owner, victim } = await banFixture('replay');

      const first = await ban(group.id, victim.id, owner);
      expect(first.statusCode).toBe(200);
      const afterFirst = await membershipOf(group.id, victim.id);
      expect(afterFirst.status).toBe('BANNED');

      // Any write that actually touched the row would bump @updatedAt; an
      // idempotent no-op cannot. The sleep guarantees a distinguishable clock.
      await new Promise((r) => setTimeout(r, 25));
      const second = await ban(group.id, victim.id, owner);

      expect(second.statusCode).toBe(200);
      expect(JSON.parse(second.body).data.message).toBe('Member already banned');
      const afterSecond = await membershipOf(group.id, victim.id);
      expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime());
      expect(await moderationCount(victim.id)).toBe(1);
    });

    it('two concurrent bans by different managers yield one transition and one notification', async () => {
      const { group, owner, admin, victim } = await banFixture('conc');

      const [a, b] = await Promise.all([
        ban(group.id, victim.id, owner),
        ban(group.id, victim.id, admin),
      ]);

      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const messages = [JSON.parse(a.body).data.message, JSON.parse(b.body).data.message].sort();
      expect(messages).toEqual(['Member already banned', 'Member banned']);
      expect((await membershipOf(group.id, victim.id)).status).toBe('BANNED');
      expect(await moderationCount(victim.id)).toBe(1);
    });
  });
});
