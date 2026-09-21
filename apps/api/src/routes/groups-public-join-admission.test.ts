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
  type FixtureUserOptions,
} from '../test/group-admission-fixtures.js';

// Every GROUP_JOIN activity goes through safeRecordActivity, so wrapping it
// (calling straight through) lets a test say "exactly zero group-join
// reward/activity side effects" without sleeping and hoping.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// PUBLIC JOIN — POST /groups/:id/join — versus the caller's ACCOUNT, the GROUP,
// and a concurrent BAN.
//
// The route used to trust three unlocked reads. Nothing looked at the caller's
// account status (authenticate() validates only the JWT, so a SUSPENDED,
// INACTIVE, platform-BANNED or PENDING_VERIFICATION account joined freely); the
// group's status and privacy were read once, before the write, so an archive or
// a switch to private committed in between was ignored; and a LEFT membership
// was reactivated with an UNCONDITIONAL update, so a ban that committed after
// the route's read was overwritten with ACTIVE.
//
// The fix (see group-locks.ts): inside one transaction lock the caller's users
// row and the group row, re-read both, hold them through the membership
// transition and the commit, and make the transition a guarded updateMany.
//
// Every schedule is FORCED rather than raced. A test-held lock, or a scoped
// pause inside one statement, parks the request at a known point, and
// pg_stat_activity PROVES it is parked there before the competing writer is let
// through (see test/pg-locks.ts). The randomized section at the end only adds
// breadth: it asserts coherence, never an ordering.
//
//   competing writer WINS -> join REJECTED: no membership written, no activity,
//       no reward, no achievement.
//   join WINS             -> admitted at its serialization point; the writer
//       waits, then applies AFTER (a ban then leaves the member BANNED).
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gpj-';
const SLOW_EMAIL_PREFIX = `${EMAIL_PREFIX}slow-`;
const SLOW_TRIGGER = 'gpj_slow_member_insert';
const SLOW_MS = 2500;

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const emaillessUserIds: string[] = [];
const nextIp = ipAllocator(73);

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
    await cleanFixtures(EMAIL_PREFIX, () => emaillessUserIds);
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
  joiner: User;
  groupId: string;
  memberId: string | null;
}

interface FixtureOptions {
  existing?: Existing;
  joiner?: FixtureUserOptions;
  /** The joiner's INSERT of a new membership pauses inside the statement (see the trigger). */
  slow?: boolean;
  isPrivate?: boolean;
}

async function makeFixture(tag: string, opts: FixtureOptions = {}): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const joiner = await createUser(EMAIL_PREFIX, opts.slow ? `slow-${tag}` : `${tag}-jn`, opts.joiner);
  if (joiner.email === null) emaillessUserIds.push(joiner.id);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `PubJoin-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: opts.isPrivate ?? false, status: 'ACTIVE' },
  });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  let memberId: string | null = null;
  if (opts.existing) {
    const m = await prisma.groupMember.create({
      data: { groupId: group.id, userId: joiner.id, role: opts.existing.role ?? 'MEMBER', status: opts.existing.status },
    });
    memberId = m.id;
  }
  return { owner, joiner, groupId: group.id, memberId };
}

const join = (f: Fixture, as: User = f.joiner) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/join`,
    headers: { authorization: `Bearer ${signToken(as)}` },
    remoteAddress: nextIp(),
  });

const ban = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/members/${f.joiner.id}/ban`,
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
// A ban locks the manager's row and the target's together before it writes (group-locks.ts, level 4).
const MEMBER_LOCK = '%FROM "group_members"%FOR NO KEY UPDATE%';
const MEMBER_INSERT = '%INSERT INTO "public"."group_members"%';
const USER_WRITE = '%UPDATE "public"."users"%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';

const NOT_ELIGIBLE = 'Your account is not eligible to join groups';
const RESTRICTED = ['SUSPENDED', 'INACTIVE', 'BANNED', 'PENDING_VERIFICATION'] as const;

// Reward / achievement / streak state a GROUP_JOIN activity could touch.
async function activityState(user: User) {
  const where = { userId: user.id };
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
const NO_ACTIVITY = { streaks: 0, tasks: 0, achievements: 0, xpEvents: 0, rewardClaims: 0, progress: 0, notifications: 0 };

/** The request left NOTHING behind: same membership row (xmin included), no activity, no reward, no achievement, no notification. */
async function expectNothingHappened(f: Fixture, before: Awaited<ReturnType<typeof membershipSnapshot>>) {
  expect(await membershipSnapshot(f.groupId, f.joiner.id)).toEqual(before);
  expect(safeRecordActivity).not.toHaveBeenCalled();
  await settle(); // any fire-and-forget activity would have landed by now
  expect(await activityState(f.joiner)).toEqual(NO_ACTIVITY);
}

/** The join was ADMITTED: 200, ACTIVE, the activity called once, and its streak row really lands. */
async function expectJoined(f: Fixture, resp: { statusCode: number; body: string }, message: string) {
  expect(resp.statusCode, resp.body).toBe(200);
  expect(JSON.parse(resp.body).data.message).toBe(message);
  expect((await membershipSnapshot(f.groupId, f.joiner.id))?.status).toBe('ACTIVE');
  expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  expect(safeRecordActivity).toHaveBeenCalledWith(f.joiner.id, { type: 'GROUP_JOIN' });
  // The activity probe is live: an admitted join DOES write the streak row the
  // rejections assert is absent.
  await vi.waitFor(async () => expect((await activityState(f.joiner)).streaks).toBe(1), { timeout: 8_000, interval: 50 });
}

// ─── the caller's ACCOUNT ─────────────────────────────────────────────────────

describeIf('public join vs the caller\'s account status', () => {
  for (const status of RESTRICTED) {
    for (const existing of [undefined, 'LEFT'] as const) {
      const label = `${status}, existing membership: ${existing ?? 'none'}`;

      it(`restricted BEFORE the join (${label}): refused, no membership written or reactivated, no activity`, async () => {
        const f = await makeFixture(`pre-${status}-${existing ?? 'none'}`, {
          joiner: { status },
          existing: existing ? { status: existing } : undefined,
        });
        const before = await membershipSnapshot(f.groupId, f.joiner.id);

        const resp = await join(f);

        expect(resp.statusCode).toBe(403);
        // One generic answer for every restricted status.
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
    it(`restriction WINS while the join waits on the account row (${status}, existing membership: ${existing ?? 'none'}): refused under the lock, nothing written`, async () => {
      const f = await makeFixture(`win-${status}-${existing ?? 'none'}`, { existing: existing ? { status: existing } : undefined });
      const before = await membershipSnapshot(f.groupId, f.joiner.id);
      let pending: ReturnType<typeof join> | undefined;

      await prisma.$transaction(async (tx) => {
        // An uncommitted status change holds the users row. The join's UNLOCKED
        // fast-path reads see the committed ACTIVE account and pass...
        await tx.user.update({ where: { id: f.joiner.id }, data: { status } });
        pending = join(f);
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

  it('join WINS (new membership, parked inside its INSERT): the account writer WAITS, both complete, the restriction applies afterwards', async () => {
    const f = await makeFixture('jw-create', { slow: true });
    const joinP = join(f);
    joinP.catch(() => undefined);
    // The join holds its account and group locks and is paused mid-INSERT.
    await waitForWaitEvent('PgSleep', { queryLike: MEMBER_INSERT });

    const writerP = prisma.user.update({ where: { id: f.joiner.id }, data: { status: 'SUSPENDED' } });
    writerP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: USER_WRITE });

    const resp = await joinP;
    await writerP; // would reject with 40P01 if the lock orders were inconsistent

    await expectJoined(f, resp, 'Joined group successfully');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.joiner.id } })).status).toBe('SUSPENDED');
  }, 60_000);

  it('join WINS (LEFT rejoin, parked at the membership write): the account writer WAITS, both complete, the restriction applies afterwards', async () => {
    const f = await makeFixture('jw-left', { existing: { status: 'LEFT' } });
    let joinP: ReturnType<typeof join> | undefined;
    let writerP: Promise<unknown> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      joinP = join(f);
      joinP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

      writerP = prisma.user.update({ where: { id: f.joiner.id }, data: { status: 'INACTIVE' } });
      writerP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: USER_WRITE });
    }, tx30);

    const resp = await joinP!;
    await writerP;

    await expectJoined(f, resp, 'You have rejoined the group');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: f.joiner.id } })).status).toBe('INACTIVE');
  }, 60_000);

  it('the ACCOUNT row is locked first: a join parked on it holds no group lock (an external archive is not made to wait)', async () => {
    const f = await makeFixture('order-users');
    let pending: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: f.joiner.id }, data: { status: 'ACTIVE' } });
      pending = join(f);
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

describeIf('public join vs the group\'s status', () => {
  for (const [status, existing] of [
    ['ARCHIVED', undefined],
    ['INACTIVE', undefined],
    ['BANNED', undefined],
    ['ARCHIVED', 'LEFT'],
  ] as const) {
    it(`the group becomes ${status} while the join waits on the group row (existing membership: ${existing ?? 'none'}): refused, nothing written or reactivated`, async () => {
      const f = await makeFixture(`grp-${status}-${existing ?? 'none'}`, { existing: existing ? { status: existing } : undefined });
      const before = await membershipSnapshot(f.groupId, f.joiner.id);
      let pending: ReturnType<typeof join> | undefined;

      await prisma.$transaction(async (tx) => {
        // (1) hold the group row FOR UPDATE.
        await holdGroup(tx, f.groupId);
        // (2) start the join: its fast-path read still sees a public ACTIVE group,
        //     and it PARKS on the group row — proven, not assumed.
        pending = join(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        // (3) the external writer's status change commits first.
        await tx.group.update({ where: { id: f.groupId }, data: { status } });
      }, tx30);

      // (4) the join re-reads the row under the lock and is refused.
      const resp = await pending!;

      expect(resp.statusCode).toBe(400);
      expect(errorMessage(resp)).toBe('Group is not active');
      await expectNothingHappened(f, before);
      expect((await groupSnapshot(f.groupId))?.status).toBe(status);
    }, 60_000);
  }

  it('join WINS (new membership, parked inside its INSERT): an external ARCHIVE waits for it, then applies — a member of a group that was ACTIVE when they were admitted', async () => {
    const f = await makeFixture('gw-create', { slow: true });
    const joinP = join(f);
    joinP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: MEMBER_INSERT });

    const archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    archiveP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });

    const resp = await joinP;
    await archiveP;

    await expectJoined(f, resp, 'Joined group successfully');
    expect((await groupSnapshot(f.groupId))?.status).toBe('ARCHIVED');
  }, 60_000);

  it('join WINS (LEFT rejoin, parked at the membership write): an external ARCHIVE waits for it, then applies', async () => {
    const f = await makeFixture('gw-left', { existing: { status: 'LEFT' } });
    let joinP: ReturnType<typeof join> | undefined;
    let archiveP: Promise<unknown> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      joinP = join(f);
      joinP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

      archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
      archiveP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const resp = await joinP!;
    await archiveP;

    await expectJoined(f, resp, 'You have rejoined the group');
    expect((await groupSnapshot(f.groupId))?.status).toBe('ARCHIVED');
  }, 60_000);

  it('the group is DELETED while the join waits on the group row: refused, nothing written', async () => {
    const f = await makeFixture('grp-deleted');
    let pending: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = join(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.delete({ where: { id: f.groupId } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is not active');
    expect(await membershipSnapshot(f.groupId, f.joiner.id)).toBeNull();
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('a lock-only SHARE holder on the group row does NOT block a join: admissions to one group run in parallel', async () => {
    const f = await makeFixture('share-compat');

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR SHARE`;
      // The join runs to completion WHILE the share lock is held.
      await expectJoined(f, await join(f), 'Joined group successfully');
    }, tx30);
  }, 60_000);

  it('waiting for the group row is not itself a failure: a lock-only holder that changes nothing lets the join through', async () => {
    const f = await makeFixture('lock-only');
    let pending: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = join(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
    }, tx30);

    await expectJoined(f, await pending!, 'Joined group successfully');
  }, 60_000);
});

// ─── the group's PRIVACY ──────────────────────────────────────────────────────

describeIf('public join vs the group turning private', () => {
  it('the group becomes PRIVATE while the join waits on the group row: refused, nothing written', async () => {
    const f = await makeFixture('priv-wins');
    const before = await membershipSnapshot(f.groupId, f.joiner.id);
    let pending: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = join(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { isPrivate: true } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is private; you cannot join directly');
    await expectNothingHappened(f, before);
    expect((await groupSnapshot(f.groupId))?.isPrivate).toBe(true);
  }, 60_000);

  it('the group becomes PRIVATE while a LEFT member\'s rejoin waits: refused, the LEFT row is untouched', async () => {
    const f = await makeFixture('priv-wins-left', { existing: { status: 'LEFT' } });
    const before = await membershipSnapshot(f.groupId, f.joiner.id);
    let pending: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdGroup(tx, f.groupId);
      pending = join(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { isPrivate: true } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is private; you cannot join directly');
    await expectNothingHappened(f, before);
  }, 60_000);

  it('join WINS (parked inside its INSERT): a switch to PRIVATE waits for it, then applies', async () => {
    const f = await makeFixture('priv-after', { slow: true });
    const joinP = join(f);
    joinP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: MEMBER_INSERT });

    const privateP = prisma.group.update({ where: { id: f.groupId }, data: { isPrivate: true } });
    privateP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });

    const resp = await joinP;
    await privateP;

    await expectJoined(f, resp, 'Joined group successfully');
    expect((await groupSnapshot(f.groupId))?.isPrivate).toBe(true);
  }, 60_000);
});

// ─── a concurrent BAN ─────────────────────────────────────────────────────────

describeIf('public join (LEFT -> ACTIVE) vs a ban — a successful ban is never overwritten', () => {
  it('BAN first: the ban is queued at the member row before the join; the join is refused and the member stays BANNED', async () => {
    const f = await makeFixture('ban-first', { existing: { status: 'LEFT' } });
    let banP: ReturnType<typeof ban> | undefined;
    let joinP: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      banP = ban(f);
      banP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_LOCK }); // the ban is parked first (at the lock on the member rows)...
      joinP = join(f);
      joinP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // ...and the join queues behind it
    }, tx30);

    const [b, j] = [await banP!, await joinP!];

    expect(b.statusCode, b.body).toBe(200);
    expect(JSON.parse(b.body).data.message).toBe('Member banned');
    expect(j.statusCode, j.body).toBe(403);
    expect(errorMessage(j)).toBe('You are banned from this group');
    expect((await membershipSnapshot(f.groupId, f.joiner.id))?.status).toBe('BANNED');
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('JOIN first: the join is queued at the member row before the ban; the join succeeds, the ban applies AFTER and the final state is BANNED', async () => {
    const f = await makeFixture('join-first', { existing: { status: 'LEFT' } });
    let joinP: ReturnType<typeof join> | undefined;
    let banP: ReturnType<typeof ban> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      joinP = join(f);
      joinP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the join is parked first...
      banP = ban(f);
      banP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_LOCK }); // ...and the ban queues behind it, at the lock on the member rows
    }, tx30);

    const [j, b] = [await joinP!, await banP!];

    expect(j.statusCode, j.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(JSON.parse(b.body).data.message).toBe('Member banned'); // it banned an ACTIVE member — not a replay
    // Never ban=200 with a final ACTIVE membership.
    expect((await membershipSnapshot(f.groupId, f.joiner.id))?.status).toBe('BANNED');
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('a ban that commits AFTER the join\'s fast-path read and BEFORE its write is not overwritten: refused, BANNED (byte for byte the ban\'s row)', async () => {
    const f = await makeFixture('ban-between', { existing: { status: 'LEFT' } });
    let pending: ReturnType<typeof join> | undefined;
    let bannedRow: Awaited<ReturnType<typeof membershipSnapshot>> | null = null;

    await prisma.$transaction(async (tx) => {
      // The ban's write: uncommitted, holding the member row.
      await tx.groupMember.update({ where: { id: f.memberId! }, data: { status: 'BANNED' } });
      pending = join(f); // its fast-path read still sees the committed LEFT row
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
    }, tx30);
    bannedRow = await membershipSnapshot(f.groupId, f.joiner.id);

    const resp = await pending!;

    expect(resp.statusCode, resp.body).toBe(403);
    expect(errorMessage(resp)).toBe('You are banned from this group');
    expect(bannedRow?.status).toBe('BANNED');
    // The refused join wrote nothing: the row is exactly the one the ban committed.
    expect(await membershipSnapshot(f.groupId, f.joiner.id)).toEqual(bannedRow);
    expect(safeRecordActivity).not.toHaveBeenCalled();
  }, 60_000);

  it('the membership PREDICATES hold: a row that changed after the read (PENDING / MUTED / promoted to OWNER) is refused with a specific 4xx and left as it is', async () => {
    const cases: Array<{ name: string; change: Prisma.GroupMemberUpdateInput; status: number; message: string; keep: { status: string; role: string } }> = [
      { name: 'PENDING', change: { status: 'PENDING' }, status: 409, message: 'Your membership is pending approval', keep: { status: 'PENDING', role: 'MEMBER' } },
      { name: 'MUTED', change: { status: 'MUTED' }, status: 409, message: 'You are already a member of this group', keep: { status: 'MUTED', role: 'MEMBER' } },
      { name: 'promoted to OWNER', change: { role: 'OWNER' }, status: 409, message: 'Your membership status cannot be changed', keep: { status: 'LEFT', role: 'OWNER' } },
    ];
    for (const c of cases) {
      const f = await makeFixture(`pred-${c.name.replace(/\W+/g, '')}`, { existing: { status: 'LEFT' } });
      let pending: ReturnType<typeof join> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.update({ where: { id: f.memberId! }, data: c.change });
        pending = join(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      }, tx30);

      const resp = await pending!;
      const row = await membershipSnapshot(f.groupId, f.joiner.id);

      expect(resp.statusCode, `${c.name}: ${resp.body}`).toBe(c.status);
      expect(errorMessage(resp), c.name).toBe(c.message);
      expect({ status: row?.status, role: row?.role }, c.name).toEqual(c.keep);
      expect(safeRecordActivity, c.name).not.toHaveBeenCalled();
      vi.mocked(safeRecordActivity).mockClear();
    }
  }, 120_000);

  it('randomized breadth: LEFT rejoin vs ban, started 0-30 ms apart in either order — never a 500, never ban=200 with a final ACTIVE membership', async () => {
    let bannedFirst = 0;
    let joinedFirst = 0;
    for (let i = 0; i < 25; i++) {
      const f = await makeFixture(`rz-ban-${i}`, { existing: { status: 'LEFT' } });
      const [j, b] = await raceWithJitter(() => join(f), () => ban(f));
      expect(j.statusCode, `round ${i} join: ${j.body}`).toBeLessThan(500);
      expect(b.statusCode, `round ${i} ban: ${b.body}`).toBeLessThan(500);
      const final = (await membershipSnapshot(f.groupId, f.joiner.id))?.status;
      // The ban always lands (it is a manager's action on an existing member)...
      expect(b.statusCode, `round ${i}`).toBe(200);
      // ...so the member ends BANNED, whichever request got there first.
      expect(final, `round ${i}: ban=${b.statusCode} join=${j.statusCode}`).toBe('BANNED');
      expect([200, 403], `round ${i} join`).toContain(j.statusCode);
      if (j.statusCode === 200) joinedFirst++;
      else bannedFirst++;
    }
    console.log(`join vs ban: joinedFirst=${joinedFirst} bannedFirst=${bannedFirst}`);
  }, 180_000);
});

// ─── duplicate joins ──────────────────────────────────────────────────────────

describeIf('public join — concurrent duplicates are a controlled conflict', () => {
  it('two joins with no membership yet, both parked at the INSERT: exactly one wins, the other is a specific 409 (never a Prisma uniqueness error)', async () => {
    const f = await makeFixture('dup-create');
    class Rollback extends Error {}
    let p1: ReturnType<typeof join> | undefined;
    let p2: ReturnType<typeof join> | undefined;

    await prisma
      .$transaction(async (tx) => {
        // An uncommitted INSERT of the very same (group, user) membership: both joins'
        // INSERTs must wait on the unique index entry it holds.
        await tx.groupMember.create({ data: { groupId: f.groupId, userId: f.joiner.id, role: 'MEMBER', status: 'ACTIVE' } });
        p1 = join(f);
        p2 = join(f);
        p1.catch(() => undefined);
        p2.catch(() => undefined);
        await waitForBlockedBackends(2, { queryLike: MEMBER_INSERT });
        // Roll the test's row back: both INSERTs proceed and race for the slot.
        throw new Rollback();
      }, tx30)
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });

    const results = [await p1!, await p2!];

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' | ')).toEqual([200, 409]);
    const loser = results.find((r) => r.statusCode === 409)!;
    expect(errorMessage(loser)).toBe('You are already a member of this group');
    expect(await prisma.groupMember.count({ where: { groupId: f.groupId, userId: f.joiner.id } })).toBe(1);
    expect((await membershipSnapshot(f.groupId, f.joiner.id))?.status).toBe('ACTIVE');
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('two rejoins of one LEFT membership, both parked at the write: exactly one wins, the other is a specific 409, and the activity is recorded once', async () => {
    const f = await makeFixture('dup-left', { existing: { status: 'LEFT' } });
    let p1: ReturnType<typeof join> | undefined;
    let p2: ReturnType<typeof join> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.memberId!);
      p1 = join(f);
      p2 = join(f);
      p1.catch(() => undefined);
      p2.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MEMBER_UPDATE });
    }, tx30);

    const results = [await p1!, await p2!];

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' | ')).toEqual([200, 409]);
    expect(errorMessage(results.find((r) => r.statusCode === 409)!)).toBe('You are already a member of this group');
    expect((await membershipSnapshot(f.groupId, f.joiner.id))?.status).toBe('ACTIVE');
    expect(safeRecordActivity).toHaveBeenCalledTimes(1);
  }, 60_000);
});

// ─── behavior that must not change ────────────────────────────────────────────

describeIf('public join — the ordinary behavior is unchanged', () => {
  it('a new member joins: 200, one ACTIVE MEMBER row, the GROUP_JOIN activity recorded once', async () => {
    const f = await makeFixture('normal');
    await expectJoined(f, await join(f), 'Joined group successfully');
    const row = await membershipSnapshot(f.groupId, f.joiner.id);
    expect(row?.role).toBe('MEMBER');
    expect(await prisma.groupMember.count({ where: { groupId: f.groupId, userId: f.joiner.id } })).toBe(1);
  });

  it('a LEFT MODERATOR rejoins: 200, ACTIVE, and the old privilege is dropped — the role is reset to MEMBER', async () => {
    const f = await makeFixture('rejoin-mod', { existing: { status: 'LEFT', role: 'MODERATOR' } });
    await expectJoined(f, await join(f), 'You have rejoined the group');
    expect((await membershipSnapshot(f.groupId, f.joiner.id))?.role).toBe('MEMBER');
  });

  it('a LEFT ADMIN rejoins: 200, ACTIVE, and the old privilege is dropped — the role is reset to MEMBER', async () => {
    const f = await makeFixture('rejoin-admin', { existing: { status: 'LEFT', role: 'ADMIN' } });
    await expectJoined(f, await join(f), 'You have rejoined the group');
    expect((await membershipSnapshot(f.groupId, f.joiner.id))?.role).toBe('MEMBER');
  });

  it('no invitation or verified-email binding: an unverified, email-less ACTIVE account joins just the same', async () => {
    const f = await makeFixture('no-email', { joiner: { email: null, isVerified: false } });
    await expectJoined(f, await join(f), 'Joined group successfully');
  });

  it.each([
    ['ACTIVE', 409, 'You are already a member of this group'],
    ['MUTED', 409, 'You are already a member of this group'],
    ['PENDING', 409, 'Your membership is pending approval'],
    ['BANNED', 403, 'You are banned from this group'],
  ] as const)('an existing %s membership is refused with %s "%s", and left untouched', async (status, code, message) => {
    const f = await makeFixture(`existing-${status}`, { existing: { status } });
    const before = await membershipSnapshot(f.groupId, f.joiner.id);

    const resp = await join(f);

    expect(resp.statusCode).toBe(code);
    expect(errorMessage(resp)).toBe(message);
    await expectNothingHappened(f, before);
  });

  it('a private group, an archived group, a missing group and an anonymous caller keep their answers', async () => {
    const priv = await makeFixture('is-private', { isPrivate: true });
    const r1 = await join(priv);
    expect(r1.statusCode).toBe(400);
    expect(errorMessage(r1)).toBe('Group is private; you cannot join directly');
    expect(await membershipSnapshot(priv.groupId, priv.joiner.id)).toBeNull();

    const archived = await makeFixture('is-archived');
    await prisma.group.update({ where: { id: archived.groupId }, data: { status: 'ARCHIVED' } });
    const r2 = await join(archived);
    expect(r2.statusCode).toBe(400);
    expect(errorMessage(r2)).toBe('Group is not active');

    const missing = await server.inject({
      method: 'POST',
      url: `${PREFIX}/${'00000000-0000-4000-8000-000000000000'}/join`,
      headers: { authorization: `Bearer ${signToken(priv.joiner)}` },
      remoteAddress: nextIp(),
    });
    expect(missing.statusCode).toBe(404);

    const anonymous = await server.inject({ method: 'POST', url: `${PREFIX}/${priv.groupId}/join`, remoteAddress: nextIp() });
    expect(anonymous.statusCode).toBe(401);
    expect(safeRecordActivity).not.toHaveBeenCalled();
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
