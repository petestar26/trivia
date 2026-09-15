/**
 * Isolated N+1 regression guard for `GET /groups`.
 *
 * `vi.mock` replaces the `prisma` export of `@socialplay/database` — in THIS
 * file's module graph only (the vitest config uses `pool: 'forks'`) — with a
 * pass-through Proxy. Only the `groupMember` delegate is instrumented: its
 * direct read methods that could recreate a per-group membership lookup
 * (`findUnique`, `findFirst`, `findMany`, and the `OrThrow` variants) are
 * counted, then forwarded untouched to the real delegate. Every other
 * delegate (`user`, `group`, …) and every client method is forwarded without
 * counting.
 *
 * The real Prisma client and its delegates are never written to, so there is
 * nothing to restore if an assertion fails: the proxy simply disappears with
 * this file's module graph. Counters are reset before every test, and
 * fixture rows are removed in `afterAll`, which runs regardless of outcome.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma as instrumentedPrisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

const tracker = vi.hoisted(() => {
  const methods = ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany'] as const;
  const zero = () => Object.fromEntries(methods.map((m) => [m, 0])) as Record<string, number>;
  const state = { methods: methods as readonly string[], calls: zero() };
  return {
    methods: state.methods,
    get calls() {
      return state.calls;
    },
    zero,
    reset() {
      state.calls = zero();
    },
    record(method: string) {
      state.calls[method] = (state.calls[method] ?? 0) + 1;
    },
    total() {
      return Object.values(state.calls).reduce((sum, n) => sum + n, 0);
    },
  };
});

vi.mock('@socialplay/database', async (importOriginal) => {
  const original = (await importOriginal()) as { prisma: typeof instrumentedPrisma };
  const realPrisma = original.prisma;
  const counted = new Set(tracker.methods);

  const instrumentGroupMember = (delegate: object) =>
    new Proxy(delegate, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof prop === 'string' && counted.has(prop) && typeof value === 'function') {
          return (...args: unknown[]) => {
            tracker.record(prop);
            return value.apply(target, args);
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

  let realDelegate: object | undefined;
  let instrumentedDelegate: object | undefined;
  const prisma = new Proxy(realPrisma, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === 'groupMember' && value !== null && typeof value === 'object') {
        if (value !== realDelegate) {
          realDelegate = value;
          instrumentedDelegate = instrumentGroupMember(value);
        }
        return instrumentedDelegate;
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { ...original, prisma, default: prisma };
});

const PREFIX = `${config.API_PREFIX}/groups`;

let dbAvailable = true;
try {
  await instrumentedPrisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}

const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;

const EMAIL_PREFIX = 'mygroups-n1-';

async function createUser(tag: string) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `${EMAIL_PREFIX}${tag}-${suffix}@test.local`;
  const user = await instrumentedPrisma.user.create({
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
  return instrumentedPrisma.group.create({
    data: { ownerId, name, description: `Fixture group: ${name}`, isPrivate: false, status: 'ACTIVE' },
  });
}

async function addMember(groupId: string, userId: string, role: GroupMemberRole, status: GroupMemberStatus) {
  return instrumentedPrisma.groupMember.create({ data: { groupId, userId, role, status } });
}

async function cleanFixtures() {
  const users = await instrumentedPrisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    const groups = await instrumentedPrisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g) => g.id);
    if (groupIds.length) {
      await instrumentedPrisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
      await instrumentedPrisma.group.deleteMany({ where: { id: { in: groupIds } } });
    }
    await instrumentedPrisma.groupMember.deleteMany({ where: { userId: { in: userIds } } });
  }
  await instrumentedPrisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

beforeEach(() => {
  tracker.reset();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures();
  if (server) await server.close();
  await instrumentedPrisma.$disconnect();
});

describeIf('groups/routes — GET /groups does not fall back to an N+1 membership lookup', () => {
  it('runs no groupMember read (findUnique/findFirst/findMany) for a multi-group page', async () => {
    const caller = await createUser('no_n_plus_1');
    const token = await mintToken(caller);

    const groups = await Promise.all(
      Array.from({ length: 5 }, (_, i) => createGroup(caller.id, `N1 Group ${i}`))
    );
    for (const g of groups) {
      await addMember(g.id, caller.id, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE);
    }

    // Measure only the request itself.
    tracker.reset();
    const qs = new URLSearchParams({ mine: 'true' }).toString();
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const body = JSON.parse(resp.body) as { success: boolean; data: unknown[]; meta: unknown };
    expect(resp.statusCode).toBe(200);
    expect(body.data).toHaveLength(5);
    // A per-row membership fallback would surface here as one groupMember
    // read per returned group, whichever read method it used.
    expect(tracker.calls).toEqual(tracker.zero());
  });

  it('counts only groupMember reads, forwards them intact, and never replaces the real delegate', async () => {
    const caller = await createUser('delegate_check');
    const group = await createGroup(caller.id, 'Delegate Check Group');
    await addMember(group.id, caller.id, GroupMemberRole.OWNER, GroupMemberStatus.ACTIVE);
    const where = { groupId_userId: { groupId: group.id, userId: caller.id } };

    // A genuine read through the instrumented delegate resolves the real row
    // and is counted exactly once.
    const row = await instrumentedPrisma.groupMember.findUnique({ where });
    expect(row?.role).toBe(GroupMemberRole.OWNER);
    expect(tracker.calls.findUnique).toBe(1);
    expect(tracker.total()).toBe(1);

    // Reads on unrelated delegates are forwarded but never counted.
    const user = await instrumentedPrisma.user.findUnique({ where: { id: caller.id } });
    expect(user?.id).toBe(caller.id);
    expect(tracker.total()).toBe(1);

    // The real client is a separate, untouched object: its own delegate
    // still works and bypasses the instrumentation entirely.
    const actual = (await vi.importActual('@socialplay/database')) as { prisma: typeof instrumentedPrisma };
    expect(actual.prisma).not.toBe(instrumentedPrisma);
    expect(actual.prisma.groupMember).not.toBe(instrumentedPrisma.groupMember);
    const direct = await actual.prisma.groupMember.findUnique({ where });
    expect(direct?.role).toBe(GroupMemberRole.OWNER);
    expect(tracker.total()).toBe(1);
  });
});
