import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { lockInviteSubject, type Tx } from './group-locks.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';

// An invitation that EXPIRES WHILE ACCEPTANCE IS BLOCKED ON A DATABASE LOCK.
//
// Acceptance reads the invite, checks it is live, and only then opens the
// admission transaction — where it can wait, behind the account row, the
// (group, email) subject lock, or the invite row itself, for as long as a
// competing transaction holds them. If the invite's deadline passes during
// that wait, the eventual claim must NOT succeed: expiry has to be enforced at
// the atomic claim, against the clock as it is AFTER the last blocking lock is
// held — not the clock at the pre-read, not the transaction-start now().
//
// Every schedule here is forced, not raced:
//   1. a test-held transaction takes the lock under test;
//   2. the acceptance is fired (not awaited) while the invite is still valid;
//   3. pg_stat_activity is polled until the acceptance is PROVABLY parked on
//      that lock (see test/pg-locks.ts) — no fixed settle windows;
//   4. the test waits until the DATABASE clock has passed the invite's
//      deadline (polled, not slept for a guessed duration);
//   5. only then is the lock released.
//
// The four lock levels of the admission protocol are each exercised, because
// the wait that matters is whichever one the request happens to be parked
// behind: the invite ROW lock taken by a lock-only holder (the claim's own
// statement waits — a plain UPDATE's WHERE is NOT re-evaluated after a
// lock-only wait, which is why the claim must lock first and read the clock
// second), the same row lock taken by a WRITER, the account row, and the
// subject advisory lock.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below carries a unique remoteAddress.

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

const EMAIL_PREFIX = 'gexl-';

// Long enough that the request always reaches its pre-read while the invite is
// live, short enough to keep each schedule to a few seconds.
const SHORT_TTL_MS = 3000;

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.41.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `gx_${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `ExpiryLock ${tag}`.slice(0, 100),
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
  // teardown runs; repeat until the block stops colliding with those writes.
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
  token: string;
  expiresAt: Date;
}

/** A private group, its owner, an ACTIVE verified invitee, and one PENDING invite for them. */
async function makeFixture(tag: string, ttlMs: number): Promise<Fixture> {
  const owner = await createUser(`${tag}-o`);
  const invitee = await createUser(`${tag}-e`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `XL-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });
  const expiresAt = new Date(Date.now() + ttlMs);
  const invite = await prisma.groupInvite.create({
    data: {
      groupId: group.id,
      email: invitee.email,
      role: 'MEMBER',
      status: 'PENDING',
      token: `xl${uniqueSuffix()}${uniqueSuffix()}`,
      expiresAt,
      invitedBy: owner.id,
    },
  });
  return { owner, invitee, groupId: group.id, inviteId: invite.id, token: invite.token, expiresAt };
}

/**
 * Run `take` in a test-held transaction, signal once it has run, then keep the
 * transaction open until `release()`; `afterGate` (if any) runs inside the
 * same transaction just before it commits. Generous Prisma timeouts: the
 * default 5s interactive-transaction limit must not end a hold that is
 * waiting on a wall-clock deadline.
 */
function holdTransaction(take: (tx: Tx) => Promise<void>, afterGate?: (tx: Tx) => Promise<void>) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const done = prisma.$transaction(
    async (tx) => {
      await take(tx);
      acquired();
      await gate;
      if (afterGate) await afterGate(tx);
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
  // Surface a failure while taking the lock instead of hanging on `ready`.
  done.catch(() => acquired());
  return {
    /** Resolves once the lock is held. */
    held: async () => {
      await ready;
    },
    /** Let the holder finish (running afterGate) and commit; resolves once committed. */
    release: async () => {
      open();
      await done;
    },
  };
}

/** Fire the acceptance without awaiting it. */
function startAcceptance(fx: Fixture) {
  return server.inject({
    method: 'POST',
    url: `${PREFIX}/accept-invite`,
    headers: { authorization: `Bearer ${signToken(fx.invitee)}` },
    payload: { token: fx.token },
    remoteAddress: nextIp(),
  });
}

/** Poll the DATABASE clock until the deadline has passed — never a guessed sleep. */
async function waitUntilPastExpiry(expiresAt: Date, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ past: boolean }[]>`SELECT clock_timestamp() > ${expiresAt} AS past`;
    if (row.past) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`The database clock never passed ${expiresAt.toISOString()} within ${timeoutMs}ms`);
}

const inviteState = (id: string) => prisma.groupInvite.findUniqueOrThrow({ where: { id } });
const membershipOf = (fx: Fixture) =>
  prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: fx.groupId, userId: fx.invitee.id } } });
const acceptanceNotifications = (fx: Fixture) =>
  prisma.notification.count({
    where: { type: 'GROUP_INVITE_ACCEPTED', data: { path: ['inviteId'], equals: fx.inviteId } },
  });

/** The rejection left NO trace of a successful acceptance. */
async function expectNoAcceptance(fx: Fixture) {
  const invite = await inviteState(fx.inviteId);
  expect(invite.status).not.toBe('ACCEPTED');
  expect(invite.acceptedBy).toBeNull();
  expect(await membershipOf(fx)).toBeNull();
  expect(await acceptanceNotifications(fx)).toBe(0);
}

async function expectExpiredRejection(fx: Fixture, resp: { statusCode: number; body: string }) {
  expect(resp.statusCode).toBe(400);
  expect(JSON.parse(resp.body).error.message).toBe('This invite has expired');
  // EXPIRED is COMMITTED — not rolled back with a thrown rejection.
  expect((await inviteState(fx.inviteId)).status).toBe('EXPIRED');
  await expectNoAcceptance(fx);
}

describeIf('invite expires while acceptance is blocked on a database lock', () => {
  it('the INVITE ROW is locked by a lock-only holder: the claim itself waits, the deadline passes, and the acceptance is rejected', async () => {
    const fx = await makeFixture('row-lockonly', SHORT_TTL_MS);
    const holder = holdTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${fx.inviteId} FOR NO KEY UPDATE`;
    });
    await holder.held();

    const accepting = startAcceptance(fx);
    await waitForBlockedBackends(1, { queryLike: '%group_invites%' });
    expect((await inviteState(fx.inviteId)).status).toBe('PENDING'); // parked, valid so far

    await waitUntilPastExpiry(fx.expiresAt);
    await holder.release();

    await expectExpiredRejection(fx, await accepting);
  }, 60_000);

  it('the INVITE ROW is locked by a WRITER that commits: the acceptance still rejects the expired invite', async () => {
    const fx = await makeFixture('row-writer', SHORT_TTL_MS);
    const holder = holdTransaction(async (tx) => {
      // Any write takes the row lock; this one changes nothing that matters.
      await tx.groupInvite.update({ where: { id: fx.inviteId }, data: { role: GroupMemberRole.ADMIN } });
    });
    await holder.held();

    const accepting = startAcceptance(fx);
    await waitForBlockedBackends(1, { queryLike: '%group_invites%' });

    await waitUntilPastExpiry(fx.expiresAt);
    await holder.release();

    await expectExpiredRejection(fx, await accepting);
  }, 60_000);

  it('the ACCOUNT ROW is locked (the first lock the admission takes): the deadline passes behind it and the acceptance is rejected', async () => {
    const fx = await makeFixture('acct-lock', SHORT_TTL_MS);
    const holder = holdTransaction(async (tx) => {
      // A status-neutral write: it conflicts with the admission's FOR SHARE.
      await tx.user.update({ where: { id: fx.invitee.id }, data: { bio: 'held' } });
    });
    await holder.held();

    const accepting = startAcceptance(fx);
    await waitForBlockedBackends(1, { queryLike: '%FROM "users"%' });

    await waitUntilPastExpiry(fx.expiresAt);
    await holder.release();

    await expectExpiredRejection(fx, await accepting);
  }, 60_000);

  it('the (group, email) SUBJECT advisory lock is held: the deadline passes behind it and the acceptance is rejected', async () => {
    const fx = await makeFixture('subject-lock', SHORT_TTL_MS);
    const holder = holdTransaction((tx) => lockInviteSubject(tx, fx.groupId, fx.invitee.email));
    await holder.held();

    const accepting = startAcceptance(fx);
    await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
    expect((await inviteState(fx.inviteId)).status).toBe('PENDING');

    await waitUntilPastExpiry(fx.expiresAt);
    await holder.release();

    await expectExpiredRejection(fx, await accepting);
  }, 60_000);

  describe('replacement vs acceptance', () => {
    it('REPLACEMENT WINS the subject lock: the stale invite is closed out and superseded, the parked acceptance is rejected, the replacement is untouched', async () => {
      const fx = await makeFixture('replace-wins', SHORT_TTL_MS);
      let replacementId = '';
      const holder = holdTransaction(
        (tx) => lockInviteSubject(tx, fx.groupId, fx.invitee.email),
        async (tx) => {
          // What the create route does under this same lock once the invite it
          // finds PENDING has expired: close it out and issue a fresh one.
          await tx.groupInvite.updateMany({ where: { id: fx.inviteId, status: 'PENDING' }, data: { status: 'EXPIRED' } });
          const replacement = await tx.groupInvite.create({
            data: {
              groupId: fx.groupId,
              email: fx.invitee.email,
              role: 'MEMBER',
              status: 'PENDING',
              token: `xlrep${uniqueSuffix()}${uniqueSuffix()}`,
              expiresAt: new Date(Date.now() + 3_600_000),
              invitedBy: fx.owner.id,
            },
          });
          replacementId = replacement.id;
        }
      );
      await holder.held();

      const accepting = startAcceptance(fx);
      await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
      await waitUntilPastExpiry(fx.expiresAt);
      await holder.release();

      const resp = await accepting;
      await expectExpiredRejection(fx, resp);
      // The superseding invite was neither accepted nor consumed by the loser.
      const replacement = await inviteState(replacementId);
      expect(replacement.status).toBe('PENDING');
      expect(replacement.acceptedBy).toBeNull();
    }, 60_000);

    it('ACCEPTANCE WINS first: it is admitted, and a replacement create afterwards is refused because the account is already a member', async () => {
      const fx = await makeFixture('accept-wins', 3_600_000);
      const accepted = await startAcceptance(fx);
      expect(accepted.statusCode).toBe(200);
      expect((await inviteState(fx.inviteId)).status).toBe('ACCEPTED');
      expect((await membershipOf(fx))?.status).toBe('ACTIVE');

      const create = await server.inject({
        method: 'POST',
        url: `${PREFIX}/${fx.groupId}/invites`,
        headers: { authorization: `Bearer ${signToken(fx.owner)}` },
        payload: { email: fx.invitee.email },
        remoteAddress: nextIp(),
      });
      expect(create.statusCode).toBe(409);
      expect(JSON.parse(create.body).error.message).toBe('User is already a member of this group');
    }, 60_000);
  });

  it('an invite REVOKED underneath a parked acceptance is reported as revoked — not expired, not accepted', async () => {
    const fx = await makeFixture('revoked-under', 3_600_000);
    const holder = holdTransaction(
      (tx) => lockInviteSubject(tx, fx.groupId, fx.invitee.email),
      async (tx) => {
        await tx.groupInvite.updateMany({ where: { id: fx.inviteId, status: 'PENDING' }, data: { status: 'REVOKED' } });
      }
    );
    await holder.held();

    const accepting = startAcceptance(fx);
    await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
    await holder.release();

    const resp = await accepting;
    expect(resp.statusCode).toBe(409);
    expect(JSON.parse(resp.body).error.message).toBe('This invite has been revoked');
    expect((await inviteState(fx.inviteId)).status).toBe('REVOKED');
    await expectNoAcceptance(fx);
  }, 60_000);

  it('CONTROL: a lock wait that ends BEFORE the deadline still admits the account — the guard rejects only what has actually expired', async () => {
    const fx = await makeFixture('control-live', 3_600_000);
    const holder = holdTransaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${fx.inviteId} FOR NO KEY UPDATE`;
    });
    await holder.held();

    const accepting = startAcceptance(fx);
    await waitForBlockedBackends(1, { queryLike: '%group_invites%' });
    await holder.release();

    const resp = await accepting;
    expect(resp.statusCode).toBe(200);
    const invite = await inviteState(fx.inviteId);
    expect(invite.status).toBe('ACCEPTED');
    expect(invite.acceptedBy).toBe(fx.invitee.id);
    expect((await membershipOf(fx))?.status).toBe('ACTIVE');
    expect(await acceptanceNotifications(fx)).toBe(1);
  }, 60_000);

  it('an invite that has ALREADY expired when the request arrives is rejected up front, persisted EXPIRED, with no lock wait at all', async () => {
    const fx = await makeFixture('already-expired', -1000);
    const resp = await startAcceptance(fx);
    await expectExpiredRejection(fx, resp);
  }, 60_000);
});
