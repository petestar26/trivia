import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { safeRecordActivity } from '../rewards/activity-service.js';
import type * as ActivityModule from '../rewards/activity-service.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';
import {
  cleanFixtures,
  createUser,
  ipAllocator,
  membershipSnapshot,
  uniqueSuffix,
  type FixtureUserOptions,
} from '../test/group-admission-fixtures.js';

// Every GROUP_JOIN activity goes through safeRecordActivity, so wrapping it
// (calling straight through) lets a test say "exactly zero group-join
// reward/activity side effects" without sleeping and hoping.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// JOIN APPROVAL versus the applicant's ACCOUNT status, and versus the GROUP's
// status.
//
// POST /groups/:id/requests/:userId/approve used to guard only the membership
// (PENDING -> ACTIVE). An applicant who was SUSPENDED, INACTIVE or platform-
// BANNED became an ACTIVE member all the same and was sent a GROUP_APPROVED
// notification; and a group archived after the manager's fast-path read still
// took the member. The fix is a locking protocol (see group-locks.ts): inside
// the SAME transaction as the activation, lock the applicant's users row and the
// group row, re-read both, and hold the locks through the transition, the
// notification and the commit.
//
// Every schedule is FORCED rather than raced: a test-held lock parks the request
// at a known point, and pg_stat_activity PROVES the request is blocked inside
// that statement before the other side is let through (see test/pg-locks.ts).
//
//   restriction / archive WINS  -> approval REJECTED; the request stays PENDING;
//       no notification, no activity.
//   approval WINS               -> the applicant was eligible at its
//       serialization point and IS admitted; the restriction (or archive) applies
//       afterwards and does not unwind the membership.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gja-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const emaillessUserIds: string[] = [];
const nextIp = ipAllocator(70);

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

beforeEach(() => {
  vi.mocked(safeRecordActivity).mockClear();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures(EMAIL_PREFIX, () => emaillessUserIds);
  if (server) await server.close();
  await prisma.$disconnect();
});

type User = Awaited<ReturnType<typeof createUser>>;

function signToken(user: User): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Fixture {
  owner: User;
  admin: User;
  applicant: User;
  groupId: string;
  memberId: string;
}

async function makeFixture(tag: string, applicant: FixtureUserOptions = {}): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const admin = await createUser(EMAIL_PREFIX, `${tag}-adm`);
  const app = await createUser(EMAIL_PREFIX, `${tag}-app`, applicant);
  if (app.email === null) emaillessUserIds.push(app.id);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `Appr-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: admin.id, role: 'ADMIN', status: 'ACTIVE' } });
  const member = await prisma.groupMember.create({
    data: { groupId: group.id, userId: app.id, role: 'MEMBER', status: 'PENDING' },
  });
  return { owner, admin, applicant: app, groupId: group.id, memberId: member.id };
}

function approve(f: Fixture, as: User = f.owner, target: User = f.applicant) {
  return server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/requests/${target.id}/approve`,
    headers: { authorization: `Bearer ${signToken(as)}` },
    remoteAddress: nextIp(),
  });
}

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;

const approvedNotifications = (f: Fixture) =>
  prisma.notification.count({ where: { userId: f.applicant.id, type: 'GROUP_APPROVED' } });
const anyNotificationsFor = (f: Fixture) => prisma.notification.count({ where: { userId: f.applicant.id } });
const streakRows = (f: Fixture) => prisma.dailyStreak.count({ where: { userId: f.applicant.id } });
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** The request left NOTHING behind: same row (xmin included), no notification, no activity. */
async function expectNothingHappened(f: Fixture, before: Awaited<ReturnType<typeof membershipSnapshot>>) {
  expect(await membershipSnapshot(f.groupId, f.applicant.id)).toEqual(before);
  expect(before?.status).toBe('PENDING');
  expect(await approvedNotifications(f)).toBe(0);
  expect(await anyNotificationsFor(f)).toBe(0);
  expect(safeRecordActivity).not.toHaveBeenCalled();
  await settle(); // any fire-and-forget activity would have landed by now
  expect(await streakRows(f)).toBe(0);
}

const LOCK_USERS = '%FROM "users"%FOR SHARE%';
const LOCK_GROUP = '%FROM "groups"%FOR SHARE%';

const RESTRICTED = ['SUSPENDED', 'INACTIVE', 'BANNED', 'PENDING_VERIFICATION'] as const;
const NOT_ELIGIBLE = 'This applicant is not eligible to be admitted';

describeIf('join approval vs the applicant\'s account status', () => {
  for (const status of RESTRICTED) {
    describe(`applicant is ${status}`, () => {
      it('restricted BEFORE approval: rejected, the request stays PENDING, no notification, no activity', async () => {
        const f = await makeFixture(`pre-${status}`);
        await prisma.user.update({ where: { id: f.applicant.id }, data: { status } });
        const before = await membershipSnapshot(f.groupId, f.applicant.id);

        const resp = await approve(f);

        expect(resp.statusCode).toBe(403);
        // One generic answer for every restricted status: a manager learns nothing
        // about the applicant's platform standing.
        expect(errorMessage(resp)).toBe(NOT_ELIGIBLE);
        expect(resp.body).not.toContain(status);
        await expectNothingHappened(f, before);
      });

      it('restriction WINS serialization after the fast path passed: rejected under the lock, zero side effects', async () => {
        const f = await makeFixture(`win-${status}`);
        const before = await membershipSnapshot(f.groupId, f.applicant.id);
        let pending: ReturnType<typeof approve> | undefined;

        await prisma.$transaction(
          async (tx) => {
            // An uncommitted status change holds the users row lock. The approval's
            // unlocked fast-path reads still see the committed ACTIVE account and
            // pass...
            await tx.user.update({ where: { id: f.applicant.id }, data: { status } });
            pending = approve(f);
            pending.catch(() => undefined);
            // ...and then it parks inside the authoritative FOR SHARE lock. Proving
            // that is the point: without it this could be a slow request that has
            // not looked at the account yet.
            await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
          },
          { timeout: 30_000, maxWait: 30_000 }
        );

        const resp = await pending!;

        expect(resp.statusCode).toBe(403);
        expect(errorMessage(resp)).toBe(NOT_ELIGIBLE);
        await expectNothingHappened(f, before);
      }, 60_000);

      it('approval WINS serialization: the applicant is admitted, and the restriction applies afterwards', async () => {
        const f = await makeFixture(`acc-${status}`);
        let approveP: ReturnType<typeof approve> | undefined;
        let writerP: Promise<unknown> | undefined;

        await prisma.$transaction(
          async (tx) => {
            // Park the approval at its membership write: the member row is held, so
            // the approval has already locked the applicant's users row and the
            // group row by the time it waits here.
            await tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${f.memberId} FOR UPDATE`;
            approveP = approve(f);
            approveP.catch(() => undefined);
            await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."group_members"%' });

            // Now a status writer arrives. It must WAIT for the approval — which
            // proves the account lock is held all the way through the transition,
            // not released after the check.
            writerP = prisma.user.update({ where: { id: f.applicant.id }, data: { status } });
            writerP.catch(() => undefined);
            await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."users"%' });
          },
          { timeout: 30_000, maxWait: 30_000 }
        );

        const resp = await approveP!;
        await writerP;

        expect(resp.statusCode).toBe(200);
        expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
        expect(await approvedNotifications(f)).toBe(1);
        // The restriction landed afterwards and does not unwind the membership.
        expect((await prisma.user.findUniqueOrThrow({ where: { id: f.applicant.id } })).status).toBe(status);
      }, 60_000);
    });
  }

  it('an ACTIVE applicant is approved: membership ACTIVE, one notification, the GROUP_JOIN activity recorded', async () => {
    const f = await makeFixture('control');

    const resp = await approve(f);

    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).data.message).toBe('Request approved');
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
    expect(await approvedNotifications(f)).toBe(1);
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
    expect(safeRecordActivity).toHaveBeenCalledWith(f.applicant.id, { type: 'GROUP_JOIN' });
    // The activity probe is live: the success case DOES write the streak row the
    // rejection cases assert is absent.
    await vi.waitFor(async () => expect(await streakRows(f)).toBe(1), { timeout: 8_000, interval: 50 });
  });

  it('no invitation-specific binding: an unverified, email-less ACTIVE account is approved just the same', async () => {
    const f = await makeFixture('no-email', { email: null, isVerified: false });

    const resp = await approve(f);

    expect(resp.statusCode).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
    expect(await approvedNotifications(f)).toBe(1);
  });

  it('an account restricted for a while and then reinstated can still be approved: the request stayed PENDING', async () => {
    const f = await makeFixture('reinstated');
    await prisma.user.update({ where: { id: f.applicant.id }, data: { status: 'SUSPENDED' } });
    expect((await approve(f)).statusCode).toBe(403);

    await prisma.user.update({ where: { id: f.applicant.id }, data: { status: 'ACTIVE' } });
    const resp = await approve(f);

    expect(resp.statusCode).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
  });

  it('a request that cannot be approved can still be REJECTED by the manager', async () => {
    const f = await makeFixture('reject-after');
    await prisma.user.update({ where: { id: f.applicant.id }, data: { status: 'SUSPENDED' } });
    expect((await approve(f)).statusCode).toBe(403);

    const resp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${f.groupId}/requests/${f.applicant.id}/reject`,
      headers: { authorization: `Bearer ${signToken(f.owner)}` },
      remoteAddress: nextIp(),
    });

    expect(resp.statusCode).toBe(200);
    expect(await membershipSnapshot(f.groupId, f.applicant.id)).toBeNull();
  });

  it('the applicant is DELETED after the manager\'s fast-path read: rejected under the lock, nothing admitted or announced', async () => {
    const f = await makeFixture('deleted');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${f.applicant.id} FOR UPDATE`;
        pending = approve(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
        // The account (and, by cascade, its membership) is gone when the lock is granted.
        await tx.user.delete({ where: { id: f.applicant.id } });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await pending!;

    expect(resp.statusCode).toBe(404);
    expect(errorMessage(resp)).toBe('Join request not found');
    expect(await prisma.user.findUnique({ where: { id: f.applicant.id } })).toBeNull();
    expect(await membershipSnapshot(f.groupId, f.applicant.id)).toBeNull();
    expect(await approvedNotifications(f)).toBe(0);
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);
});

describeIf('join approval keeps its duplicate/replay and manager-authorization behavior', () => {
  it('a replayed approval is refused as "not pending", with one notification and one activity in total', async () => {
    const f = await makeFixture('replay');

    expect((await approve(f)).statusCode).toBe(200);
    const again = await approve(f);

    expect(again.statusCode).toBe(400);
    expect(errorMessage(again)).toBe('This request is not pending');
    expect(await approvedNotifications(f)).toBe(1);
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  });

  it('two managers approving at once: exactly one wins, the other is told "not pending"', async () => {
    const f = await makeFixture('two-managers');

    const [a, b] = await Promise.all([approve(f, f.owner), approve(f, f.admin)]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    const loser = a.statusCode === 400 ? a : b;
    expect(errorMessage(loser)).toBe('This request is not pending');
    expect(await approvedNotifications(f)).toBe(1);
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
  });

  it('a plain member cannot approve, and neither can an anonymous caller', async () => {
    const f = await makeFixture('authz');
    const member = await createUser(EMAIL_PREFIX, 'authz-mem');
    await prisma.groupMember.create({ data: { groupId: f.groupId, userId: member.id, role: 'MEMBER', status: 'ACTIVE' } });
    const before = await membershipSnapshot(f.groupId, f.applicant.id);

    const asMember = await approve(f, member);
    const anonymous = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${f.groupId}/requests/${f.applicant.id}/approve`,
      remoteAddress: nextIp(),
    });

    expect(asMember.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
    await expectNothingHappened(f, before);
  });

  it('a membership that is not PENDING is refused with the same answer as before', async () => {
    const f = await makeFixture('not-pending');
    await prisma.groupMember.update({ where: { id: f.memberId }, data: { status: 'ACTIVE' } });

    const resp = await approve(f);

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('This request is not pending');
    expect(safeRecordActivity).not.toHaveBeenCalled();
  });

  it('a user with no request at all is "Join request not found"', async () => {
    const f = await makeFixture('no-request');
    const stranger = await createUser(EMAIL_PREFIX, 'no-request-str');

    const resp = await approve(f, f.owner, stranger);

    expect(resp.statusCode).toBe(404);
    expect(errorMessage(resp)).toBe('Join request not found');
  });
});

describeIf('join approval vs the GROUP\'s status — the same authoritative check as invitation acceptance', () => {
  for (const status of ['ARCHIVED', 'INACTIVE', 'BANNED'] as const) {
    it(`the group becomes ${status} while approval waits on the group row: rejected, the request stays PENDING, nothing announced`, async () => {
      const f = await makeFixture(`grp-${status}`);
      const before = await membershipSnapshot(f.groupId, f.applicant.id);
      let pending: ReturnType<typeof approve> | undefined;

      await prisma.$transaction(
        async (tx) => {
          // (1) hold the group row FOR UPDATE.
          await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
          // (2) start the approval: its unlocked fast-path read still sees ACTIVE
          //     and passes, and it parks on the group row — which is proven, not assumed.
          pending = approve(f);
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
          // (3) the external writer's status change commits first.
          await tx.group.update({ where: { id: f.groupId }, data: { status } });
        },
        { timeout: 30_000, maxWait: 30_000 }
      );

      // (4) the approval re-reads the row under the lock and is rejected.
      const resp = await pending!;

      expect(resp.statusCode).toBe(400);
      expect(errorMessage(resp)).toBe('Group is not active');
      await expectNothingHappened(f, before);
      expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).status).toBe(status);
    }, 60_000);
  }

  it('waiting for the group row is not itself a failure: a lock-only holder that changes nothing lets the approval through', async () => {
    const f = await makeFixture('grp-lock-only');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
        pending = approve(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    expect((await pending!).statusCode).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
  }, 60_000);

  it('the group is DELETED after the fast-path read: rejected, nothing announced', async () => {
    const f = await makeFixture('grp-deleted');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
        pending = approve(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        await tx.group.delete({ where: { id: f.groupId } });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is not active');
    expect(await approvedNotifications(f)).toBe(0);
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('the APPLICANT\'s account row is locked first: an approval parked on it holds no group lock (an external archive is not made to wait)', async () => {
    const f = await makeFixture('grp-order-users');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({ where: { id: f.applicant.id }, data: { status: 'ACTIVE' } });
        pending = approve(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
        // Nothing else is held yet, so this goes straight through. (Were the group
        // locked BEFORE the account it would hang here until the test timed out.)
        await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await pending!;
    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is not active');
  }, 60_000);

  it('a lock-only SHARE holder on the group row does NOT block approval: admissions to one group run in parallel', async () => {
    const f = await makeFixture('grp-share-compat');

    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR SHARE`;
        const resp = await approve(f);
        expect(resp.statusCode, resp.body).toBe(200);
      },
      { timeout: 30_000, maxWait: 30_000 }
    );
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
  }, 60_000);

  it('REVERSE order — approval takes the group row first: an external archive WAITS for it, and each side has a coherent result', async () => {
    const f = await makeFixture('grp-reverse');
    let approveP: ReturnType<typeof approve> | undefined;
    let archiveP: Promise<unknown> | undefined;

    await prisma.$transaction(
      async (tx) => {
        // Park the approval at its membership write: it already holds the account
        // and group locks by then.
        await tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${f.memberId} FOR UPDATE`;
        approveP = approve(f);
        approveP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."group_members"%' });

        // The external status writer arrives NOW, and must wait behind the
        // approval's group lock (it is held through the transition, not dropped
        // after the check).
        archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
        archiveP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%UPDATE "public"."groups"%' });
      },
      { timeout: 30_000, maxWait: 30_000 }
    );

    const resp = await approveP!;
    await archiveP; // would reject with 40P01 if the orders were inconsistent

    // Serial order: approval, then archive.
    expect(resp.statusCode).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
    expect(await approvedNotifications(f)).toBe(1);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).status).toBe('ARCHIVED');
  }, 60_000);
});
