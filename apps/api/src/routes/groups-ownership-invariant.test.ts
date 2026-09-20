import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// Deterministic coverage for the group-ownership invariant:
//
//   a group always has exactly one ACTIVE OWNER, and group.ownerId points
//   at that membership row.
//
// Three routes mutate a member row after checking `role !== 'OWNER'` on a
// value read earlier: DELETE /members/:userId, PATCH /members/:userId/role,
// and POST /leave. A concurrent ownership transfer can promote that same
// row to OWNER in the window between the check and the write. Without an
// atomic guard the write then lands on the group's owner — deleting it,
// demoting it, or marking it LEFT — and leaves the group with no active
// owner at all. No route can repair that: transfer requires an ACTIVE
// OWNER actor, role-change refuses to assign OWNER, and re-join/leave
// reject a non-ACTIVE row.
//
// Rather than racing requests and hoping to hit a sub-millisecond window,
// each test below FORCES the interleaving with a row lock, so it is
// deterministic and mutation-sensitive instead of statistical:
//
//   1. open a transaction and SELECT ... FOR UPDATE the target row
//   2. fire the request — it passes its pre-checks, then blocks on the write
//   3. inside the lock, apply exactly what a committed transfer does
//      (promote target to OWNER, demote old owner, move group.ownerId)
//   4. commit — the blocked write unblocks and re-qualifies under READ
//      COMMITTED against the new row
//
// Own file, as with the other group suites: the API's global rate limit is
// IP-keyed and shared per server instance.

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

const EMAIL_PREFIX = 'gown-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `go_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `OwnTest ${tag}`.slice(0, 100),
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

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

// `server.jwt.sign` is synchronous; this variant exists so a token can be
// minted inside the non-async arrow passed to
// withTransferCommittingUnderneath, where `await` is not available.
function signToken(user: { id: string; email: string; username: string }): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Fixture {
  groupId: string;
  owner: Awaited<ReturnType<typeof createUser>>;
  admin: Awaited<ReturnType<typeof createUser>>;
  target: Awaited<ReturnType<typeof createUser>>;
  ownerRowId: string;
  targetRowId: string;
}

async function makeFixture(tag: string): Promise<Fixture> {
  const owner = await createUser(`${tag}-own`);
  const admin = await createUser(`${tag}-adm`);
  const target = await createUser(`${tag}-tgt`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `Own-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.createMany({
    data: [
      { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
      { groupId: group.id, userId: admin.id, role: GroupMemberRole.ADMIN, status: GroupMemberStatus.ACTIVE },
      { groupId: group.id, userId: target.id, role: GroupMemberRole.MEMBER, status: GroupMemberStatus.ACTIVE },
    ],
  });
  const ownerRow = await prisma.groupMember.findUniqueOrThrow({
    where: { groupId_userId: { groupId: group.id, userId: owner.id } },
  });
  const targetRow = await prisma.groupMember.findUniqueOrThrow({
    where: { groupId_userId: { groupId: group.id, userId: target.id } },
  });
  return { groupId: group.id, owner, admin, target, ownerRowId: ownerRow.id, targetRowId: targetRow.id };
}

/**
 * Run `fire()` against the target row while a transfer commits underneath
 * it. Returns the request's status code once the lock is released.
 *
 * The request promise is deliberately NOT awaited inside the transaction:
 * the request is blocked on our lock, so awaiting it there would deadlock.
 */
async function withTransferCommittingUnderneath(
  f: Fixture,
  fire: () => Promise<{ statusCode: number }>
): Promise<number> {
  let pending: Promise<{ statusCode: number }> | undefined;
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM group_members WHERE id = ${f.targetRowId} FOR UPDATE`;
      pending = fire();
      pending.catch(() => undefined);
      await sleep(350); // let the request clear its pre-checks and reach its write
      // Exactly what a committed POST /:id/transfer leaves behind.
      await tx.groupMember.update({ where: { id: f.targetRowId }, data: { role: GroupMemberRole.OWNER } });
      await tx.groupMember.update({ where: { id: f.ownerRowId }, data: { role: GroupMemberRole.ADMIN } });
      await tx.group.update({ where: { id: f.groupId }, data: { ownerId: f.target.id } });
    },
    { timeout: 20_000, maxWait: 20_000 }
  );
  const resp = await pending!.catch(() => ({ statusCode: -1 }));
  await sleep(150);
  return resp.statusCode;
}

/** The invariant every one of these tests must uphold. */
async function assertOwnershipInvariant(groupId: string, expectedOwnerUserId: string, label: string) {
  const group = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
  const activeOwners = await prisma.groupMember.findMany({
    where: { groupId, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });

  expect(activeOwners, `${label}: exactly one ACTIVE OWNER`).toHaveLength(1);
  expect(group.ownerId, `${label}: group.ownerId matches the surviving owner`).toBe(activeOwners[0].userId);
  expect(activeOwners[0].userId, `${label}: the promoted user is still the owner`).toBe(expectedOwnerUserId);

  // The owner membership must not have been deleted, demoted or deactivated.
  const ownerRow = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: expectedOwnerUserId } },
  });
  expect(ownerRow, `${label}: owner membership row still exists`).not.toBeNull();
  expect(ownerRow!.role, `${label}: owner not demoted`).toBe('OWNER');
  expect(ownerRow!.status, `${label}: owner still ACTIVE`).toBe('ACTIVE');
}

describeIf('groups/routes — ownership invariant under concurrent transfer', () => {
  it('DELETE /members/:userId cannot remove a member promoted to OWNER mid-flight', async () => {
    const f = await makeFixture('rm');
    const status = await withTransferCommittingUnderneath(f, () =>
      server.inject({
        method: 'DELETE',
        url: `${PREFIX}/${f.groupId}/members/${f.target.id}`,
        headers: authHeader(signToken(f.admin)),
      })
    );

    // The row is now OWNER, so the guarded deleteMany matches nothing and
    // the zero-count re-read reports the same 403 the pre-check would have.
    expect(status).toBe(403);
    await assertOwnershipInvariant(f.groupId, f.target.id, 'remove vs transfer');
  }, 60_000);

  it('PATCH /members/:userId/role cannot demote a member promoted to OWNER mid-flight', async () => {
    const f = await makeFixture('cr');
    const status = await withTransferCommittingUnderneath(f, () =>
      server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${f.groupId}/members/${f.target.id}/role`,
        headers: authHeader(signToken(f.owner)),
        payload: { role: 'MEMBER' },
      })
    );

    expect(status).toBe(403);
    await assertOwnershipInvariant(f.groupId, f.target.id, 'role change vs transfer');
  }, 60_000);

  it('POST /leave cannot mark a member promoted to OWNER as LEFT mid-flight', async () => {
    const f = await makeFixture('lv');
    const status = await withTransferCommittingUnderneath(f, () =>
      server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.groupId}/leave`,
        headers: authHeader(signToken(f.target)),
      })
    );

    // Leave reports the owner case as 400, matching its pre-check.
    expect(status).toBe(400);
    await assertOwnershipInvariant(f.groupId, f.target.id, 'leave vs transfer');
  }, 60_000);

  // The leave guard carries a status clause as well as the role clause;
  // this forces a concurrent status change so that clause is load-bearing
  // rather than merely shadowed by the pre-checks.
  it('POST /leave reports 409 when the row is marked LEFT underneath it', async () => {
    const f = await makeFixture('lv-race');
    let pending: Promise<{ statusCode: number; body: string }> | undefined;
    const token = signToken(f.target);

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM group_members WHERE id = ${f.targetRowId} FOR UPDATE`;
        pending = server.inject({
          method: 'POST',
          url: `${PREFIX}/${f.groupId}/leave`,
          headers: authHeader(token),
        }) as unknown as Promise<{ statusCode: number; body: string }>;
        pending.catch(() => undefined);
        await sleep(350);
        // A concurrent leave (second tab, retried request) wins the race.
        await tx.groupMember.update({
          where: { id: f.targetRowId },
          data: { status: GroupMemberStatus.LEFT },
        });
      },
      { timeout: 20_000, maxWait: 20_000 }
    );

    const resp = await pending!;
    expect(resp.statusCode).toBe(409);
    expect(JSON.parse(resp.body).error.message).toBe('You have already left this group');
    await assertOwnershipInvariant(f.groupId, f.owner.id, 'leave vs concurrent leave');
  }, 60_000);

  it('POST /leave reports 403 when the row is BANNED underneath it', async () => {
    const f = await makeFixture('lv-ban-race');
    let pending: Promise<{ statusCode: number; body: string }> | undefined;
    const token = signToken(f.target);

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM group_members WHERE id = ${f.targetRowId} FOR UPDATE`;
        pending = server.inject({
          method: 'POST',
          url: `${PREFIX}/${f.groupId}/leave`,
          headers: authHeader(token),
        }) as unknown as Promise<{ statusCode: number; body: string }>;
        pending.catch(() => undefined);
        await sleep(350);
        // A manager bans the member while their leave is in flight.
        await tx.groupMember.update({
          where: { id: f.targetRowId },
          data: { status: GroupMemberStatus.BANNED },
        });
      },
      { timeout: 20_000, maxWait: 20_000 }
    );

    const resp = await pending!;
    expect(resp.statusCode).toBe(403);
    expect(JSON.parse(resp.body).error.message).toBe('You are banned from this group');
    await assertOwnershipInvariant(f.groupId, f.owner.id, 'leave vs concurrent ban');
  }, 60_000);

  describe('uncontended behavior is unchanged', () => {
    it('remove still removes a plain member', async () => {
      const f = await makeFixture('rm-ok');
      const resp = await server.inject({
        method: 'DELETE',
        url: `${PREFIX}/${f.groupId}/members/${f.target.id}`,
        headers: authHeader(await mintToken(f.admin)),
      });
      expect(resp.statusCode).toBe(200);
      expect(
        await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: f.groupId, userId: f.target.id } } })
      ).toBeNull();
      await assertOwnershipInvariant(f.groupId, f.owner.id, 'remove uncontended');
    });

    it('remove returns 404 when the membership vanished before the write', async () => {
      const f = await makeFixture('rm-404');
      await prisma.groupMember.delete({ where: { id: f.targetRowId } });
      const resp = await server.inject({
        method: 'DELETE',
        url: `${PREFIX}/${f.groupId}/members/${f.target.id}`,
        headers: authHeader(await mintToken(f.admin)),
      });
      expect(resp.statusCode).toBe(404);
    });

    it('role change still updates a plain member', async () => {
      const f = await makeFixture('cr-ok');
      const resp = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${f.groupId}/members/${f.target.id}/role`,
        headers: authHeader(await mintToken(f.owner)),
        payload: { role: 'MODERATOR' },
      });
      expect(resp.statusCode).toBe(200);
      const row = await prisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: f.groupId, userId: f.target.id } },
      });
      expect(row.role).toBe('MODERATOR');
      await assertOwnershipInvariant(f.groupId, f.owner.id, 'role uncontended');
    });

    it('leave still marks a plain member LEFT, and a second leave is still 409', async () => {
      const f = await makeFixture('lv-ok');
      const token = await mintToken(f.target);
      const first = await server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/leave`, headers: authHeader(token) });
      expect(first.statusCode).toBe(200);
      const row = await prisma.groupMember.findUniqueOrThrow({
        where: { groupId_userId: { groupId: f.groupId, userId: f.target.id } },
      });
      expect(row.status).toBe('LEFT');

      const second = await server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/leave`, headers: authHeader(token) });
      expect(second.statusCode).toBe(409);
      await assertOwnershipInvariant(f.groupId, f.owner.id, 'leave uncontended');
    });

    it('leave by a BANNED member is still 403', async () => {
      const f = await makeFixture('lv-ban');
      await prisma.groupMember.update({ where: { id: f.targetRowId }, data: { status: GroupMemberStatus.BANNED } });
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.groupId}/leave`,
        headers: authHeader(await mintToken(f.target)),
      });
      expect(resp.statusCode).toBe(403);
    });

    it('the owner still cannot leave', async () => {
      const f = await makeFixture('lv-own');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.groupId}/leave`,
        headers: authHeader(await mintToken(f.owner)),
      });
      expect(resp.statusCode).toBe(400);
      await assertOwnershipInvariant(f.groupId, f.owner.id, 'owner leave rejected');
    });
  });
});
