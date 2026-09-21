import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';
import {
  cleanFixtures,
  createUser,
  inviteSnapshot,
  ipAllocator,
  membershipSnapshot,
  uniqueSuffix,
} from '../test/group-admission-fixtures.js';

// PUBLIC JOIN and REQUEST TO JOIN versus every other writer of the group: one
// global lock order, no deadlock.
//
// Both routes now take the caller's users row (level 1) and the group row
// FOR SHARE (level 2) FIRST, then write ONE membership row (level 4) — and, for
// a request, insert the manager notifications (level 6). They take no
// (group, email) advisory lock (level 3) and no invite row (level 5): a
// membership transition is a guarded UPDATE/INSERT of a single row, so a ban or
// an unban that races it is ordered by that row itself (see group-locks.ts).
//
// That only stays deadlock-free if every writer that takes the group row in a
// CONFLICTING mode (transfer, delete, edit) takes it before any member row, which
// the previous change arranged. These schedules force the interleavings that
// would expose a cycle — the other writer already inside its transaction, the
// join/request already inside its own — and prove with pg_stat_activity that each
// side is really parked where the schedule says, then that both complete.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below also carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'gjo-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(75);

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (dbAvailable) await cleanFixtures(EMAIL_PREFIX);
  if (server) await server.close();
  await prisma.$disconnect();
});

type User = Awaited<ReturnType<typeof createUser>>;
type Held = Prisma.TransactionClient;
type Kind = 'join' | 'request';

function signToken(user: User): string {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface Fixture {
  owner: User;
  /** An ACTIVE member: the target of an ownership transfer. */
  target: User;
  /** The account that joins / requests. */
  caller: User;
  groupId: string;
  ownerMemberId: string;
  callerMemberId: string | null;
}

/** A PUBLIC group for `join`, a PRIVATE one for `request`; the caller has a LEFT membership when `existing`. */
async function makeFixture(kind: Kind, tag: string, existing = false): Promise<Fixture> {
  const owner = await createUser(EMAIL_PREFIX, `${tag}-own`);
  const target = await createUser(EMAIL_PREFIX, `${tag}-tgt`);
  const caller = await createUser(EMAIL_PREFIX, `${tag}-cal`);
  const group = await prisma.group.create({
    data: { ownerId: owner.id, name: `JLock-${tag}-${uniqueSuffix().slice(0, 6)}`, isPrivate: kind === 'request', status: 'ACTIVE' },
  });
  const ownerMember = await prisma.groupMember.create({ data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' } });
  await prisma.groupMember.create({ data: { groupId: group.id, userId: target.id, role: 'MEMBER', status: 'ACTIVE' } });
  let callerMemberId: string | null = null;
  if (existing) {
    const m = await prisma.groupMember.create({ data: { groupId: group.id, userId: caller.id, role: 'MEMBER', status: 'LEFT' } });
    callerMemberId = m.id;
  }
  return { owner, target, caller, groupId: group.id, ownerMemberId: ownerMember.id, callerMemberId };
}

const enter = (kind: Kind, f: Fixture) =>
  server.inject({
    method: 'POST',
    url: `${PREFIX}/${f.groupId}/${kind === 'join' ? 'join' : 'request'}`,
    headers: { authorization: `Bearer ${signToken(f.caller)}` },
    remoteAddress: nextIp(),
  });

const asOwner = (f: Fixture) => ({ authorization: `Bearer ${signToken(f.owner)}` });

const transfer = (f: Fixture) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/transfer`, headers: asOwner(f), payload: { targetUserId: f.target.id }, remoteAddress: nextIp() });
const deleteGroup = (f: Fixture) =>
  server.inject({ method: 'DELETE', url: `${PREFIX}/${f.groupId}`, headers: asOwner(f), remoteAddress: nextIp() });
const editGroup = (f: Fixture, name: string) =>
  server.inject({ method: 'PUT', url: `${PREFIX}/${f.groupId}`, headers: asOwner(f), payload: { name }, remoteAddress: nextIp() });
const unban = (f: Fixture) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/members/${f.caller.id}/unban`, headers: asOwner(f), remoteAddress: nextIp() });
const createInvite = (f: Fixture, email: string) =>
  server.inject({ method: 'POST', url: `${PREFIX}/${f.groupId}/invites`, headers: asOwner(f), payload: { email }, remoteAddress: nextIp() });

const errorMessage = (resp: { body: string }) => JSON.parse(resp.body).error?.message as string;
const tx30 = { timeout: 30_000, maxWait: 30_000 };
const holdMember = (tx: Held, id: string) => tx.$queryRaw`SELECT "id" FROM "group_members" WHERE "id" = ${id} FOR UPDATE`;

const LOCK_GROUP_SHARE = '%FROM "groups"%FOR SHARE%';
const LOCK_GROUP_UPDATE = '%FROM "groups"%FOR UPDATE%';
const MEMBER_UPDATE = '%UPDATE "public"."group_members"%';
const GROUP_WRITE = '%UPDATE "public"."groups"%';

const ENTERED_STATUS: Record<Kind, string> = { join: 'ACTIVE', request: 'PENDING' };

/** The group's invariant: exactly one ACTIVE OWNER, and it is groups.ownerId. */
async function expectOneOwnerMatchingGroup(groupId: string) {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) return; // deleted: nothing left to violate
  const owners = await prisma.groupMember.findMany({ where: { groupId, role: 'OWNER', status: 'ACTIVE' } });
  expect(owners.length, 'ACTIVE OWNER rows').toBe(1);
  expect(owners[0].userId, 'the OWNER row matches groups.ownerId').toBe(group.ownerId);
}

for (const kind of ['join', 'request'] as const) {
  describeIf(`${kind} x ownership transfer`, () => {
    it('transfer takes the group row FIRST (parked at the old owner\'s member row): the caller waits at the GROUP row, then completes; one OWNER remains', async () => {
      const f = await makeFixture(kind, `${kind}-tr1`);
      let transferP: ReturnType<typeof transfer> | undefined;
      let callP: ReturnType<typeof enter> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdMember(tx, f.ownerMemberId);
        transferP = transfer(f);
        transferP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE }); // it already holds the group row

        callP = enter(kind, f);
        callP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_SHARE });
      }, tx30);

      const [t, c] = [await transferP!, await callP!];

      expect(t.statusCode, t.body).toBe(200);
      expect(c.statusCode, c.body).toBe(200);
      expect((await membershipSnapshot(f.groupId, f.caller.id))?.status).toBe(ENTERED_STATUS[kind]);
      await expectOneOwnerMatchingGroup(f.groupId);
    }, 60_000);

    it(`the ${kind} takes the group row FIRST (parked at its member write): a transfer waits at the GROUP row, then completes; one OWNER remains`, async () => {
      const f = await makeFixture(kind, `${kind}-tr2`, true);
      let callP: ReturnType<typeof enter> | undefined;
      let transferP: ReturnType<typeof transfer> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdMember(tx, f.callerMemberId!);
        callP = enter(kind, f);
        callP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

        transferP = transfer(f);
        transferP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
      }, tx30);

      const [c, t] = [await callP!, await transferP!];

      expect(c.statusCode, c.body).toBe(200);
      expect(t.statusCode, t.body).toBe(200);
      expect((await membershipSnapshot(f.groupId, f.caller.id))?.status).toBe(ENTERED_STATUS[kind]);
      await expectOneOwnerMatchingGroup(f.groupId);
    }, 60_000);
  });

  describeIf(`${kind} x group DELETE`, () => {
    it('delete parked at a member row (it holds the group row FOR UPDATE), the caller arrives: the caller waits at the GROUP row — no deadlock — and is refused once the group is gone', async () => {
      const f = await makeFixture(kind, `${kind}-del1`, true);
      let deleteP: ReturnType<typeof deleteGroup> | undefined;
      let callP: ReturnType<typeof enter> | undefined;

      await prisma.$transaction(async (tx) => {
        // The delete is parked FIRST, at a member row it cannot lock yet. Had it removed
        // members before taking the group row, the caller below would get the group
        // row and then queue for the SAME member row behind it: a cycle.
        await holdMember(tx, f.callerMemberId!);
        deleteP = deleteGroup(f);
        deleteP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: '%DELETE FROM%group_members%' });

        callP = enter(kind, f);
        callP.catch(() => undefined);
        await waitForBlockedBackends(2);
      }, tx30);

      const [d, c] = [await deleteP!, await callP!];

      expect(d.statusCode, `delete: ${d.body}`).toBeLessThan(500);
      expect(c.statusCode, `${kind}: ${c.body}`).toBeLessThan(500);
      expect(d.statusCode).toBe(200);
      expect(c.statusCode).toBe(400);
      expect(errorMessage(c)).toBe('Group is not active');
      expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    }, 60_000);

    it(`the ${kind} parked at its member write FIRST, the delete arrives: the delete waits at the GROUP row; the caller is admitted, then the group goes`, async () => {
      const f = await makeFixture(kind, `${kind}-del2`, true);
      let callP: ReturnType<typeof enter> | undefined;
      let deleteP: ReturnType<typeof deleteGroup> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdMember(tx, f.callerMemberId!);
        callP = enter(kind, f);
        callP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

        deleteP = deleteGroup(f);
        deleteP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP_UPDATE });
      }, tx30);

      const [c, d] = [await callP!, await deleteP!];

      expect(c.statusCode, `${kind}: ${c.body}`).toBe(200);
      expect(d.statusCode, `delete: ${d.body}`).toBe(200);
      expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    }, 60_000);
  });

  describeIf(`${kind} x group EDIT`, () => {
    it(`the ${kind} parked at its member write, an edit of the group arrives: the edit waits behind the group lock, both complete`, async () => {
      const f = await makeFixture(kind, `${kind}-edit`, true);
      let callP: ReturnType<typeof enter> | undefined;
      let editP: ReturnType<typeof editGroup> | undefined;
      const renamed = `Edited-${uniqueSuffix().slice(0, 8)}`;

      await prisma.$transaction(async (tx) => {
        await holdMember(tx, f.callerMemberId!);
        callP = enter(kind, f);
        callP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_UPDATE });

        editP = editGroup(f, renamed);
        editP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: GROUP_WRITE });
      }, tx30);

      const [c, e] = [await callP!, await editP!];

      expect(c.statusCode, `${kind}: ${c.body}`).toBe(200);
      expect(e.statusCode, `edit: ${e.body}`).toBe(200);
      expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).name).toBe(renamed);
    }, 60_000);
  });
}

describeIf('randomized breadth: whichever order wins, nothing 500s and the group keeps one OWNER', () => {
  // One round in flight at a time gives genuine, independently-timed racing
  // inside the round. What is asserted is never an ordering — only coherence.
  const ROUNDS = 20;

  for (const kind of ['join', 'request'] as const) {
    it(`${kind} vs ownership transfer`, async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const f = await makeFixture(kind, `rz-${kind}-tr-${i}`, i % 2 === 0);
        const [c, t] = await raceWithJitter(() => enter(kind, f), () => transfer(f));
        expect(c.statusCode, `round ${i} ${kind}: ${c.body}`).toBe(200);
        expect(t.statusCode, `round ${i} transfer: ${t.body}`).toBe(200);
        expect((await membershipSnapshot(f.groupId, f.caller.id))?.status).toBe(ENTERED_STATUS[kind]);
        await expectOneOwnerMatchingGroup(f.groupId);
      }
    }, 180_000);

    it(`${kind} vs group DELETE`, async () => {
      let entered = 0;
      let deletedFirst = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const f = await makeFixture(kind, `rz-${kind}-del-${i}`, i % 2 === 0);
        const [c, d] = await raceWithJitter(() => enter(kind, f), () => deleteGroup(f));
        expect(c.statusCode, `round ${i} ${kind}: ${c.body}`).toBeLessThan(500);
        expect(d.statusCode, `round ${i} delete: ${d.body}`).toBe(200);
        // 200: entered, then deleted. 400: the delete took the group row first, after the
        // caller's own reads. 404: the delete had already committed before the caller even
        // looked the group up.
        expect([200, 400, 404], `round ${i} ${kind}`).toContain(c.statusCode);
        if (c.statusCode === 200) entered++;
        else {
          deletedFirst++;
          expect(errorMessage(c)).toBe(c.statusCode === 400 ? 'Group is not active' : 'Group not found');
        }
        expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
      }
      console.log(`${kind} vs delete: enteredThenDeleted=${entered} deletedFirst=${deletedFirst}`);
    }, 180_000);

    it(`${kind} vs an external ARCHIVE`, async () => {
      let entered = 0;
      let refused = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const f = await makeFixture(kind, `rz-${kind}-arch-${i}`, i % 2 === 0);
        const [c] = await raceWithJitter(
          () => enter(kind, f),
          () => prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } })
        );
        expect(c.statusCode, `round ${i} ${kind}: ${c.body}`).toBeLessThan(500);
        const row = await membershipSnapshot(f.groupId, f.caller.id);
        if (c.statusCode === 200) {
          entered++;
          expect(row?.status).toBe(ENTERED_STATUS[kind]);
        } else {
          refused++;
          expect(c.statusCode).toBe(400);
          expect(errorMessage(c)).toBe('Group is not active');
          // Refused: nothing was written — no row at all, or the LEFT row exactly as it was.
          if (i % 2 === 0) expect(row?.status).toBe('LEFT');
          else expect(row).toBeNull();
        }
      }
      console.log(`${kind} vs archive: entered=${entered} refused=${refused}`);
    }, 180_000);

    it(`${kind} vs an external ACCOUNT restriction`, async () => {
      let entered = 0;
      let refused = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const f = await makeFixture(kind, `rz-${kind}-acct-${i}`, i % 2 === 0);
        const [c] = await raceWithJitter(
          () => enter(kind, f),
          () => prisma.user.update({ where: { id: f.caller.id }, data: { status: 'SUSPENDED' } })
        );
        expect(c.statusCode, `round ${i} ${kind}: ${c.body}`).toBeLessThan(500);
        const row = await membershipSnapshot(f.groupId, f.caller.id);
        if (c.statusCode === 200) {
          entered++;
          expect(row?.status).toBe(ENTERED_STATUS[kind]);
        } else {
          refused++;
          expect(c.statusCode).toBe(403);
          if (i % 2 === 0) expect(row?.status).toBe('LEFT');
          else expect(row).toBeNull();
        }
      }
      console.log(`${kind} vs suspension: entered=${entered} refused=${refused}`);
    }, 180_000);
  }

  it('join vs UNBAN of a banned member: no 500, and a member is ACTIVE only if the unban committed', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture('join', `rz-unban-${i}`, false);
      const m = await prisma.groupMember.create({ data: { groupId: f.groupId, userId: f.caller.id, role: 'MEMBER', status: 'BANNED' } });
      const [j, u] = await raceWithJitter(() => enter('join', f), () => unban(f));
      expect(j.statusCode, `round ${i} join: ${j.body}`).toBeLessThan(500);
      expect(u.statusCode, `round ${i} unban: ${u.body}`).toBe(200);
      const row = await prisma.groupMember.findUniqueOrThrow({ where: { id: m.id } });
      // 403: refused while still banned (the member is LEFT once the unban lands). 200: the
      // unban committed first and the join then admitted them.
      expect([200, 403], `round ${i} join`).toContain(j.statusCode);
      expect(row.status, `round ${i}`).toBe(j.statusCode === 200 ? 'ACTIVE' : 'LEFT');
    }
  }, 180_000);

  it('request vs CREATING an invite for the same account: both complete, no 500', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture('request', `rz-invite-${i}`, i % 2 === 0);
      const [r, c] = await raceWithJitter(() => enter('request', f), () => createInvite(f, f.caller.email!));
      expect(r.statusCode, `round ${i} request: ${r.body}`).toBe(200);
      expect(c.statusCode, `round ${i} invite: ${c.body}`).toBe(200);
      expect((await membershipSnapshot(f.groupId, f.caller.id))?.status).toBe('PENDING');
    }
  }, 180_000);

  it('request vs ACCEPTING an invite for the same account: no 500, and the final state is coherent', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await makeFixture('request', `rz-accept-${i}`, true);
      const token = `gjotok-${uniqueSuffix()}${uniqueSuffix()}`;
      const invite = await prisma.groupInvite.create({
        data: {
          groupId: f.groupId,
          email: f.caller.email!.toLowerCase(),
          role: 'MEMBER',
          status: 'PENDING',
          token,
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedBy: f.owner.id,
        },
      });
      const [r, a] = await raceWithJitter(
        () => enter('request', f),
        () =>
          server.inject({
            method: 'POST',
            url: `${PREFIX}/accept-invite`,
            headers: { authorization: `Bearer ${signToken(f.caller)}` },
            payload: { token },
            remoteAddress: nextIp(),
          })
      );
      expect(r.statusCode, `round ${i} request: ${r.body}`).toBeLessThan(500);
      expect(a.statusCode, `round ${i} accept: ${a.body}`).toBeLessThan(500);
      const row = await membershipSnapshot(f.groupId, f.caller.id);
      const inv = await inviteSnapshot(invite.id);
      if (a.statusCode === 200) {
        expect(row?.status, `round ${i}`).toBe('ACTIVE');
        expect(inv?.status).toBe('ACCEPTED');
      } else {
        expect(inv?.status, `round ${i}`).toBe('PENDING');
        expect(row?.status, `round ${i}`).toBe(r.statusCode === 200 ? 'PENDING' : 'LEFT');
      }
    }
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
