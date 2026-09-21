import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
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
} from '../test/group-admission-fixtures.js';

// Wrapping the activity intake (calling straight through) lets a test say
// "exactly zero group-join reward/activity side effects" without sleeping.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// JOIN APPROVAL versus the ACTOR's own authority.
//
// POST /groups/:id/requests/:userId/approve judged the manager once, with a plain
// read BEFORE its transaction. A manager demoted, banned, muted, removed or who
// left after that read — and before the transaction wrote — still completed the
// approval: the applicant became an ACTIVE member and was sent GROUP_APPROVED on
// the authority of somebody who no longer had any.
//
// The fix (see group-locks.ts): inside the same transaction, after the applicant's
// account row (level 1) and the group row (level 2), lock the ACTOR's own
// membership row FOR SHARE (level 4, the authority row, before any target row),
// re-read role and status from it, and hold it through the transition, the
// notification and the commit. A demotion, ban, leave or removal of the manager
// then either commits BEFORE the lock is granted (the approval is refused, nothing
// written) or waits for the approval to commit (it was legitimately authorized at
// its serialization point).
//
// Every schedule is FORCED, never raced: a test-held lock parks the request at a
// known point, and pg_stat_activity PROVES it is parked there before the competing
// writer is let through (see test/pg-locks.ts). The randomized section at the end
// only adds breadth: it asserts coherence, never an ordering.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gaa-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(76);

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
type Held = Prisma.TransactionClient;

function signToken(user: User): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Fixture {
  owner: User;
  /** The ADMIN who approves. */
  manager: User;
  /** A plain ACTIVE member: gives the group a row to park on. */
  member: User;
  applicant: User;
  groupId: string;
  ownerMemberId: string;
  managerMemberId: string;
  applicantMemberId: string;
}

async function makeFixture(tag: string): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const manager = await createUser(EMAIL_PREFIX, `${tag}-mgr`);
  const member = await createUser(EMAIL_PREFIX, `${tag}-mem`);
  const applicant = await createUser(EMAIL_PREFIX, `${tag}-app`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `ApprAuth-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  const ownerRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  const managerRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: manager.id, role: 'ADMIN', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: member.id, role: 'MEMBER', status: 'ACTIVE' } });
  const applicantRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: applicant.id, role: 'MEMBER', status: 'PENDING' } });
  return {
    owner,
    manager,
    member,
    applicant,
    groupId: group.id,
    ownerMemberId: ownerRow.id,
    managerMemberId: managerRow.id,
    applicantMemberId: applicantRow.id,
  };
}

const asUser = (user: User) => ({ authorization: `Bearer ${signToken(user)}` });

const approve = (f: Fixture, as: User = f.manager, target: User = f.applicant) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/requests/${target.id}/approve`,
    headers: asUser(as),
    remoteAddress: nextIp(),
  });

// The competing writers, each through its REAL route.
const demote = (f: Fixture, role: 'MEMBER' | 'MODERATOR' = 'MEMBER') =>
  server.inject({
    method: 'PATCH',
    url: `${PREFIX}/${f.groupId}/members/${f.manager.id}/role`,
    headers: asUser(f.owner),
    payload: { role },
    remoteAddress: nextIp(),
  });
const banManager = (f: Fixture) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/members/${f.manager.id}/ban`, headers: asUser(f.owner), remoteAddress: nextIp() });
const managerLeaves = (f: Fixture) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/leave`, headers: asUser(f.manager), remoteAddress: nextIp() });
const removeManager = (f: Fixture) =>
  server.inject({ method: 'DELETE', url: `${PREFIX}/${f.groupId}/members/${f.manager.id}`, headers: asUser(f.owner), remoteAddress: nextIp() });
const transfer = (f: Fixture, to: User) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/transfer`, headers: asUser(f.owner), payload: { targetUserId: to.id }, remoteAddress: nextIp() });

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const holdRow = (tx: Held, table: 'group_members' | 'users' | 'groups', id: string) =>
  tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

const ACTOR_LOCK = '%FROM "group_members"%FOR SHARE%';
const LOCK_USERS = '%FROM "users"%FOR SHARE%';
const LOCK_GROUP = '%FROM "groups"%FOR SHARE%';
const MEMBER_UPDATE = '%UPDATE "public"."group_members"%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';

// Everything a REFUSED approval must not have produced.
const approvedNotices = (f: Fixture) =>
  prisma.notification.count({ where: { userId: f.applicant.id, type: 'GROUP_APPROVED' } });
async function applicantState(f: Fixture) {
  const where = { userId: f.applicant.id };
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

/** The refused approval left NOTHING behind: the request row exactly as it was (xmin included), no notification, no activity/reward/achievement. */
async function expectNothingHappened(f: Fixture, before: Awaited<ReturnType<typeof membershipSnapshot>>) {
  expect(await membershipSnapshot(f.groupId, f.applicant.id)).toEqual(before);
  expect(before?.status).toBe('PENDING');
  expect(await approvedNotices(f)).toBe(0);
  expect(safeRecordActivity).not.toHaveBeenCalled();
  await settle(); // anything fire-and-forget would have landed by now
  expect(await applicantState(f)).toEqual(NO_STATE);
}

/** The approval WENT THROUGH: 200, ACTIVE, one notification, the activity recorded once (and its streak row really lands). */
async function expectApproved(f: Fixture, resp: { statusCode: number; body: string }) {
  expect(resp.statusCode, resp.body).toBe(200);
  expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('ACTIVE');
  expect(await approvedNotices(f)).toBe(1);
  expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  expect(safeRecordActivity).toHaveBeenCalledWith(f.applicant.id, { type: 'GROUP_JOIN' });
  await vi.waitFor(async () => expect((await applicantState(f)).streaks).toBe(1), { timeout: 8_000, interval: 50 });
}

async function actorRow(f: Fixture) {
  return membershipSnapshot(f.groupId, f.manager.id);
}

// ─── the manager loses authority BEFORE the approval's transaction writes ─────

describeIf('join approval — a manager whose authority ended after the fast-path read cannot complete the approval', () => {
  // The approval is parked at the APPLICANT's account row (level 1), which it takes
  // before the actor row. Its unlocked preflight has already passed — the manager
  // was still an ADMIN then. The competing writer goes through its real route and
  // COMMITS while the approval is parked; only then is the approval released.
  interface Loss {
    name: string;
    happen: (f: Fixture) => Promise<{ statusCode: number; body: string }>;
    message: string;
    /** What the manager's row must look like afterwards. */
    row: { status?: string; role?: string } | null;
  }
  const losses: Loss[] = [
    { name: 'demoted to MEMBER (PATCH role)', happen: (f) => demote(f, 'MEMBER'), message: 'Insufficient permissions', row: { status: 'ACTIVE', role: 'MEMBER' } },
    { name: 'demoted to MODERATOR (PATCH role)', happen: (f) => demote(f, 'MODERATOR'), message: 'Insufficient permissions', row: { status: 'ACTIVE', role: 'MODERATOR' } },
    { name: 'banned from the group (POST ban)', happen: (f) => banManager(f), message: 'You are not a member of this group', row: { status: 'BANNED', role: 'ADMIN' } },
    { name: 'left the group (POST leave)', happen: (f) => managerLeaves(f), message: 'You are not a member of this group', row: { status: 'LEFT', role: 'ADMIN' } },
    { name: 'removed from the group (DELETE member)', happen: (f) => removeManager(f), message: 'You are not a member of this group', row: null },
  ];

  for (const loss of losses) {
    it(`${loss.name} while the approval waits on the applicant's account row: refused under the lock, nothing approved or announced`, async () => {
      const f = await makeFixture(`lost-${loss.name.slice(0, 8).replace(/\W+/g, '')}`);
      const before = await membershipSnapshot(f.groupId, f.applicant.id);
      let pending: ReturnType<typeof approve> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'users', f.applicant.id);
        pending = approve(f);
        pending.catch(() => undefined);
        // The preflight passed (the manager is still an ADMIN) and the approval parks at level 1.
        await waitForBlockedBackends(1, { queryLike: LOCK_USERS });

        // The manager's authority ends — through the real route, committed — while it waits.
        const resp = await loss.happen(f);
        expect(resp.statusCode, `${loss.name}: ${resp.body}`).toBe(200);
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(loss.message);
      const row = await actorRow(f);
      if (loss.row === null) expect(row).toBeNull();
      else expect({ status: row?.status, role: row?.role }).toEqual(loss.row);
      await expectNothingHappened(f, before);
    }, 60_000);
  }

  it('a MUTED manager (status change committed while the approval waits) is refused too', async () => {
    const f = await makeFixture('muted');
    const before = await membershipSnapshot(f.groupId, f.applicant.id);
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'users', f.applicant.id);
      pending = approve(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
      await prisma.groupMember.update({ where: { id: f.managerMemberId }, data: { status: 'MUTED' } });
    }, tx30);

    const resp = await pending!;
    expect(resp.statusCode).toBe(403);
    expect(errorMessage(resp)).toBe('You are not a member of this group');
    await expectNothingHappened(f, before);
  }, 60_000);

  it('a lock-only holder on the manager\'s row that changes nothing lets the approval through (waiting is not failing)', async () => {
    const f = await makeFixture('lock-only');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.managerMemberId);
      pending = approve(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: ACTOR_LOCK }); // parked on the AUTHORITY lock
    }, tx30);

    await expectApproved(f, await pending!);
  }, 60_000);

  it('a lock-only SHARE holder on the manager\'s row does NOT block the approval: the authority lock is shared', async () => {
    const f = await makeFixture('share-compat');

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${f.managerMemberId} FOR SHARE`;
      await expectApproved(f, await approve(f)); // runs to completion WHILE the share lock is held
    }, tx30);
  }, 60_000);
});

describeIf('join approval — the authority row is held: a competing writer QUEUED FIRST at the manager\'s row wins (real routes, FIFO)', () => {
  // The test holds the manager's row. The competing writer queues at it first, the
  // approval second (each PROVEN parked); on release the writer commits, and the
  // approval — whose lock request was behind it — re-reads and is refused.
  const writers: Array<{ name: string; go: (f: Fixture) => ReturnType<typeof demote>; message: string; role: string; status: string }> = [
    { name: 'demotion', go: (f) => demote(f), message: 'Insufficient permissions', role: 'MEMBER', status: 'ACTIVE' },
    { name: 'ban', go: (f) => banManager(f), message: 'You are not a member of this group', role: 'ADMIN', status: 'BANNED' },
    { name: 'leave', go: (f) => managerLeaves(f), message: 'You are not a member of this group', role: 'ADMIN', status: 'LEFT' },
  ];
  for (const w of writers) {
    it(`${w.name} queued first: the approval is refused, nothing approved or announced`, async () => {
      const f = await makeFixture(`fifo-${w.name}`);
      const before = await membershipSnapshot(f.groupId, f.applicant.id);
      let writerP: ReturnType<typeof demote> | undefined;
      let pending: ReturnType<typeof approve> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'group_members', f.managerMemberId);
        writerP = w.go(f);
        writerP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the writer is parked first...
        pending = approve(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: ACTOR_LOCK }); // ...and the approval queues behind it
      }, tx30);

      const [wr, resp] = [await writerP!, await pending!];

      expect(wr.statusCode, wr.body).toBe(200);
      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(w.message);
      const row = await actorRow(f);
      expect({ status: row?.status, role: row?.role }).toEqual({ status: w.status, role: w.role });
      await expectNothingHappened(f, before);
    }, 60_000);
  }
});

// ─── REVERSE order: the approval holds the authority row first ────────────────

describeIf('join approval — REVERSE order: the approval holds the manager\'s row through commit, so the competing writer WAITS and applies after', () => {
  // The approval is parked at its WRITE of the applicant's row (held by the test), so
  // it already holds the account, group and authority locks. The writer targets the
  // MANAGER's row — which nothing but the approval's authority lock can be holding —
  // and must be observed WAITING there.
  const writers: Array<{ name: string; go: (f: Fixture) => ReturnType<typeof demote>; role: string; status: string | null }> = [
    { name: 'demotion', go: (f) => demote(f), role: 'MEMBER', status: 'ACTIVE' },
    { name: 'ban', go: (f) => banManager(f), role: 'ADMIN', status: 'BANNED' },
    { name: 'leave', go: (f) => managerLeaves(f), role: 'ADMIN', status: 'LEFT' },
    { name: 'removal', go: (f) => removeManager(f), role: '', status: null },
  ];
  for (const w of writers) {
    it(`${w.name}: waits behind the approval (proven parked), then applies — the applicant was legitimately approved first`, async () => {
      const f = await makeFixture(`rev-${w.name}`);
      let approveP: ReturnType<typeof approve> | undefined;
      let writerP: ReturnType<typeof demote> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'group_members', f.applicantMemberId);
        approveP = approve(f);
        approveP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // parked at the applicant's row

        writerP = w.go(f);
        writerP.catch(() => undefined);
        // Two statements are parked now: the approval (applicant's row) and the writer
        // (the manager's row, behind the authority lock).
        await waitForBlockedBackends(2, { queryLike: w.name === 'removal' ? '%group_members%' : MEMBER_UPDATE });
      }, tx30);

      const [resp, wr] = [await approveP!, await writerP!];

      await expectApproved(f, resp);
      expect(wr.statusCode, wr.body).toBe(200);
      const row = await actorRow(f);
      if (w.status === null) expect(row).toBeNull();
      else expect({ status: row?.status, role: row?.role }).toEqual({ status: w.status, role: w.role });
    }, 60_000);
  }
});

// ─── lock order ───────────────────────────────────────────────────────────────

describeIf('join approval — lock order: account row (1), group row (2), THEN the authority row (4)', () => {
  it('parked on the applicant\'s ACCOUNT row it holds no authority lock: a demotion of the manager goes straight through', async () => {
    const f = await makeFixture('order-users');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'users', f.applicant.id);
      pending = approve(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_USERS });
      // Were the authority row locked BEFORE the account row this would hang until the test timed out.
      const resp = await demote(f);
      expect(resp.statusCode, resp.body).toBe(200);
    }, tx30);

    expect((await pending!).statusCode).toBe(403);
  }, 60_000);

  it('parked on the GROUP row it holds no authority lock either', async () => {
    const f = await makeFixture('order-group');
    let pending: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = approve(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      const resp = await demote(f);
      expect(resp.statusCode, resp.body).toBe(200);
    }, tx30);

    expect((await pending!).statusCode).toBe(403);
  }, 60_000);

  it('the authority row (the ACTOR\'s) is locked before the target row (the applicant\'s): a ban of the applicant queued behind the approval cannot cycle with it', async () => {
    const f = await makeFixture('order-target');
    let approveP: ReturnType<typeof approve> | undefined;
    let banP: Promise<{ statusCode: number; body: string }> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.applicantMemberId);
      approveP = approve(f);
      approveP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      banP = server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.groupId}/members/${f.applicant.id}/ban`,
        headers: asUser(f.owner),
        remoteAddress: nextIp(),
      });
      banP.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE });
    }, tx30);

    const [a, b] = [await approveP!, await banP!];

    // Serial order: approval, then the ban of the now-ACTIVE member. No deadlock, no 500.
    expect(a.statusCode, a.body).toBe(200);
    expect(await approvedNotices(f)).toBe(1);
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
    expect(b.statusCode, b.body).toBe(200);
    expect(JSON.parse(b.body).data.message).toBe('Member banned'); // it banned an ACTIVE member — not a replay
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('BANNED');
  }, 60_000);

  it('a ban of the applicant that queued FIRST wins; the approval is told "not pending" and produces nothing', async () => {
    const f = await makeFixture('order-target-ban');
    const before = await membershipSnapshot(f.groupId, f.applicant.id);
    let banP: Promise<{ statusCode: number; body: string }> | undefined;
    let approveP: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.applicantMemberId);
      banP = server.inject({
        method: 'POST',
        url: `${PREFIX}/${f.groupId}/members/${f.applicant.id}/ban`,
        headers: asUser(f.owner),
        remoteAddress: nextIp(),
      });
      banP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      approveP = approve(f);
      approveP.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE });
    }, tx30);

    const [b, a] = [await banP!, await approveP!];

    expect(b.statusCode, b.body).toBe(200);
    expect(a.statusCode, a.body).toBe(400);
    expect(errorMessage(a)).toBe('This request is not pending');
    expect((await membershipSnapshot(f.groupId, f.applicant.id))?.status).toBe('BANNED');
    expect(before?.status).toBe('PENDING');
    expect(await approvedNotices(f)).toBe(0);
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('two managers approving the same applicant, both parked at the write: exactly one wins, the other is told "not pending", no deadlock', async () => {
    const f = await makeFixture('two-managers');
    let a1: ReturnType<typeof approve> | undefined;
    let a2: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.applicantMemberId);
      a1 = approve(f, f.manager);
      a2 = approve(f, f.owner);
      a1.catch(() => undefined);
      a2.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE });
    }, tx30);

    const results = [await a1!, await a2!];

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' | ')).toEqual([200, 400]);
    expect(errorMessage(results.find((r) => r.statusCode === 400)!)).toBe('This request is not pending');
    expect(await approvedNotices(f)).toBe(1);
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  }, 60_000);
});

// ─── a FORMER OWNER keeps approval authority (as an ADMIN) — and nothing deadlocks ─

describeIf('join approval vs an ownership transfer by the approving owner', () => {
  it('transfer first (parked holding the group row): the old owner\'s approval waits at the GROUP row, then succeeds as an ADMIN', async () => {
    const f = await makeFixture('tr-first');
    let transferP: ReturnType<typeof transfer> | undefined;
    let approveP: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.ownerMemberId);
      transferP = transfer(f, f.member);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // it holds the group row already

      approveP = approve(f, f.owner);
      approveP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
    }, tx30);

    const [t, a] = [await transferP!, await approveP!];

    expect(t.statusCode, t.body).toBe(200);
    await expectApproved(f, a); // an ADMIN may still approve
    const owners = await prisma.groupMember.findMany({ where: { groupId: f.groupId, role: 'OWNER', status: 'ACTIVE' } });
    expect(owners.map((o) => o.userId)).toEqual([f.member.id]);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.member.id);
  }, 60_000);

  it('approval first (parked at the applicant\'s row): the transfer waits at the GROUP row, then completes', async () => {
    const f = await makeFixture('tr-second');
    let approveP: ReturnType<typeof approve> | undefined;
    let transferP: ReturnType<typeof transfer> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.applicantMemberId);
      approveP = approve(f, f.owner);
      approveP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      transferP = transfer(f, f.member);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [a, t] = [await approveP!, await transferP!];

    await expectApproved(f, a);
    expect(t.statusCode, t.body).toBe(200);
    const owners = await prisma.groupMember.findMany({ where: { groupId: f.groupId, role: 'OWNER', status: 'ACTIVE' } });
    expect(owners.map((o) => o.userId)).toEqual([f.member.id]);
  }, 60_000);
});

// ─── behavior that must not change ────────────────────────────────────────────

describeIf('join approval — the ordinary behavior is unchanged', () => {
  it('an ADMIN and the OWNER can approve; the request is approved once, announced once, and recorded once', async () => {
    const f = await makeFixture('normal');
    await expectApproved(f, await approve(f, f.manager));

    vi.mocked(safeRecordActivity).mockClear();
    const g = await makeFixture('normal-owner');
    await expectApproved(g, await approve(g, g.owner));
  });

  it('a plain member and an anonymous caller are still refused before the transaction', async () => {
    const f = await makeFixture('non-manager');
    const before = await membershipSnapshot(f.groupId, f.applicant.id);

    const asMember = await approve(f, f.member);
    const anonymous = await server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/requests/${f.applicant.id}/approve`, remoteAddress: nextIp() });

    expect(asMember.statusCode).toBe(403);
    expect(errorMessage(asMember)).toBe('Insufficient permissions');
    expect(anonymous.statusCode).toBe(401);
    await expectNothingHappened(f, before);
  });

  it('a replayed approval is still "not pending"', async () => {
    const f = await makeFixture('replay');
    await expectApproved(f, await approve(f));
    const again = await approve(f);
    expect(again.statusCode).toBe(400);
    expect(errorMessage(again)).toBe('This request is not pending');
  });
});

// ─── randomized breadth ───────────────────────────────────────────────────────

describeIf('randomized breadth: whichever order wins, nothing 500s and the outcomes are coherent', () => {
  // One round in flight at a time gives genuine, independently-timed racing inside the round.
  // What is asserted is never an ordering — only coherence.
  const ROUNDS = 25;

  for (const kind of ['demotion', 'ban', 'leave'] as const) {
    it(`approval vs the manager's ${kind}`, async () => {
      let approved = 0;
      let refused = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const f = await makeFixture(`rz-${kind}-${i}`);
        const writer = () => (kind === 'demotion' ? demote(f) : kind === 'ban' ? banManager(f) : managerLeaves(f));
        const [a, w] = await raceWithJitter(() => approve(f), writer);
        expect(a.statusCode, `round ${i} approve: ${a.body}`).toBeLessThan(500);
        expect(w.statusCode, `round ${i} ${kind}: ${w.body}`).toBeLessThan(500);
        const row = await membershipSnapshot(f.groupId, f.applicant.id);
        if (a.statusCode === 200) {
          approved++;
          expect(row?.status, `round ${i}`).toBe('ACTIVE');
          expect(await approvedNotices(f), `round ${i}`).toBe(1);
        } else {
          refused++;
          expect(a.statusCode, `round ${i}: ${a.body}`).toBe(403);
          // Refused: the request is untouched and nobody was told anything.
          expect(row?.status, `round ${i}`).toBe('PENDING');
          expect(await approvedNotices(f), `round ${i}`).toBe(0);
        }
        // The competing writer always lands: the manager is left without the authority.
        expect(w.statusCode, `round ${i} ${kind}`).toBe(200);
      }
      console.log(`approval vs ${kind}: approved=${approved} refused=${refused}`);
    }, 180_000);
  }
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
