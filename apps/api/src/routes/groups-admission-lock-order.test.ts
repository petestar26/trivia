import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { waitForBlockedBackends, waitForWaitEvent } from '../test/pg-locks.js';
import {
  cleanFixtures,
  createUser,
  inviteSnapshot,
  ipAllocator,
  membershipSnapshot,
  uniqueSuffix,
} from '../test/group-admission-fixtures.js';

// ADMISSION versus the other group writers: one global lock order, no deadlock.
//
// Acceptance and join approval now hold the group row FOR SHARE from before any
// member, invite or advisory lock until commit (group-locks.ts, level 2). That
// only stays deadlock-free if every writer that takes the group row in a
// CONFLICTING mode takes it FIRST. The writer audit found two that did not
// arrange to:
//
//   - group DELETE removed the members BEFORE taking the group row — the inverse
//     of transfer (group row, then members) and of admission. A delete holding
//     member rows and waiting for the group row, against an admission holding
//     the group row and waiting for a member row, is a deadlock (PostgreSQL
//     40P01, a 500 for whichever request the server picked as the victim).
//   - invite CREATION replaced a stale invite (a row lock) and only then
//     INSERTed a new one, whose foreign key wants FOR KEY SHARE on the group
//     row — while a DELETE already held that row FOR UPDATE and was waiting for
//     the stale invite through the cascade. The same cycle, from the other side.
//
// Every schedule below is FORCED: a test-held lock, or a scoped pause inside one
// statement, parks a request at a known point; pg_stat_activity PROVES it is
// parked there (or mid-statement) before the next request is fired. The final
// randomized section only adds breadth on top of that: it never asserts an
// ordering, only that whatever order won, nothing 500s and the group keeps
// exactly one ACTIVE OWNER matching groups.ownerId.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'glo-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(72);

// The stale-invite replacement schedule needs the INSERT of the NEW invite to
// pause so "create holds the stale invite row and is about to insert" is a state
// the test can observe rather than a race it hopes to win. The trigger sleeps
// only for an invite created by the ROUTE (its expiry is seven days out; every
// fixture invite expires in a day or has already expired), for this file's
// fixture emails only, so it cannot slow anything else. It is dropped in
// afterAll, and defensively before it is created, in case a crashed run left it.
const SLOW_MS = 2500;
async function installSlowInsertTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS glo_slow_invite_insert ON group_invites`);
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION glo_slow_invite_insert() RETURNS trigger AS $$
    BEGIN
      IF NEW.email LIKE '${EMAIL_PREFIX}%' AND NEW."expiresAt" > now() + interval '6 days' THEN
        PERFORM pg_sleep(${SLOW_MS / 1000});
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `);
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER glo_slow_invite_insert BEFORE INSERT ON group_invites FOR EACH ROW EXECUTE FUNCTION glo_slow_invite_insert()`
  );
}
async function removeSlowInsertTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS glo_slow_invite_insert ON group_invites`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS glo_slow_invite_insert()`);
}

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
  await installSlowInsertTrigger();
});

afterAll(async () => {
  if (dbAvailable) {
    await removeSlowInsertTrigger();
    await cleanFixtures(EMAIL_PREFIX);
  }
  if (server) await server.close();
  await prisma.$disconnect();
});

type User = Awaited<ReturnType<typeof createUser>>;

function signToken(user: User): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Fixture {
  owner: User;
  /** An ACTIVE member: the target of an ownership transfer. */
  target: User;
  /** Holds an invitation to the group, and (optionally) an existing membership. */
  invitee: User;
  groupId: string;
  ownerMemberId: string;
  inviteeMemberId: string | null;
  inviteId: string;
  inviteToken: string;
}

async function makeFixture(tag: string, existing?: 'LEFT' | 'PENDING'): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const target = await createUser(EMAIL_PREFIX, `${tag}-tgt`);
  const invitee = await createUser(EMAIL_PREFIX, `${tag}-inv`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `Lock-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: true, status: 'ACTIVE' },
  });
  const ownerMember = await prisma.groupMember.create({
    data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
  });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: target.id, role: 'MEMBER', status: 'ACTIVE' } });
  let inviteeMemberId: string | null = null;
  if (existing) {
    const m = await prisma.groupMember.create({
      data: { groupId: group.id, userId: invitee.id, role: 'MEMBER', status: existing },
    });
    inviteeMemberId = m.id;
  }
  const inviteToken = `glotok-${uniqueSuffix()}${uniqueSuffix()}`;
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
  return { owner, target, invitee, groupId: group.id, ownerMemberId: ownerMember.id, inviteeMemberId, inviteId: invite.id, inviteToken };
}

const asUser = (user: User) => ({ authorization: `Bearer ${signToken(user)}` });

const accept = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/accept-invite`,
    headers: asUser(f.invitee),
    payload: { token: f.inviteToken },
    remoteAddress: nextIp(),
  });

const approve = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/requests/${f.invitee.id}/approve`,
    headers: asUser(f.owner),
    remoteAddress: nextIp(),
  });

const transfer = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/transfer`,
    headers: asUser(f.owner),
    payload: { targetUserId: f.target.id },
    remoteAddress: nextIp(),
  });

const deleteGroup = (f: Fixture) =>
  server.inject({ method: 'DELETE', url: `${PREFIX}/${f.groupId}`, headers: asUser(f.owner), remoteAddress: nextIp() });

const ban = (f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/members/${f.invitee.id}/ban`,
    headers: asUser(f.owner),
    remoteAddress: nextIp(),
  });

const createInvite = (f: Fixture, email: string) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/invites`,
    headers: asUser(f.owner),
    payload: { email },
    remoteAddress: nextIp(),
  });

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;

/** The group's invariant: exactly one ACTIVE OWNER, and it is groups.ownerId. */
async function expectOneOwnerMatchingGroup(groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return; // deleted: nothing left to violate
  const owners = await prisma.groupMember.findMany({ where: { groupId, role: 'OWNER', status: 'ACTIVE' } });
  expect(owners.length, 'ACTIVE OWNER rows').toBe(1);
  expect(owners[0].userId, 'the OWNER row matches groups.ownerId').toBe(group.ownerId);
}

const acceptanceNotices = (f: Fixture) =>
  prisma.notification.count({ where: { userId: f.owner.id, type: 'GROUP_INVITE_ACCEPTED' } });

const LOCK_GROUP_SHARE = '%FROM "groups"%FOR SHARE%';
const LOCK_GROUP_UPDATE = '%FROM "groups"%FOR UPDATE%';
const GROUP_MEMBER_WRITE = '%UPDATE "public"."group_members"%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';
const tx30 = { timeout: 30_000, maxWait: 30_000 };

type Held = Prisma.TransactionClient;
const holdMember = (tx: Held, id: string) => tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${id} FOR UPDATE`;
const holdInvite = (tx: Held, id: string) => tx.$queryRaw`SELECT "id" FROM "group_invites" WHERE "id" = ${id} FOR UPDATE`;

describeIf('acceptance x ownership transfer', () => {
  it('transfer takes the group row FIRST: an acceptance that arrives while it is parked waits at the group row, then is admitted', async () => {
    const f = await makeFixture('tr-first');
    let transferP: ReturnType<typeof transfer> | undefined;
    let acceptP: ReturnType<typeof accept> | undefined;

    await prisma.$transaction(async (tx) => {
      // Park the transfer at its demotion of the old owner: it has already
      // updated the group row (the ownerId guard), and holds it.
      await holdMember(tx, f.ownerMemberId);
      transferP = transfer(f);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_MEMBER_WRITE });

      acceptP = accept(f);
      acceptP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_SHARE });
    }, tx30);

    const [t, a] = [await transferP!, await acceptP!];

    expect(t.statusCode, t.body).toBe(200);
    expect(a.statusCode, a.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.invitee.id))?.status).toBe('ACTIVE');
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.target.id);
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);

  it('acceptance takes the group row FIRST: a transfer that arrives while it is parked waits at the group row, then completes', async () => {
    const f = await makeFixture('acc-first');
    let acceptP: ReturnType<typeof accept> | undefined;
    let transferP: ReturnType<typeof transfer> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdInvite(tx, f.inviteId); // park the acceptance at its invite claim
      acceptP = accept(f);
      acceptP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: '%"group_invites"%' });

      transferP = transfer(f);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [a, t] = [await acceptP!, await transferP!];

    expect(a.statusCode, a.body).toBe(200);
    expect(t.statusCode, t.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.invitee.id))?.status).toBe('ACTIVE');
    expect((await inviteSnapshot(f.inviteId))?.status).toBe('ACCEPTED');
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.target.id);
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);

  it('approval takes the group row FIRST: a transfer that arrives while it is parked waits, then completes', async () => {
    const f = await makeFixture('appr-first', 'PENDING');
    let approveP: ReturnType<typeof approve> | undefined;
    let transferP: ReturnType<typeof transfer> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.inviteeMemberId!); // park the approval at its membership write
      approveP = approve(f);
      approveP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_MEMBER_WRITE });

      transferP = transfer(f);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
    }, tx30);

    const [a, t] = [await approveP!, await transferP!];

    expect(a.statusCode, a.body).toBe(200);
    expect(t.statusCode, t.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.invitee.id))?.status).toBe('ACTIVE');
    await expectOneOwnerMatchingGroup(f.groupId);
  }, 60_000);
});

describeIf('admission x group DELETE — the delete takes the group row before any member row', () => {
  it('delete parked at a member row, acceptance arrives: the acceptance waits at the GROUP row — no deadlock — and is refused once the group is gone', async () => {
    const f = await makeFixture('del-first', 'LEFT');
    let deleteP: ReturnType<typeof deleteGroup> | undefined;
    let acceptP: ReturnType<typeof accept> | undefined;

    await prisma.$transaction(async (tx) => {
      // The delete is parked FIRST, at a member row it cannot lock yet. If it had
      // already deleted the group row's siblings without taking the group row, the
      // acceptance below would get the group row and then queue for the SAME member
      // row behind the delete: a cycle.
      await holdMember(tx, f.inviteeMemberId!);
      deleteP = deleteGroup(f);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: '%DELETE FROM%group_members%' });

      acceptP = accept(f);
      acceptP.catch(() => undefined);
      // Two backends are parked: the delete (member row) and the acceptance.
      await waitForBlockedBackends(2);
    }, tx30);

    const [d, a] = [await deleteP!, await acceptP!];

    // The point: neither request was chosen as a deadlock victim.
    expect(d.statusCode, `delete: ${d.body}`).toBeLessThan(500);
    expect(a.statusCode, `accept: ${a.body}`).toBeLessThan(500);
    // A coherent serial order: the delete first, then an acceptance into nothing.
    expect(d.statusCode).toBe(200);
    expect(a.statusCode).toBe(400);
    expect(errorMessage(a)).toBe('Group is not active');
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    expect(await acceptanceNotices(f)).toBe(0);
  }, 60_000);

  it('approval arrives while the delete is parked at a member row: the approval waits at the GROUP row, and is refused once the group is gone', async () => {
    const f = await makeFixture('del-first-appr', 'PENDING');
    let deleteP: ReturnType<typeof deleteGroup> | undefined;
    let approveP: ReturnType<typeof approve> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.inviteeMemberId!);
      deleteP = deleteGroup(f);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: '%DELETE FROM%group_members%' });

      approveP = approve(f);
      approveP.catch(() => undefined);
      await waitForBlockedBackends(2);
    }, tx30);

    const [d, a] = [await deleteP!, await approveP!];

    expect(d.statusCode, `delete: ${d.body}`).toBeLessThan(500);
    expect(a.statusCode, `approve: ${a.body}`).toBeLessThan(500);
    expect(d.statusCode).toBe(200);
    expect(a.statusCode).toBe(400);
    expect(errorMessage(a)).toBe('Group is not active');
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  }, 60_000);

  it('acceptance parked at the member row FIRST, delete arrives: the delete waits at the GROUP row; the acceptance is admitted, then the group goes', async () => {
    const f = await makeFixture('acc-first-del', 'LEFT');
    let acceptP: ReturnType<typeof accept> | undefined;
    let deleteP: ReturnType<typeof deleteGroup> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdMember(tx, f.inviteeMemberId!);
      acceptP = accept(f);
      acceptP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: GROUP_MEMBER_WRITE });

      deleteP = deleteGroup(f);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_UPDATE });
    }, tx30);

    const [a, d] = [await acceptP!, await deleteP!];

    expect(a.statusCode, `accept: ${a.body}`).toBe(200);
    expect(d.statusCode, `delete: ${d.body}`).toBe(200);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  }, 60_000);

  it('two DELETEs of the same group: one wins, the other is a clean 404 (not a Prisma error surfaced as a 500)', async () => {
    const f = await makeFixture('del-del');
    const [a, b] = await Promise.all([deleteGroup(f), deleteGroup(f)]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses[0], `${a.body} ${b.body}`).toBe(200);
    expect(statuses[1], `${a.body} ${b.body}`).toBeLessThan(500);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  }, 60_000);

  it('a delete and a transfer racing for the same owner never deadlock (both order the group row before the member rows)', async () => {
    for (let round = 0; round < 12; round++) {
      const f = await makeFixture(`del-tr-${round}`);
      const [d, t] = await raceWithJitter(() => deleteGroup(f), () => transfer(f));
      expect(d.statusCode, `round ${round} delete: ${d.body}`).toBeLessThan(500);
      expect(t.statusCode, `round ${round} transfer: ${t.body}`).toBeLessThan(500);
      await expectOneOwnerMatchingGroup(f.groupId);
    }
  }, 120_000);
});

describeIf('invite CREATION — the stale-invite replacement and the group row', () => {
  /** A stale PENDING invite (its expiry passed) that creating a replacement closes out. */
  async function staleFixture(tag: string) {
    const f = await makeFixture(tag);
    await prisma.groupInvite.update({
      where: { id: f.inviteId },
      data: { expiresAt: new Date(Date.now() - 3_600_000) },
    });
    return f;
  }

  it('creation paused inside its INSERT (stale invite closed out, group row held), delete arrives: the delete waits, both complete, no deadlock', async () => {
    const f = await staleFixture('cr-del');

    // The replacement's INSERT is paused by the trigger, after the stale invite
    // was UPDATEd (its row lock is held) and before the INSERT's foreign key asks
    // for the group row.
    const createP = createInvite(f, f.invitee.email!);
    createP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: '%INSERT INTO "public"."group_invites"%' });

    const deleteP = deleteGroup(f);
    deleteP.catch(() => undefined);
    await waitForBlockedBackends(1);

    const [c, d] = [await createP, await deleteP];

    // Without the group row taken first the delete held it FOR UPDATE and waited
    // for the stale invite, while the INSERT waited for the group row: 40P01.
    expect(c.statusCode, `create: ${c.body}`).toBeLessThan(500);
    expect(d.statusCode, `delete: ${d.body}`).toBeLessThan(500);
    expect(c.statusCode).toBe(200);
    expect(d.statusCode).toBe(200);
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  }, 60_000);

  it('creation paused inside its INSERT, an external ARCHIVE arrives: it waits for the group lock; the invite is created, then the group is archived', async () => {
    const f = await staleFixture('cr-arch');

    const createP = createInvite(f, f.invitee.email!);
    createP.catch(() => undefined);
    await waitForWaitEvent('PgSleep', { queryLike: '%INSERT INTO "public"."group_invites"%' });

    const archiveP = prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    archiveP.catch(() => undefined);
    await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });

    const c = await createP;
    await archiveP;

    expect(c.statusCode, c.body).toBe(200);
    expect(await prisma.groupInvite.count({ where: { groupId: f.groupId, email: f.invitee.email!.toLowerCase(), status: 'PENDING' } })).toBe(1);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).status).toBe('ARCHIVED');
  }, 60_000);

  it('the group is archived while creation waits on the group row: refused under the lock, the stale invite untouched, nothing announced', async () => {
    const f = await staleFixture('cr-locked');
    const before = await inviteSnapshot(f.inviteId);
    let pending: ReturnType<typeof createInvite> | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "groups" WHERE "id" = ${f.groupId} FOR UPDATE`;
      pending = createInvite(f, f.invitee.email!);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_SHARE });
      await tx.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode).toBe(400);
    expect(errorMessage(resp)).toBe('Group is not active');
    expect(await inviteSnapshot(f.inviteId)).toEqual(before);
    expect(await prisma.groupInvite.count({ where: { groupId: f.groupId } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: f.invitee.id, type: 'GROUP_INVITE' } })).toBe(0);
  }, 60_000);

  it('an ordinary creation still works (the group lock does not over-reject)', async () => {
    const f = await makeFixture('cr-control');
    const other = await createUser(EMAIL_PREFIX, 'cr-control-new');
    const resp = await createInvite(f, other.email!);
    expect(resp.statusCode, resp.body).toBe(200);
  }, 60_000);
});

/**
 * Start two operations a random 0-30 ms apart, in a random order, and wait for
 * both. Firing both in the same tick tends to let the same side win every round
 * (the pool services them in a fixed order); a random stagger sweeps the
 * interleaving across the whole transaction of the one that starts first.
 */
async function raceWithJitter<A, B>(first: () => PromiseLike<A>, second: () => PromiseLike<B>): Promise<[A, B]> {
  // Prisma queries are LAZY: they run only once something calls .then on them.
  // Promise.resolve does that at once, so each side really starts when meant to.
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

describeIf('randomized breadth: whichever order wins, nothing 500s and the group keeps one OWNER', () => {
  // One round in flight at a time gives genuine, independently-timed racing
  // inside the round (a batch of rounds in one Promise.all serializes in the
  // pool). What is asserted is never an ordering — only coherence.
  const ROUNDS = 25;

  it('acceptance vs an external ARCHIVE', async () => {
    let admitted = 0;
    let refused = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-arch-${i}`);
      const [a] = await raceWithJitter(
        () => accept(f),
        () => prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } })
      );
      expect(a.statusCode, `round ${i}: ${a.body}`).toBeLessThan(500);
      const membership = await membershipSnapshot(f.groupId, f.invitee.id);
      const invite = await inviteSnapshot(f.inviteId);
      if (a.statusCode === 200) {
        admitted++;
        expect(membership?.status).toBe('ACTIVE');
        expect(invite?.status).toBe('ACCEPTED');
      } else {
        refused++;
        expect(a.statusCode).toBe(400);
        expect(errorMessage(a)).toBe('Group is not active');
        expect(membership).toBeNull();
        expect(invite?.status).toBe('PENDING');
        expect(await acceptanceNotices(f)).toBe(0);
      }
      expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).status).toBe('ARCHIVED');
      await expectOneOwnerMatchingGroup(f.groupId);
    }
    console.log(`acceptance vs archive: admitted=${admitted} refused=${refused}`);
  }, 180_000);

  it('acceptance vs ownership transfer', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-tr-${i}`);
      const [a, t] = await raceWithJitter(() => accept(f), () => transfer(f));
      expect(a.statusCode, `round ${i} accept: ${a.body}`).toBe(200);
      expect(t.statusCode, `round ${i} transfer: ${t.body}`).toBe(200);
      expect((await membershipSnapshot(f.groupId, f.invitee.id))?.status).toBe('ACTIVE');
      await expectOneOwnerMatchingGroup(f.groupId);
    }
  }, 180_000);

  it('acceptance vs group DELETE', async () => {
    let admittedThenDeleted = 0;
    let deletedFirst = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-del-${i}`, i % 2 === 0 ? 'LEFT' : undefined);
      const [a, d] = await raceWithJitter(() => accept(f), () => deleteGroup(f));
      expect(a.statusCode, `round ${i} accept: ${a.body}`).toBeLessThan(500);
      expect(d.statusCode, `round ${i} delete: ${d.body}`).toBe(200);
      // 200: admitted, then deleted. 400: the delete took the group row first
      // (and the invite with it) after the acceptance's own reads. 404: the delete
      // had already committed before the acceptance even looked the invite up.
      expect([200, 400, 404], `round ${i} accept`).toContain(a.statusCode);
      if (a.statusCode === 200) admittedThenDeleted++;
      else {
        deletedFirst++;
        expect(errorMessage(a)).toBe(a.statusCode === 400 ? 'Group is not active' : 'Invalid invite token');
      }
      expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    }
    console.log(`acceptance vs delete: admittedThenDeleted=${admittedThenDeleted} deletedFirst=${deletedFirst}`);
  }, 180_000);

  it('acceptance vs a BAN of the invitee', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-ban-${i}`, 'LEFT');
      const [a, b] = await raceWithJitter(() => accept(f), () => ban(f));
      expect(a.statusCode, `round ${i} accept: ${a.body}`).toBeLessThan(500);
      expect(b.statusCode, `round ${i} ban: ${b.body}`).toBeLessThan(500);
      const invite = await inviteSnapshot(f.inviteId);
      const membership = await membershipSnapshot(f.groupId, f.invitee.id);
      if (a.statusCode === 200) expect(invite?.status, `round ${i}`).toBe('ACCEPTED');
      else expect(invite?.status, `round ${i}`).not.toBe('ACCEPTED');
      // A ban that landed leaves the member BANNED and no live invite behind.
      if (membership?.status === 'BANNED') expect(invite?.status, `round ${i}`).not.toBe('PENDING');
      await expectOneOwnerMatchingGroup(f.groupId);
    }
  }, 180_000);

  it('approval vs an external ARCHIVE', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture(`rz-appr-${i}`, 'PENDING');
      const [a] = await raceWithJitter(
        () => approve(f),
        () => prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } })
      );
      expect(a.statusCode, `round ${i}: ${a.body}`).toBeLessThan(500);
      const membership = await membershipSnapshot(f.groupId, f.invitee.id);
      if (a.statusCode === 200) expect(membership?.status).toBe('ACTIVE');
      else {
        expect(errorMessage(a)).toBe('Group is not active');
        expect(membership?.status).toBe('PENDING');
      }
      await expectOneOwnerMatchingGroup(f.groupId);
    }
  }, 180_000);
});
