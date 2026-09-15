/**
 * Isolated N+1 regression guard for `GET /groups`.
 *
 * This file lives separate from `groups.test.ts` on purpose. It instruments
 * the `mockedPrisma` export of `@socialplay/database` with a pass-through Proxy
 * that counts `groupMember.findUnique` calls. The instrumentation is
 * installed via `vi.mock`, so it exists only in THIS file's module graph
 * (the vitest config for this package uses `pool: 'forks'` with
 * `fileParallelism: false`, so each test file runs in its own OS process)
 * and disappears with it — the real Prisma delegate object is never
 * modified, so nothing can be left broken for later files.
 *
 * A control test still exercises a real `findUnique` afterwards to prove the
 * delegate remains functional in this file's own process.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma as mockedPrisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

const tracker = vi.hoisted(() => ({ findUniqueCalls: 0 }));

// Intercept the prisma export (and only that export) at the module boundary.
// Every delegate call forwards to the real implementation untouched — this
// is pure instrumentation. `vi.mock` scopes the replacement to this file's
// module graph, so the production server and every other test file keep the
// genuine, unmodified prisma instance.
vi.mock('@socialplay/database', async (importOriginal) => {
  const original = (await importOriginal()) as { prisma: typeof mockedPrisma };
  const realPrisma = original.prisma;

  const instrumentDelegate = (delegate: object) =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        if (prop === 'findUnique') {
          return (args: unknown) => {
            tracker.findUniqueCalls += 1;
            return Reflect.get(target, prop, receiver)(args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

  const prisma = new Proxy(realPrisma, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (value && typeof value === 'object') {
        return instrumentDelegate(value);
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return { ...original, prisma, default: prisma };
});

const PREFIX = `${config.API_PREFIX}/groups`;

let dbAvailable = true;
try {
  await mockedPrisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}

const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;

const EMAIL_PREFIX = 'mygroups-n1-';

async function createUser(tag: string) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `${EMAIL_PREFIX}${tag}-${suffix}@test.local`;
  const user = await mockedPrisma.user.create({
    data: {
      email,
      username: `mg_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `MyGroups ${tag} ${suffix}`.slice(0, 100),
      status: 'ACTIVE',
    },
  });
  if (user.email === null) throw new Error('Test fixture expected non-null email');
  return { ...user, email: user.email };
}

async function createGroup(ownerId: string, name: string) {
  return mockedPrisma.group.create({
    data: { ownerId, name, description: `Fixture group: ${name}`, isPrivate: false, status: 'ACTIVE' },
  });
}

async function addMember(groupId: string, userId: string, role: GroupMemberRole, status: GroupMemberStatus) {
  return mockedPrisma.groupMember.create({ data: { groupId, userId, role, status } });
}

async function cleanFixtures() {
  const users = await mockedPrisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    const groups = await mockedPrisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g) => g.id);
    if (groupIds.length) {
      await mockedPrisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
      await mockedPrisma.group.deleteMany({ where: { id: { in: groupIds } } });
    }
    await mockedPrisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  }
  await mockedPrisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures();
  if (server) await server.close();
  await mockedPrisma.$disconnect();
});

describeIf('groups/routes — GET /groups does not fall back to an N+1 membership lookup', () => {
  it('never calls groupMember.findUnique for a multi-group page', async () => {
    const caller = await createUser('no_n_plus_1');
    const token = await mintToken(caller);

    const groups = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createGroup(caller.id, `N1 Group ${i}`))
    );
    for (const g of groups) {
      await addMember(g.id, caller.id, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE);
    }

    tracker.findUniqueCalls = 0;
    const qs = new URLSearchParams({ mine: 'true' }).toString();
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(resp.body) as { success: boolean; data: unknown[]; meta: unknown };
    expect(resp.statusCode).toBe(200);
    expect(body.data).toHaveLength(5);
    // A per-row `getGroupMembership` fallback would surface here as one
    // `findUnique` per returned group.
    expect(tracker.findUniqueCalls).toBe(0);
  });

  it('the groupMember delegate passes through real calls intact', async () => {
    const caller = await createUser('delegate_check');
    const group = await createGroup(caller.id, 'Delegate Check Group');
    await addMember(group.id, caller.id, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE);

    // A genuine findUnique still resolves the row through the proxy.
    const row = await mockedPrisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: caller.id } },
    });
    expect(row).not.toBeNull();
    expect(row!.role).toBe(GroupMemberRole.OWNER);
    expect(tracker.findUniqueCalls).toBe(1);
  });
});