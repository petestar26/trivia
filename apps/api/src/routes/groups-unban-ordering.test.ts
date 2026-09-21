import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { lockInviteSubject, type Tx } from './group-locks.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';

// Unban under concurrency: forced PostgreSQL schedules, not timing loops.
//
// Unban takes the same level-3 (group, email) subject lock as ban and as invite
// acceptance (see group-locks.ts), so it is TOTALLY ORDERED against them. Each
// schedule below holds that lock in a test transaction, parks the requests
// behind it in a chosen order, PROVES they are all parked (pg_stat_activity),
// and then releases. Postgres wakes advisory-lock waiters in arrival order, so
// the order they were parked in is the order they serialize in.
//
// That makes the tests self-checking: if unban did NOT take the lock it would
// never park, the wait for "N blocked backends" would time out and the test
// would fail loudly; and the outcome of every order below is different from
// the outcome an unlocked unban would produce.
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

const EMAIL_PREFIX = 'gunbo-';
const USERNAME_PREFIX = 'gunbo_';
// Marks the groups whose unban notification the rollback test makes fail.
const FAILING_GROUP_MARK = 'UnbanFailGrp-';

// A trigger that refuses to store the "Unbanned from group" notification for
// groups carrying FAILING_GROUP_MARK — used to prove the membership write and
// the notification are ONE transaction. Scoped to those groups so it cannot
// touch any other suite, removed in afterAll, and defensively dropped first in
// case a crashed run left it behind.
async function installFailingNotificationTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS gunbo_fail_notice ON notifications`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION gunbo_fail_notice() RETURNS trigger AS $$
    BEGIN
      IF NEW.title = 'Unbanned from group' AND NEW.body LIKE '%${FAILING_GROUP_MARK}%' THEN
        RAISE EXCEPTION 'forced notification failure';
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER gunbo_fail_notice BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION gunbo_fail_notice()`
  );
}

async function removeFailingNotificationTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS gunbo_fail_notice ON notifications`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS gunbo_fail_notice()`);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
  await installFailingNotificationTrigger();
});

afterAll(async () => {
  if (dbAvailable) {
    await removeFailingNotificationTrigger();
    await cleanFixtures();
  }
  if (server) await server.close();
  await prisma.$disconnect();
});

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.32.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

type Actor = { id: string; email: string; username: string };
type Res = { statusCode: number; body: string };

async function createUser(tag: string): Promise<Actor> {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      username: `${USERNAME_PREFIX}${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `UnbanOrder ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { id: user.id, email: user.email, username: user.username };
}

async function cleanFixtures() {
  // Late-write-tolerant teardown, like the sibling invite suites: a successful
  // acceptance fires safeRecordActivity without awaiting it.
  for (let attempt = 0; attempt < 12; attempt++) {
    const users = await prisma.user.findMany({ where: { username: { startsWith: USERNAME_PREFIX } } });
    if (!users.length) return;
    const userIds = users.map((u: { id: string }) => u.id);

    const groups = await prisma.group.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } });
    const groupIds = groups.map((g: { id: string }) => g.id);
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
    const walletIds = wallets.map((w: { id: string }) => w.id);
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

function signToken(user: Actor): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Fixture {
  owner: Actor;
  admin: Actor;
  target: Actor;
  groupId: string;
  groupName: string;
}

async function makeFixture(
  tag: string,
  opts: { targetStatus?: GroupMemberStatus | null; targetRole?: GroupMemberRole; groupMark?: string } = {}
): Promise<Fixture> {
  const owner = await createUser(`${tag}-own`);
  const admin = await createUser(`${tag}-adm`);
  const target = await createUser(`${tag}-tgt`);
  const group = await prisma.group.create({
    data: {
      ownerId: owner.id,
      name: `${opts.groupMark ?? 'UO-'}${tag}-${uniqueSuffix().slice(0, 6)}`,
      isPrivate: true,
      status: 'ACTIVE',
    },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: admin.id, role: GroupMemberRole.ADMIN, status: GroupMemberStatus.ACTIVE },
  });
  const status = opts.targetStatus === undefined ? GroupMemberStatus.BANNED : opts.targetStatus;
  if (status) {
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: target.id, role: opts.targetRole ?? GroupMemberRole.MEMBER, status },
    });
  }
  return { owner, admin, target, groupId: group.id, groupName: group.name };
}

const body = (res: Res) => JSON.parse(res.body);

const unbanReq = (f: Fixture, actor: Actor): Promise<Res> =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/members/${f.target.id}/unban`,
    headers: { authorization: `Bearer ${signToken(actor)}` },
    remoteAddress: nextIp(),
  });

const banReq = (f: Fixture, actor: Actor): Promise<Res> =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/members/${f.target.id}/ban`,
    headers: { authorization: `Bearer ${signToken(actor)}` },
    remoteAddress: nextIp(),
  });

const acceptReq = (user: Actor, token: string): Promise<Res> =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/accept-invite`,
    headers: { authorization: `Bearer ${signToken(user)}` },
    payload: { token },
    remoteAddress: nextIp(),
  });

const joinReq = (f: Fixture, user: Actor): Promise<Res> =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/request`,
    headers: { authorization: `Bearer ${signToken(user)}` },
    remoteAddress: nextIp(),
  });

const createInviteReq = (f: Fixture, actor: Actor, email: string): Promise<Res> =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/invites`,
    headers: { authorization: `Bearer ${signToken(actor)}` },
    payload: { email },
    remoteAddress: nextIp(),
  });

/** A membership row exactly as stored, plus xmin — which changes on ANY write to the row. */
async function snapshot(f: Fixture, userId: string = f.target.id) {
  const rows = await prisma.$queryRaw<{ status: string; role: string; updatedAt: Date; xmin: string }[]>`
    SELECT status::text AS status, role::text AS role, "updatedAt", xmin::text AS xmin
    FROM group_members
    WHERE "groupId" = ${f.groupId} AND "userId" = ${userId}
  `;
  return rows[0] ?? null;
}

const notices = (userId: string, title: string) => prisma.notification.count({ where: { userId, title } });

/** A live invite for the target, written directly. See the note on the accept schedules. */
async function seedLegacyInvite(f: Fixture) {
  return prisma.groupInvite.create({
    data: {
      groupId: f.groupId,
      email: f.target.email.toLowerCase(),
      role: 'MEMBER',
      status: 'PENDING',
      token: `gunbotok-${uniqueSuffix()}${uniqueSuffix()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedBy: f.owner.id,
    },
  });
}

const inviteStatus = async (id: string) => (await prisma.groupInvite.findUniqueOrThrow({ where: { id } })).status;

const SUBJECT_LOCK_WAIT = '%pg_advisory_xact_lock%';

/**
 * Hold the (group, email) subject lock in a test transaction while `during`
 * queues requests behind it, then commit — releasing them in arrival order.
 */
async function withSubjectLock(f: Fixture, during: (tx: Tx) => Promise<void>) {
  await prisma.$transaction(
    async (tx) => {
      await lockInviteSubject(tx, f.groupId, f.target.email);
      await during(tx);
    },
    { timeout: 30_000, maxWait: 30_000 }
  );
}

/**
 * Fire `start` and return once the request is provably parked on the subject
 * lock — the `parkedSoFar`-th backend waiting on it. Calling this in sequence
 * fixes the arrival order, and therefore the order they serialize in.
 */
async function parkOnSubjectLock(parkedSoFar: number, start: () => Promise<Res>): Promise<{ result: Promise<Res> }> {
  const result = start();
  result.catch(() => undefined);
  await waitForBlockedBackends(parkedSoFar, { queryLike: SUBJECT_LOCK_WAIT });
  // Wrapped: returning the promise itself from an async function would make the
  // caller wait for the request to FINISH, which it cannot while the lock is held.
  return { result };
}

describeIf('unban vs ban — forced schedules on the shared subject lock', () => {
  it('BAN parks first, UNBAN second: the unban waits, then sees the BANNED row and lifts it', async () => {
    // The target is ACTIVE when both requests start. An unban that did not wait
    // for the ban would run at once, find an ACTIVE member and answer 409.
    const f = await makeFixture('ban-then-unban', { targetStatus: GroupMemberStatus.ACTIVE });
    let banP: Promise<Res> | undefined;
    let unbanP: Promise<Res> | undefined;

    await withSubjectLock(f, async () => {
      banP = (await parkOnSubjectLock(1, () => banReq(f, f.owner))).result;
      unbanP = (await parkOnSubjectLock(2, () => unbanReq(f, f.admin))).result;
    });
    const [ban, unban] = await Promise.all([banP!, unbanP!]);

    expect(ban.statusCode).toBe(200);
    expect(body(ban).data.message).toBe('Member banned');
    expect(unban.statusCode).toBe(200);
    expect(body(unban).data.message).toBe('Member unbanned');
    expect(await snapshot(f)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
    // One announcement per real transition.
    expect(await notices(f.target.id, 'Banned from group')).toBe(1);
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(1);
  }, 60_000);

  it('UNBAN parks first, BAN second: the ban is a fresh transition and the member ends BANNED', async () => {
    const f = await makeFixture('unban-then-ban', { targetRole: GroupMemberRole.ADMIN });
    let unbanP: Promise<Res> | undefined;
    let banP: Promise<Res> | undefined;

    await withSubjectLock(f, async () => {
      unbanP = (await parkOnSubjectLock(1, () => unbanReq(f, f.owner))).result;
      banP = (await parkOnSubjectLock(2, () => banReq(f, f.owner))).result;
    });
    const [unban, ban] = await Promise.all([unbanP!, banP!]);

    expect(unban.statusCode).toBe(200);
    expect(ban.statusCode).toBe(200);
    // Not "already banned": the unban had already moved the row to LEFT.
    expect(body(ban).data.message).toBe('Member banned');
    expect(await snapshot(f)).toMatchObject({ status: 'BANNED' });
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(1);
    expect(await notices(f.target.id, 'Banned from group')).toBe(1);
  }, 60_000);
});

// A live invite for a BANNED account cannot come out of the routes — ban
// revokes the target's pending invites and creation refuses a banned invitee —
// so the invite below is written directly, standing in for data that arrived
// some other way (an import, a restore, an earlier bug). Admission has to be
// correct for it anyway, and it is the one state in which the two orders of
// acceptance and unban give different answers.
describeIf('unban vs invite acceptance — forced schedules on the shared subject lock', () => {
  it('ACCEPT parks first, UNBAN second: the accept still sees BANNED and is refused; the invite is untouched', async () => {
    // An unban that did not take the lock would run immediately, and the
    // parked accept would then read LEFT and admit the member.
    const f = await makeFixture('accept-then-unban');
    const invite = await seedLegacyInvite(f);
    let acceptP: Promise<Res> | undefined;
    let unbanP: Promise<Res> | undefined;

    await withSubjectLock(f, async () => {
      acceptP = (await parkOnSubjectLock(1, () => acceptReq(f.target, invite.token))).result;
      unbanP = (await parkOnSubjectLock(2, () => unbanReq(f, f.owner))).result;
    });
    const [accept, unban] = await Promise.all([acceptP!, unbanP!]);

    expect(accept.statusCode).toBe(403);
    expect(body(accept).error.message).toBe('You are banned from this group');
    expect(unban.statusCode).toBe(200);
    // The refused accept claimed nothing.
    expect(await inviteStatus(invite.id)).toBe('PENDING');
    expect(await snapshot(f)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
    expect(await notices(f.owner.id, 'Invite accepted')).toBe(0);
  }, 60_000);

  it('UNBAN parks first, ACCEPT second: the accept reads the committed LEFT row and admits the member', async () => {
    const f = await makeFixture('unban-then-accept');
    const invite = await seedLegacyInvite(f);
    let unbanP: Promise<Res> | undefined;
    let acceptP: Promise<Res> | undefined;

    await withSubjectLock(f, async () => {
      unbanP = (await parkOnSubjectLock(1, () => unbanReq(f, f.owner))).result;
      acceptP = (await parkOnSubjectLock(2, () => acceptReq(f.target, invite.token))).result;
    });
    const [unban, accept] = await Promise.all([unbanP!, acceptP!]);

    expect(unban.statusCode).toBe(200);
    expect(accept.statusCode).toBe(200);
    expect(await inviteStatus(invite.id)).toBe('ACCEPTED');
    // The invite, not the unban, decides what the member becomes.
    expect(await snapshot(f)).toMatchObject({ status: 'ACTIVE', role: 'MEMBER' });
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(1);
    expect(await notices(f.owner.id, 'Invite accepted')).toBe(1);
  }, 60_000);

  it('the way back through a NEW invitation: unban, then invite, then accept — and the old link stays dead', async () => {
    const f = await makeFixture('new-invite', { targetStatus: GroupMemberStatus.ACTIVE });
    const oldInvite = await seedLegacyInvite(f);
    expect((await banReq(f, f.owner)).statusCode).toBe(200);
    expect(await inviteStatus(oldInvite.id)).toBe('REVOKED');

    // Still banned: no new invitation can be issued.
    const refused = await createInviteReq(f, f.owner, f.target.email);
    expect(refused.statusCode).toBe(403);

    expect((await unbanReq(f, f.owner)).statusCode).toBe(200);
    expect(await inviteStatus(oldInvite.id)).toBe('REVOKED');
    expect((await acceptReq(f.target, oldInvite.token)).statusCode).toBe(409);
    expect(await snapshot(f)).toMatchObject({ status: 'LEFT' });

    const created = await createInviteReq(f, f.owner, f.target.email);
    expect(created.statusCode).toBe(200);
    const accepted = await acceptReq(f.target, body(created).data.token);
    expect(accepted.statusCode).toBe(200);
    expect(await snapshot(f)).toMatchObject({ status: 'ACTIVE', role: 'MEMBER' });
  }, 60_000);
});

describeIf('concurrent duplicate unbans', () => {
  it('three unbans parked on the lock: the first transitions, the others find nothing to do — ONE notification', async () => {
    const f = await makeFixture('dupes', { targetRole: GroupMemberRole.MODERATOR });
    const parked: Promise<Res>[] = [];

    await withSubjectLock(f, async () => {
      // All three have already passed the unlocked pre-read, which still says
      // BANNED for each — so it is the guarded write, not that read, that has
      // to make sure only one of them counts.
      parked.push((await parkOnSubjectLock(1, () => unbanReq(f, f.owner))).result);
      parked.push((await parkOnSubjectLock(2, () => unbanReq(f, f.admin))).result);
      parked.push((await parkOnSubjectLock(3, () => unbanReq(f, f.owner))).result);
    });
    const results = await Promise.all(parked);

    expect(results.map((r) => r.statusCode)).toEqual([200, 409, 409]);
    expect(body(results[1]).error.message).toBe('This member is not banned');
    expect(await snapshot(f)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(1);
  }, 60_000);

  it('without any subject lock to lean on (no account email), the guarded write alone still admits ONE winner', async () => {
    const f = await makeFixture('dupes-noemail', { targetStatus: null });
    const noEmail = await prisma.user.create({
      data: {
        email: null,
        username: `${USERNAME_PREFIX}${uniqueSuffix()}_noem`.slice(0, 30),
        passwordHash: 'fixture-only-not-a-real-hash',
        displayName: 'No email',
        status: 'ACTIVE',
      },
    });
    await prisma.groupMember.create({
      data: { groupId: f.groupId, userId: noEmail.id, role: GroupMemberRole.ADMIN, status: GroupMemberStatus.BANNED },
    });
    const noEmailFixture: Fixture = { ...f, target: { id: noEmail.id, email: '', username: noEmail.username } };

    const results = await Promise.all(
      [f.owner, f.admin, f.owner, f.admin, f.owner, f.admin].map((actor) => unbanReq(noEmailFixture, actor))
    );

    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(5);
    expect(await snapshot(noEmailFixture)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
    expect(await notices(noEmail.id, 'Unbanned from group')).toBe(1);
  }, 60_000);
});

describeIf('an unban that is refused up front never queues on the lock', () => {
  it('an OWNER target is turned away before any lock is taken, even while the subject lock is held', async () => {
    // The refusal needs no lock and must not wait for one: a request that is
    // going to be refused anyway has no business queueing behind — or ahead of —
    // the writers that are actually serializing on this (group, email).
    const f = await makeFixture('owner-early', { targetStatus: null });
    const ownerAsTarget: Fixture = { ...f, target: f.owner };
    let outcome: Res | 'parked' | undefined;

    await withSubjectLock(ownerAsTarget, async () => {
      const pending = unbanReq(ownerAsTarget, f.admin);
      pending.catch(() => undefined);
      outcome = await Promise.race([pending, new Promise<'parked'>((resolve) => setTimeout(() => resolve('parked'), 3_000))]);
    });

    expect(outcome).not.toBe('parked');
    expect((outcome as Res).statusCode).toBe(403);
    expect(body(outcome as Res).error.message).toBe('You cannot unban the owner of the group');
    expect(await snapshot(f, f.owner.id)).toMatchObject({ status: 'ACTIVE', role: 'OWNER' });
  }, 60_000);
});

describeIf('the guarded write re-checks what changed while the request waited', () => {
  it('the target is promoted to OWNER while the unban is parked: refused, and the row is not touched', async () => {
    const f = await makeFixture('promoted', { targetRole: GroupMemberRole.ADMIN });
    let unbanP: Promise<Res> | undefined;

    await withSubjectLock(f, async (tx) => {
      // The unban has passed its own OWNER check (the row said ADMIN) and is
      // parked; an ownership transfer now lands ahead of it.
      unbanP = (await parkOnSubjectLock(1, () => unbanReq(f, f.owner))).result;
      await tx.groupMember.updateMany({
        where: { groupId: f.groupId, userId: f.target.id },
        data: { role: 'OWNER' },
      });
    });
    const unban = await unbanP!;

    expect(unban.statusCode).toBe(403);
    expect(body(unban).error.message).toBe('You cannot unban the owner of the group');
    expect(await snapshot(f)).toMatchObject({ status: 'BANNED', role: 'OWNER' });
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(0);
  }, 60_000);

  it('the membership is removed while the unban is parked: 404, no notification', async () => {
    const f = await makeFixture('removed');
    let unbanP: Promise<Res> | undefined;

    await withSubjectLock(f, async (tx) => {
      unbanP = (await parkOnSubjectLock(1, () => unbanReq(f, f.owner))).result;
      await tx.groupMember.deleteMany({ where: { groupId: f.groupId, userId: f.target.id } });
    });
    const unban = await unbanP!;

    expect(unban.statusCode).toBe(404);
    expect(body(unban).error.message).toBe('User is not a member of this group');
    expect(await snapshot(f)).toBeNull();
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(0);
  }, 60_000);
});

describeIf('unban vs a join request', () => {
  it('a request made while the unban is in flight is decided against the committed BANNED row; the next one succeeds', async () => {
    const f = await makeFixture('joinreq', { targetRole: GroupMemberRole.ADMIN });
    let unbanP: Promise<Res> | undefined;
    let during: Res | undefined;

    await prisma.$transaction(
      async (tx) => {
        // Pin the target's row, so the unban gets as far as the lock on the
        // membership rows (the manager's and the target's, together) and provably
        // waits there — past the group and subject locks, in the middle of the
        // transaction.
        await tx.$queryRaw`
          SELECT 1 FROM group_members WHERE "groupId" = ${f.groupId} AND "userId" = ${f.target.id} FOR UPDATE
        `;
        unbanP = unbanReq(f, f.owner);
        unbanP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%FROM "group_members"%FOR NO KEY UPDATE%' });

        during = await joinReq(f, f.target);
      },
      { timeout: 30_000, maxWait: 30_000 }
    );
    const unban = await unbanP!;

    expect(during!.statusCode).toBe(403);
    expect(body(during!).error.message).toBe('You are banned from this group');
    expect(unban.statusCode).toBe(200);
    expect(await snapshot(f)).toMatchObject({ status: 'LEFT', role: 'MEMBER' });
    // The refused request notified no manager.
    expect(await prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(0);

    const after = await joinReq(f, f.target);
    expect(after.statusCode).toBe(200);
    expect(await snapshot(f)).toMatchObject({ status: 'PENDING', role: 'MEMBER' });
    expect(await prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(1);
  }, 60_000);
});

describeIf('atomicity', () => {
  it('if the notification cannot be stored the whole unban rolls back: still BANNED, still the old role, nothing sent', async () => {
    const f = await makeFixture('rollback', { targetRole: GroupMemberRole.ADMIN, groupMark: FAILING_GROUP_MARK });
    const before = await snapshot(f);
    expect(before).toMatchObject({ status: 'BANNED', role: 'ADMIN' });

    const res = await unbanReq(f, f.owner);

    expect(res.statusCode).toBe(500);
    // xmin included: the aborted UPDATE left the original row version in force.
    expect(await snapshot(f)).toEqual(before);
    expect(await notices(f.target.id, 'Unbanned from group')).toBe(0);
  }, 60_000);
});
