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
  groupSnapshot,
  inviteSnapshot,
  ipAllocator,
  membershipSnapshot,
  uniqueSuffix,
} from '../test/group-admission-fixtures.js';

// Wrapping the activity intake (calling straight through) lets a test say
// "no activity/reward call ran" without sleeping.
vi.mock('../rewards/activity-service', async (importOriginal) => {
  const actual = await importOriginal<typeof ActivityModule>();
  return { ...actual, safeRecordActivity: vi.fn(actual.safeRecordActivity) };
});

// GROUP DELETION versus the actor's ownership.
//
// DELETE /groups/:id judged "is the caller the OWNER?" once, with a plain read
// BEFORE its transaction. An owner who transferred ownership after that read — and
// before the transaction took the group row — was by then an ADMIN, yet the
// transaction (which re-checked nothing) removed every member, invite, message
// and competition of a group they no longer owned. There is no undo for a deletion.
//
// The fix (see group-locks.ts): inside the transaction, after the group row is
// locked FOR UPDATE (level 2 — which is also what excludes a transfer, an edit
// and every admission for the whole transaction), re-read the owner from the
// LOCKED row and lock and re-read the ACTOR's own membership row (level 4): the
// caller must be the group's ownerId AND an ACTIVE OWNER member. Otherwise
// nothing is deleted.
//
// Every schedule is FORCED, never raced: a test-held lock parks the request at a
// known point, and pg_stat_activity PROVES it is parked there before the competing
// writer is let through (see test/pg-locks.ts). The randomized section only adds
// breadth: it asserts coherence, never an ordering.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gda-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(78);

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
  /** An ACTIVE member: the target of an ownership transfer, and a row to park on. */
  target: User;
  groupId: string;
  ownerMemberId: string;
  targetMemberId: string;
  inviteId: string;
  messageId: string;
}

async function makeFixture(tag: string): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const admin = await createUser(EMAIL_PREFIX, `${tag}-adm`);
  const target = await createUser(EMAIL_PREFIX, `${tag}-tgt`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `DelAuth-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  const ownerRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: admin.id, role: 'ADMIN', status: 'ACTIVE' } });
  const targetRow = await prisma.groupMember.create({ data: { groupId: group.id, userId: target.id, role: 'MEMBER', status: 'ACTIVE' } });
  // Things a deletion would take with it (members, invites, messages): each must survive a REFUSED one.
  const invite = await prisma.groupInvite.create({
    data: {
      groupId: group.id,
      email: `${EMAIL_PREFIX}outsider-${uniqueSuffix()}@test.local`,
      role: 'MEMBER',
      status: 'PENDING',
      token: `gdatok-${uniqueSuffix()}${uniqueSuffix()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
      invitedBy: owner.id,
    },
  });
  const message = await prisma.message.create({ data: { groupId: group.id, userId: owner.id, content: 'hello', type: 'TEXT' } });
  return { owner, admin, target, groupId: group.id, ownerMemberId: ownerRow.id, targetMemberId: targetRow.id, inviteId: invite.id, messageId: message.id };
}

const asUser = (user: User) => ({ authorization: `Bearer ${signToken(user)}` });

const deleteGroup = (f: Fixture, as: User) =>
  server.inject({ method: 'DELETE', url: `${PREFIX}/${f.groupId}`, headers: asUser(as), remoteAddress: nextIp() });
const transfer = (f: Fixture, from: User, to: User) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/transfer`, headers: asUser(from), payload: { targetUserId: to.id }, remoteAddress: nextIp() });

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const holdRow = (tx: Held, table: 'group_members' | 'users' | 'groups', id: string) =>
  tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

const LOCK_GROUP_UPDATE = '%FROM "groups"%FOR UPDATE%';
const ACTOR_LOCK = '%FROM "group_members"%FOR SHARE%';
const MEMBER_UPDATE = '%UPDATE "public"."group_members"%';
const MEMBER_DELETE = '%DELETE FROM%group_members%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';

interface World {
  group: Awaited<ReturnType<typeof groupSnapshot>>;
  members: Array<{ id: string; xmin: string }>;
  invite: Awaited<ReturnType<typeof inviteSnapshot>>;
  message: { id: string; xmin: string } | null;
}

/** Everything a deletion would remove, with xmin (which changes on ANY write to a row). */
async function world(f: Fixture): Promise<World> {
  const members = await prisma.$queryRaw<{ id: string; xmin: string }[]>`
    SELECT id, xmin::text AS xmin FROM group_members WHERE "groupId" = ${f.groupId} ORDER BY id
  `;
  const messages = await prisma.$queryRaw<{ id: string; xmin: string }[]>`
    SELECT id, xmin::text AS xmin FROM messages WHERE id = ${f.messageId}
  `;
  return { group: await groupSnapshot(f.groupId), members, invite: await inviteSnapshot(f.inviteId), message: messages[0] ?? null };
}

/**
 * The REFUSED deletion removed NOTHING. `changed` names the rows a competing transfer legitimately rewrote (the group row,
 * the old and the new owner's member rows); every other row must be byte for byte as it was (xmin included).
 */
function expectSurvived(before: World, after: World, changed: { groupRewritten: boolean; memberIdsRewritten: string[] }) {
  expect(after.group, 'the group survived').not.toBeNull();
  if (!changed.groupRewritten) expect(after.group).toEqual(before.group);
  expect(after.members.map((m) => m.id), 'every member row survived').toEqual(before.members.map((m) => m.id));
  for (const m of after.members) {
    if (changed.memberIdsRewritten.includes(m.id)) continue;
    expect(m.xmin, `member ${m.id} untouched`).toBe(before.members.find((b) => b.id === m.id)?.xmin);
  }
  expect(after.invite, 'the invite survived untouched').toEqual(before.invite);
  expect(after.message, 'the message survived untouched').toEqual(before.message);
}

async function expectOneOwnerMatchingGroup(groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return;
  const owners = await prisma.groupMember.findMany({ where: { groupId, role: 'OWNER', status: 'ACTIVE' } });
  expect(owners.length, 'ACTIVE OWNER rows').toBe(1);
  expect(owners[0].userId, 'the OWNER row matches groups.ownerId').toBe(group.ownerId);
}

const transferNotices = (f: Fixture) => prisma.notification.count({ where: { userId: { in: [f.owner.id, f.target.id] }, type: 'GROUP_OWNERSHIP_TRANSFERRED' } });

// ─── OWNERSHIP TRANSFER racing a deletion ─────────────────────────────────────

describeIf('group deletion vs an ownership transfer by the deleting owner', () => {
  it('transfer FIRST (parked holding the group row): the old owner\'s deletion waits at the GROUP row, then is refused — nothing is deleted', async () => {
    const f = await makeFixture('tr-first');
    const before = await world(f);
    let transferP: ReturnType<typeof transfer> | undefined;
    let deleteP: ReturnType<typeof deleteGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.ownerMemberId);
      transferP = transfer(f, f.owner, f.target);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // the transfer already holds the group row

      // The owner's fast-path check passes: they are still the OWNER.
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_UPDATE });
    }, tx30);

    const [t, d] = [await transferP!, await deleteP!];

    expect(t.statusCode, t.body).toBe(200);
    expect(d.statusCode, d.body).toBe(403);
    expect(errorMessage(d)).toBe('Insufficient permissions');
    const after = await world(f);
    // The transfer rewrote the group row and the two owners' member rows; the refused deletion wrote nothing.
    expectSurvived(before, after, { groupRewritten: true, memberIdsRewritten: [f.ownerMemberId, f.targetMemberId] });
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.target.id);
    expect((await membershipSnapshot(f.groupId, f.owner.id))?.role).toBe('ADMIN');
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);

  it('the same stale action through a DIRECT database transfer, committed while the deletion waits at the group row', async () => {
    const f = await makeFixture('tr-direct');
    const before = await world(f);
    let deleteP: ReturnType<typeof deleteGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_UPDATE });
      await tx.group.update({ where: { id: f.groupId }, data: { ownerId: f.target.id } });
      await tx.groupMember.update({ where: { id: f.ownerMemberId }, data: { role: 'ADMIN' } });
      await tx.groupMember.update({ where: { id: f.targetMemberId }, data: { role: 'OWNER' } });
    }, tx30);

    const d = await deleteP!;

    expect(d.statusCode, d.body).toBe(403);
    expect(errorMessage(d)).toBe('Insufficient permissions');
    expectSurvived(before, await world(f), { groupRewritten: true, memberIdsRewritten: [f.ownerMemberId, f.targetMemberId] });
  }, 60_000);

  it('the group\'s ownerId moved on (an external update) while the deletion waits, though the caller\'s member row still says OWNER: refused too', async () => {
    const f = await makeFixture('owner-column');
    const before = await world(f);
    let deleteP: ReturnType<typeof deleteGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_UPDATE });
      await tx.group.update({ where: { id: f.groupId }, data: { ownerId: f.target.id } });
    }, tx30);

    const d = await deleteP!;

    expect(d.statusCode, d.body).toBe(403);
    expect(errorMessage(d)).toBe('Insufficient permissions');
    expectSurvived(before, await world(f), { groupRewritten: true, memberIdsRewritten: [] });
  }, 60_000);

  it('a demoted OWNER row (role changed by an external writer) while the deletion waits: refused, nothing deleted', async () => {
    const f = await makeFixture('owner-row');
    const before = await world(f);
    let deleteP: ReturnType<typeof deleteGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_UPDATE });
      await tx.groupMember.update({ where: { id: f.ownerMemberId }, data: { role: 'ADMIN' } });
    }, tx30);

    const d = await deleteP!;

    expect(d.statusCode, d.body).toBe(403);
    expect(errorMessage(d)).toBe('Insufficient permissions');
    expectSurvived(before, await world(f), { groupRewritten: false, memberIdsRewritten: [f.ownerMemberId] });
  }, 60_000);

  it('an external writer that does NOT take the group row demotes the OWNER row while the deletion waits at the AUTHORITY lock: refused, nothing deleted', async () => {
    const f = await makeFixture('owner-row-external');
    const before = await world(f);
    let deleteP: ReturnType<typeof deleteGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      // An uncommitted role change of the owner's row (say, an operator's UPDATE): no route writes an OWNER row
      // without the group row, so only a LOCKED read of the actor's own row can see it coming. The deletion has
      // the group row (free) and parks on the authority lock.
      await tx.groupMember.update({ where: { id: f.ownerMemberId }, data: { role: 'ADMIN' } });
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: ACTOR_LOCK });
    }, tx30);

    const d = await deleteP!;

    expect(d.statusCode, d.body).toBe(403);
    expect(errorMessage(d)).toBe('Insufficient permissions');
    expectSurvived(before, await world(f), { groupRewritten: false, memberIdsRewritten: [f.ownerMemberId] });
  }, 60_000);

  it('REVERSE: the deletion goes first (parked at the member rows, holding the group row and the owner\'s row); the transfer WAITS at the group row, and finds nothing to transfer', async () => {
    const f = await makeFixture('del-first');
    let deleteP: ReturnType<typeof deleteGroup> | undefined;
    let transferP: ReturnType<typeof transfer> | undefined;

    await prisma.$transaction(async (tx) => {
      // Park the deletion at the removal of the members: the target's row is held here.
      await holdRow(tx, 'group_members', f.targetMemberId);
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_DELETE });

      transferP = transfer(f, f.owner, f.target); // its fast-path checks pass: the group still exists
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [d, t] = [await deleteP!, await transferP!];

    // Serial order: the deletion, then a transfer of a group that is gone.
    expect(d.statusCode, d.body).toBe(200);
    expect(t.statusCode, t.body).toBe(409);
    expect(errorMessage(t)).toBe('Concurrent ownership change detected; please retry');
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    expect(await prisma.groupMember.count({ where: { groupId: f.groupId } })).toBe(0);
    expect(await transferNotices(f)).toBe(0);
  }, 60_000);

  it('the NEW owner can delete after the transfer (the check is on the current owner, not the first one)', async () => {
    const f = await makeFixture('new-owner');
    expect((await transfer(f, f.owner, f.target)).statusCode).toBe(200);

    const stale = await deleteGroup(f, f.owner);
    const resp = await deleteGroup(f, f.target);

    expect(stale.statusCode).toBe(403);
    expect(resp.statusCode, resp.body).toBe(200);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    expect(await prisma.groupMember.count({ where: { groupId: f.groupId } })).toBe(0);
    expect(await prisma.groupInvite.count({ where: { groupId: f.groupId } })).toBe(0);
    expect(await prisma.message.count({ where: { groupId: f.groupId } })).toBe(0);
  }, 60_000);
});

// ─── lock order ───────────────────────────────────────────────────────────────

describeIf('group deletion — lock order: group row (2) FOR UPDATE, THEN the authority row (4), then every member row', () => {
  it('a NEW deletion by the owner completes (members, invites and messages all go) when nothing races it', async () => {
    const f = await makeFixture('normal');

    const resp = await deleteGroup(f, f.owner);

    expect(resp.statusCode, resp.body).toBe(200);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    expect(await prisma.groupMember.count({ where: { groupId: f.groupId } })).toBe(0);
    expect(await prisma.groupInvite.count({ where: { groupId: f.groupId } })).toBe(0);
    expect(await prisma.message.count({ where: { groupId: f.groupId } })).toBe(0);
  });

  it('an ADMIN and a plain member are still refused before the transaction', async () => {
    const f = await makeFixture('non-owner');
    const before = await world(f);

    const asAdmin = await deleteGroup(f, f.admin);
    const asMember = await deleteGroup(f, f.target);

    expect(asAdmin.statusCode).toBe(403);
    expect(errorMessage(asAdmin)).toBe('Insufficient permissions');
    expect(asMember.statusCode).toBe(403);
    expectSurvived(before, await world(f), { groupRewritten: false, memberIdsRewritten: [] });
  });

  it('two deletions of the same group by the owner: one wins, the other is a clean 404 (never a 500)', async () => {
    const f = await makeFixture('del-del');
    const [a, b] = await Promise.all([deleteGroup(f, f.owner), deleteGroup(f, f.owner)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0], `${a.body} ${b.body}`).toBe(200);
    expect(statuses[1], `${a.body} ${b.body}`).toBeLessThan(500);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  });

  it('a deletion parked at the member rows holds the group row: an EDIT (and the members\' own writers) cannot slip in — and nothing cycles', async () => {
    const f = await makeFixture('del-edit');
    let deleteP: ReturnType<typeof deleteGroup> | undefined;
    let editP: Promise<{ statusCode: number; body: string }> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.targetMemberId);
      deleteP = deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: MEMBER_DELETE });
      editP = server.inject({ method: 'PUT', url: `${PREFIX}/${f.groupId}`, headers: asUser(f.owner), payload: { name: `Renamed-${uniqueSuffix().slice(0, 6)}` }, remoteAddress: nextIp() });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [d, e] = [await deleteP!, await editP!];

    expect(d.statusCode, d.body).toBe(200);
    // The edit found a group that is gone: a controlled 4xx, not a deadlock.
    expect(e.statusCode, e.body).toBeLessThan(500);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  }, 60_000);
});

// ─── randomized breadth ───────────────────────────────────────────────────────

describeIf('randomized breadth: whichever order wins, nothing 500s and a former owner never deletes', () => {
  const ROUNDS = 25;

  it('deletion vs an ownership transfer by the same owner: never BOTH succeed', async () => {
    let deleted = 0;
    let transferred = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-tr-${i}`);
      const [d, t] = await raceWithJitter(() => deleteGroup(f, f.owner), () => transfer(f, f.owner, f.target));
      expect(d.statusCode, `round ${i} delete: ${d.body}`).toBeLessThan(500);
      expect(t.statusCode, `round ${i} transfer: ${t.body}`).toBeLessThan(500);
      // If both were 200 a FORMER owner deleted the group after handing it over.
      expect(d.statusCode === 200 && t.statusCode === 200, `round ${i}: delete=${d.statusCode} transfer=${t.statusCode}`).toBe(false);
      if (d.statusCode === 200) {
        deleted++;
        expect(await prisma.group.findUnique({ where: { id: f.groupId } }), `round ${i}`).toBeNull();
      } else {
        expect(d.statusCode, `round ${i}: ${d.body}`).toBe(403);
        transferred++;
        expect(t.statusCode, `round ${i}: ${t.body}`).toBe(200);
        expect(await prisma.group.findUnique({ where: { id: f.groupId } }), `round ${i}`).not.toBeNull();
        expect(await prisma.groupMember.count({ where: { groupId: f.groupId } }), `round ${i}`).toBe(3);
        expect(await prisma.groupInvite.findUnique({ where: { id: f.inviteId } }), `round ${i}`).not.toBeNull();
        expect(await prisma.message.findUnique({ where: { id: f.messageId } }), `round ${i}`).not.toBeNull();
      }
      await expectOneOwnerMatchingGroup(f.groupId);
    }
    console.log(`delete vs transfer: deleted=${deleted} transferredFirst=${transferred}`);
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
