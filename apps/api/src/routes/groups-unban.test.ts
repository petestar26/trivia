import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupStatus, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// The Unban lifecycle:
//   GET  /groups/:id/banned-members            (manager's list of who is banned)
//   POST /groups/:id/members/:userId/unban     (BANNED -> LEFT, role -> MEMBER)
//
// What an unban is and is not. It lifts the bar and nothing more: the member is
// LEFT (not ACTIVE), their role is MEMBER (not the ADMIN/MODERATOR that a ban
// leaves on the BANNED row), and the invitations the ban revoked stay revoked.
// From there they ask to join again or are sent a new invitation, like anyone
// who left. Every case below pins one guard in the routes, so removing any
// single guard turns at least one of them red.
//
// The forced-schedule cases (ordering against ban / invite creation / invite
// acceptance / join requests, concurrent duplicates, rollback) live in
// groups-unban-ordering.test.ts.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, so every request below carries a unique remoteAddress.

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

const EMAIL_PREFIX = 'gunb-';
const USERNAME_PREFIX = 'gunb_';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.31.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

type Actor = { id: string; email: string; username: string };

async function createUser(tag: string): Promise<Actor & { displayName: string | null }> {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      // Suffix first: usernames are capped at 30 chars.
      username: `${USERNAME_PREFIX}${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Unban ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { id: user.id, email: user.email, username: user.username, displayName: user.displayName };
}

async function addMember(
  groupId: string,
  userId: string,
  role: GroupMemberRole = GroupMemberRole.MEMBER,
  status: GroupMemberStatus = GroupMemberStatus.ACTIVE,
  updatedAt?: Date
) {
  return prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    update: { role, status, ...(updatedAt ? { updatedAt } : {}) },
    create: { groupId, userId, role, status, ...(updatedAt ? { updatedAt } : {}) },
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
    where: { username: { startsWith: USERNAME_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u: { id: string }) => u.id);
  if (!userIds.length) return;
  const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
  const groupIds = groups.map((g: { id: string }) => g.id);
  if (groupIds.length) {
    await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
    await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
  }
  await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  if (groupIds.length) await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function signToken(user: Actor): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

function call(method: 'GET' | 'POST', url: string, actor: Actor | null) {
  return server.inject({
    method,
    url: `${PREFIX}${url}`,
    ...(actor ? { headers: { authorization: `Bearer ${signToken(actor)}` } } : {}),
    remoteAddress: nextIp(),
  });
}

const unban = (groupId: string, targetUserId: string, actor: Actor | null) =>
  call('POST', `/${groupId}/members/${targetUserId}/unban`, actor);

const ban = (groupId: string, targetUserId: string, actor: Actor | null) =>
  call('POST', `/${groupId}/members/${targetUserId}/ban`, actor);

const listBanned = (groupId: string, actor: Actor | null, query = '') =>
  call('GET', `/${groupId}/banned-members${query}`, actor);

const body = (res: { body: string }) => JSON.parse(res.body);

/** A membership row exactly as stored, plus xmin — which changes on ANY write to the row. */
async function snapshot(groupId: string, userId: string) {
  const rows = await prisma.$queryRaw<{ status: string; role: string; updatedAt: Date; xmin: string }[]>`
    SELECT status::text AS status, role::text AS role, "updatedAt", xmin::text AS xmin
    FROM group_members
    WHERE "groupId" = ${groupId} AND "userId" = ${userId}
  `;
  return rows[0] ?? null;
}

const unbanNotices = (userId: string) =>
  prisma.notification.findMany({ where: { userId, title: 'Unbanned from group' } });

async function banFixture(tag: string) {
  const owner = await createUser(`${tag}-own`);
  const admin = await createUser(`${tag}-adm`);
  const moderator = await createUser(`${tag}-mod`);
  const member = await createUser(`${tag}-mem`);
  const banned = await createUser(`${tag}-ban`);
  const outsider = await createUser(`${tag}-out`);
  const group = await createGroup(owner.id, `Unban${tag}`);
  await addMember(group.id, admin.id, GroupMemberRole.ADMIN);
  await addMember(group.id, moderator.id, GroupMemberRole.MODERATOR);
  await addMember(group.id, member.id, GroupMemberRole.MEMBER);
  await addMember(group.id, banned.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);
  return { owner, admin, moderator, member, banned, outsider, group };
}

describeIf('GET /groups/:id/banned-members', () => {
  describe('authorization', () => {
    it('OWNER and ADMIN receive the banned members', async () => {
      const f = await banFixture('list-ok');

      for (const actor of [f.owner, f.admin]) {
        const res = await listBanned(f.group.id, actor);
        expect(res.statusCode).toBe(200);
        expect(body(res).data.map((m: { user: { id: string } }) => m.user.id)).toEqual([f.banned.id]);
      }
    });

    it('a MODERATOR and a MEMBER are refused, and nothing about the banned user is in the response', async () => {
      const f = await banFixture('list-nomgr');

      for (const actor of [f.moderator, f.member]) {
        const res = await listBanned(f.group.id, actor);
        expect(res.statusCode).toBe(403);
        expect(body(res).error.message).toBe('Insufficient permissions');
        expect(res.body).not.toContain(f.banned.id);
        expect(res.body).not.toContain(f.banned.username);
      }
    });

    it('a stranger, a PENDING requester, a LEFT former admin and a BANNED member are refused', async () => {
      const f = await banFixture('list-outsiders');
      const requester = await createUser('list-req');
      const formerAdmin = await createUser('list-left');
      const otherBanned = await createUser('list-ban2');
      await addMember(f.group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      await addMember(f.group.id, formerAdmin.id, GroupMemberRole.ADMIN, GroupMemberStatus.LEFT);
      // A banned ADMIN keeps the role on the BANNED row; it must confer nothing.
      await addMember(f.group.id, otherBanned.id, GroupMemberRole.ADMIN, GroupMemberStatus.BANNED);

      for (const actor of [f.outsider, requester, formerAdmin, otherBanned]) {
        const res = await listBanned(f.group.id, actor);
        expect(res.statusCode).toBe(403);
        expect(body(res).error.message).toBe('You are not a member of this group');
        expect(res.body).not.toContain(f.banned.username);
      }
    });

    it('an unauthenticated caller gets 401', async () => {
      const f = await banFixture('list-anon');
      const res = await listBanned(f.group.id, null);
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain(f.banned.username);
    });

    it('an unknown group is 404 and a malformed id is 400', async () => {
      const f = await banFixture('list-404');
      expect((await listBanned(randomUUID(), f.owner)).statusCode).toBe(404);
      expect((await listBanned('not-a-uuid', f.owner)).statusCode).toBe(400);
    });

    for (const status of [GroupStatus.ARCHIVED, GroupStatus.INACTIVE]) {
      it(`a ${status} group is refused even for its owner`, async () => {
        const f = await banFixture(`list-${status.toLowerCase()}`);
        await prisma.group.update({ where: { id: f.group.id }, data: { status } });

        const res = await listBanned(f.group.id, f.owner);
        expect(res.statusCode).toBe(400);
        expect(body(res).error.message).toBe('Group is not active');
        expect(res.body).not.toContain(f.banned.username);
      });
    }

    it('cross-group: a manager of another group is refused and learns nothing', async () => {
      const a = await banFixture('list-xa');
      const b = await banFixture('list-xb');

      const res = await listBanned(b.group.id, a.owner);
      expect(res.statusCode).toBe(403);
      expect(res.body).not.toContain(b.banned.id);
      expect(res.body).not.toContain(b.banned.username);
    });
  });

  describe('what is returned', () => {
    it('lists only BANNED memberships of THIS group', async () => {
      const f = await banFixture('list-scope');
      const other = await banFixture('list-scope-other');
      const pending = await createUser('sc-pend');
      const left = await createUser('sc-left');
      const muted = await createUser('sc-mute');
      const bannedElsewhereToo = await createUser('sc-both');
      await addMember(f.group.id, pending.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      await addMember(f.group.id, left.id, GroupMemberRole.MEMBER, GroupMemberStatus.LEFT);
      await addMember(f.group.id, muted.id, GroupMemberRole.MEMBER, GroupMemberStatus.MUTED);
      // Banned in the OTHER group, active in this one: must not appear here.
      await addMember(f.group.id, bannedElsewhereToo.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      await addMember(other.group.id, bannedElsewhereToo.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

      const res = await listBanned(f.group.id, f.owner);
      expect(res.statusCode).toBe(200);
      const ids = body(res).data.map((m: { user: { id: string } }) => m.user.id);
      expect(ids).toEqual([f.banned.id]);
      expect(body(res).meta.total).toBe(1);
      expect(ids).not.toContain(other.banned.id);
    });

    it('returns the minimal public profile — no email, role, status, dates, tokens or other memberships', async () => {
      const f = await banFixture('list-privacy');
      // Give the banned account another membership that must not leak.
      const elsewhere = await banFixture('list-privacy-else');
      await addMember(elsewhere.group.id, f.banned.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE);
      // A former admin: the role stays on the BANNED row, and must stay off the wire.
      const formerAdmin = await createUser('pv-adm');
      await addMember(f.group.id, formerAdmin.id, GroupMemberRole.ADMIN, GroupMemberStatus.BANNED);

      const res = await listBanned(f.group.id, f.owner);
      expect(res.statusCode).toBe(200);
      const data = body(res).data as Record<string, unknown>[];
      expect(data).toHaveLength(2);
      for (const item of data) {
        expect(Object.keys(item).sort()).toEqual(['groupId', 'id', 'user']);
        expect(item.groupId).toBe(f.group.id);
        expect(Object.keys(item.user as object).sort()).toEqual(['avatarUrl', 'displayName', 'id', 'username']);
      }
      const raw = res.body;
      for (const secret of [f.banned.email, formerAdmin.email, 'passwordHash', 'fixture-only-not-a-real-hash', 'token', elsewhere.group.id]) {
        expect(raw).not.toContain(secret);
      }
      expect(raw).not.toContain('"ADMIN"');
      expect(raw).not.toContain('"role"');
      expect(raw).not.toContain('"status"');
    });

    it('an empty list is a valid response with zeroed metadata', async () => {
      const f = await banFixture('list-empty');
      await prisma.groupMember.deleteMany({ where: { groupId: f.group.id, status: 'BANNED' } });

      const res = await listBanned(f.group.id, f.owner);
      expect(res.statusCode).toBe(200);
      expect(body(res).data).toEqual([]);
      expect(body(res).meta).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
      });
    });
  });

  describe('ordering and pagination', () => {
    const idOf = (m: { id: string }) => m.id;
    const byRecencyThenIdDesc = (
      a: { updatedAt: Date; id: string },
      b: { updatedAt: Date; id: string }
    ) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

    it('orders most recently changed first', async () => {
      const f = await banFixture('list-recency');
      await prisma.groupMember.deleteMany({ where: { groupId: f.group.id, status: 'BANNED' } });
      const base = Date.now() - 3_600_000;
      const users: Actor[] = [];
      for (let i = 0; i < 4; i++) {
        const u = await createUser(`rec${i}`);
        users.push(u);
        await addMember(f.group.id, u.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED, new Date(base + i * 60_000));
      }

      const res = await listBanned(f.group.id, f.owner);
      expect(body(res).data.map((m: { user: { id: string } }) => m.user.id)).toEqual(
        [...users].reverse().map((u) => u.id)
      );
    });

    it('breaks ties on the membership id, so equal timestamps still have ONE order', async () => {
      const f = await banFixture('list-ties');
      await prisma.groupMember.deleteMany({ where: { groupId: f.group.id, status: 'BANNED' } });
      const stamp = new Date(Date.now() - 3_600_000);
      for (let i = 0; i < 8; i++) {
        const u = await createUser(`tie${i}`);
        await addMember(f.group.id, u.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED, stamp);
      }
      const rows = await prisma.groupMember.findMany({
        where: { groupId: f.group.id, status: 'BANNED' },
        select: { id: true, userId: true, updatedAt: true },
      });
      expect(new Set(rows.map((r: { updatedAt: Date }) => r.updatedAt.getTime())).size).toBe(1);
      const expected = [...rows].sort(byRecencyThenIdDesc).map(idOf);

      const res = await listBanned(f.group.id, f.owner);
      expect(body(res).data.map(idOf)).toEqual(expected);
    });

    it('pages through the list with standard metadata: no row twice, none missing', async () => {
      const f = await banFixture('list-pages');
      await prisma.groupMember.deleteMany({ where: { groupId: f.group.id, status: 'BANNED' } });
      const stamp = new Date(Date.now() - 3_600_000);
      for (let i = 0; i < 8; i++) {
        const u = await createUser(`pg${i}`);
        await addMember(f.group.id, u.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED, stamp);
      }

      const seen: string[] = [];
      const metas: unknown[] = [];
      for (const page of [1, 2, 3]) {
        const res = await listBanned(f.group.id, f.owner, `?page=${page}&limit=3`);
        expect(res.statusCode).toBe(200);
        seen.push(...body(res).data.map(idOf));
        metas.push(body(res).meta);
      }
      expect(metas).toEqual([
        { page: 1, limit: 3, total: 8, totalPages: 3, hasNextPage: true, hasPrevPage: false },
        { page: 2, limit: 3, total: 8, totalPages: 3, hasNextPage: true, hasPrevPage: true },
        { page: 3, limit: 3, total: 8, totalPages: 3, hasNextPage: false, hasPrevPage: true },
      ]);
      expect(seen).toHaveLength(8);
      expect(new Set(seen).size).toBe(8);

      const all = await listBanned(f.group.id, f.owner, '?limit=100');
      expect(seen).toEqual(body(all).data.map(idOf));

      const beyond = await listBanned(f.group.id, f.owner, '?page=4&limit=3');
      expect(beyond.statusCode).toBe(200);
      expect(body(beyond).data).toEqual([]);
      expect(body(beyond).meta).toMatchObject({ page: 4, total: 8, hasNextPage: false, hasPrevPage: true });
    });

    it('rejects out-of-range paging parameters', async () => {
      const f = await banFixture('list-badpage');
      for (const query of ['?page=0', '?page=-1', '?page=abc', '?page=1000001', '?limit=0', '?limit=101', '?limit=1.5']) {
        const res = await listBanned(f.group.id, f.owner, query);
        expect(res.statusCode, query).toBe(400);
      }
    });
  });
});

describeIf('POST /groups/:id/members/:userId/unban', () => {
  describe('the transition', () => {
    it('OWNER unbans: LEFT, role MEMBER, one notification with the specified text, nothing else touched', async () => {
      const f = await banFixture('ok-owner');
      const before = {
        owner: await snapshot(f.group.id, f.owner.id),
        admin: await snapshot(f.group.id, f.admin.id),
        member: await snapshot(f.group.id, f.member.id),
      };

      const res = await unban(f.group.id, f.banned.id, f.owner);

      expect(res.statusCode).toBe(200);
      expect(body(res)).toEqual({ success: true, data: { message: 'Member unbanned' } });
      expect(await snapshot(f.group.id, f.banned.id)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });

      const notices = await unbanNotices(f.banned.id);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        userId: f.banned.id,
        type: 'MODERATION',
        title: 'Unbanned from group',
        body: `You are no longer banned from "${f.group.name}". You may request to join again.`,
        data: { groupId: f.group.id, unbannedBy: f.owner.id },
        isRead: false,
      });

      // Only the one membership changed.
      expect(await snapshot(f.group.id, f.owner.id)).toEqual(before.owner);
      expect(await snapshot(f.group.id, f.admin.id)).toEqual(before.admin);
      expect(await snapshot(f.group.id, f.member.id)).toEqual(before.member);
      expect(await prisma.notification.count({ where: { userId: { in: [f.owner.id, f.admin.id, f.member.id] }, title: 'Unbanned from group' } })).toBe(0);
    });

    it('ADMIN unbans, and the notification names the admin as the actor', async () => {
      const f = await banFixture('ok-admin');

      const res = await unban(f.group.id, f.banned.id, f.admin);

      expect(res.statusCode).toBe(200);
      expect(await snapshot(f.group.id, f.banned.id)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
      const notices = await unbanNotices(f.banned.id);
      expect(notices).toHaveLength(1);
      expect(notices[0].data).toEqual({ groupId: f.group.id, unbannedBy: f.admin.id });
    });

    it('never restores ACTIVE: the member is LEFT and cannot act as a member', async () => {
      const f = await banFixture('not-active');
      await unban(f.group.id, f.banned.id, f.owner);

      const row = await snapshot(f.group.id, f.banned.id);
      expect(row?.status).toBe('LEFT');
      expect(row?.status).not.toBe('ACTIVE');
      // The members list serves ACTIVE members only, and refuses a LEFT caller.
      const members = await call('GET', `/${f.group.id}/members`, f.banned);
      expect(members.statusCode).toBe(403);
    });

    for (const role of [GroupMemberRole.ADMIN, GroupMemberRole.MODERATOR] as const) {
      it(`a banned ${role} comes back as a plain MEMBER — the old role is not restored`, async () => {
        const f = await banFixture(`role-${role.toLowerCase()}`);
        const formerStaff = await createUser('former');
        // Ban leaves the role on the BANNED row; that is the state being reset.
        await addMember(f.group.id, formerStaff.id, role, GroupMemberStatus.BANNED);

        const res = await unban(f.group.id, formerStaff.id, f.owner);

        expect(res.statusCode).toBe(200);
        expect(await snapshot(f.group.id, formerStaff.id)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
      });
    }

    it('the unbanned user disappears from the banned list', async () => {
      const f = await banFixture('list-after');
      const second = await createUser('second');
      await addMember(f.group.id, second.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

      await unban(f.group.id, f.banned.id, f.owner);

      const res = await listBanned(f.group.id, f.owner);
      expect(body(res).data.map((m: { user: { id: string } }) => m.user.id)).toEqual([second.id]);
      expect(body(res).meta.total).toBe(1);
    });

    it('unbanning one banned user leaves every other banned user banned', async () => {
      const f = await banFixture('only-one');
      const others: Actor[] = [];
      for (const tag of ['o1', 'o2', 'o3']) {
        const u = await createUser(tag);
        others.push(u);
        await addMember(f.group.id, u.id, GroupMemberRole.ADMIN, GroupMemberStatus.BANNED);
      }
      const before = await Promise.all(others.map((u) => snapshot(f.group.id, u.id)));

      const res = await unban(f.group.id, f.banned.id, f.owner);

      expect(res.statusCode).toBe(200);
      expect(await Promise.all(others.map((u) => snapshot(f.group.id, u.id)))).toEqual(before);
      for (const u of others) expect(await unbanNotices(u.id)).toHaveLength(0);
    });

    it('a target with no account email is unbanned too (the subject lock is simply not needed)', async () => {
      const f = await banFixture('no-email');
      const suffix = uniqueSuffix();
      const noEmail = await prisma.user.create({
        data: {
          email: null,
          username: `${USERNAME_PREFIX}${suffix}_noem`.slice(0, 30),
          passwordHash: 'fixture-only-not-a-real-hash',
          displayName: 'No email',
          status: 'ACTIVE',
        },
      });
      await addMember(f.group.id, noEmail.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);

      const res = await unban(f.group.id, noEmail.id, f.owner);

      expect(res.statusCode).toBe(200);
      expect(await snapshot(f.group.id, noEmail.id)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
      expect(await unbanNotices(noEmail.id)).toHaveLength(1);
    });
  });

  describe('authorization', () => {
    it('a MODERATOR and a MEMBER are refused: target stays BANNED, no notification', async () => {
      const f = await banFixture('authz-role');
      const before = await snapshot(f.group.id, f.banned.id);

      for (const actor of [f.moderator, f.member]) {
        const res = await unban(f.group.id, f.banned.id, actor);
        expect(res.statusCode).toBe(403);
        expect(body(res).error.message).toBe('Insufficient permissions');
      }

      expect(await snapshot(f.group.id, f.banned.id)).toEqual(before);
      expect(await unbanNotices(f.banned.id)).toHaveLength(0);
    });

    it('a stranger, a PENDING requester, a LEFT former admin and a BANNED admin are refused', async () => {
      const f = await banFixture('authz-out');
      const requester = await createUser('req');
      const formerAdmin = await createUser('leftadm');
      const bannedAdmin = await createUser('banadm');
      await addMember(f.group.id, requester.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      await addMember(f.group.id, formerAdmin.id, GroupMemberRole.ADMIN, GroupMemberStatus.LEFT);
      await addMember(f.group.id, bannedAdmin.id, GroupMemberRole.ADMIN, GroupMemberStatus.BANNED);
      const before = await snapshot(f.group.id, f.banned.id);

      for (const actor of [f.outsider, requester, formerAdmin, bannedAdmin]) {
        const res = await unban(f.group.id, f.banned.id, actor);
        expect(res.statusCode).toBe(403);
        expect(body(res).error.message).toBe('You are not a member of this group');
      }

      expect(await snapshot(f.group.id, f.banned.id)).toEqual(before);
      expect(await unbanNotices(f.banned.id)).toHaveLength(0);
    });

    it('an unauthenticated caller gets 401 and nothing changes', async () => {
      const f = await banFixture('authz-anon');
      const before = await snapshot(f.group.id, f.banned.id);

      const res = await unban(f.group.id, f.banned.id, null);

      expect(res.statusCode).toBe(401);
      expect(await snapshot(f.group.id, f.banned.id)).toEqual(before);
      expect(await unbanNotices(f.banned.id)).toHaveLength(0);
    });

    for (const status of [GroupStatus.ARCHIVED, GroupStatus.INACTIVE]) {
      it(`a ${status} group is refused even for its owner: nothing changes`, async () => {
        const f = await banFixture(`inactive-${status.toLowerCase()}`);
        await prisma.group.update({ where: { id: f.group.id }, data: { status } });
        const before = await snapshot(f.group.id, f.banned.id);

        const res = await unban(f.group.id, f.banned.id, f.owner);

        expect(res.statusCode).toBe(400);
        expect(body(res).error.message).toBe('Group is not active');
        expect(await snapshot(f.group.id, f.banned.id)).toEqual(before);
        expect(await unbanNotices(f.banned.id)).toHaveLength(0);
      });
    }

    it('an unknown group is 404 and malformed ids are 400', async () => {
      const f = await banFixture('authz-ids');
      expect((await unban(randomUUID(), f.banned.id, f.owner)).statusCode).toBe(404);
      expect((await unban('nope', f.banned.id, f.owner)).statusCode).toBe(400);
      expect((await unban(f.group.id, 'nope', f.owner)).statusCode).toBe(400);
    });
  });

  describe('scoping and non-disclosure', () => {
    it('a missing target, a user from nowhere and a user banned in ANOTHER group all get the same 404', async () => {
      const f = await banFixture('missing');
      const other = await banFixture('missing-other');
      const stranger = await createUser('neverin');
      const otherBefore = await snapshot(other.group.id, other.banned.id);

      const responses = [
        await unban(f.group.id, randomUUID(), f.owner), // no such account
        await unban(f.group.id, stranger.id, f.owner), // account exists, never in this group
        await unban(f.group.id, other.banned.id, f.owner), // banned — but in another group
      ];

      for (const res of responses) {
        expect(res.statusCode).toBe(404);
        expect(body(res).error.message).toBe('User is not a member of this group');
      }
      // Byte-identical bodies apart from the per-request id fields, if any.
      expect(new Set(responses.map((r) => JSON.stringify(body(r).error))).size).toBe(1);
      expect(await snapshot(other.group.id, other.banned.id)).toEqual(otherBefore);
      expect(await unbanNotices(other.banned.id)).toHaveLength(0);
    });

    it('is scoped to the group in the path: banned elsewhere and ACTIVE here → refused, the other ban stays', async () => {
      const a = await banFixture('scope-a');
      const b = await banFixture('scope-b');
      const both = await createUser('both');
      await addMember(a.group.id, both.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      await addMember(b.group.id, both.id, GroupMemberRole.ADMIN, GroupMemberStatus.BANNED);
      const bBefore = await snapshot(b.group.id, both.id);
      const aBefore = await snapshot(a.group.id, both.id);

      const res = await unban(a.group.id, both.id, a.owner);

      expect(res.statusCode).toBe(409);
      expect(await snapshot(b.group.id, both.id)).toEqual(bBefore);
      expect(await snapshot(a.group.id, both.id)).toEqual(aBefore);
      expect(await unbanNotices(both.id)).toHaveLength(0);
    });

    it("a manager of one group cannot act on another group's ban through either path", async () => {
      const a = await banFixture('xg-a');
      const b = await banFixture('xg-b');
      const bBefore = await snapshot(b.group.id, b.banned.id);

      const viaOtherGroup = await unban(b.group.id, b.banned.id, a.owner);
      expect(viaOtherGroup.statusCode).toBe(403);
      const viaOwnGroup = await unban(a.group.id, b.banned.id, a.owner);
      expect(viaOwnGroup.statusCode).toBe(404);

      expect(await snapshot(b.group.id, b.banned.id)).toEqual(bBefore);
      expect(await unbanNotices(b.banned.id)).toHaveLength(0);
    });
  });

  describe('only a BANNED member is transitioned', () => {
    const cases: [string, GroupMemberRole, GroupMemberStatus][] = [
      ['ACTIVE member', GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE],
      ['ACTIVE admin', GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE],
      ['PENDING requester', GroupMemberRole.MEMBER, GroupMemberStatus.PENDING],
      ['LEFT member', GroupMemberRole.MEMBER, GroupMemberStatus.LEFT],
      ['MUTED member', GroupMemberRole.MEMBER, GroupMemberStatus.MUTED],
    ];
    for (const [label, role, status] of cases) {
      it(`${label}: 409, no write at all, no notification`, async () => {
        const f = await banFixture(`nb-${status.toLowerCase()}-${role.toLowerCase()}`);
        const target = await createUser('target');
        await addMember(f.group.id, target.id, role, status);
        const before = await snapshot(f.group.id, target.id);

        const res = await unban(f.group.id, target.id, f.owner);

        expect(res.statusCode).toBe(409);
        expect(body(res).error.message).toBe('This member is not banned');
        // xmin included: not even a no-op UPDATE reached the row.
        expect(await snapshot(f.group.id, target.id)).toEqual(before);
        expect(await unbanNotices(target.id)).toHaveLength(0);
      });
    }

    it('a manager cannot "unban" themselves', async () => {
      const f = await banFixture('self');
      const before = await snapshot(f.group.id, f.admin.id);

      const res = await unban(f.group.id, f.admin.id, f.admin);

      expect(res.statusCode).toBe(409);
      expect(await snapshot(f.group.id, f.admin.id)).toEqual(before);
    });

    it('an unban replayed after it succeeded writes nothing and notifies no one', async () => {
      const f = await banFixture('replay');
      expect((await unban(f.group.id, f.banned.id, f.owner)).statusCode).toBe(200);
      const afterFirst = await snapshot(f.group.id, f.banned.id);
      expect(await unbanNotices(f.banned.id)).toHaveLength(1);

      for (const actor of [f.owner, f.admin]) {
        const replay = await unban(f.group.id, f.banned.id, actor);
        expect(replay.statusCode).toBe(409);
        expect(body(replay).error.message).toBe('This member is not banned');
      }

      expect(await snapshot(f.group.id, f.banned.id)).toEqual(afterFirst);
      expect(await unbanNotices(f.banned.id)).toHaveLength(1);
    });
  });

  describe('the owner is never changed', () => {
    it('an admin cannot unban the owner: 403, unchanged', async () => {
      const f = await banFixture('owner-normal');
      const before = await snapshot(f.group.id, f.owner.id);

      const res = await unban(f.group.id, f.owner.id, f.admin);

      expect(res.statusCode).toBe(403);
      expect(body(res).error.message).toBe('You cannot unban the owner of the group');
      expect(await snapshot(f.group.id, f.owner.id)).toEqual(before);
    });

    it('an OWNER membership that is somehow BANNED is left exactly as it is', async () => {
      const f = await banFixture('owner-stranded');
      const stranded = await createUser('stranded');
      // Ban refuses to do this, so it is legacy or hand-edited data — the state
      // this route must still refuse to "repair" by demoting an owner.
      await addMember(f.group.id, stranded.id, GroupMemberRole.OWNER, GroupMemberStatus.BANNED);
      const before = await snapshot(f.group.id, stranded.id);

      const res = await unban(f.group.id, stranded.id, f.owner);

      expect(res.statusCode).toBe(403);
      expect(body(res).error.message).toBe('You cannot unban the owner of the group');
      expect(await snapshot(f.group.id, stranded.id)).toEqual(before);
      expect(await unbanNotices(stranded.id)).toHaveLength(0);
    });
  });

  describe('invitations and the way back', () => {
    async function seedPendingInvite(f: Awaited<ReturnType<typeof banFixture>>, tag: string) {
      const token = `gunbtok-${tag}-${uniqueSuffix()}${uniqueSuffix()}`;
      return prisma.groupInvite.create({
        data: {
          groupId: f.group.id,
          email: f.banned.email.toLowerCase(),
          role: 'ADMIN',
          status: 'PENDING',
          token,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedBy: f.owner.id,
        },
      });
    }

    async function inviteRow(id: string) {
      const rows = await prisma.$queryRaw<{ status: string; xmin: string }[]>`
        SELECT status::text AS status, xmin::text AS xmin FROM group_invites WHERE id = ${id}
      `;
      return rows[0];
    }

    it('invitations revoked by the ban stay revoked — unban never touches group_invites', async () => {
      const f = await banFixture('inv-revoked');
      // Back to a real ACTIVE member with a live invite, then ban through the
      // API so the ban itself revokes it.
      await addMember(f.group.id, f.banned.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      const invite = await seedPendingInvite(f, 'rev');
      expect((await ban(f.group.id, f.banned.id, f.owner)).statusCode).toBe(200);
      const revoked = await inviteRow(invite.id);
      expect(revoked.status).toBe('REVOKED');

      const res = await unban(f.group.id, f.banned.id, f.owner);

      expect(res.statusCode).toBe(200);
      // Same status AND same xmin: the row was not rewritten.
      expect(await inviteRow(invite.id)).toEqual(revoked);
      // The revoked link is dead: it does not readmit the user.
      const accept = await server.inject({
        method: 'POST',
        url: `${PREFIX}/accept-invite`,
        headers: { authorization: `Bearer ${signToken(f.banned)}` },
        payload: { token: invite.token },
        remoteAddress: nextIp(),
      });
      expect(accept.statusCode).toBe(409);
      expect(body(accept).error.message).toBe('This invite has been revoked');
      expect(await snapshot(f.group.id, f.banned.id)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
    });

    it('a still-PENDING invite for the target is not revived, revoked or modified either', async () => {
      const f = await banFixture('inv-pending');
      const invite = await seedPendingInvite(f, 'pend');
      const before = await inviteRow(invite.id);

      await unban(f.group.id, f.banned.id, f.owner);

      expect(await inviteRow(invite.id)).toEqual(before);
    });

    it('before the unban a join request is refused; after it the user can ask to join, and lands PENDING as MEMBER', async () => {
      const f = await banFixture('joinreq');
      // A banned former admin: the request must not carry the old role back.
      await addMember(f.group.id, f.banned.id, GroupMemberRole.ADMIN, GroupMemberStatus.BANNED);

      const before = await call('POST', `/${f.group.id}/request`, f.banned);
      expect(before.statusCode).toBe(403);
      expect(body(before).error.message).toBe('You are banned from this group');
      expect(await snapshot(f.group.id, f.banned.id)).toMatchObject({ status: 'BANNED' });

      expect((await unban(f.group.id, f.banned.id, f.owner)).statusCode).toBe(200);

      const after = await call('POST', `/${f.group.id}/request`, f.banned);
      expect(after.statusCode).toBe(200);
      expect(body(after).data.message).toBe('Join request submitted');
      // Not admitted: PENDING, and a plain MEMBER — a manager still has to approve.
      expect(await snapshot(f.group.id, f.banned.id)).toMatchObject({ status: 'PENDING', role: 'MEMBER' });
      // The managers were told about the new request (the unban did not do it for them).
      expect(await prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(1);
    });

    it('a ban after an unban works again, and the second ban is a real transition', async () => {
      const f = await banFixture('reban');
      await unban(f.group.id, f.banned.id, f.owner);

      const res = await ban(f.group.id, f.banned.id, f.owner);

      expect(res.statusCode).toBe(200);
      expect(body(res).data.message).toBe('Member banned');
      expect(await snapshot(f.group.id, f.banned.id)).toMatchObject({ status: 'BANNED' });
      expect(await prisma.notification.count({ where: { userId: f.banned.id, title: 'Banned from group' } })).toBe(1);
      expect(await unbanNotices(f.banned.id)).toHaveLength(1);
    });
  });
});
