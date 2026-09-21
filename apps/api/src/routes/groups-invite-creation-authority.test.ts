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
  groupSnapshot,
  inviteSnapshot,
  ipAllocator,
  membershipSnapshot,
  uniqueSuffix,
} from '../test/group-admission-fixtures.js';

// Wrapping the activity intake (calling straight through) lets a test say
// "no activity/reward call ran" without sleeping. Creating an invite records
// none — not on success, and certainly not on rejection.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// INVITE CREATION versus the ACTOR's authority and the GROUP's privacy.
//
// POST /groups/:id/invites judged two things once, BEFORE its transaction, and
// re-checked only the group's ACTIVE status under the group lock:
//
//   - the actor: a manager whose authority ended after that read — an owner who
//     just transferred ownership (now an ADMIN, who may not mint ADMIN invites),
//     an admin demoted to MEMBER, banned, muted, removed or who left — still
//     created the invite, and the ADMIN-ceiling was applied to the role read
//     BEFORE the transaction;
//   - the group's privacy: an edit that made the group PUBLIC after that read
//     still got a PENDING invite (and an invitation notification) in a group
//     that does not take invitations.
//
// The fix (see group-locks.ts): inside the transaction, after the group row
// (level 2) and the (group, email) subject lock (level 3), lock the ACTOR's own
// membership row FOR SHARE (level 4), re-read role and status from it, apply the
// ceiling to THAT role, and require the LOCKED group to be both ACTIVE and
// PRIVATE. A rejected creation writes NOTHING: no invite, no stale-invite
// closing, no notification.
//
// Every schedule is FORCED, never raced: a test-held lock parks the request at a
// known point, and pg_stat_activity PROVES it is parked there before the competing
// writer is let through (see test/pg-locks.ts).
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gic-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(77);

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
  /** An ADMIN. */
  admin: User;
  /** An ACTIVE member: the target of an ownership transfer. */
  target: User;
  /** The account being invited: an existing user, so a creation also notifies them. */
  invitee: User;
  groupId: string;
  ownerMemberId: string;
  adminMemberId: string;
  /** A closed-out-able (expired, PENDING) invite for the invitee's email. */
  staleInviteId: string;
}

async function makeFixture(tag: string, opts: { isPrivate?: boolean } = {}): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const admin = await createUser(EMAIL_PREFIX, `${tag}-adm`);
  const target = await createUser(EMAIL_PREFIX, `${tag}-tgt`);
  const invitee = await createUser(EMAIL_PREFIX, `${tag}-inv`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `InvAuth-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: opts.isPrivate ?? true, status: 'ACTIVE' },
  });
  const ownerRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  const adminRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: admin.id, role: 'ADMIN', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: target.id, role: 'MEMBER', status: 'ACTIVE' } });
  // A stale PENDING invite (its expiry passed) for the invitee: creating a replacement closes it out —
  // a write a REFUSED creation must not leave behind.
  const stale = await prisma.groupInvite.create({
    data: {
      groupId: group.id,
      email: invitee.email!.toLowerCase(),
      role: 'MEMBER',
      status: 'PENDING',
      token: `gictok-${uniqueSuffix()}${uniqueSuffix()}`,
      expiresAt: new Date(Date.now() - 3_600_000),
      invitedBy: owner.id,
    },
  });
  return { owner, admin, target, invitee, groupId: group.id, ownerMemberId: ownerRow.id, adminMemberId: adminRow.id, staleInviteId: stale.id };
}

const asUser = (user: User) => ({ authorization: `Bearer ${signToken(user)}` });

const createInvite = (f: Fixture, as: User, role?: 'ADMIN' | 'MODERATOR' | 'MEMBER', email: string = f.invitee.email!) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/invites`,
    headers: asUser(as),
    payload: role ? { email, role } : { email },
    remoteAddress: nextIp(),
  });

// The competing writers, each through its REAL route.
const transfer = (f: Fixture, to: User = f.target) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/transfer`, headers: asUser(f.owner), payload: { targetUserId: to.id }, remoteAddress: nextIp() });
const demoteAdmin = (f: Fixture) =>
  server.inject({ method: 'PATCH', url: `${PREFIX}/${f.groupId}/members/${f.admin.id}/role`, headers: asUser(f.owner), payload: { role: 'MEMBER' }, remoteAddress: nextIp() });
const banAdmin = (f: Fixture) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/members/${f.admin.id}/ban`, headers: asUser(f.owner), remoteAddress: nextIp() });
const adminLeaves = (f: Fixture) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/leave`, headers: asUser(f.admin), remoteAddress: nextIp() });
const removeAdmin = (f: Fixture) =>
  server.inject({ method: 'DELETE', url: `${PREFIX}/${f.groupId}/members/${f.admin.id}`, headers: asUser(f.owner), remoteAddress: nextIp() });
const editGroup = (f: Fixture, body: { isPrivate?: boolean; name?: string }) =>
  server.inject({ method: 'PUT', url: `${PREFIX}/${f.groupId}`, headers: asUser(f.owner), payload: body, remoteAddress: nextIp() });

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const holdRow = (tx: Held, table: 'group_members' | 'users' | 'groups', id: string) =>
  tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

const ACTOR_LOCK = '%FROM "group_members"%FOR SHARE%';
const LOCK_GROUP = '%FROM "groups"%FOR SHARE%';
const SUBJECT_LOCK = '%pg_advisory_xact_lock%';
const MEMBER_UPDATE = '%UPDATE "public"."group_members"%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';
const NOTICE_INSERT = '%INSERT INTO "public"."notifications"%';

// Everything a REFUSED creation must not have produced.
const inviteCount = (f: Fixture) => prisma.groupInvite.count({ where: { groupId: f.groupId } });
const inviteNotices = (f: Fixture) => prisma.notification.count({ where: { userId: f.invitee.id, type: 'GROUP_INVITE' } });
async function inviteeState(f: Fixture) {
  const where = { userId: f.invitee.id };
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

/**
 * The refused creation left NOTHING behind: no new invite, the stale invite exactly as it was (xmin included — the
 * "close it out as EXPIRED" write did not survive), no invitation notification, no membership for the invitee, and no
 * activity, reward or achievement.
 */
async function expectNothingHappened(f: Fixture, staleBefore: Awaited<ReturnType<typeof inviteSnapshot>>) {
  expect(await inviteCount(f)).toBe(1);
  expect(await inviteSnapshot(f.staleInviteId)).toEqual(staleBefore);
  expect(staleBefore?.status).toBe('PENDING');
  expect(await inviteNotices(f)).toBe(0);
  expect(await membershipSnapshot(f.groupId, f.invitee.id)).toBeNull();
  expect(safeRecordActivity).not.toHaveBeenCalled();
  await settle(); // anything fire-and-forget would have landed by now
  expect(await inviteeState(f)).toEqual(NO_STATE);
}

/** The creation WENT THROUGH: 200, one live invite with the requested role by this inviter, the stale one closed out, one notification. */
async function expectCreated(f: Fixture, resp: { statusCode: number; body: string }, role: string, invitedBy: User) {
  expect(resp.statusCode, resp.body).toBe(200);
  const invite = JSON.parse(resp.body).data;
  expect(invite.role).toBe(role);
  expect(invite.invitedBy).toBe(invitedBy.id);
  expect(await inviteCount(f)).toBe(2);
  expect((await inviteSnapshot(f.staleInviteId))?.status).toBe('EXPIRED');
  expect((await inviteSnapshot(invite.id))?.status).toBe('PENDING');
  expect(await inviteNotices(f)).toBe(1);
  expect(safeRecordActivity).not.toHaveBeenCalled();
}

async function expectOneOwnerMatchingGroup(groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return;
  const owners = await prisma.groupMember.findMany({ where: { groupId, role: 'OWNER', status: 'ACTIVE' } });
  expect(owners.length, 'ACTIVE OWNER rows').toBe(1);
  expect(owners[0].userId, 'the OWNER row matches groups.ownerId').toBe(group.ownerId);
}

// ─── OWNERSHIP TRANSFER racing an ADMIN invite ────────────────────────────────

describeIf('invite creation vs an ownership transfer by the inviting owner', () => {
  it('transfer FIRST (parked holding the group row): the old owner\'s ADMIN invite waits at the GROUP row, then is refused — an ADMIN may not mint ADMIN invites', async () => {
    const f = await makeFixture('tr-admin-first');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let transferP: ReturnType<typeof transfer> | undefined;
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.ownerMemberId);
      transferP = transfer(f);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the transfer already holds the group row

      // The owner's fast-path checks all pass: they are still the OWNER, the group is private and ACTIVE.
      createP = createInvite(f, f.owner, 'ADMIN');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
    }, tx30);

    const [t, c] = [await transferP!, await createP!];

    expect(t.statusCode, t.body).toBe(200);
    expect(c.statusCode, c.body).toBe(403);
    expect(errorMessage(c)).toBe('Only the owner can assign admin roles');
    expect((await membershipSnapshot(f.groupId, f.owner.id))?.role).toBe('ADMIN');
    await expectNothingHappened(f, staleBefore);
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);

  it('the same race with a MEMBER invite: the former owner is still an ADMIN, so the invite is created (nothing is over-rejected)', async () => {
    const f = await makeFixture('tr-member-first');
    let transferP: ReturnType<typeof transfer> | undefined;
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.ownerMemberId);
      transferP = transfer(f);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });
      createP = createInvite(f, f.owner, 'MEMBER');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
    }, tx30);

    const [t, c] = [await transferP!, await createP!];

    expect(t.statusCode, t.body).toBe(200);
    await expectCreated(f, c, 'MEMBER', f.owner);
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);

  it('REVERSE: the ADMIN invite is created first (parked at its notification, holding every lock); the transfer WAITS at the group row, then applies', async () => {
    const f = await makeFixture('tr-admin-second');
    let createP: ReturnType<typeof createInvite> | undefined;
    let transferP: ReturnType<typeof transfer> | undefined;

    await prisma.$transaction(async (tx) => {
      // The notification's foreign key wants FOR KEY SHARE on the invitee's users row, which this refuses: the
      // creation is parked AFTER it took its group, subject and authority locks and inserted the invite.
      await holdRow(tx, 'users', f.invitee.id);
      createP = createInvite(f, f.owner, 'ADMIN');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: NOTICE_INSERT });

      transferP = transfer(f);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [c, t] = [await createP!, await transferP!];

    // Serial order: the creation (the OWNER was entitled to mint it), then the transfer.
    await expectCreated(f, c, 'ADMIN', f.owner);
    expect(t.statusCode, t.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.owner.id))?.role).toBe('ADMIN');
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);

  it('the same stale action through a DIRECT database transfer (group row and both member rows), committed while the invite waits at the group row', async () => {
    const f = await makeFixture('tr-direct');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      createP = createInvite(f, f.owner, 'ADMIN');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      // A complete ownership transfer, committed by an external writer.
      await tx.group.update({ where: { id: f.groupId }, data: { ownerId: f.target.id } });
      await tx.groupMember.update({ where: { id: f.ownerMemberId }, data: { role: 'ADMIN' } });
      await tx.groupMember.updateMany({ where: { groupId: f.groupId, userId: f.target.id }, data: { role: 'OWNER' } });
    }, tx30);

    const c = await createP!;

    expect(c.statusCode, c.body).toBe(403);
    expect(errorMessage(c)).toBe('Only the owner can assign admin roles');
    await expectNothingHappened(f, staleBefore);
  }, 60_000);
});

// ─── a manager loses authority while the creation waits ───────────────────────

describeIf('invite creation — a manager whose authority ended after the fast-path read cannot complete it', () => {
  // The creation is parked at the GROUP row (level 2), which it takes before the authority row.
  // Its preflight has already passed — the admin was still an ADMIN then. The competing writer goes
  // through its real route and COMMITS while the creation is parked; only then is it released.
  interface Loss {
    name: string;
    happen: (f: Fixture) => Promise<{ statusCode: number; body: string }>;
    message: string;
    row: { status?: string; role?: string } | null;
  }
  const losses: Loss[] = [
    { name: 'demoted to MEMBER (PATCH role)', happen: demoteAdmin, message: 'Insufficient permissions', row: { status: 'ACTIVE', role: 'MEMBER' } },
    { name: 'banned from the group (POST ban)', happen: banAdmin, message: 'You are not a member of this group', row: { status: 'BANNED', role: 'ADMIN' } },
    { name: 'left the group (POST leave)', happen: adminLeaves, message: 'You are not a member of this group', row: { status: 'LEFT', role: 'ADMIN' } },
    { name: 'removed from the group (DELETE member)', happen: removeAdmin, message: 'You are not a member of this group', row: null },
  ];

  for (const loss of losses) {
    it(`${loss.name} while the creation waits on the group row: refused under the lock, nothing created or announced`, async () => {
      const f = await makeFixture(`lost-${loss.name.slice(0, 8).replace(/\W+/g, '')}`);
      const staleBefore = await inviteSnapshot(f.staleInviteId);
      let pending: ReturnType<typeof createInvite> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'groups', f.groupId);
        pending = createInvite(f, f.admin, 'MEMBER');
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });

        const resp = await loss.happen(f);
        expect(resp.statusCode, `${loss.name}: ${resp.body}`).toBe(200);
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(loss.message);
      const row = await membershipSnapshot(f.groupId, f.admin.id);
      if (loss.row === null) expect(row).toBeNull();
      else expect({ status: row?.status, role: row?.role }).toEqual(loss.row);
      await expectNothingHappened(f, staleBefore);
    }, 60_000);
  }

  it('a competing writer QUEUED FIRST at the admin\'s row wins (real route, FIFO): the creation is refused', async () => {
    const f = await makeFixture('fifo-demote');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let writerP: ReturnType<typeof demoteAdmin> | undefined;
    let pending: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.adminMemberId);
      writerP = demoteAdmin(f);
      writerP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the demotion is parked first...
      pending = createInvite(f, f.admin, 'MEMBER');
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: ACTOR_LOCK }); // ...and the creation queues behind it, on the AUTHORITY lock
    }, tx30);

    const [w, resp] = [await writerP!, await pending!];

    expect(w.statusCode, w.body).toBe(200);
    expect(resp.statusCode, resp.body).toBe(403);
    expect(errorMessage(resp)).toBe('Insufficient permissions');
    await expectNothingHappened(f, staleBefore);
  }, 60_000);

  it('a MUTED admin (status change committed while the creation waits) is refused too', async () => {
    const f = await makeFixture('muted');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let pending: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = createInvite(f, f.admin, 'MEMBER');
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await prisma.groupMember.update({ where: { id: f.adminMemberId }, data: { status: 'MUTED' } });
    }, tx30);

    const resp = await pending!;
    expect(resp.statusCode).toBe(403);
    expect(errorMessage(resp)).toBe('You are not a member of this group');
    await expectNothingHappened(f, staleBefore);
  }, 60_000);

  const holders: Array<{ name: string; go: (f: Fixture) => ReturnType<typeof demoteAdmin>; role: string; status: string | null }> = [
    { name: 'demotion', go: demoteAdmin, role: 'MEMBER', status: 'ACTIVE' },
    { name: 'ban', go: banAdmin, role: 'ADMIN', status: 'BANNED' },
    { name: 'leave', go: adminLeaves, role: 'ADMIN', status: 'LEFT' },
    { name: 'removal', go: removeAdmin, role: '', status: null },
  ];
  for (const w of holders) {
    it(`REVERSE: the creation holds the admin's row through commit (parked at its notification), so the ${w.name} WAITS and applies after`, async () => {
      const f = await makeFixture(`rev-${w.name}`);
      let createP: ReturnType<typeof createInvite> | undefined;
      let writerP: ReturnType<typeof demoteAdmin> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'users', f.invitee.id);
        createP = createInvite(f, f.admin, 'MEMBER');
        createP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: NOTICE_INSERT });

        writerP = w.go(f);
        writerP.catch(() => undefined);
        // The writer targets the ADMIN's row, which nothing but the creation's authority lock can be holding.
        await waitForBlockedBackends(1, { queryLike: w.name === 'removal' ? '%DELETE FROM%group_members%' : MEMBER_UPDATE });
      }, tx30);

      const [c, wr] = [await createP!, await writerP!];

      await expectCreated(f, c, 'MEMBER', f.admin);
      expect(wr.statusCode, wr.body).toBe(200);
      const row = await membershipSnapshot(f.groupId, f.admin.id);
      if (w.status === null) expect(row).toBeNull();
      else expect({ status: row?.status, role: row?.role }).toEqual({ status: w.status, role: w.role });
    }, 60_000);
  }
});

// ─── PRIVATE -> PUBLIC edit racing an invite ──────────────────────────────────

describeIf('invite creation vs the group turning PUBLIC', () => {
  it('a real PUT that queued first: the group becomes PUBLIC while the creation waits on the group row — refused, nothing created', async () => {
    const f = await makeFixture('pub-first');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let editP: ReturnType<typeof editGroup> | undefined;
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      editP = editGroup(f, { isPrivate: false });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE }); // the edit is parked first...
      createP = createInvite(f, f.owner, 'MEMBER');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP }); // ...and the creation queues behind it
    }, tx30);

    const [e, c] = [await editP!, await createP!];

    expect(e.statusCode, e.body).toBe(200);
    expect(c.statusCode, c.body).toBe(400);
    expect(errorMessage(c)).toBe('Invites are only available for private groups');
    expect((await groupSnapshot(f.groupId))?.isPrivate).toBe(false);
    await expectNothingHappened(f, staleBefore);
  }, 60_000);

  it('the flip committed by a lock-holding external writer while the creation waits on the group row: refused, nothing created', async () => {
    const f = await makeFixture('pub-direct');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      createP = createInvite(f, f.owner, 'MEMBER');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { isPrivate: false } });
    }, tx30);

    const c = await createP!;

    expect(c.statusCode, c.body).toBe(400);
    expect(errorMessage(c)).toBe('Invites are only available for private groups');
    await expectNothingHappened(f, staleBefore);
  }, 60_000);

  it('REVERSE: the invite is created first (parked at its notification, holding the group row); the edit WAITS behind it and applies after', async () => {
    const f = await makeFixture('pub-second');
    let createP: ReturnType<typeof createInvite> | undefined;
    let editP: ReturnType<typeof editGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'users', f.invitee.id);
      createP = createInvite(f, f.owner, 'MEMBER');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: NOTICE_INSERT });

      editP = editGroup(f, { isPrivate: false });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [c, e] = [await createP!, await editP!];

    // Serial order: the creation (the group WAS private), then the edit.
    await expectCreated(f, c, 'MEMBER', f.owner);
    expect(e.statusCode, e.body).toBe(200);
    expect((await groupSnapshot(f.groupId))?.isPrivate).toBe(false);
  }, 60_000);

  it('the group is ARCHIVED while the creation waits on the group row: still refused, nothing created (the ACTIVE check is intact)', async () => {
    const f = await makeFixture('archived');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      createP = createInvite(f, f.owner, 'MEMBER');
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      await tx.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    }, tx30);

    const c = await createP!;

    expect(c.statusCode, c.body).toBe(400);
    expect(errorMessage(c)).toBe('Group is not active');
    await expectNothingHappened(f, staleBefore);
  }, 60_000);

  it('a group that is (and stays) PRIVATE and ACTIVE still takes invitations, and a PUBLIC one is still refused before the transaction', async () => {
    const f = await makeFixture('normal');
    await expectCreated(f, await createInvite(f, f.owner, 'MEMBER'), 'MEMBER', f.owner);

    const pub = await makeFixture('public', { isPrivate: false });
    const staleBefore = await inviteSnapshot(pub.staleInviteId);
    const resp = await createInvite(pub, pub.owner, 'MEMBER');
    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Invites are only available for private groups');
    await expectNothingHappened(pub, staleBefore);
  }, 60_000);
});

// ─── lock order ───────────────────────────────────────────────────────────────

describeIf('invite creation — lock order: group row (2), subject (3), THEN the authority row (4)', () => {
  it('parked on the GROUP row it holds no authority lock: a demotion of the admin goes straight through', async () => {
    const f = await makeFixture('order-group');
    let pending: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = createInvite(f, f.admin, 'MEMBER');
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
      const resp = await demoteAdmin(f); // were the authority row locked BEFORE the group row this would hang
      expect(resp.statusCode, resp.body).toBe(200);
    }, tx30);

    expect((await pending!).statusCode).toBe(403);
  }, 60_000);

  it('parked on the (group, email) SUBJECT lock it holds no authority lock either (the subject lock is level 3, the authority row level 4)', async () => {
    const f = await makeFixture('order-subject');
    const staleBefore = await inviteSnapshot(f.staleInviteId);
    let pending: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await lockInviteSubject(tx, f.groupId, f.invitee.email!);
      pending = createInvite(f, f.admin, 'MEMBER');
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SUBJECT_LOCK });
      // It holds the group row (SHARE) but NOT the admin's row: this goes straight through.
      const resp = await demoteAdmin(f);
      expect(resp.statusCode, resp.body).toBe(200);
    }, tx30);

    const resp = await pending!;
    expect(resp.statusCode, resp.body).toBe(403);
    expect(errorMessage(resp)).toBe('Insufficient permissions');
    await expectNothingHappened(f, staleBefore);
  }, 60_000);

  it('a ban of a DIFFERENT member and a creation for that member\'s email, both parked, complete in either order — no deadlock', async () => {
    // The ban holds the subject lock for the target's email and wants the target's row; the creation
    // wants that subject lock and holds only the ADMIN's row afterwards — never the target's.
    const f = await makeFixture('order-ban-subject');
    const victim = await createUser(EMAIL_PREFIX, 'order-ban-subject-vic');
    const victimRow = await prisma.groupMember.create({ data: { groupId: f.groupId, userId: victim.id, role: 'MEMBER', status: 'LEFT' } });
    let banP: Promise<{ statusCode: number; body: string }> | undefined;
    let createP: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', victimRow.id);
      banP = server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/members/${victim.id}/ban`, headers: asUser(f.owner), remoteAddress: nextIp() });
      banP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the ban holds the subject lock
      createP = createInvite(f, f.admin, 'MEMBER', victim.email!);
      createP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SUBJECT_LOCK });
    }, tx30);

    const [b, c] = [await banP!, await createP!];

    expect(b.statusCode, b.body).toBe(200);
    // The ban won: the invitee is BANNED, so the creation is refused (403 "banned"), never a 500.
    expect(c.statusCode, c.body).toBe(403);
    expect((await membershipSnapshot(f.groupId, victim.id))?.status).toBe('BANNED');
    expect(await prisma.groupInvite.count({ where: { groupId: f.groupId, email: victim.email!.toLowerCase() } })).toBe(0);
  }, 60_000);
});

// ─── randomized breadth ───────────────────────────────────────────────────────

describeIf('randomized breadth: whichever order wins, nothing 500s and the outcomes are coherent', () => {
  // One round in flight at a time gives genuine, independently-timed racing inside the round.
  // What is asserted is never an ordering — only coherence.
  const ROUNDS = 25;

  it('the OWNER\'s ADMIN invite vs an ownership transfer', async () => {
    let created = 0;
    let refused = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-tr-${i}`);
      const [c, t] = await raceWithJitter(() => createInvite(f, f.owner, 'ADMIN'), () => transfer(f));
      expect(c.statusCode, `round ${i} create: ${c.body}`).toBeLessThan(500);
      expect(t.statusCode, `round ${i} transfer: ${t.body}`).toBeLessThan(500);
      const live = await prisma.groupInvite.count({ where: { groupId: f.groupId, status: 'PENDING', expiresAt: { gt: new Date() } } });
      if (c.statusCode === 200) {
        created++;
        expect(live, `round ${i}`).toBe(1);
        expect(await inviteNotices(f), `round ${i}`).toBe(1);
      } else {
        refused++;
        expect(c.statusCode, `round ${i}: ${c.body}`).toBe(403);
        expect(live, `round ${i}`).toBe(0);
        expect(await inviteNotices(f), `round ${i}`).toBe(0);
        expect((await inviteSnapshot(f.staleInviteId))?.status, `round ${i}`).toBe('PENDING');
      }
      await expectOneOwnerMatchingGroup(f.groupId);
    }
    console.log(`ADMIN invite vs transfer: created=${created} refused=${refused}`);
  }, 180_000);

  for (const kind of ['demotion', 'ban', 'leave'] as const) {
    it(`the admin's invite vs the admin's ${kind}`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const f = await makeFixture(`rz-${kind}-${i}`);
        const writer = () => (kind === 'demotion' ? demoteAdmin(f) : kind === 'ban' ? banAdmin(f) : adminLeaves(f));
        const [c, w] = await raceWithJitter(() => createInvite(f, f.admin, 'MEMBER'), writer);
        expect(c.statusCode, `round ${i} create: ${c.body}`).toBeLessThan(500);
        expect(w.statusCode, `round ${i} ${kind}: ${w.body}`).toBe(200);
        const live = await prisma.groupInvite.count({ where: { groupId: f.groupId, status: 'PENDING', expiresAt: { gt: new Date() } } });
        if (c.statusCode === 200) {
          expect(live, `round ${i}`).toBe(1);
          expect(await inviteNotices(f), `round ${i}`).toBe(1);
        } else {
          expect(c.statusCode, `round ${i}: ${c.body}`).toBe(403);
          expect(live, `round ${i}`).toBe(0);
          expect(await inviteNotices(f), `round ${i}`).toBe(0);
        }
      }
    }, 180_000);
  }

  it('an invite vs the group turning PUBLIC', async () => {
    let created = 0;
    let refused = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-pub-${i}`);
      const [c, e] = await raceWithJitter(() => createInvite(f, f.owner, 'MEMBER'), () => editGroup(f, { isPrivate: false }));
      expect(c.statusCode, `round ${i} create: ${c.body}`).toBeLessThan(500);
      expect(e.statusCode, `round ${i} edit: ${e.body}`).toBe(200);
      const live = await prisma.groupInvite.count({ where: { groupId: f.groupId, status: 'PENDING', expiresAt: { gt: new Date() } } });
      if (c.statusCode === 200) {
        created++;
        expect(live, `round ${i}`).toBe(1);
      } else {
        refused++;
        expect(c.statusCode, `round ${i}: ${c.body}`).toBe(400);
        expect(errorMessage(c)).toBe('Invites are only available for private groups');
        expect(live, `round ${i}`).toBe(0);
        expect(await inviteNotices(f), `round ${i}`).toBe(0);
      }
    }
    console.log(`invite vs private->public edit: created=${created} refused=${refused}`);
  }, 180_000);
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
