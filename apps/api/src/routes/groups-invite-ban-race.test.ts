import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma, GroupMemberRole, GroupMemberStatus } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { lockInviteSubject } from './group-locks.js';
import { waitForBlockedBackends, waitForWaitEvent } from '../test/pg-locks.js';

// Invite CREATION versus a group BAN of the same invitee, and the lock order
// shared with invite ACCEPTANCE (see group-locks.ts).
//
// Before the (group, email) subject lock, invite creation re-checked the
// invitee's membership with a plain read inside its transaction. That read is
// not ordered against a ban: a ban could commit after the read but before the
// insert, leaving a live PENDING invite — and an invitation notification —
// for a banned user, because the ban's own "revoke pending invites" step had
// already run and found nothing to revoke.
//
// Each schedule is forced: the test holds the subject lock, parks each writer
// on it in a chosen order, PROVES both are parked (pg_stat_activity), and then
// releases. Postgres wakes advisory-lock waiters in arrival order, so the
// order they were parked in is the order they serialize in.
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

const EMAIL_PREFIX = 'gilock-';

// The deadlock regression below needs the accept's invite claim to be slow so
// "accept holds the invite row" is a state the test can observe rather than a
// race it hopes to win. The trigger is scoped to this file's fixture emails so
// it cannot slow any other suite, and is removed in afterAll (and defensively
// dropped first, in case a previous crashed run left it behind).
async function installSlowClaimTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS gilock_slow_claim ON group_invites`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION gilock_slow_claim() RETURNS trigger AS $$
    BEGIN
      IF NEW.status = 'ACCEPTED' AND OLD.status = 'PENDING' AND NEW.email LIKE '${EMAIL_PREFIX}%' THEN
        PERFORM pg_sleep(0.8);
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER gilock_slow_claim AFTER UPDATE ON group_invites FOR EACH ROW EXECUTE FUNCTION gilock_slow_claim()`
  );
}

async function removeSlowClaimTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS gilock_slow_claim ON group_invites`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS gilock_slow_claim()`);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
  await installSlowClaimTrigger();
});

afterAll(async () => {
  if (dbAvailable) {
    await removeSlowClaimTrigger();
    await cleanFixtures();
  }
  if (server) await server.close();
  await prisma.$disconnect();
});

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

let ipCounter = 0;
const nextIp = () => `10.21.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${tag}-${suffix}@test.local`,
      // Suffix first: usernames are capped at 30 chars.
      username: `gl_${suffix}_${tag}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `InviteBan ${tag}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function cleanFixtures() {
  // Same late-write-tolerant teardown as the sibling invite suites: a
  // successful acceptance fires safeRecordActivity without awaiting it.
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
      // Coin provenance/allocation rows are a real foreign key to User —
      // must be cleared before the user row itself can be deleted (covers
      // legacy backfill rows for any stale fixture user too).
      await prisma.coinAllocation.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.coinProvenance.deleteMany({ where: { userId: { in: userIds } } });
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
}

async function makeFixture(tag: string, opts: { membership?: GroupMemberStatus | null } = {}): Promise<Fixture> {
  const owner = await createUser(`${tag}-own`);
  const invitee = await createUser(`${tag}-inv`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `IB-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: GroupMemberRole.OWNER, status: GroupMemberStatus.ACTIVE },
  });
  const membership = opts.membership === undefined ? GroupMemberStatus.LEFT : opts.membership;
  if (membership) {
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: invitee.id, role: GroupMemberRole.MEMBER, status: membership },
    });
  }
  return { owner, invitee, groupId: group.id };
}

const createInvite = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/invites`,
    headers: { authorization: `Bearer ${signToken(f.owner)}` },
    payload: { email: f.invitee.email },
    remoteAddress: nextIp(),
  });

const banInvitee = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/members/${f.invitee.id}/ban`,
    headers: { authorization: `Bearer ${signToken(f.owner)}` },
    remoteAddress: nextIp(),
  });

const counts = async (f: Fixture) => ({
  pendingInvites: await prisma.groupInvite.count({
    where: { groupId: f.groupId, email: f.invitee.email.toLowerCase(), status: 'PENDING' },
  }),
  totalInvites: await prisma.groupInvite.count({
    where: { groupId: f.groupId, email: f.invitee.email.toLowerCase() },
  }),
  invitationNotifications: await prisma.notification.count({ where: { userId: f.invitee.id, type: 'GROUP_INVITE' } }),
  moderationNotifications: await prisma.notification.count({ where: { userId: f.invitee.id, type: 'MODERATION' } }),
});

const membershipStatus = async (f: Fixture) =>
  (await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: f.groupId, userId: f.invitee.id } } }))?.status ?? null;

describeIf('invite creation vs ban — forced PostgreSQL schedules', () => {
  it('BAN wins: no PENDING invite and no invitation notification is created; exactly one moderation notification', async () => {
    const f = await makeFixture('ban-wins');
    let banP: ReturnType<typeof banInvitee> | undefined;
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await lockInviteSubject(tx, f.groupId, f.invitee.email);
        // The ban parks FIRST, so it serializes first...
        banP = banInvitee(f);
        banP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
        // ...and the create parks SECOND. Its unlocked fast-path read has
        // already seen the (still committed) LEFT membership and passed.
        createP = createInvite(f);
        createP.catch(() => undefined);
        await waitForBlockedBackends(2, { queryLike: '%pg_advisory_xact_lock%' });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const [ban, create] = await Promise.all([banP!, createP!]);

    expect(ban.statusCode).toBe(200);
    expect(JSON.parse(ban.body).data.message).toBe('Member banned');
    // The create's AUTHORITATIVE read, taken under the lock, now sees BANNED.
    expect(create.statusCode).toBe(403);
    expect(JSON.parse(create.body).error.message).toBe('User is banned from this group');

    expect(await membershipStatus(f)).toBe('BANNED');
    expect(await counts(f)).toEqual({
      pendingInvites: 0,
      totalInvites: 0,
      invitationNotifications: 0,
      moderationNotifications: 1,
    });
  }, 60_000);

  it('CREATE wins: the ban then revokes the invite it just created; a replayed ban adds no second moderation notification', async () => {
    const f = await makeFixture('create-wins');
    let createP: ReturnType<typeof createInvite> | undefined;
    let banP: ReturnType<typeof banInvitee> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await lockInviteSubject(tx, f.groupId, f.invitee.email);
        createP = createInvite(f);
        createP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
        banP = banInvitee(f);
        banP.catch(() => undefined);
        await waitForBlockedBackends(2, { queryLike: '%pg_advisory_xact_lock%' });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const [create, ban] = await Promise.all([createP!, banP!]);

    expect(create.statusCode).toBe(200);
    expect(ban.statusCode).toBe(200);
    expect(JSON.parse(ban.body).data.message).toBe('Member banned');

    // The invite committed first, so the ban's revoke step SAW it and closed it.
    const invite = await prisma.groupInvite.findFirstOrThrow({
      where: { groupId: f.groupId, email: f.invitee.email.toLowerCase() },
    });
    expect(invite.status).toBe('REVOKED');
    expect(await membershipStatus(f)).toBe('BANNED');
    expect(await counts(f)).toMatchObject({ pendingInvites: 0, totalInvites: 1, invitationNotifications: 1, moderationNotifications: 1 });

    // Idempotent replay is preserved: no second transition, no second notice.
    const replay = await banInvitee(f);
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body).data.message).toBe('Member already banned');
    expect((await counts(f)).moderationNotifications).toBe(1);
  }, 60_000);

  it('a ban that lands where NO membership row existed at the fast-path read still wins', async () => {
    // The invitee has no membership row when the create's unlocked read runs,
    // so there is no row to lock. This is the case a row lock alone cannot
    // cover and the reason the subject lock is an advisory lock.
    const f = await makeFixture('no-row', { membership: null });
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await lockInviteSubject(tx, f.groupId, f.invitee.email);
        createP = createInvite(f); // fast path: no row -> passes
        createP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%pg_advisory_xact_lock%' });
        // A ban writer that follows the protocol (subject lock first — held
        // by this very transaction) commits a BANNED membership.
        await tx.groupMember.create({
          data: { groupId: f.groupId, userId: f.invitee.id, role: GroupMemberRole.MEMBER, status: GroupMemberStatus.BANNED },
        });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const create = await createP!;
    expect(create.statusCode).toBe(403);
    expect(JSON.parse(create.body).error.message).toBe('User is banned from this group');
    expect(await counts(f)).toMatchObject({ pendingInvites: 0, totalInvites: 0, invitationNotifications: 0 });
  }, 60_000);

  it('a create with no ban in play is unaffected', async () => {
    const f = await makeFixture('control');
    const create = await createInvite(f);
    expect(create.statusCode).toBe(200);
    expect(await counts(f)).toMatchObject({ pendingInvites: 1, totalInvites: 1, invitationNotifications: 1 });
  });
});

describeIf('accept vs ban — the lock cycle that used to deadlock', () => {
  it('accept holding the invite row while a ban arrives no longer deadlocks: they serialize, both succeed', async () => {
    // Before the shared lock order, ban locked the MEMBER row then wanted the
    // INVITE row, while accept had claimed the INVITE row and then wanted the
    // MEMBER row. Forced here by making the claim slow, so accept demonstrably
    // holds the invite row while the ban starts: PostgreSQL then aborted one
    // side with 40P01 — measured as a 500 for the manager while the target was
    // admitted anyway.
    const f = await makeFixture('cycle', { membership: GroupMemberStatus.LEFT });
    const inviteToken = `gilocktok-${uniqueSuffix()}${uniqueSuffix()}`;
    await prisma.groupInvite.create({
      data: {
        groupId: f.groupId,
        email: f.invitee.email.toLowerCase(),
        role: 'MEMBER',
        status: 'PENDING',
        token: inviteToken,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: f.owner.id,
      },
    });

    const acceptP = server.inject({
      method: 'POST',
      url: `${PREFIX}/accept-invite`,
      headers: { authorization: `Bearer ${signToken(f.invitee)}` },
      payload: { token: inviteToken },
      remoteAddress: nextIp(),
    });
    acceptP.catch(() => undefined);

    // Accept is now provably MID-TRANSACTION, asleep inside the claim UPDATE's
    // trigger while holding the invite row.
    await waitForWaitEvent('PgSleep', { queryLike: '%UPDATE "public"."group_invites"%' });

    const banP = banInvitee(f);
    const [accept, ban] = await Promise.all([acceptP, banP]);

    // Neither side may see a database error.
    expect(accept.statusCode).toBe(200);
    expect(ban.statusCode).toBe(200);
    // They serialized: accept admitted the member, then the ban banned them.
    expect(await membershipStatus(f)).toBe('BANNED');
  }, 60_000);
});
