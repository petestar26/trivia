import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { lockInviteSubject } from './group-locks.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';

// Invitation acceptance versus the acceptor's ACCOUNT status.
//
// The check that an account may be admitted used to be a plain read taken
// BEFORE the admission transaction. A suspension committing between that read
// and the transaction was invisible to it, so a token issued earlier still
// admitted the account. The fix is a locking protocol (see group-locks.ts):
// inside the admission transaction, lock the account row FOR SHARE, re-read
// it, and hold the lock through the membership change, the invite claim and
// the commit.
//
// Every schedule here is FORCED rather than raced. A test-held lock parks the
// request at a known point, and the test then observes pg_stat_activity to
// PROVE the request is blocked inside that statement before letting the other
// side commit. See test/pg-locks.ts.
//
// The two serialization orders have different, intentional results:
//
//   status change wins  -> the acceptance is REJECTED with zero side effects.
//   acceptance wins     -> the account was legitimately eligible at its
//       serialization point and IS admitted; the later status change applies
//       afterwards and does NOT unwind the membership. A suspension workflow
//       that must also evict has to do so itself, taking the users row first
//       (the compliant-writer test below shows that order completing without
//       a deadlock).
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

const EMAIL_PREFIX = 'gadm-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.20.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      // Suffix FIRST: usernames are capped at 30 chars, and the longer tags
      // (e.g. win-PENDING_VERIFICATION-own) would otherwise have the unique
      // part truncated away.
      username: `ga_${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `Admission ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function cleanFixtures() {
  // A successful acceptance fires safeRecordActivity (GROUP_JOIN) without
  // awaiting it, so reward/achievement/wallet rows may still be arriving while
  // teardown runs. Repeat the whole block until it stops colliding with those
  // late writes, then drop the users — same approach as the sibling invite suites.
  for (let attempt = 0; attempt < 12; attempt++) {
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    if (!users.length) return;
    const userIds = users.map((u) => u.id);

    const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g) => g.id);
    if (groupIds.length) {
      await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
      await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
    }
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

    const wallets = await prisma.wallet.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const walletIds = wallets.map((w) => w.id);
    if (walletIds.length) {
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
      const res = await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      if (res.count === users.length) return;
    } catch {
      // A late async reward write still references these users; wait and retry.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function signToken(user: { id: string; email: string; username: string }): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Fixture {
  owner: Awaited<ReturnType<typeof createUser>>;
  invitee: Awaited<ReturnType<typeof createUser>>;
  groupId: string;
  inviteId: string;
  inviteToken: string;
}

async function makeFixture(tag: string, opts: { existingMembership?: GroupMemberStatus } = {}): Promise<Fixture> {
  const owner = await createUser(`${tag}-own`);
  const invitee = await createUser(`${tag}-inv`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `Adm-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });
  if (opts.existingMembership) {
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: invitee.id, role: GroupMemberRole.MEMBER, status: opts.existingMembership },
    });
  }
  const inviteToken = `admtok-${uniqueSuffix()}${uniqueSuffix()}`;
  const invite = await prisma.groupInvite.create({
    data: {
      groupId: group.id,
      email: invitee.email.toLowerCase(),
      role: 'MEMBER',
      status: 'PENDING',
      token: inviteToken,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedBy: owner.id,
    },
  });
  return { owner, invitee, groupId: group.id, inviteId: invite.id, inviteToken };
}

function accept(f: Fixture) {
  return server.inject({
    method: 'POST',
    url: `${PREFIX}/accept-invite`,
    headers: { authorization: `Bearer ${signToken(f.invitee)}` },
    payload: { token: f.inviteToken },
    remoteAddress: nextIp(),
  });
}

const membershipOf = (f: Fixture) =>
  prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: f.groupId, userId: f.invitee.id } } });
const inviteOf = (f: Fixture) => prisma.groupInvite.findUniqueOrThrow({ where: { id: f.inviteId } });
const acceptanceNotifications = (f: Fixture) =>
  prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_INVITE_ACCEPTED' } });

/** Assert the acceptance left NOTHING behind. */
async function expectNoSideEffects(f: Fixture, membershipBefore: Awaited<ReturnType<typeof membershipOf>>) {
  const invite = await inviteOf(f);
  expect(invite.status).toBe('PENDING');
  expect(invite.acceptedBy).toBeNull();
  expect(await acceptanceNotifications(f)).toBe(0);

  const membershipAfter = await membershipOf(f);
  if (membershipBefore === null) {
    expect(membershipAfter).toBeNull();
  } else {
    expect(membershipAfter).not.toBeNull();
    expect(membershipAfter!.status).toBe(membershipBefore.status);
    expect(membershipAfter!.role).toBe(membershipBefore.role);
    expect(membershipAfter!.updatedAt.getTime()).toBe(membershipBefore.updatedAt.getTime());
  }
}

const RESTRICTED = [
  { status: 'SUSPENDED', message: 'Your account is not eligible to accept invitations' },
  { status: 'INACTIVE', message: 'Your account is not eligible to accept invitations' },
  { status: 'BANNED', message: 'You are banned from this group' },
  // Not restricted by any blacklist — rejected only because ACTIVE is the sole
  // permitted status. A blacklist implementation would admit this one.
  { status: 'PENDING_VERIFICATION', message: 'Your account is not eligible to accept invitations' },
] as const;

describeIf('invite acceptance vs account status — deterministic PostgreSQL schedules', () => {
  for (const { status, message } of RESTRICTED) {
    describe(`account becomes ${status}`, () => {
      it('status change committed BEFORE acceptance starts: rejected at the fast path', async () => {
        const f = await makeFixture(`pre-${status}`);
        await prisma.user.update({ where: { id: f.invitee.id }, data: { status } });

        const resp = await accept(f);

        expect(resp.statusCode).toBe(403);
        expect(JSON.parse(resp.body).error.message).toBe(message);
        await expectNoSideEffects(f, null);
      });

      it('status change WINS serialization after the fast path passed: rejected under the lock, zero side effects', async () => {
        const f = await makeFixture(`win-${status}`);
        const before = await membershipOf(f);
        let pending: ReturnType<typeof accept> | undefined;

        await prisma.$transaction(
          async (tx) => {
            // Uncommitted status change: holds the users row lock. The
            // acceptance's UNLOCKED fast-path read still sees the committed
            // ACTIVE row and passes...
            await tx.user.update({ where: { id: f.invitee.id }, data: { status } });
            pending = accept(f);
            pending.catch(() => undefined);
            // ...and then parks inside the authoritative FOR SHARE lock.
            // Proving that is the point: without it this could just be a
            // slow request that has not looked at the account yet.
            await waitForBlockedBackends(1, { queryLike: '%FOR SHARE%' });
          },
          { timeout: 30_000, maxWait: 30_000 }
        );

        const resp = await pending!;

        expect(resp.statusCode).toBe(403);
        expect(JSON.parse(resp.body).error.message).toBe(message);
        await expectNoSideEffects(f, before);
      }, 60_000);

      it('acceptance WINS serialization: the account is admitted, and the status change applies afterwards', async () => {
        const f = await makeFixture(`acc-${status}`);
        let acceptP: ReturnType<typeof accept> | undefined;
        let writerP: Promise<unknown> | undefined;

        await prisma.$transaction(
          async (tx) => {
            // Park the acceptance at its invite CLAIM — the invite-row lock it
            // takes (lockInviteRow) before it reads the clock and claims. By
            // then it has already taken the account lock (level 1) and the
            // subject lock (level 2).
            await tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${f.inviteId} FOR UPDATE`;
            acceptP = accept(f);
            acceptP.catch(() => undefined);
            await waitForBlockedBackends(1, { queryLike: '%"group_invites"%' });

            // Now a status writer arrives. It must WAIT for the acceptance —
            // which proves the account lock is held all the way through the
            // claim, not released after the check.
            writerP = prisma.user.update({ where: { id: f.invitee.id }, data: { status } });
            writerP.catch(() => undefined);
            await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."users"%' });
          },
          { timeout: 30_000, maxWait: 30_000 }
        );

        const resp = await acceptP!;
        await writerP;

        // Admitted at its serialization point...
        expect(resp.statusCode).toBe(200);
        const membership = await membershipOf(f);
        expect(membership?.status).toBe('ACTIVE');
        const invite = await inviteOf(f);
        expect(invite.status).toBe('ACCEPTED');
        expect(invite.acceptedBy).toBe(f.invitee.id);
        expect(await acceptanceNotifications(f)).toBe(1);

        // ...and the restriction landed afterwards. It does not retroactively
        // unwind the membership: that is the intended result of this order.
        const account = await prisma.user.findUniqueOrThrow({ where: { id: f.invitee.id } });
        expect(account.status).toBe(status);
      }, 60_000);
    });
  }

  it('a suspended re-joiner keeps their existing LEFT membership untouched (membership unchanged, not just absent)', async () => {
    const f = await makeFixture('left-row', { existingMembership: GroupMemberStatus.LEFT });
    const before = await membershipOf(f);
    let pending: ReturnType<typeof accept> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({ where: { id: f.invitee.id }, data: { status: 'SUSPENDED' } });
        pending = accept(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%FOR SHARE%' });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await pending!;
    expect(resp.statusCode).toBe(403);
    await expectNoSideEffects(f, before);
    expect(before?.status).toBe('LEFT');
  }, 60_000);

  describe('the lock protocol itself', () => {
    it('acceptance takes the (group, email) subject lock: it parks behind a held one and completes once released', async () => {
      const f = await makeFixture('subject-lock');
      let pending: ReturnType<typeof accept> | undefined;

      await prisma.$transaction(
        async (tx) => {
          await lockInviteSubject(tx, f.groupId, f.invitee.email);
          pending = accept(f);
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
        },
        { timeout: 30_000, maxWait: 30_000 }
      );

      const resp = await pending!;
      expect(resp.statusCode).toBe(200);
      expect((await inviteOf(f)).status).toBe('ACCEPTED');
    }, 60_000);

    it('a moderation writer that follows the order (users row FIRST, then memberships) completes with acceptance — no deadlock, and it can evict', async () => {
      const f = await makeFixture('compliant-writer');
      let acceptP: ReturnType<typeof accept> | undefined;
      let writerP: Promise<unknown> | undefined;

      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${f.inviteId} FOR UPDATE`;
          acceptP = accept(f);
          acceptP.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: '%"group_invites"%' });

          // A writer following the documented order: users row first, and
          // only afterwards the memberships it wants to evict. If it took the
          // memberships first it would invert the lock order and the two
          // could wait on each other forever (PostgreSQL would abort one).
          writerP = prisma.$transaction(
            async (wtx) => {
              await wtx.user.update({ where: { id: f.invitee.id }, data: { status: 'SUSPENDED' } });
              await wtx.groupMember.updateMany({
                where: { userId: f.invitee.id, status: GroupMemberStatus.ACTIVE },
                data: { status: GroupMemberStatus.LEFT },
              });
            },
            { timeout: 30_000, maxWait: 30_000 }
          );
          writerP.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."users"%' });
        },
        { timeout: 30_000, maxWait: 30_000 }
      );

      const resp = await acceptP!;
      await writerP; // would reject with 40P01 if the orders were inconsistent

      expect(resp.statusCode).toBe(200);
      const account = await prisma.user.findUniqueOrThrow({ where: { id: f.invitee.id } });
      expect(account.status).toBe('SUSPENDED');
      // Ordered AFTER the admission, so the eviction sees the new membership.
      expect((await membershipOf(f))?.status).toBe('LEFT');
    }, 60_000);
  });

  describe('the invite claim loses a race: the rejection says WHY', () => {
    // The pre-transaction reads see PENDING, so the claim itself is the first
    // place these states can be noticed. It used to answer "already accepted"
    // for all of them.
    async function acceptWhileInviteChanges(f: Fixture, change: 'REVOKED' | 'EXPIRED') {
      let pending: ReturnType<typeof accept> | undefined;
      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${f.inviteId} FOR UPDATE`;
          pending = accept(f);
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: '%"group_invites"%' });
          await tx.groupInvite.update({ where: { id: f.inviteId }, data: { status: change } });
        },
        { timeout: 30_000, maxWait: 30_000 }
      );
      return pending!;
    }

    it('revoked underneath it -> 409 "revoked", nothing admitted', async () => {
      const f = await makeFixture('claim-revoked');
      const resp = await acceptWhileInviteChanges(f, 'REVOKED');

      expect(resp.statusCode).toBe(409);
      expect(JSON.parse(resp.body).error.message).toBe('This invite has been revoked');
      expect(await membershipOf(f)).toBeNull();
      expect(await acceptanceNotifications(f)).toBe(0);
    }, 60_000);

    it('expired underneath it -> 400 "expired", nothing admitted', async () => {
      const f = await makeFixture('claim-expired');
      const resp = await acceptWhileInviteChanges(f, 'EXPIRED');

      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('This invite has expired');
      expect(await membershipOf(f)).toBeNull();
      expect(await acceptanceNotifications(f)).toBe(0);
    }, 60_000);
  });

  it('an ACTIVE, verified account is still admitted (the fix does not over-reject)', async () => {
    const f = await makeFixture('control');
    const resp = await accept(f);
    expect(resp.statusCode).toBe(200);
    expect((await membershipOf(f))?.status).toBe('ACTIVE');
    expect((await inviteOf(f)).status).toBe('ACCEPTED');
    expect(await acceptanceNotifications(f)).toBe(1);
  });
});
