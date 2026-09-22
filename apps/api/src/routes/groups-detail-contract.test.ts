import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// The response contract of GET /groups/:id.
//
// The endpoint returns TWO different shapes and clients (and the shared
// GroupDetailInfo type) must be able to tell them apart:
//
//   safe summary  — a private group viewed by a non-ACTIVE viewer. Deliberately
//                   thin: no owner identity, no dates.
//   full detail   — everyone else: owner, createdAt and updatedAt.
//
// In BOTH shapes `memberRole` is present and is null unless the viewer is an
// ACTIVE member. It used to be omitted from the JSON (undefined) for a viewer
// with no membership, and to carry the role of a membership that was not
// ACTIVE — so a LEFT admin still read as "ADMIN".
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

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

const EMAIL_PREFIX = 'gdc-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.23.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `gd_${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Contract ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
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
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function signToken(user: { id: string; email: string; username: string }): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

async function makeGroup(tag: string, isPrivate: boolean) {
  const owner = await createUser(`${tag}-own`);
  const viewer = await createUser(`${tag}-vw`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `DC-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });
  return { owner, viewer, groupId: group.id };
}

async function getDetail(groupId: string, viewer: { id: string; email: string; username: string }) {
  const resp = await server.inject({
    method: 'GET',
    url: `${PREFIX}/${groupId}`,
    headers: { authorization: `Bearer ${signToken(viewer)}` },
    remoteAddress: nextIp(),
  });
  expect(resp.statusCode).toBe(200);
  return JSON.parse(resp.body).data as Record<string, unknown>;
}

const addViewerMembership = (
  g: Awaited<ReturnType<typeof makeGroup>>,
  role: GroupMemberRole,
  status: GroupMemberStatus
) =>
  prisma.groupMember.create({ data: { groupId: g.groupId, userId: g.viewer.id, role, status } });

describeIf('GET /groups/:id response contract', () => {
  describe('safe summary (private group, non-ACTIVE viewer)', () => {
    it('is thin: null memberRole, null owner, and NO date fields', async () => {
      const g = await makeGroup('safe', true);
      const data = await getDetail(g.groupId, g.viewer);

      expect(data.isMember).toBe(false);
      expect('memberRole' in data).toBe(true);
      expect(data.memberRole).toBeNull();
      expect(data.owner).toBeNull();
      expect(data).not.toHaveProperty('createdAt');
      expect(data).not.toHaveProperty('updatedAt');
    });

    it('a PENDING requester still gets null memberRole, with their status surfaced', async () => {
      const g = await makeGroup('safe-pending', true);
      await addViewerMembership(g, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      const data = await getDetail(g.groupId, g.viewer);

      expect(data.memberRole).toBeNull();
      expect(data.viewerMembershipStatus).toBe('PENDING');
      expect(data.owner).toBeNull();
    });
  });

  describe('full detail', () => {
    it('an ACTIVE member sees their real role, the owner, and both dates', async () => {
      const g = await makeGroup('full-active', true);
      await addViewerMembership(g, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
      const data = await getDetail(g.groupId, g.viewer);

      expect(data.isMember).toBe(true);
      expect(data.memberRole).toBe('ADMIN');
      expect(data.owner).toMatchObject({ id: g.owner.id });
      expect(typeof data.createdAt).toBe('string');
      expect(typeof data.updatedAt).toBe('string');
    });

    it('a viewer with NO membership in a public group gets an explicit null memberRole (not an omitted key)', async () => {
      const g = await makeGroup('full-none', false);
      const data = await getDetail(g.groupId, g.viewer);

      expect(data.isMember).toBe(false);
      expect('memberRole' in data).toBe(true);
      expect(data.memberRole).toBeNull();
      expect(data.viewerMembershipStatus).toBeNull();
      expect(typeof data.createdAt).toBe('string');
    });

    it("a LEFT admin's role is not reported: memberRole is null while the LEFT status is surfaced", async () => {
      const g = await makeGroup('full-left', false);
      await addViewerMembership(g, GroupMemberRole.ADMIN, GroupMemberStatus.LEFT);
      const data = await getDetail(g.groupId, g.viewer);

      expect(data.isMember).toBe(false);
      expect(data.memberRole).toBeNull();
      expect(data.viewerMembershipStatus).toBe('LEFT');
    });

    it("a BANNED viewer's former role is not reported either", async () => {
      const g = await makeGroup('full-banned', false);
      await addViewerMembership(g, GroupMemberRole.MODERATOR, GroupMemberStatus.BANNED);
      const data = await getDetail(g.groupId, g.viewer);

      expect(data.memberRole).toBeNull();
      expect(data.viewerMembershipStatus).toBe('BANNED');
    });
  });
});
