import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { waitForBlockedBackends } from '../test/pg-locks.js';
import { cleanFixtures, inviteSnapshot, ipAllocator, membershipSnapshot, uniqueSuffix } from '../test/group-admission-fixtures.js';
import {
  authorityApi,
  errorMessage,
  makeAuthorityFixture,
  type AuthorityFixture,
  type AuthorityUser,
  type Res,
} from '../test/group-authority-fixtures.js';

// BAN, UNBAN, REMOVE MEMBER, CHANGE ROLE, REJECT and APPROVE — lock order, deadlock
// freedom, the group's state and the group's name.
//
// The companion suite (groups-moderation-authority.test.ts) proves that a manager who
// lost authority is refused. This one proves what the locks that make that possible
// must not do:
//
//   MUTUAL ACTIONS   Two managers acting on EACH OTHER (A bans B while B bans A; A removes B
//                    while B removes A; A demotes B while B demotes A) each need both rows.
//                    Locking "my own row first, then the other's" makes each hold the row the
//                    other is waiting for: PostgreSQL 40P01 and a 500. The actor's row and the
//                    target's are locked together, in ONE statement, in ascending id order, so
//                    they cannot. The schedule parks the two requests so that the old order
//                    would deadlock every time (see the comment there), and checks it for BOTH
//                    relative row orders.
//   SAME TARGET      Two managers acting on one target queue at its row; the second reads what
//                    the first left, and says so with a specific 4xx.
//   GROUP STATE      A group archived (or deleted) after the fast-path read is refused under the
//                    lock, nothing written.
//   GROUP NAME       The notification carries the name the locked group row has, not the one a
//                    read before the transaction saw.
//
// Every schedule is FORCED (a test-held lock, proven by pg_stat_activity), never raced; the
// randomized section at the end only adds breadth and asserts coherence, never an ordering.
//
// Own file: the API's global rate limit is IP-keyed and shared per server instance, and
// every request below carries a unique remoteAddress.

const EMAIL_PREFIX = 'gml-';
const GROUP_PREFIX = 'ModOrder-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(81);
const api = authorityApi(() => server, config.API_PREFIX, nextIp);

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

type Held = Prisma.TransactionClient;
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const holdRow = (tx: Held, table: 'group_members' | 'users' | 'groups', id: string) =>
  tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

const MEMBER_ROWS_LOCK = '%FROM "group_members"%FOR NO KEY UPDATE%';
const SUBJECT_LOCK = '%pg_advisory_xact_lock%';
const LOCK_GROUP = '%FROM "groups"%FOR SHARE%';

const notices = (userId: string, type?: Prisma.NotificationWhereInput['type']) => prisma.notification.count({ where: { userId, ...(type ? { type } : {}) } });
const fresh = (tag: string, opts: Parameters<typeof makeAuthorityFixture>[3] = {}) =>
  makeAuthorityFixture(EMAIL_PREFIX, GROUP_PREFIX, tag, opts);
const rowState = async (f: AuthorityFixture, user: AuthorityUser) => {
  const row = await membershipSnapshot(f.groupId, user.id);
  return row ? { status: row.status, role: row.role } : null;
};

// ─── MUTUAL ACTIONS ───────────────────────────────────────────────────────────

describeIf('MUTUAL ACTIONS: two managers acting on each other never deadlock — exactly one wins', () => {
  // A = f.admin, B = f.admin2. The test holds A's row. X (A acts on B) queues first and Y (B acts on
  // A) second, each PROVEN parked. Were each request to lock "its own row, then the other's", X
  // would hold nothing but wait for A, Y would take B's row and then wait for A: on release X gets
  // A and wants B, which Y holds, while Y wants A, which X holds — a cycle, 40P01, a 500. With both
  // rows locked in one statement in id order neither can hold one row while waiting for the
  // other, whichever of the two ids is lower (the swapped fixture reverses it).
  const kinds: Array<{
    name: string;
    act: (f: AuthorityFixture, as: AuthorityUser, target: AuthorityUser) => Promise<Res>;
    loserMessage: string;
    victim: { status: string; role: string } | null;
  }> = [
    { name: 'ban', act: (f, as, t) => api.ban(f, as, t), loserMessage: 'You are not a member of this group', victim: { status: 'BANNED', role: 'ADMIN' } },
    { name: 'remove', act: (f, as, t) => api.remove(f, as, t), loserMessage: 'You are not a member of this group', victim: null },
    { name: 'demote', act: (f, as, t) => api.role(f, as, t, 'MEMBER'), loserMessage: 'Insufficient permissions', victim: { status: 'ACTIVE', role: 'MEMBER' } },
  ];
  for (const swapped of [false, true]) {
    for (const kind of kinds) {
      it(`${kind.name} A→B vs ${kind.name} B→A (${swapped ? "B's row sorts first" : "A's row sorts first"}): the first to queue wins, the other is refused as no longer a manager — no 500`, async () => {
        const f = await fresh(`mu-${kind.name}-${swapped ? 's' : 'n'}`, { adminsSwapped: swapped });
        let x: Promise<Res> | undefined;
        let y: Promise<Res> | undefined;

        await prisma.$transaction(async (tx) => {
          await holdRow(tx, 'group_members', f.rows.admin);
          x = kind.act(f, f.admin, f.admin2);
          x.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK });
          y = kind.act(f, f.admin2, f.admin);
          y.catch(() => undefined);
          await waitForBlockedBackends(2, { queryLike: MEMBER_ROWS_LOCK });
        }, tx30);

        const [rx, ry] = [await x!, await y!];

        expect(rx.statusCode, `A→B: ${rx.body}`).toBe(200);
        expect(ry.statusCode, `B→A: ${ry.body}`).toBe(403);
        expect(errorMessage(ry)).toBe(kind.loserMessage);
        expect(await rowState(f, f.admin2)).toEqual(kind.victim); // B was the one acted on
        expect(await rowState(f, f.admin)).toEqual({ status: 'ACTIVE', role: 'ADMIN' }); // A was untouched
      }, 60_000);
    }
  }

  it('an approval and a rejection of the same request by the same manager never deadlock: the first to queue wins, the other is "not pending"', async () => {
    for (const [first, second] of [['approve', 'reject'], ['reject', 'approve']] as const) {
      const f = await fresh(`ar-${first}`);
      const run = (kind: 'approve' | 'reject') => (kind === 'approve' ? api.approve(f, f.admin, f.pending) : api.reject(f, f.admin, f.pending));
      let x: Promise<Res> | undefined;
      let y: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'group_members', f.rows.admin);
        x = run(first);
        x.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK });
        y = run(second);
        y.catch(() => undefined);
        await waitForBlockedBackends(2, { queryLike: MEMBER_ROWS_LOCK });
      }, tx30);

      const [rx, ry] = [await x!, await y!];

      expect(rx.statusCode, `${first}: ${rx.body}`).toBe(200);
      expect(ry.statusCode, `${second}: ${ry.body}`).toBe(400);
      expect(errorMessage(ry)).toBe('This request is not pending');
      expect(await notices(f.pending.id, first === 'approve' ? 'GROUP_APPROVED' : 'GROUP_REJECTED')).toBe(1);
      expect(await notices(f.pending.id, first === 'approve' ? 'GROUP_REJECTED' : 'GROUP_APPROVED')).toBe(0);
      expect(await rowState(f, f.pending)).toEqual(first === 'approve' ? { status: 'ACTIVE', role: 'MEMBER' } : null);
    }
  }, 120_000);
});

// ─── SAME TARGET ──────────────────────────────────────────────────────────────

describeIf('SAME TARGET: two managers acting on one member queue at its row; the second reads what the first left', () => {
  // The test holds the target's row; X queues first and Y second (each PROVEN parked, at the lock
  // on the manager's and the target's rows). Both managers are still managers, so neither is
  // refused for authority — the second is told what the first did.
  const scenarios: Array<{
    name: string;
    x: (f: AuthorityFixture) => Promise<Res>;
    y: (f: AuthorityFixture) => Promise<Res>;
    expectXY: (f: AuthorityFixture, x: Res, y: Res) => Promise<void>;
    target: (f: AuthorityFixture) => string;
    /** Where the SECOND request waits: a ban or an unban takes the (group, email) subject lock BEFORE the member rows, so a second one waits for the first at the subject lock. */
    secondWaitsIn?: string;
  }> = [
    {
      name: 'ban, then a ban by the other manager: the second is the idempotent replay',
      x: (f) => api.ban(f, f.admin, f.member),
      y: (f) => api.ban(f, f.admin2, f.member),
      target: (f) => f.rows.member,
      secondWaitsIn: SUBJECT_LOCK,
      expectXY: async (f, x, y) => {
        expect([x.statusCode, y.statusCode], `${x.body} | ${y.body}`).toEqual([200, 200]);
        expect(JSON.parse(x.body).data.message).toBe('Member banned');
        expect(JSON.parse(y.body).data.message).toBe('Member already banned');
        expect(await notices(f.member.id, 'MODERATION')).toBe(1); // told once
        expect((await inviteSnapshot(f.memberInviteId))?.status).toBe('REVOKED');
      },
    },
    {
      name: 'remove, then a role change: the second finds nobody',
      x: (f) => api.remove(f, f.admin, f.member),
      y: (f) => api.role(f, f.admin2, f.member, 'MODERATOR'),
      target: (f) => f.rows.member,
      expectXY: async (f, x, y) => {
        expect(x.statusCode, x.body).toBe(200);
        expect(y.statusCode, y.body).toBe(404);
        expect(errorMessage(y)).toBe('User is not a member of this group');
        expect(await membershipSnapshot(f.groupId, f.member.id)).toBeNull();
      },
    },
    {
      name: 'role change, then a removal: both go through, in that order',
      x: (f) => api.role(f, f.admin, f.member, 'MODERATOR'),
      y: (f) => api.remove(f, f.admin2, f.member),
      target: (f) => f.rows.member,
      expectXY: async (f, x, y) => {
        expect([x.statusCode, y.statusCode], `${x.body} | ${y.body}`).toEqual([200, 200]);
        expect(await membershipSnapshot(f.groupId, f.member.id)).toBeNull();
      },
    },
    {
      name: 'ban, then a removal of the banned row: both go through',
      x: (f) => api.ban(f, f.admin, f.member),
      y: (f) => api.remove(f, f.admin2, f.member),
      target: (f) => f.rows.member,
      expectXY: async (f, x, y) => {
        expect([x.statusCode, y.statusCode], `${x.body} | ${y.body}`).toEqual([200, 200]);
        expect(await membershipSnapshot(f.groupId, f.member.id)).toBeNull();
        expect(await notices(f.member.id, 'MODERATION')).toBe(1);
      },
    },
    {
      name: 'reject, then a rejection by the other manager: the second is "not pending"',
      x: (f) => api.reject(f, f.admin, f.pending),
      y: (f) => api.reject(f, f.admin2, f.pending),
      target: (f) => f.rows.pending,
      expectXY: async (f, x, y) => {
        expect(x.statusCode, x.body).toBe(200);
        expect(y.statusCode, y.body).toBe(400);
        expect(errorMessage(y)).toBe('This request is not pending');
        expect(await notices(f.pending.id, 'GROUP_REJECTED')).toBe(1);
      },
    },
    {
      name: 'unban, then an unban by the other manager: the second is "not banned"',
      x: (f) => api.unban(f, f.admin, f.banned),
      y: (f) => api.unban(f, f.admin2, f.banned),
      target: (f) => f.rows.banned,
      secondWaitsIn: SUBJECT_LOCK,
      expectXY: async (f, x, y) => {
        expect(x.statusCode, x.body).toBe(200);
        expect(y.statusCode, y.body).toBe(409);
        expect(errorMessage(y)).toBe('This member is not banned');
        expect(await notices(f.banned.id, 'MODERATION')).toBe(1);
      },
    },
  ];
  for (const s of scenarios) {
    it(s.name, async () => {
      const f = await fresh(`st-${s.name.slice(0, 8).replace(/\W+/g, '')}`);
      let x: Promise<Res> | undefined;
      let y: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'group_members', s.target(f));
        x = s.x(f);
        x.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK });
        y = s.y(f);
        y.catch(() => undefined);
        await waitForBlockedBackends(s.secondWaitsIn ? 1 : 2, { queryLike: s.secondWaitsIn ?? MEMBER_ROWS_LOCK });
      }, tx30);

      await s.expectXY(f, await x!, await y!);
    }, 60_000);
  }
});

// ─── GROUP STATE ──────────────────────────────────────────────────────────────

describeIf('GROUP STATE: a group archived or deleted after the fast-path read is refused under the group lock', () => {
  // The test holds the group row FOR UPDATE, the request passes its fast-path checks and parks at
  // the group lock (PROVEN), the test changes the group and commits.
  interface Case {
    name: string;
    fire: (f: AuthorityFixture) => Promise<Res>;
    snapshot: (f: AuthorityFixture) => Promise<Record<string, unknown>>;
  }
  const cases: Case[] = [
    {
      name: 'ban',
      fire: (f) => api.ban(f, f.admin, f.member),
      snapshot: async (f) => ({ member: await membershipSnapshot(f.groupId, f.member.id), invite: await inviteSnapshot(f.memberInviteId), notices: await notices(f.member.id) }),
    },
    {
      name: 'unban',
      fire: (f) => api.unban(f, f.admin, f.banned),
      snapshot: async (f) => ({ banned: await membershipSnapshot(f.groupId, f.banned.id), notices: await notices(f.banned.id) }),
    },
    {
      name: 'reject',
      fire: (f) => api.reject(f, f.admin, f.pending),
      snapshot: async (f) => ({ pending: await membershipSnapshot(f.groupId, f.pending.id), notices: await notices(f.pending.id) }),
    },
    {
      name: 'approve',
      fire: (f) => api.approve(f, f.admin, f.pending),
      snapshot: async (f) => ({ pending: await membershipSnapshot(f.groupId, f.pending.id), notices: await notices(f.pending.id) }),
    },
  ];

  for (const c of cases) {
    for (const status of ['ARCHIVED', 'INACTIVE', 'BANNED'] as const) {
      it(`${c.name}: the group becomes ${status} while the request waits at the group row: 400 "Group is not active", nothing written`, async () => {
        const f = await fresh(`gs-${c.name}-${status.slice(0, 3)}`);
        const before = await c.snapshot(f);
        let pending: Promise<Res> | undefined;

        await prisma.$transaction(async (tx) => {
          await holdRow(tx, 'groups', f.groupId);
          pending = c.fire(f);
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
          await tx.group.update({ where: { id: f.groupId }, data: { status } });
        }, tx30);

        const resp = await pending!;

        expect(resp.statusCode, resp.body).toBe(400);
        expect(errorMessage(resp)).toBe('Group is not active');
        expect(await c.snapshot(f)).toEqual(before);
      }, 60_000);
    }

    it(`${c.name}: the group is DELETED while the request waits at the group row: refused (an inactive group), nothing written`, async () => {
      const f = await fresh(`gd-${c.name}`);
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'groups', f.groupId);
        pending = c.fire(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        await tx.group.delete({ where: { id: f.groupId } });
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(400);
      expect(errorMessage(resp)).toBe('Group is not active');
      expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
      expect(await prisma.notification.count({ where: { userId: { in: [f.member.id, f.banned.id, f.pending.id] } } })).toBe(0);
    }, 60_000);
  }

  it('remove and change role never needed an ACTIVE group: an ARCHIVED group still lets a manager do both (unchanged)', async () => {
    const f = await fresh('archived-ok');
    await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });

    const role = await api.role(f, f.admin, f.member, 'MODERATOR');
    const remove = await api.remove(f, f.admin, f.peer);

    expect([role.statusCode, remove.statusCode], `${role.body} | ${remove.body}`).toEqual([200, 200]);
  }, 60_000);

  for (const [name, fire] of [
    ['remove member', (f: AuthorityFixture) => api.remove(f, f.admin, f.member)],
    ['change role', (f: AuthorityFixture) => api.role(f, f.admin, f.member, 'MODERATOR')],
  ] as const) {
    it(`${name}: the group is DELETED while the request waits at the group row: 404 "Group not found"`, async () => {
      const f = await fresh(`gd-${name.slice(0, 3)}`);
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'groups', f.groupId);
        pending = fire(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        await tx.group.delete({ where: { id: f.groupId } });
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(404);
      expect(errorMessage(resp)).toBe('Group not found');
    }, 60_000);
  }
});

// ─── GROUP NAME ───────────────────────────────────────────────────────────────

describeIf("GROUP NAME: the notification carries the name the LOCKED group row has", () => {
  // The route read the group before its transaction (the fast path) and used that name in the
  // message. A rename that commits while the request waits at the group row is what the member is
  // then told about.
  const cases: Array<{ name: string; fire: (f: AuthorityFixture) => Promise<Res>; who: (f: AuthorityFixture) => AuthorityUser; text: (n: string) => string }> = [
    { name: 'ban', fire: (f) => api.ban(f, f.admin, f.member), who: (f) => f.member, text: (n) => `You have been banned from "${n}"` },
    { name: 'unban', fire: (f) => api.unban(f, f.admin, f.banned), who: (f) => f.banned, text: (n) => `You are no longer banned from "${n}". You may request to join again.` },
  ];
  for (const c of cases) {
    it(`${c.name}: a rename that commits while the request waits is what the member is told`, async () => {
      const f = await fresh(`nm-${c.name}`);
      const renamed = `${GROUP_PREFIX}Renamed-${uniqueSuffix().slice(0, 8)}`;
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'groups', f.groupId);
        pending = c.fire(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: LOCK_GROUP });
        await tx.group.update({ where: { id: f.groupId }, data: { name: renamed } });
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(200);
      const notification = await prisma.notification.findFirstOrThrow({ where: { userId: c.who(f).id, type: 'MODERATION' } });
      expect(notification.body).toBe(c.text(renamed));
      expect(notification.body).not.toContain(f.groupName);
    }, 60_000);
  }
});

// ─── randomized breadth ───────────────────────────────────────────────────────

describeIf('randomized breadth: whichever order wins, nothing 500s and the outcomes are coherent', () => {
  // One round in flight at a time gives genuine, independently-timed racing inside the round.
  // What is asserted is never an ordering — only coherence: the action either went through (200,
  // every effect) or was refused as a lost authority (403, nothing written), and the writer always lands.
  const ROUNDS = 12;
  const actions: Array<{
    name: string;
    fire: (f: AuthorityFixture) => Promise<Res>;
    snapshot: (f: AuthorityFixture) => Promise<Record<string, unknown>>;
    done: (f: AuthorityFixture) => Promise<void>;
  }> = [
    {
      name: 'ban',
      fire: (f) => api.ban(f, f.admin, f.member),
      snapshot: async (f) => ({ member: await membershipSnapshot(f.groupId, f.member.id), invite: await inviteSnapshot(f.memberInviteId), notices: await notices(f.member.id) }),
      done: async (f) => {
        expect((await membershipSnapshot(f.groupId, f.member.id))?.status).toBe('BANNED');
        expect((await inviteSnapshot(f.memberInviteId))?.status).toBe('REVOKED');
        expect(await notices(f.member.id, 'MODERATION')).toBe(1);
      },
    },
    {
      name: 'unban',
      fire: (f) => api.unban(f, f.admin, f.banned),
      snapshot: async (f) => ({ banned: await membershipSnapshot(f.groupId, f.banned.id), notices: await notices(f.banned.id) }),
      done: async (f) => {
        expect(await rowState(f, f.banned)).toEqual({ status: 'LEFT', role: 'MEMBER' });
        expect(await notices(f.banned.id, 'MODERATION')).toBe(1);
      },
    },
    {
      name: 'remove',
      fire: (f) => api.remove(f, f.admin, f.member),
      snapshot: async (f) => ({ member: await membershipSnapshot(f.groupId, f.member.id) }),
      done: async (f) => expect(await membershipSnapshot(f.groupId, f.member.id)).toBeNull(),
    },
    {
      name: 'role',
      fire: (f) => api.role(f, f.admin, f.member, 'MODERATOR'),
      snapshot: async (f) => ({ member: await membershipSnapshot(f.groupId, f.member.id) }),
      done: async (f) => expect(await rowState(f, f.member)).toEqual({ status: 'ACTIVE', role: 'MODERATOR' }),
    },
    {
      name: 'reject',
      fire: (f) => api.reject(f, f.admin, f.pending),
      snapshot: async (f) => ({ pending: await membershipSnapshot(f.groupId, f.pending.id), notices: await notices(f.pending.id) }),
      done: async (f) => {
        expect(await membershipSnapshot(f.groupId, f.pending.id)).toBeNull();
        expect(await notices(f.pending.id, 'GROUP_REJECTED')).toBe(1);
      },
    },
    {
      name: 'approve',
      fire: (f) => api.approve(f, f.admin, f.pending),
      snapshot: async (f) => ({ pending: await membershipSnapshot(f.groupId, f.pending.id), notices: await notices(f.pending.id) }),
      done: async (f) => {
        expect((await rowState(f, f.pending))?.status).toBe('ACTIVE');
        expect(await notices(f.pending.id, 'GROUP_APPROVED')).toBe(1);
      },
    },
  ];
  const writers: Array<{ name: string; go: (f: AuthorityFixture) => Promise<Res>; final: { status: string; role: string } | null }> = [
    { name: 'demotion', go: (f) => api.role(f, f.owner, f.admin, 'MEMBER'), final: { status: 'ACTIVE', role: 'MEMBER' } },
    { name: 'ban', go: (f) => api.ban(f, f.owner, f.admin), final: { status: 'BANNED', role: 'ADMIN' } },
    { name: 'leave', go: (f) => api.leave(f, f.admin), final: { status: 'LEFT', role: 'ADMIN' } },
    { name: 'removal', go: (f) => api.remove(f, f.owner, f.admin), final: null },
  ];

  for (const action of actions) {
    for (const writer of writers) {
      it(`${action.name} vs the manager's ${writer.name}`, async () => {
        let went = 0;
        let refused = 0;
        for (let i = 0; i < ROUNDS; i++) {
          const f = await fresh(`rz-${action.name.slice(0, 3)}-${writer.name.slice(0, 3)}-${i}`);
          const before = await action.snapshot(f);
          const [a, w] = await raceWithJitter(() => action.fire(f), () => writer.go(f));
          expect(a.statusCode, `round ${i} ${action.name}: ${a.body}`).toBeLessThan(500);
          expect(w.statusCode, `round ${i} ${writer.name}: ${w.body}`).toBeLessThan(500);
          expect(w.statusCode, `round ${i} ${writer.name}: ${w.body}`).toBe(200);
          expect(await rowState(f, f.admin), `round ${i}`).toEqual(writer.final);
          if (a.statusCode === 200) {
            went++;
            await action.done(f);
          } else {
            refused++;
            expect(a.statusCode, `round ${i} ${action.name}: ${a.body}`).toBe(403);
            expect(await action.snapshot(f), `round ${i}: a refused ${action.name} left something behind`).toEqual(before);
          }
        }
        console.log(`${action.name} vs ${writer.name}: went through=${went} refused=${refused}`);
      }, 180_000);
    }
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
