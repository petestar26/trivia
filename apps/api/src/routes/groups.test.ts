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
  if (dbAvailable) await cleanMyGroupsFixtures();
  if (server) await server.close();
  await prisma.$disconnect();
});

// ─── Fixtures ──────────────────────────────────────────────────

const EMAIL_PREFIX = 'mygroups-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const email = `${EMAIL_PREFIX}${tag}-${suffix}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      username: `mg_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `MyGroups ${tag} ${suffix}`.slice(0, 100),
      status: 'ACTIVE',
    },
  });

  // Prisma truthfully returns email: string | null. This fixture always
  // stores a known non-null email, so narrow it once at the fixture
  // boundary rather than at every call site.
  if (user.email === null) {
    throw new Error('Test fixture expected non-null email');
  }

  return { ...user, email: user.email };
}

async function createGroup(
  ownerId: string,
  name: string,
  overrides: { isPrivate?: boolean; status?: GroupStatus; createdAt?: Date; id?: string } = {}
) {
  const group = await prisma.group.create({
    data: {
      ...(overrides.id ? { id: overrides.id } : {}),
      ownerId,
      name,
      description: `Fixture group: ${name}`,
      isPrivate: overrides.isPrivate ?? false,
      status: overrides.status ?? GroupStatus.ACTIVE,
    },
  });
  if (overrides.createdAt) {
    // `createdAt` has no client-settable input in the Prisma schema
    // (`@default(now())` with no explicit field in `GroupCreateInput`), so
    // backdating a fixture's creation time for ordering tests needs a
    // direct update after creation.
    return prisma.group.update({ where: { id: group.id }, data: { createdAt: overrides.createdAt } });
  }
  return group;
}

async function addMember(
  groupId: string,
  userId: string,
  role: GroupMemberRole = GroupMemberRole.MEMBER,
  status: GroupMemberStatus = GroupMemberStatus.ACTIVE,
  joinedAt?: Date
) {
  const base = { groupId, userId, role, status };
  return prisma.groupMember.upsert({
    where: { groupId_userId: { groupId, userId } },
    update: { role, status, ...(joinedAt ? { joinedAt } : {}) },
    create: { ...base, ...(joinedAt ? { joinedAt } : {}) },
  });
}

async function cleanMyGroupsFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g) => g.id);
    if (groupIds.length) {
      await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
      await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
    }
    // Memberships in groups owned by non-fixture users (shouldn't happen in
    // this suite, but keep cleanup exhaustive) and any stray rows.
    await prisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({
    sub: user.id,
    email: user.email,
    username: user.username,
    roles: ['USER'],
  });
}

interface GroupListItem {
  id: string;
  name: string;
  isPrivate: boolean;
  memberCount: number;
  isMember: boolean;
  memberRole?: string | null;
}

interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

async function listGroups(token: string, query: Record<string, string | number | boolean> = {}) {
  const qs = new URLSearchParams(
    Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])
  ).toString();
  const resp = await server.inject({
    method: 'GET',
    url: `${PREFIX}${qs ? `?${qs}` : ''}`,
    headers: authHeader(token),
  });
  const body = JSON.parse(resp.body) as { success: boolean; data: GroupListItem[]; meta: ListMeta };
  return { resp, body };
}

// ─── Tests ─────────────────────────────────────────────────────

describeIf('groups/routes — GET /groups', () => {
  describe('authentication', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const resp = await server.inject({ method: 'GET', url: PREFIX });
      expect(resp.statusCode).toBe(401);
    });

    it('rejects an unauthenticated mine=true request with 401', async () => {
      const resp = await server.inject({ method: 'GET', url: `${PREFIX}?mine=true` });
      expect(resp.statusCode).toBe(401);
    });
  });

  describe('mine=true filters at the database level, before pagination', () => {
    it('returns an older membership even when more than 100 newer unrelated groups exist, and meta describes the filtered set', async () => {
      const caller = await createUser('old_member');
      const other = await createUser('flood_owner');
      const callerToken = await mintToken(caller);

      const oldGroup = await createGroup(caller.id, 'Old Home Group', {
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      await addMember(oldGroup.id, caller.id, 'OWNER');

      // 105 unrelated, strictly newer groups the caller has no membership
      // in at all — more than the server's own max page size (100), and
      // more than enough that the old group would fall off page 1 (or
      // every page) of an unfiltered, then-paginated listing.
      const flood = Array.from({ length: 105 }, (_, i) => ({
        ownerId: other.id,
        name: `Flood Group ${i}`,
        description: null,
        isPrivate: false,
        status: 'ACTIVE' as const,
      }));
      await prisma.group.createMany({ data: flood });

      const { resp, body } = await listGroups(callerToken, { mine: true });

      expect(resp.statusCode).toBe(200);
      expect(body.data.map((g) => g.id)).toEqual([oldGroup.id]);
      expect(body.data[0].isMember).toBe(true);
      expect(body.data[0].memberRole).toBe('OWNER');
      // Filtering happened before counting too — `total` describes only
      // the caller's own membership, not the 106 ACTIVE groups that exist
      // overall.
      expect(body.meta).toEqual<ListMeta>({
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
      });
    });

    it('reports accurate OWNER, ADMIN, MODERATOR, and MEMBER roles — never another member\'s', async () => {
      const caller = await createUser('roles');
      const decoy = await createUser('roles_decoy');
      const token = await mintToken(caller);

      // The decoy holds a DIFFERENT role with an EARLIER join time in every
      // one of these groups, so a bug that leaked "the first membership
      // row" (instead of the caller's own) would surface here.
      const earlier = new Date('2022-01-01T00:00:00.000Z');

      const gOwner = await createGroup(caller.id, 'Roles Owner Group');
      await addMember(gOwner.id, caller.id, 'OWNER');
      await addMember(gOwner.id, decoy.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE, earlier);

      const gAdmin = await createGroup(decoy.id, 'Roles Admin Group');
      await addMember(gAdmin.id, caller.id, GroupMemberRole.ADMIN);
      await addMember(gAdmin.id, decoy.id, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE, earlier);

      const gMod = await createGroup(decoy.id, 'Roles Moderator Group');
      await addMember(gMod.id, caller.id, GroupMemberRole.MODERATOR);
      await addMember(gMod.id, decoy.id, GroupMemberRole.ADMIN, GroupMemberStatus.ACTIVE, earlier);

      const gMember = await createGroup(decoy.id, 'Roles Member Group');
      await addMember(gMember.id, caller.id, GroupMemberRole.MEMBER);
      await addMember(gMember.id, decoy.id, GroupMemberRole.MODERATOR, GroupMemberStatus.ACTIVE, earlier);

      const { resp, body } = await listGroups(token, { mine: true, limit: 50 });
      expect(resp.statusCode).toBe(200);

      const byId = new Map(body.data.map((g) => [g.id, g]));
      expect(byId.get(gOwner.id)?.memberRole).toBe('OWNER');
      expect(byId.get(gAdmin.id)?.memberRole).toBe('ADMIN');
      expect(byId.get(gMod.id)?.memberRole).toBe('MODERATOR');
      expect(byId.get(gMember.id)?.memberRole).toBe('MEMBER');
      for (const g of body.data) expect(g.isMember).toBe(true);
    });

    it('includes an active private membership', async () => {
      const caller = await createUser('private_member');
      const token = await mintToken(caller);

      const privateGroup = await createGroup(caller.id, 'Private Book Club', { isPrivate: true });
      await addMember(privateGroup.id, caller.id, 'OWNER');

      const { body } = await listGroups(token, { mine: true });
      const ids = body.data.map((g) => g.id);
      expect(ids).toContain(privateGroup.id);
      const entry = body.data.find((g) => g.id === privateGroup.id)!;
      expect(entry.isPrivate).toBe(true);
      expect(entry.isMember).toBe(true);
    });

    it('excludes PENDING, LEFT, BANNED, and MUTED memberships', async () => {
      const caller = await createUser('inactive_statuses');
      const owner2 = await createUser('inactive_statuses_owner');
      const token = await mintToken(caller);

      const statuses = ['PENDING', 'LEFT', 'BANNED', 'MUTED'] as const;
      const groups = await Promise.all(
        statuses.map((s) => createGroup(owner2.id, `Inactive ${s} Group`))
      );
      for (let i = 0; i < statuses.length; i++) {
        await addMember(groups[i].id, caller.id, 'MEMBER', statuses[i]);
      }

      const { body } = await listGroups(token, { mine: true, limit: 50 });
      const ids = new Set(body.data.map((g) => g.id));
      for (const g of groups) {
        expect(ids.has(g.id)).toBe(false);
      }
    });

    it('excludes groups the caller has no membership row in at all', async () => {
      const caller = await createUser('nonmember');
      const owner2 = await createUser('nonmember_owner');
      const token = await mintToken(caller);

      const strangerGroup = await createGroup(owner2.id, 'Stranger Group');
      // Someone else is a member, but never the caller.
      await addMember(strangerGroup.id, owner2.id, 'OWNER');

      const { body } = await listGroups(token, { mine: true, limit: 50 });
      expect(body.data.map((g) => g.id)).not.toContain(strangerGroup.id);
    });

    it('combines a search query with mine=true', async () => {
      const caller = await createUser('search_mine');
      const token = await mintToken(caller);

      const trivia = await createGroup(caller.id, 'Trivia Fanatics MG');
      await addMember(trivia.id, caller.id, 'OWNER');
      const boardgame = await createGroup(caller.id, 'Board Game Nerds MG');
      await addMember(boardgame.id, caller.id, 'OWNER');

      const { body } = await listGroups(token, { mine: true, query: 'Trivia Fanatics' });
      expect(body.data.map((g) => g.id)).toEqual([trivia.id]);
    });

    it('describes page, limit, total, totalPages, hasNextPage, and hasPrevPage for the filtered set across pages', async () => {
      const caller = await createUser('paging');
      const token = await mintToken(caller);

      const groups = await Promise.all(
        Array.from({ length: 3 }, (_, i) => createGroup(caller.id, `Paging Group ${i}`))
      );
      for (const g of groups) await addMember(g.id, caller.id, 'OWNER');

      const page1 = await listGroups(token, { mine: true, limit: 2, page: 1 });
      expect(page1.body.meta).toEqual<ListMeta>({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNextPage: true,
        hasPrevPage: false,
      });
      expect(page1.body.data).toHaveLength(2);

      const page2 = await listGroups(token, { mine: true, limit: 2, page: 2 });
      expect(page2.body.meta).toEqual<ListMeta>({
        page: 2,
        limit: 2,
        total: 3,
        totalPages: 2,
        hasNextPage: false,
        hasPrevPage: true,
      });
      expect(page2.body.data).toHaveLength(1);

      // No overlap/duplication across pages, and every fixture group is
      // accounted for exactly once.
      const seenIds = [...page1.body.data, ...page2.body.data].map((g) => g.id).sort();
      expect(seenIds).toEqual([...groups.map((g) => g.id)].sort());
    });
  });

  describe('mine=false / omitted mine preserve existing discovery behavior', () => {
    it('discovery includes a group the caller has a non-ACTIVE (e.g. PENDING) membership in, with isMember false', async () => {
      const caller = await createUser('discovery_pending');
      const owner2 = await createUser('discovery_pending_owner');
      const token = await mintToken(caller);

      const group = await createGroup(owner2.id, 'Discovery Pending Group');
      await addMember(group.id, caller.id, 'MEMBER', 'PENDING');

      const withoutMine = await listGroups(token, { query: 'Discovery Pending Group' });
      const withMineFalse = await listGroups(token, { mine: false, query: 'Discovery Pending Group' });

      for (const { body } of [withoutMine, withMineFalse]) {
        const entry = body.data.find((g) => g.id === group.id);
        expect(entry).toBeDefined();
        expect(entry!.isMember).toBe(false);
      }
    });

    it('discovery reports isMember/memberRole accurately for an active member alongside mine=false', async () => {
      const caller = await createUser('discovery_active');
      const token = await mintToken(caller);

      const group = await createGroup(caller.id, 'Discovery Active Group');
      await addMember(group.id, caller.id, 'OWNER');

      const { body } = await listGroups(token, { query: 'Discovery Active Group' });
      const entry = body.data.find((g) => g.id === group.id);
      expect(entry?.isMember).toBe(true);
      expect(entry?.memberRole).toBe('OWNER');
    });

    it('a stranger in discovery mode gets isMember: false and never another user\'s memberRole', async () => {
      const stranger = await createUser('stranger');
      const member = await createUser('stranger_member');
      const token = await mintToken(stranger);

      const group = await createGroup(member.id, 'Stranger Peek Group');
      await addMember(group.id, member.id, GroupMemberRole.ADMIN);

      const { body } = await listGroups(token, { query: 'Stranger Peek Group' });
      const entry = body.data.find((g) => g.id === group.id);
      expect(entry).toBeDefined();
      expect(entry!.isMember).toBe(false);
      // No role may leak from another user's membership.
      expect(entry!.memberRole).toBeUndefined();
    });

    it('an inactive former membership reports isMember: false with no memberRole', async () => {
      const caller = await createUser('former');
      const token = await mintToken(caller);

      const group = await createGroup(caller.id, 'Former Membership Group');
      await addMember(group.id, caller.id, GroupMemberRole.OWNER, GroupMemberStatus.LEFT);

      const { body } = await listGroups(token, { query: 'Former Membership Group' });
      const entry = body.data.find((g) => g.id === group.id);
      expect(entry).toBeDefined();
      expect(entry!.isMember).toBe(false);
      // The stale OWNER role must not surface for an inactive membership.
      expect(entry!.memberRole).toBeUndefined();

      // mine=true excludes the group entirely for a non-ACTIVE member.
      const mine = await listGroups(token, { mine: true, limit: 50 });
      expect(mine.body.data.map((g) => g.id)).not.toContain(group.id);
    });

    it('omitted mine and explicit mine=false return the same result set and meta', async () => {
      const caller = await createUser('discovery_parity');
      const token = await mintToken(caller);
      const group = await createGroup(caller.id, 'Discovery Parity Group');
      await addMember(group.id, caller.id, 'OWNER');

      const omitted = await listGroups(token, { query: 'Discovery Parity Group' });
      const explicitFalse = await listGroups(token, { mine: false, query: 'Discovery Parity Group' });

      expect(omitted.body.data.map((g) => g.id)).toEqual(explicitFalse.body.data.map((g) => g.id));
      expect(omitted.body.meta).toEqual(explicitFalse.body.meta);
    });
  });

  describe('deterministic ordering with an id tie-breaker', () => {
    it('orders by createdAt DESC then id DESC with exact ids on every page, using collision-safe random ids', async () => {
      const caller = await createUser('ties');
      const token = await mintToken(caller);

      // Random primary keys: nothing fixed can collide with rows left behind
      // by an aborted earlier run or created by another test process sharing
      // this database.
      const tiedAt = new Date('2024-05-05T00:00:00.000Z');
      const tiedIds = Array.from({ length: 4 }, () => randomUUID());
      // Insert the tied groups in ASCENDING id order — the reverse of the
      // expected result — so a missing (or ascending) id tie-breaker cannot
      // pass merely by returning rows in insertion order.
      const ascendingIds = [...tiedIds].sort();
      for (const [i, id] of ascendingIds.entries()) {
        const g = await createGroup(caller.id, `Tie ${i}`, { id, createdAt: tiedAt });
        await addMember(g.id, caller.id, GroupMemberRole.OWNER);
      }
      // createdAt takes precedence over id in both directions.
      const newer = await createGroup(caller.id, 'Tie Newer', { createdAt: new Date('2024-05-06T00:00:00.000Z') });
      await addMember(newer.id, caller.id, GroupMemberRole.OWNER);
      const older = await createGroup(caller.id, 'Tie Older', { createdAt: new Date('2024-05-04T00:00:00.000Z') });
      await addMember(older.id, caller.id, GroupMemberRole.OWNER);

      const expected = [newer.id, ...[...tiedIds].sort().reverse(), older.id];

      // Every page boundary (limit 1), boundaries splitting the tie (limit
      // 2 and 4): exact ids per page, so no duplicate and no skip anywhere.
      for (const limit of [1, 2, 4]) {
        const pageCount = Math.ceil(expected.length / limit);
        const expectedPages = Array.from({ length: pageCount }, (_, i) => expected.slice(i * limit, (i + 1) * limit));
        const actualPages: string[][] = [];
        for (let page = 1; page <= pageCount; page++) {
          const { body } = await listGroups(token, { mine: true, limit, page });
          expect(body.meta.total).toBe(expected.length);
          actualPages.push(body.data.map((g) => g.id));
        }
        expect(actualPages).toEqual(expectedPages);
      }

      // A full scan returns the same exact order.
      const full = await listGroups(token, { mine: true, limit: 50 });
      expect(full.body.data.map((g) => g.id)).toEqual(expected);
    });
  });

  describe('non-active group statuses are excluded', () => {
    it('INACTIVE, ARCHIVED, and BANNED groups are absent from data, total, and pagination', async () => {
      const caller = await createUser('statuses');
      const token = await mintToken(caller);

      // Unique test-specific prefix so assertions are scoped to these
      // fixtures — never to the count of every ACTIVE group in the shared
      // database, which is unstable under concurrent writers.
      const prefix = `OpusStatusScope${Date.now()}`;
      const active = await createGroup(caller.id, `${prefix} Active Group`);
      await addMember(active.id, caller.id, GroupMemberRole.OWNER);
      const inactive = await createGroup(caller.id, `${prefix} Inactive Group`, { status: GroupStatus.INACTIVE });
      const archived = await createGroup(caller.id, `${prefix} Archived Group`, { status: GroupStatus.ARCHIVED });
      const banned = await createGroup(caller.id, `${prefix} Banned Group`, { status: GroupStatus.BANNED });
      await addMember(inactive.id, caller.id, GroupMemberRole.OWNER);
      await addMember(archived.id, caller.id, GroupMemberRole.OWNER);
      await addMember(banned.id, caller.id, GroupMemberRole.OWNER);

      // Only these scoped fixtures match the query, so `total` is deterministic
      // regardless of what other processes create or delete concurrently.
      const modes: Array<{ mine?: boolean }> = [{ mine: true }, {}, { mine: false }];
      for (const params of modes) {
        const { body } = await listGroups(token, { ...params, query: prefix, limit: 50 });
        const ids = new Set(body.data.map((g) => g.id));
        expect(ids.has(active.id)).toBe(true);
        expect(ids.has(inactive.id)).toBe(false);
        expect(ids.has(archived.id)).toBe(false);
        expect(ids.has(banned.id)).toBe(false);

        // Scoped to the unique prefix, exactly one ACTIVE group matches in
        // every mode: mine=true via the caller's membership, and discovery by
        // the name filter alone. The non-active fixtures never inflate it.
        const expectedTotal = 1;
        expect(body.meta.total).toBe(expectedTotal);
        // Pagination metadata is derived from that same filtered count.
        expect(body.meta.totalPages).toBe(Math.ceil(expectedTotal / body.meta.limit));
        expect(body.meta.hasNextPage).toBe(body.meta.page < body.meta.totalPages);
      }
    });
  });

  describe('memberCount counts only ACTIVE memberships', () => {
    it('ignores PENDING, LEFT, BANNED, and MUTED members', async () => {
      const caller = await createUser('mc_owner');
      const token = await mintToken(caller);
      const group = await createGroup(caller.id, 'Member Count Group');
      await addMember(group.id, caller.id, GroupMemberRole.OWNER);

      const p1 = await createUser('mc_active');
      const p2 = await createUser('mc_pending');
      const p3 = await createUser('mc_left');
      const p4 = await createUser('mc_banned');
      const p5 = await createUser('mc_muted');
      await addMember(group.id, p1.id, GroupMemberRole.MEMBER, GroupMemberStatus.ACTIVE);
      await addMember(group.id, p2.id, GroupMemberRole.MEMBER, GroupMemberStatus.PENDING);
      await addMember(group.id, p3.id, GroupMemberRole.MEMBER, GroupMemberStatus.LEFT);
      await addMember(group.id, p4.id, GroupMemberRole.MEMBER, GroupMemberStatus.BANNED);
      await addMember(group.id, p5.id, GroupMemberRole.MEMBER, GroupMemberStatus.MUTED);

      const { body } = await listGroups(token, { query: 'Member Count Group' });
      const entry = body.data.find((g) => g.id === group.id);
      expect(entry).toBeDefined();
      // Only the caller (OWNER) and the ACTIVE member count.
      expect(entry!.memberCount).toBe(2);
    });
  });
});
