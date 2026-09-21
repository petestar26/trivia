import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { safeRecordActivity } from '../rewards/activity-service.js';
import type * as ActivityModule from '../rewards/activity-service.js';
import { waitForBlockedBackends, waitForWaitEvent } from '../test/pg-locks.js';
import {
  cleanFixtures,
  createUser,
  groupSnapshot,
  installSlowMemberInsertTrigger,
  ipAllocator,
  membershipSnapshot,
  removeSlowMemberInsertTrigger,
  uniqueSuffix,
} from '../test/group-admission-fixtures.js';

// Wrapping the activity intake (calling straight through) lets a test say
// "no activity/reward call ran" without sleeping and hoping. A join REQUEST
// records no activity at all — not on success, and certainly not on rejection.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// REQUEST TO JOIN — POST /groups/:id/request — versus the caller's ACCOUNT, the
// GROUP, and a concurrent BAN.
//
// Hardened approval already stops a restricted account from being ADMITTED, but
// the request route judged the account and the group before its transaction
// only: a SUSPENDED account could still create a PENDING request and notify
// every manager, and an archive or a switch to public committed after the
// route's read was ignored (the notification even named the group from that
// stale read).
//
// The fix (see group-locks.ts): inside the request's transaction lock the
// caller's users row and the group row, re-read both, and hold them through the
// membership write, the manager notifications and the commit. A rejected
// request creates or changes NOTHING.
//
// Every schedule is FORCED, never raced: a test-held lock, or a scoped pause
// inside one statement, parks the request, and pg_stat_activity PROVES it is
// parked before the competing writer is let through (see test/pg-locks.ts).
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gjr-';
const SLOW_EMAIL_PREFIX = `${EMAIL_PREFIX}slow-`;
const SLOW_TRIGGER = 'gjr_slow_member_insert';
const SLOW_MS = 2500;

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(74);

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
  await installSlowMemberInsertTrigger(SLOW_TRIGGER, SLOW_EMAIL_PREFIX, SLOW_MS);
});

beforeEach(() => {
  vi.mocked(safeRecordActivity).mockClear();
});

afterAll(async () => {
  if (dbAvailable) {
    await removeSlowMemberInsertTrigger(SLOW_TRIGGER);
    await cleanFixtures(EMAIL_PREFIX);
  }
  if (server) await server.close();
  await prisma.$disconnect();
});

type User = Awaited<ReturnType<typeof createUser>>;
type Held = Prisma.TransactionClient;

function signToken(user: User): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Existing {
  status: 'LEFT' | 'ACTIVE' | 'PENDING' | 'BANNED' | 'MUTED';
  role?: 'MEMBER' | 'MODERATOR' | 'ADMIN' | 'OWNER';
}

interface Fixture {
  owner: User;
  admin: User;
  moderator: User;
  requester: User;
  groupId: string;
  groupName: string;
  memberId: string | null;
}

interface FixtureOptions {
  existing?: Existing;
  requesterStatus?: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'BANNED' | 'PENDING_VERIFICATION';
  /** The requester's INSERT of a new membership pauses inside the statement (see the trigger). */
  slow?: boolean;
  isPrivate?: boolean;
}

async function makeFixture(tag: string, opts: FixtureOptions = {}): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const admin = await createUser(EMAIL_PREFIX, `${tag}-adm`);
  const moderator = await createUser(EMAIL_PREFIX, `${tag}-mod`);
  const requester = await createUser(EMAIL_PREFIX, opts.slow ? `slow-${tag}` : `${tag}-req`, { status: opts.requesterStatus });
  const groupName = `ReqJoin-${tag}-${uniqueSuffix().slice(0, 6)}`;
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: groupName, isPrivate: opts.isPrivate ?? true, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: admin.id, role: 'ADMIN', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: moderator.id, role: 'MODERATOR', status: 'ACTIVE' } });
  let memberId: string | null = null;
  if (opts.existing) {
    const m = await prisma.groupMember.create({
      data: { groupId: group.id, userId: requester.id, role: opts.existing.role ?? 'MEMBER', status: opts.existing.status },
    });
    memberId = m.id;
  }
  return { owner, admin, moderator, requester, groupId: group.id, groupName, memberId };
}

const requestJoin = (f: Fixture, as: User = f.requester) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/request`,
    headers: { authorization: `Bearer ${signToken(as)}` },
    remoteAddress: nextIp(),
  });

const ban = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/members/${f.requester.id}/ban`,
    headers: { authorization: `Bearer ${signToken(f.owner)}` },
    remoteAddress: nextIp(),
  });

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const holdMember = (tx: Held, id: string) => tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${id} FOR UPDATE`;
const holdGroup = (tx: Held, id: string) => tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${id} FOR UPDATE`;

const LOCK_USERS = '%FROM "users"%FOR SHARE%';
const LOCK_GROUP = '%FROM "groups"%FOR SHARE%';
const MEMBER_UPDATE = '%UPDATE "public"."group_members"%';
const MEMBER_INSERT = '%INSERT INTO "public"."group_members"%';
const USER_WRITE = '%UPDATE "public"."users"%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';

const NOT_ELIGIBLE = 'Your account is not eligible to join groups';
const RESTRICTED = ['SUSPENDED', 'INACTIVE', 'BANNED', 'PENDING_VERIFICATION'] as const;

// Everything a rejected request must NOT have produced.
const managerNotices = (f: Fixture) =>
  prisma.notification.count({ where: { userId: { in: [f.owner.id, f.admin.id, f.moderator.id] }, type: 'GROUP_JOIN_REQUEST' } });
async function requesterState(f: Fixture) {
  const where = { userId: f.requester.id };
  return {
    streaks: await prisma.dailyStreak.count({ where }),
    tasks: await prisma.userTask.count({ where }),
    achievements: await prisma.userAchievement.count({ where }),
    xpEvents: await prisma.userXpEvent.count({ where }),
    rewardClaims: await prisma.rewardClaim.count({ where }),
    progress: await prisma.userProgress.count({ where }),
    notifications: await prisma.notification.count({ where }),
  };
}
const NO_STATE = { streaks: 0, tasks: 0, achievements: 0, xpEvents: 0, rewardClaims: 0, progress: 0, notifications: 0 };

/** The request left NOTHING behind: same membership row (xmin included) or none, no manager notification, no activity/reward/achievement. */
async function expectNothingHappened(f: Fixture, before: Awaited<ReturnType<typeof membershipSnapshot>>) {
  expect(await membershipSnapshot(f.groupId, f.requester.id)).toEqual(before);
  expect(await managerNotices(f)).toBe(0);
  expect(safeRecordActivity).not.toHaveBeenCalled();
  await settle(); // anything fire-and-forget would have landed by now
  expect(await requesterState(f)).toEqual(NO_STATE);
}

/** The request was ACCEPTED: 200, one PENDING row, one notification for each manager (OWNER and ADMIN, not the MODERATOR), no activity. */
async function expectRequested(f: Fixture, resp: { statusCode: number; body: string }) {
  expect(resp.statusCode, resp.body).toBe(200);
  expect(JSON.parse(resp.body).data.message).toBe('Join request submitted');
  const row = await membershipSnapshot(f.groupId, f.requester.id);
  expect(row?.status).toBe('PENDING');
  expect(row?.role).toBe('MEMBER');
  expect(await prisma.groupMember.count({ where: { groupId: f.groupId, userId: f.requester.id } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: f.admin.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(1);
  expect(await prisma.notification.count({ where: { userId: f.moderator.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(0);
  expect(safeRecordActivity).not.toHaveBeenCalled();
}

// ─── the caller's ACCOUNT ─────────────────────────────────────────────────────

describeIf('join request vs the caller\'s account status', () => {
  for (const status of RESTRICTED) {
    for (const existing of [undefined, 'LEFT'] as const) {
      it(`restricted BEFORE the request (${status}, existing membership: ${existing ?? 'none'}): refused, no PENDING row, no manager notification, no activity`, async () => {
        const f = await makeFixture(`pre-${status}-${existing ?? 'none'}`, {
          requesterStatus: status,
          existing: existing ? { status: existing } : undefined,
        });
        const before = await membershipSnapshot(f.groupId, f.requester.id);

        const resp = await requestJoin(f);

        expect(resp.statusCode).toBe(403);
        expect(errorMessage(resp)).toBe(NOT_ELIGIBLE);
        expect(resp.body).not.toContain(status);
        await expectNothingHappened(f, before);
      });
    }
  }

  for (const [status, existing] of [
    ['SUSPENDED', undefined],
    ['INACTIVE', undefined],
    ['BANNED', undefined],
    ['PENDING_VERIFICATION', undefined],
    ['SUSPENDED', 'LEFT'],
  ] as const) {
    it(`restriction WINS while the request waits on the account row (${status}, existing membership: ${existing ?? 'none'}): refused under the lock, nothing created`, async () => {
      const f = await makeFixture(`win-${status}-${existing ?? 'none'}`, { existing: existing ? { status: existing } : undefined });
      const before = await membershipSnapshot(f.groupId, f.requester.id);
      let pending: ReturnType<typeof requestJoin> | undefined;

      await prisma.$transaction(async (tx) => {
        // An uncommitted status change holds the users row; the request's UNLOCKED
        // fast-path reads see the committed ACTIVE account and pass...
        await tx.user.update({ where: { id: f.requester.id }, data: { status } });
        pending = requestJoin(f);
        pending.catch(() => undefined);
        // ...and it parks inside the authoritative FOR SHARE lock.
        await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode).toBe(403);
      expect(errorMessage(resp)).toBe(NOT_ELIGIBLE);
      await expectNothingHappened(f, before);
    }, 60_000);
  }

  it('request WINS (new membership, parked inside its INSERT): the account writer WAITS, both complete, the restriction applies afterwards', async () => {
    const f = await makeFixture('rw-create', { slow: true });
    const reqP = requestJoin(f);
    reqP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: MEMBER_INSERT });

    const writerP = prisma.user.update({ where: { id: f.requester.id }, data: { status: 'SUSPENDED' } });
    writerP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: USER_WRITE });

    const resp = await reqP;
    await writerP; // would reject with 40P01 if the lock orders were inconsistent

    await expectRequested(f, resp);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.requester.id } })).status).toBe('SUSPENDED');
  }, 60_000);

  it('request WINS (LEFT -> PENDING, parked at the membership write): the account writer WAITS, both complete, the restriction applies afterwards', async () => {
    const f = await makeFixture('rw-left', { existing: { status: 'LEFT' } });
    let reqP: ReturnType<typeof requestJoin> | undefined;
    let writerP: Promise<unknown> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      reqP = requestJoin(f);
      reqP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

      writerP = prisma.user.update({ where: { id: f.requester.id }, data: { status: 'INACTIVE' } });
      writerP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: USER_WRITE });
    }, tx30);

    const resp = await reqP!;
    await writerP;

    await expectRequested(f, resp);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.requester.id } })).status).toBe('INACTIVE');
  }, 60_000);

  it('the ACCOUNT row is locked first: a request parked on it holds no group lock (an external archive is not made to wait)', async () => {
    const f = await makeFixture('order-users');
    let pending: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: f.requester.id }, data: { status: 'ACTIVE' } });
      pending = requestJoin(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
      // Nothing else is held yet, so this goes straight through. (Were the group
      // locked BEFORE the account it would hang here until the test timed out.)
      await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    }, tx30);

    const resp = await pending!;
    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is not active');
  }, 60_000);
});

// ─── the GROUP's status ───────────────────────────────────────────────────────

describeIf('join request vs the group\'s status', () => {
  for (const [status, existing] of [
    ['ARCHIVED', undefined],
    ['INACTIVE', undefined],
    ['BANNED', undefined],
    ['ARCHIVED', 'LEFT'],
  ] as const) {
    it(`the group becomes ${status} while the request waits on the group row (existing membership: ${existing ?? 'none'}): refused, no PENDING row, no manager notification`, async () => {
      const f = await makeFixture(`grp-${status}-${existing ?? 'none'}`, { existing: existing ? { status: existing } : undefined });
      const before = await membershipSnapshot(f.groupId, f.requester.id);
      let pending: ReturnType<typeof requestJoin> | undefined;

      await prisma.$transaction(async (tx) => {
        // (1) hold the group row FOR UPDATE.
        await holdGroup(tx, f.groupId);
        // (2) start the request: its fast-path read still sees an ACTIVE private
        //     group, and it PARKS on the group row — proven, not assumed.
        pending = requestJoin(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        // (3) the external writer's status change commits first.
        await tx.group.update({ where: { id: f.groupId }, data: { status } });
      }, tx30);

      // (4) the request re-reads the row under the lock and is refused.
      const resp = await pending!;

      expect(resp.statusCode).toBe(400);
      expect(errorMessage(resp)).toBe('Group is not active');
      await expectNothingHappened(f, before);
      expect((await groupSnapshot(f.groupId))?.status).toBe(status);
    }, 60_000);
  }

  it('request WINS (new membership, parked inside its INSERT): an external ARCHIVE waits for it, then applies', async () => {
    const f = await makeFixture('gw-create', { slow: true });
    const reqP = requestJoin(f);
    reqP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: MEMBER_INSERT });

    const archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    archiveP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });

    const resp = await reqP;
    await archiveP;

    await expectRequested(f, resp);
    expect((await groupSnapshot(f.groupId))?.status).toBe('ARCHIVED');
  }, 60_000);

  it('request WINS (LEFT -> PENDING, parked at the membership write): an external ARCHIVE waits for it, then applies', async () => {
    const f = await makeFixture('gw-left', { existing: { status: 'LEFT' } });
    let reqP: ReturnType<typeof requestJoin> | undefined;
    let archiveP: Promise<unknown> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      reqP = requestJoin(f);
      reqP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

      archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
      archiveP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const resp = await reqP!;
    await archiveP;

    await expectRequested(f, resp);
    expect((await groupSnapshot(f.groupId))?.status).toBe('ARCHIVED');
  }, 60_000);

  it('the group is DELETED while the request waits on the group row: refused, nothing created', async () => {
    const f = await makeFixture('grp-deleted');
    let pending: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = requestJoin(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.delete({ where: { id: f.groupId } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is not active');
    expect(await membershipSnapshot(f.groupId, f.requester.id)).toBeNull();
    expect(await managerNotices(f)).toBe(0);
  }, 60_000);

  it('a lock-only SHARE holder on the group row does NOT block a request: admissions to one group run in parallel', async () => {
    const f = await makeFixture('share-compat');

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR SHARE`;
      await expectRequested(f, await requestJoin(f)); // runs to completion WHILE the share lock is held
    }, tx30);
  }, 60_000);

  it('the notification names the group as the LOCKED row read it (a rename that committed while the request waited)', async () => {
    const f = await makeFixture('locked-name');
    const renamed = `Renamed-${uniqueSuffix().slice(0, 8)}`;
    let pending: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = requestJoin(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { name: renamed } });
    }, tx30);

    await expectRequested(f, await pending!);
    for (const manager of [f.owner, f.admin]) {
      const notice = await prisma.notification.findFirstOrThrow({ where: { userId: manager.id, type: 'GROUP_JOIN_REQUEST' } });
      expect(notice.body).toContain(`"${renamed}"`);
      expect(notice.body).not.toContain(f.groupName);
    }
  }, 60_000);
});

// ─── the group's PRIVACY ──────────────────────────────────────────────────────

describeIf('join request vs the group turning public', () => {
  it('the group becomes PUBLIC while the request waits on the group row: refused, nothing created', async () => {
    const f = await makeFixture('pub-wins');
    const before = await membershipSnapshot(f.groupId, f.requester.id);
    let pending: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = requestJoin(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { isPrivate: false } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Public groups can be joined directly; use POST /join');
    await expectNothingHappened(f, before);
    expect((await groupSnapshot(f.groupId))?.isPrivate).toBe(false);
  }, 60_000);

  it('the group becomes PUBLIC while a LEFT member\'s request waits: refused, the LEFT row is untouched', async () => {
    const f = await makeFixture('pub-wins-left', { existing: { status: 'LEFT' } });
    const before = await membershipSnapshot(f.groupId, f.requester.id);
    let pending: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = requestJoin(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { isPrivate: false } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Public groups can be joined directly; use POST /join');
    await expectNothingHappened(f, before);
  }, 60_000);

  it('request WINS (parked inside its INSERT): a switch to PUBLIC waits for it, then applies', async () => {
    const f = await makeFixture('pub-after', { slow: true });
    const reqP = requestJoin(f);
    reqP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: MEMBER_INSERT });

    const publicP = prisma.group.update({ where: { id: f.groupId }, data: { isPrivate: false } });
    publicP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });

    const resp = await reqP;
    await publicP;

    await expectRequested(f, resp);
    expect((await groupSnapshot(f.groupId))?.isPrivate).toBe(false);
  }, 60_000);
});

// ─── a concurrent BAN ─────────────────────────────────────────────────────────

describeIf('join request (LEFT -> PENDING) vs a ban — a successful ban is never overwritten', () => {
  it('BAN first: the ban is queued at the member row before the request; the request is refused, the member stays BANNED, no manager is notified', async () => {
    const f = await makeFixture('ban-first', { existing: { status: 'LEFT' } });
    let banP: ReturnType<typeof ban> | undefined;
    let reqP: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      banP = ban(f);
      banP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the ban is parked first...
      reqP = requestJoin(f);
      reqP.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE }); // ...and the request queues behind it
    }, tx30);

    const [b, r] = [await banP!, await reqP!];

    expect(b.statusCode, b.body).toBe(200);
    expect(JSON.parse(b.body).data.message).toBe('Member banned');
    expect(r.statusCode, r.body).toBe(403);
    expect(errorMessage(r)).toBe('You are banned from this group');
    expect((await membershipSnapshot(f.groupId, f.requester.id))?.status).toBe('BANNED');
    expect(await managerNotices(f)).toBe(0);
  }, 60_000);

  it('REQUEST first: the request is queued at the member row before the ban; the ban applies AFTER and the final state is BANNED', async () => {
    const f = await makeFixture('req-first', { existing: { status: 'LEFT' } });
    let reqP: ReturnType<typeof requestJoin> | undefined;
    let banP: ReturnType<typeof ban> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      reqP = requestJoin(f);
      reqP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      banP = ban(f);
      banP.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE });
    }, tx30);

    const [r, b] = [await reqP!, await banP!];

    expect(r.statusCode, r.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(JSON.parse(b.body).data.message).toBe('Member banned'); // it banned a PENDING member — not a replay
    expect((await membershipSnapshot(f.groupId, f.requester.id))?.status).toBe('BANNED');
    expect(await prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_JOIN_REQUEST' } })).toBe(1);
  }, 60_000);

  it('a ban that commits AFTER the request\'s fast-path read and BEFORE its write is not overwritten: refused, BANNED, no notification', async () => {
    const f = await makeFixture('ban-between', { existing: { status: 'LEFT' } });
    let pending: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.groupMember.update({ where: { id: f.memberId! }, data: { status: 'BANNED' } });
      pending = requestJoin(f); // its fast-path read still sees the committed LEFT row
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
    }, tx30);
    const bannedRow = await membershipSnapshot(f.groupId, f.requester.id);

    const resp = await pending!;

    expect(resp.statusCode, resp.body).toBe(403);
    expect(errorMessage(resp)).toBe('You are banned from this group');
    expect(bannedRow?.status).toBe('BANNED');
    expect(await membershipSnapshot(f.groupId, f.requester.id)).toEqual(bannedRow);
    expect(await managerNotices(f)).toBe(0);
  }, 60_000);

  it('the membership PREDICATES hold: a row that changed after the read is refused with the same specific answers as before, and left as it is', async () => {
    const cases: Array<{ name: string; change: Prisma.GroupMemberUpdateInput; status: number; message: string; keep: { status: string; role: string } }> = [
      { name: 'ACTIVE', change: { status: 'ACTIVE' }, status: 409, message: 'You are already a member of this group', keep: { status: 'ACTIVE', role: 'MEMBER' } },
      { name: 'PENDING', change: { status: 'PENDING' }, status: 409, message: 'Your membership request is already pending', keep: { status: 'PENDING', role: 'MEMBER' } },
      { name: 'BANNED', change: { status: 'BANNED' }, status: 403, message: 'You are banned from this group', keep: { status: 'BANNED', role: 'MEMBER' } },
      { name: 'promoted to OWNER', change: { role: 'OWNER' }, status: 409, message: 'Your membership status cannot be changed', keep: { status: 'LEFT', role: 'OWNER' } },
      { name: 'MUTED', change: { status: 'MUTED' }, status: 409, message: 'Your membership status has changed since this request was initiated', keep: { status: 'MUTED', role: 'MEMBER' } },
    ];
    for (const c of cases) {
      const f = await makeFixture(`pred-${c.name.replace(/\W+/g, '')}`, { existing: { status: 'LEFT' } });
      let pending: ReturnType<typeof requestJoin> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.update({ where: { id: f.memberId! }, data: c.change });
        pending = requestJoin(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      }, tx30);

      const resp = await pending!;
      const row = await membershipSnapshot(f.groupId, f.requester.id);

      expect(resp.statusCode, `${c.name}: ${resp.body}`).toBe(c.status);
      expect(errorMessage(resp), c.name).toBe(c.message);
      expect({ status: row?.status, role: row?.role }, c.name).toEqual(c.keep);
      expect(await managerNotices(f), c.name).toBe(0);
    }
  }, 180_000);

  it('randomized breadth: LEFT request vs ban, started 0-30 ms apart in either order — never a 500, the member always ends BANNED', async () => {
    let bannedFirst = 0;
    let requestedFirst = 0;
    for (let i = 0; i < 25; i++) {
      const f = await makeFixture(`rz-ban-${i}`, { existing: { status: 'LEFT' } });
      const [r, b] = await raceWithJitter(() => requestJoin(f), () => ban(f));
      expect(r.statusCode, `round ${i} request: ${r.body}`).toBeLessThan(500);
      expect(b.statusCode, `round ${i} ban: ${b.body}`).toBe(200);
      expect((await membershipSnapshot(f.groupId, f.requester.id))?.status, `round ${i}: ban=${b.statusCode} request=${r.statusCode}`).toBe('BANNED');
      expect([200, 403], `round ${i} request`).toContain(r.statusCode);
      if (r.statusCode === 200) requestedFirst++;
      else bannedFirst++;
    }
    console.log(`request vs ban: requestedFirst=${requestedFirst} bannedFirst=${bannedFirst}`);
  }, 180_000);
});

// ─── duplicate requests ───────────────────────────────────────────────────────

describeIf('join request — concurrent duplicates are a controlled conflict', () => {
  it('two requests with no membership yet, both parked at the INSERT: exactly one wins, the other is a specific 409, and the managers are notified ONCE', async () => {
    const f = await makeFixture('dup-create');
    class Rollback extends Error {}
    let p1: ReturnType<typeof requestJoin> | undefined;
    let p2: ReturnType<typeof requestJoin> | undefined;

    await prisma
      .$transaction(async (tx) => {
        // An uncommitted INSERT of the very same (group, user) membership: both
        // requests' INSERTs must wait on the unique index entry it holds.
        await tx.groupMember.create({ data: { groupId: f.groupId, userId: f.requester.id, role: 'MEMBER', status: 'PENDING' } });
        p1 = requestJoin(f);
        p2 = requestJoin(f);
        p1.catch(() => undefined);
        p2.catch(() => undefined);
        await waitForBlockedBackends(2, { queryLike: MEMBER_INSERT });
        throw new Rollback(); // roll the test's row back: both INSERTs proceed and race for the slot
      }, tx30)
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    const results = [await p1!, await p2!];

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' | ')).toEqual([200, 409]);
    expect(errorMessage(results.find((r) => r.statusCode === 409)!)).toBe('Your membership request is already pending');
    // The loser's transaction rolled back whole: one PENDING row, one notification per manager.
    await expectRequested(f, results.find((r) => r.statusCode === 200)!);
  }, 60_000);

  it('two requests on one LEFT membership, both parked at the write: exactly one wins, the other is a specific 409', async () => {
    const f = await makeFixture('dup-left', { existing: { status: 'LEFT' } });
    let p1: ReturnType<typeof requestJoin> | undefined;
    let p2: ReturnType<typeof requestJoin> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      p1 = requestJoin(f);
      p2 = requestJoin(f);
      p1.catch(() => undefined);
      p2.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE });
    }, tx30);

    const results = [await p1!, await p2!];

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' | ')).toEqual([200, 409]);
    expect(errorMessage(results.find((r) => r.statusCode === 409)!)).toBe('Your membership request is already pending');
    await expectRequested(f, results.find((r) => r.statusCode === 200)!);
  }, 60_000);
});

// ─── behavior that must not change ────────────────────────────────────────────

describeIf('join request — the ordinary behavior is unchanged', () => {
  it('a normal request creates exactly one PENDING MEMBER row and notifies the OWNER and the ADMIN — not the MODERATOR — once each', async () => {
    const f = await makeFixture('normal');
    await expectRequested(f, await requestJoin(f));
    for (const manager of [f.owner, f.admin]) {
      const notice = await prisma.notification.findFirstOrThrow({ where: { userId: manager.id, type: 'GROUP_JOIN_REQUEST' } });
      expect(notice.title).toBe('Join request');
      expect(notice.body).toContain(`"${f.groupName}"`);
      expect(notice.data).toEqual({ groupId: f.groupId, requesterId: f.requester.id });
    }
    expect(await prisma.notification.count({ where: { userId: f.requester.id } })).toBe(0);
  });

  it('a LEFT member requests again: LEFT -> PENDING, the role is reset to MEMBER, the managers are notified', async () => {
    const f = await makeFixture('rerequest', { existing: { status: 'LEFT', role: 'MODERATOR' } });
    await expectRequested(f, await requestJoin(f));
  });

  it.each([
    ['ACTIVE', 409, 'You are already a member of this group'],
    ['PENDING', 409, 'Your membership request is already pending'],
    ['BANNED', 403, 'You are banned from this group'],
    ['MUTED', 409, 'Your membership status has changed since this request was initiated'],
  ] as const)('an existing %s membership is refused with %s "%s", and left untouched', async (status, code, message) => {
    const f = await makeFixture(`existing-${status}`, { existing: { status } });
    const before = await membershipSnapshot(f.groupId, f.requester.id);

    const resp = await requestJoin(f);

    expect(resp.statusCode).toBe(code);
    expect(errorMessage(resp)).toBe(message);
    await expectNothingHappened(f, before);
  });

  it('a public group, an archived group, a missing group and an anonymous caller keep their answers', async () => {
    const pub = await makeFixture('is-public', { isPrivate: false });
    const r1 = await requestJoin(pub);
    expect(r1.statusCode).toBe(400);
    expect(errorMessage(r1)).toBe('Public groups can be joined directly; use POST /join');
    expect(await membershipSnapshot(pub.groupId, pub.requester.id)).toBeNull();

    const archived = await makeFixture('is-archived');
    await prisma.group.update({ where: { id: archived.groupId }, data: { status: 'ARCHIVED' } });
    const r2 = await requestJoin(archived);
    expect(r2.statusCode).toBe(400);
    expect(errorMessage(r2)).toBe('Group is not active');

    const missing = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${'00000000-0000-4000-8000-000000000000'}/request`,
      headers: { authorization: `Bearer ${signToken(pub.requester)}` },
      remoteAddress: nextIp(),
    });
    expect(missing.statusCode).toBe(404);

    const anonymous = await server.inject({ method: 'POST', url: `${PREFIX}/${pub.groupId}/request`, remoteAddress: nextIp() });
    expect(anonymous.statusCode).toBe(401);
    expect(await managerNotices(pub)).toBe(0);
    expect(safeRecordActivity).not.toHaveBeenCalled();
  });

  it('a pending request can still be approved by a manager afterwards (the round trip is intact)', async () => {
    const f = await makeFixture('roundtrip');
    await expectRequested(f, await requestJoin(f));

    const approved = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${f.groupId}/requests/${f.requester.id}/approve`,
      headers: { authorization: `Bearer ${signToken(f.owner)}` },
      remoteAddress: nextIp(),
    });

    expect(approved.statusCode, approved.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.requester.id))?.status).toBe('ACTIVE');
  });
});

/**
 * Start two operations a random 0-30 ms apart, in a random order, and wait for
 * both. (Prisma queries are LAZY: they run only once something calls .then on
 * them, and Promise.resolve does that at once.)
 */
async function raceWithJitter<A, B>(first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
  const start = <T>(fn: () => PromiseLike<T>): Promise<T> => Promise.resolve(fn());
  const delay = Math.floor(Math.random() * 30);
  if (Math.random() < 0.5) {
    const a = start(first);
    await new Promise((r) => setTimeout(r, delay));
    const b = start(second);
    return [await a, await b];
  }
  const b = start(second);
  await new Promise((r) => setTimeout(r, delay));
  const a = start(first);
  return [await a, await b];
}
