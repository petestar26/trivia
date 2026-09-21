import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { lockInviteSubject } from './group-locks.js';
import { safeRecordActivity } from '../rewards/activity-service.js';
import type * as ActivityModule from '../rewards/activity-service.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';
import {
  cleanFixtures,
  createUser,
  inviteSnapshot,
  ipAllocator,
  membershipSnapshot,
  uniqueSuffix,
} from '../test/group-admission-fixtures.js';

// Every GROUP_JOIN activity goes through safeRecordActivity, so wrapping it
// (calling straight through) lets a test say "exactly zero group-join
// reward/activity side effects" without sleeping and hoping.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// INVITATION ACCEPTANCE versus the GROUP's status.
//
// Acceptance used to read the group's status with a plain query, inside its
// transaction but under no lock, and then waited on the invite row. While it
// waited, an external writer could commit ARCHIVED; acceptance still returned
// 200 with an ACTIVE membership and an ACCEPTED invite, in a group that no
// longer admits anybody. A second unlocked read would not help: only a lock
// that is HELD from the check until commit orders the two.
//
// The fix (see group-locks.ts, level 2): lock the group row FOR SHARE, read the
// status AFTER the lock is granted, and keep the lock through the invite claim,
// the membership transition, the notification and the commit.
//
// Every schedule is FORCED rather than raced. A test-held lock parks the request
// at a known point, and pg_stat_activity PROVES the request is blocked inside
// that statement before the other side is let through (see test/pg-locks.ts).
//
//   status change WINS  -> acceptance REJECTED: the invite stays PENDING, the
//       membership is unchanged (or never created), no notification, no activity.
//   acceptance WINS     -> admitted into a group that WAS active at its
//       serialization point; the archive applies afterwards and does not unwind it.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gis-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(71);

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

beforeEach(() => {
  vi.mocked(safeRecordActivity).mockClear();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures(EMAIL_PREFIX);
  if (server) await server.close();
  await prisma.$disconnect();
});

type User = Awaited<ReturnType<typeof createUser>>;

function signToken(user: User): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

type Existing = 'LEFT' | 'PENDING';

interface Fixture {
  owner: User;
  invitee: User;
  groupId: string;
  groupName: string;
  inviteId: string;
  inviteToken: string;
  memberId: string | null;
}

async function makeFixture(tag: string, existing?: Existing): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const invitee = await createUser(EMAIL_PREFIX, `${tag}-inv`);
  const groupName = `Status-${tag}-${uniqueSuffix().slice(0, 6)}`;
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: groupName, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  let memberId: string | null = null;
  if (existing) {
    const m = await prisma.groupMember.create({
      data: { groupId: group.id, userId: invitee.id, role: 'MEMBER', status: existing },
    });
    memberId = m.id;
  }
  const inviteToken = `gistok-${uniqueSuffix()}${uniqueSuffix()}`;
  const invite = await prisma.groupInvite.create({
    data: {
      groupId: group.id,
      email: invitee.email!.toLowerCase(),
      role: 'MEMBER',
      status: 'PENDING',
      token: inviteToken,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedBy: owner.id,
    },
  });
  return { owner, invitee, groupId: group.id, groupName, inviteId: invite.id, inviteToken, memberId };
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

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;
const acceptanceNotifications = (f: Fixture) =>
  prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_INVITE_ACCEPTED' } });
const streakRows = (f: Fixture) => prisma.dailyStreak.count({ where: { userId: f.invitee.id } });
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** Acceptance left NOTHING behind: invite and membership exactly as they were (xmin included). */
async function expectNothingHappened(
  f: Fixture,
  before: { invite: Awaited<ReturnType<typeof inviteSnapshot>>; member: Awaited<ReturnType<typeof membershipSnapshot>> }
) {
  const invite = await inviteSnapshot(f.inviteId);
  expect(invite?.status).toBe('PENDING');
  expect(invite?.acceptedBy).toBeNull();
  expect(invite).toEqual(before.invite);
  expect(await membershipSnapshot(f.groupId, f.invitee.id)).toEqual(before.member);
  expect(await acceptanceNotifications(f)).toBe(0);
  expect(safeRecordActivity).not.toHaveBeenCalled();
  await settle(); // any fire-and-forget activity would have landed by now
  expect(await streakRows(f)).toBe(0);
}

const snapshotBefore = async (f: Fixture) => ({
  invite: await inviteSnapshot(f.inviteId),
  member: await membershipSnapshot(f.groupId, f.invitee.id),
});

/** The acceptance was ADMITTED: 200, ACCEPTED, ACTIVE, one notification, the activity recorded. */
async function expectAdmitted(f: Fixture, resp: { statusCode: number; body: string }) {
  expect(resp.statusCode, resp.body).toBe(200);
  expect((await inviteSnapshot(f.inviteId))?.status).toBe('ACCEPTED');
  expect((await inviteSnapshot(f.inviteId))?.acceptedBy).toBe(f.invitee.id);
  expect((await membershipSnapshot(f.groupId, f.invitee.id))?.status).toBe('ACTIVE');
  expect(await acceptanceNotifications(f)).toBe(1);
  expect(safeRecordActivity).toHaveBeenCalledWith(f.invitee.id, { type: 'GROUP_JOIN' });
}

const LOCK_GROUP = '%FROM "groups"%FOR SHARE%';
const GROUP_NOT_ACTIVE = 'Group is not active';

describeIf('invitation acceptance vs the group\'s status — status change commits FIRST', () => {
  const combos: Array<{ status: 'ARCHIVED' | 'INACTIVE' | 'BANNED'; existing?: Existing }> = [
    { status: 'ARCHIVED' },
    { status: 'INACTIVE' },
    { status: 'BANNED' },
    { status: 'ARCHIVED', existing: 'LEFT' },
    { status: 'ARCHIVED', existing: 'PENDING' },
  ];
  for (const { status, existing } of combos) {
    it(`group becomes ${status} while acceptance waits on the group row (existing membership: ${existing ?? 'none'}): rejected, invite stays PENDING, nothing written or announced`, async () => {
      const f = await makeFixture(`c-${status}-${existing ?? 'none'}`, existing);
      const before = await snapshotBefore(f);
      let pending: ReturnType<typeof accept> | undefined;

      await prisma.$transaction(
        async (tx) => {
          // (1) hold the group row FOR UPDATE.
          await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
          // (2) start the acceptance. Its fast-path reads (invite, account) pass, its
          //     transaction takes the account lock, and it PARKS on the group row —
          //     proven by pg_stat_activity, not assumed.
          pending = accept(f);
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
          // (3) the external writer changes the status and commits.
          await tx.group.update({ where: { id: f.groupId }, data: { status } });
        },
        { timeout: 30_000, maxWait: 30_000 }
      );

      // (4) acceptance re-reads the row under the lock and is rejected.
      const resp = await pending!;

      expect(resp.statusCode).toBe(400);
      expect(errorMessage(resp)).toBe(GROUP_NOT_ACTIVE);
      await expectNothingHappened(f, before);
      expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).status).toBe(status);
    }, 60_000);
  }

  it('waiting for the group row is not itself a failure: a lock-only holder that changes nothing lets acceptance through', async () => {
    const f = await makeFixture('lock-only');
    let pending: ReturnType<typeof accept> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
        pending = accept(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    await expectAdmitted(f, await pending!);
  }, 60_000);

  it('the notification names the group as the LOCKED row read it', async () => {
    const f = await makeFixture('locked-name');
    const resp = await accept(f);
    expect(resp.statusCode).toBe(200);
    const notice = await prisma.notification.findFirstOrThrow({ where: { userId: f.owner.id, type: 'GROUP_INVITE_ACCEPTED' } });
    expect(notice.body).toContain(`"${f.groupName}"`);
  });

  it('the group is DELETED (invites and members cascade) after the fast path: rejected, nothing announced', async () => {
    const f = await makeFixture('deleted');
    let pending: ReturnType<typeof accept> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
        pending = accept(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        await tx.group.delete({ where: { id: f.groupId } });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe(GROUP_NOT_ACTIVE);
    expect(await acceptanceNotifications(f)).toBe(0);
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('a status change committed BEFORE acceptance even starts is refused too, exactly as before', async () => {
    const f = await makeFixture('pre-archived');
    const before = await snapshotBefore(f);
    await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });

    const resp = await accept(f);

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe(GROUP_NOT_ACTIVE);
    await expectNothingHappened(f, before);
  });

  it('an ACTIVE group still admits (the fix does not over-reject)', async () => {
    const f = await makeFixture('control');
    const resp = await accept(f);
    await expectAdmitted(f, resp);
  });
});

describeIf('invitation acceptance — the group row lock is SHARED and comes AFTER the account row (lock order)', () => {
  it('a lock-only SHARE holder on the group row does NOT block acceptance: admissions to one group run in parallel', async () => {
    const f = await makeFixture('share-compat');

    await prisma.$transaction(
      async (tx) => {
        // Another admission (or anything that merely reads the group's status
        // under a lock) holds the group row FOR SHARE for as long as it likes.
        await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR SHARE`;
        // The acceptance runs to completion WHILE it is held.
        const resp = await accept(f);
        await expectAdmitted(f, resp);
      },
      { timeout: 30_000, maxWait: 30_000 }
    );
  }, 60_000);

  it('the ACCOUNT row is locked first: an acceptance parked on it holds no group lock (an external archive is not made to wait)', async () => {
    const f = await makeFixture('order-users');
    let pending: ReturnType<typeof accept> | undefined;

    await prisma.$transaction(
      async (tx) => {
        // Park the acceptance on the account row: an uncommitted status write.
        await tx.user.update({ where: { id: f.invitee.id }, data: { status: 'ACTIVE' } });
        pending = accept(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%FROM "users"%FOR SHARE%' });

        // It has taken nothing else yet, so an archive goes straight through.
        // (Were the group locked BEFORE the account, this would hang and time out.)
        await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await pending!;
    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe(GROUP_NOT_ACTIVE);
  }, 60_000);
});

describeIf('invitation acceptance vs the group\'s status — acceptance takes the group row FIRST (reverse serial order)', () => {
  // Park the acceptance at a chosen step of its transaction with a test-held
  // lock, let an external ARCHIVE arrive and prove it is WAITING, then release.
  // The archive must wait at every step from the check to the commit: that is
  // what "hold the lock through the invite claim, membership transition,
  // notification and commit" means, and a second unlocked read could not give it.
  interface ParkPoint {
    name: string;
    existing?: Existing;
    /** Hold whatever parks the acceptance at this step, inside the test's transaction. */
    hold: (tx: Prisma.TransactionClient, f: Fixture) => Promise<void>;
    /** The statement the acceptance is blocked in. */
    blockedIn: string;
  }
  const points: ParkPoint[] = [
    {
      name: 'the (group, email) subject lock',
      hold: async (tx, f) => lockInviteSubject(tx, f.groupId, f.invitee.email!),
      blockedIn: '%pg_advisory_xact_lock%',
    },
    {
      name: 'the invite row lock (before the clock is read)',
      hold: async (tx, f) => {
        await tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${f.inviteId} FOR UPDATE`;
      },
      blockedIn: '%"group_invites"%',
    },
    {
      name: 'the membership write',
      existing: 'LEFT',
      hold: async (tx, f) => {
        await tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${f.memberId} FOR UPDATE`;
      },
      blockedIn: '%UPDATE "public"."group_members"%',
    },
    {
      name: 'the notification insert (after the claim and the membership write)',
      hold: async (tx, f) => {
        // The notification's foreign key needs FOR KEY SHARE on the OWNER's users
        // row (the inviter); a FOR UPDATE held here refuses it.
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${f.owner.id} FOR UPDATE`;
      },
      blockedIn: '%INSERT INTO "public"."notifications"%',
    },
  ];

  for (const point of points) {
    it(`parked at ${point.name}: an external ARCHIVE waits for the acceptance; acceptance is admitted, the archive applies after`, async () => {
      const f = await makeFixture(`rev-${point.name.slice(0, 12).replace(/\W+/g, '')}`, point.existing);
      let acceptP: ReturnType<typeof accept> | undefined;
      let archiveP: Promise<unknown> | undefined;

      await prisma.$transaction(
        async (tx) => {
          await point.hold(tx, f);
          acceptP = accept(f);
          acceptP.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: point.blockedIn });

          // The external status writer arrives while the acceptance holds its group
          // lock. It must WAIT — observed, not assumed.
          archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
          archiveP.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."groups"%' });
        },
        { timeout: 30_000, maxWait: 30_000 }
      );

      const resp = await acceptP!;
      await archiveP; // would reject with 40P01 if the lock orders were inconsistent

      // Serial order: acceptance, then archive. Each has a coherent result.
      await expectAdmitted(f, resp);
      expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).status).toBe('ARCHIVED');
    }, 60_000);
  }

  it('once the archive has committed, the NEXT acceptance is refused (the two orders are the only two outcomes)', async () => {
    const first = await makeFixture('two-orders');
    await expectAdmitted(first, await accept(first));
    await prisma.group.update({ where: { id: first.groupId }, data: { status: 'ARCHIVED' } });

    const lateUser = await createUser(EMAIL_PREFIX, 'two-orders-late');
    const late = await prisma.groupInvite.create({
      data: {
        groupId: first.groupId,
        email: lateUser.email!.toLowerCase(),
        role: 'MEMBER',
        status: 'PENDING',
        token: `gistok-late-${uniqueSuffix()}${uniqueSuffix()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: first.owner.id,
      },
    });
    const resp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/accept-invite`,
      headers: { authorization: `Bearer ${signToken(lateUser)}` },
      payload: { token: late.token },
      remoteAddress: nextIp(),
    });

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe(GROUP_NOT_ACTIVE);
    expect(await membershipSnapshot(first.groupId, lateUser.id)).toBeNull();
  });
});
