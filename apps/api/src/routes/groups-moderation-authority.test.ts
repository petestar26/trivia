import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { ROW_LOCK_WAITS, waitForBlockedBackends } from '../test/pg-locks.js';
import { cleanFixtures, inviteSnapshot, ipAllocator, membershipSnapshot } from '../test/group-admission-fixtures.js';
import {
  authorityApi,
  authorityLosses,
  errorMessage,
  makeAuthorityFixture,
  managerRow,
  SQL,
  type AuthorityFixture,
  type AuthorityUser,
  type Res,
} from '../test/group-authority-fixtures.js';
import { holdWriteGate, installWriteGate, removeWriteGate } from '../test/group-write-gate.js';

// BAN, UNBAN, REMOVE MEMBER, CHANGE ROLE and REJECT REQUEST versus the ACTOR's own
// authority.
//
// Each of these routes judged the manager once, with a plain read BEFORE its
// transaction (and the group's status with another), and then wrote. A manager
// demoted, banned, muted, removed — or who left — after that read and before the
// write still completed the action: a demoted admin banned a member, a removed one
// removed another, a banned one rejected a request, and every one of them announced
// it to the affected member on an authority they no longer had.
//
// The fix (group-locks.ts, through the one shared authorizeManagerAction in
// groups.ts): inside the transaction, lock the group row FOR SHARE, then — after
// the (group, email) subject lock, where the action has one — the ACTOR's row and
// the TARGET's together, in ascending id order, and re-read the actor's role and
// status, the target's row and the group's status and name from those rows. Every
// lock is held to commit. A demotion, ban, leave or removal of the manager then
// either commits BEFORE the action's lock is granted (the action is refused, nothing
// written) or waits behind it (it was legitimately authorized at its serialization
// point).
//
// Every schedule is FORCED, never raced: a test-held lock (or the write gate, see
// test/group-write-gate.ts) parks the request at a known point and pg_stat_activity
// PROVES it is parked there before the competing writer is let through. The
// competing writers go through their REAL routes. What a refused action must not
// have written is asserted byte for byte (xmin included), not by looking at a field.
//
// The four schedules, for every action and every way the manager can lose authority:
//   FORWARD   the request has passed its fast-path checks and waits at the TARGET's
//             row; the loss commits; the request is released and is refused.
//   QUEUED    the request and the loss queue at the MANAGER's row, the loss first;
//             the request is refused once it gets the row.
//   EXTERNAL  a writer that bypasses the routes (and so the group lock) holds an
//             uncommitted change of the manager's row; the request waits on THAT ROW.
//   REVERSE   the request holds all of its locks (it is parked inside its own write);
//             the loss is seen WAITING behind them, and applies after.
//
// Own file: the API's global rate limit is IP-keyed and shared per server instance,
// and every request below carries a unique remoteAddress.

const EMAIL_PREFIX = 'gma-';
const GROUP_PREFIX = 'ModAuth-';
const GATE = 'gma_write_gate';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(80);
const api = authorityApi(() => server, config.API_PREFIX, nextIp);
const losses = authorityLosses(api);

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
  await installWriteGate(GATE, GROUP_PREFIX);
});

afterAll(async () => {
  if (dbAvailable) {
    await removeWriteGate(GATE);
    await cleanFixtures(EMAIL_PREFIX);
  }
  if (server) await server.close();
  await prisma.$disconnect();
});

type Held = Prisma.TransactionClient;
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const holdRow = (tx: Held, table: 'group_members' | 'users' | 'groups', id: string) =>
  tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

/** The lock on the manager's and the target's rows, in one statement (group-locks.ts, level 4). */
const { memberRowsLock: MEMBER_ROWS_LOCK, memberUpdate: MEMBER_UPDATE, memberDelete: MEMBER_DELETE } = SQL;

const notices = (userId: string, type?: Prisma.NotificationWhereInput['type']) => prisma.notification.count({ where: { userId, ...(type ? { type } : {}) } });

// ─── the five actions ─────────────────────────────────────────────────────────

interface Action {
  name: string;
  fire: (f: AuthorityFixture, as: AuthorityUser) => Promise<Res>;
  /** Hold, from a test transaction, the lock a request for this action waits at (the target's row). */
  park: (tx: Held, f: AuthorityFixture) => Promise<unknown>;
  /** The write the write gate parks in a REVERSE schedule. */
  gateWrite: string;
  /** Everything a REFUSED action must not have changed, exactly as stored (xmin included). */
  snapshot: (f: AuthorityFixture) => Promise<Record<string, unknown>>;
  /** The action WENT THROUGH: 200 and every effect it has. */
  done: (f: AuthorityFixture, resp: Res) => Promise<void>;
}

const actions: Action[] = [
  {
    name: 'ban',
    fire: (f, as) => api.ban(f, as, f.member),
    park: (tx, f) => holdRow(tx, 'group_members', f.rows.member),
    gateWrite: MEMBER_UPDATE,
    snapshot: async (f) => ({
      member: await membershipSnapshot(f.groupId, f.member.id),
      // a ban revokes the target's PENDING invites: a refused one must leave them exactly as they were
      invite: await inviteSnapshot(f.memberInviteId),
      notices: await notices(f.member.id),
    }),
    done: async (f, resp) => {
      expect(resp.statusCode, resp.body).toBe(200);
      expect(JSON.parse(resp.body).data.message).toBe('Member banned');
      expect((await membershipSnapshot(f.groupId, f.member.id))?.status).toBe('BANNED');
      expect((await inviteSnapshot(f.memberInviteId))?.status).toBe('REVOKED');
      expect(await notices(f.member.id, 'MODERATION')).toBe(1);
    },
  },
  {
    name: 'unban',
    fire: (f, as) => api.unban(f, as, f.banned),
    park: (tx, f) => holdRow(tx, 'group_members', f.rows.banned),
    gateWrite: MEMBER_UPDATE,
    snapshot: async (f) => ({
      banned: await membershipSnapshot(f.groupId, f.banned.id),
      notices: await notices(f.banned.id),
    }),
    done: async (f, resp) => {
      expect(resp.statusCode, resp.body).toBe(200);
      expect(JSON.parse(resp.body).data.message).toBe('Member unbanned');
      const row = await membershipSnapshot(f.groupId, f.banned.id);
      expect({ status: row?.status, role: row?.role }).toEqual({ status: 'LEFT', role: 'MEMBER' });
      expect(await notices(f.banned.id, 'MODERATION')).toBe(1);
    },
  },
  {
    name: 'remove member',
    fire: (f, as) => api.remove(f, as, f.member),
    park: (tx, f) => holdRow(tx, 'group_members', f.rows.member),
    gateWrite: MEMBER_DELETE,
    snapshot: async (f) => ({ member: await membershipSnapshot(f.groupId, f.member.id) }),
    done: async (f, resp) => {
      expect(resp.statusCode, resp.body).toBe(200);
      expect(await membershipSnapshot(f.groupId, f.member.id)).toBeNull();
    },
  },
  {
    name: 'change role',
    fire: (f, as) => api.role(f, as, f.member, 'MODERATOR'),
    park: (tx, f) => holdRow(tx, 'group_members', f.rows.member),
    gateWrite: MEMBER_UPDATE,
    snapshot: async (f) => ({ member: await membershipSnapshot(f.groupId, f.member.id) }),
    done: async (f, resp) => {
      expect(resp.statusCode, resp.body).toBe(200);
      const row = await membershipSnapshot(f.groupId, f.member.id);
      expect({ status: row?.status, role: row?.role }).toEqual({ status: 'ACTIVE', role: 'MODERATOR' });
    },
  },
  {
    name: 'reject request',
    fire: (f, as) => api.reject(f, as, f.pending),
    park: (tx, f) => holdRow(tx, 'group_members', f.rows.pending),
    gateWrite: MEMBER_DELETE,
    snapshot: async (f) => ({
      pending: await membershipSnapshot(f.groupId, f.pending.id),
      notices: await notices(f.pending.id),
    }),
    done: async (f, resp) => {
      expect(resp.statusCode, resp.body).toBe(200);
      expect(await membershipSnapshot(f.groupId, f.pending.id)).toBeNull();
      expect(await notices(f.pending.id, 'GROUP_REJECTED')).toBe(1);
    },
  },
];

// ─── the ways the manager (an ADMIN) loses authority: authorityLosses() in test/group-authority-fixtures.ts ───

const fresh = (tag: string, opts: Parameters<typeof makeAuthorityFixture>[3] = {}) =>
  makeAuthorityFixture(EMAIL_PREFIX, GROUP_PREFIX, tag, opts);

/** How many statements matching `pattern` are parked once the request AND the writer are: both wait in the same kind of statement, or not. */
const parkedWhenBoth = (a: string, b: string) => (a === b ? 2 : 1);

// ─── FORWARD ──────────────────────────────────────────────────────────────────

describeIf('FORWARD: a manager whose authority ended after the fast-path read cannot complete the action', () => {
  // The request has passed every fast-path check — the manager was still an ADMIN — and is
  // parked at the TARGET's row, which sorts BEFORE the manager's, so it holds nothing on the
  // manager. The loss goes through its real route and COMMITS; only then is the request released.
  for (const action of actions) {
    for (const loss of losses) {
      it(`${action.name}: the manager is ${loss.name} while the request waits at the target's row: refused (403 "${loss.message}"), nothing written`, async () => {
        const f = await fresh(`fw-${action.name.slice(0, 3)}-${loss.name.slice(0, 5).replace(/\W+/g, '')}`);
        const before = await action.snapshot(f);
        let pending: Promise<Res> | undefined;

        await prisma.$transaction(async (tx) => {
          await action.park(tx, f);
          pending = action.fire(f, f.admin);
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK });

          const resp = await loss.happen(f);
          expect(resp.statusCode, `${loss.name}: ${resp.body}`).toBe(200);
        }, tx30);

        const resp = await pending!;

        expect(resp.statusCode, resp.body).toBe(403);
        expect(errorMessage(resp)).toBe(loss.message);
        expect(await managerRow(f)).toEqual(loss.row);
        expect(await action.snapshot(f)).toEqual(before);
      }, 60_000);
    }
  }
});

// ─── QUEUED ───────────────────────────────────────────────────────────────────

describeIf("QUEUED: the request waits on the MANAGER's row behind a writer that queued first", () => {
  // The test holds the manager's row. The loss queues at it first, the request second (each PROVEN
  // parked). On release the loss commits and the request — whose lock request was behind it —
  // re-reads the row and is refused. (The request already holds the target's row while it waits.)
  const queued = losses.filter((l) => ['demoted to MEMBER (PATCH role)', 'banned (POST ban)', 'left the group (POST leave)'].includes(l.name));
  for (const action of actions) {
    for (const loss of queued) {
      it(`${action.name}: ${loss.name} queued first at the manager's row — the request is refused once it gets the row`, async () => {
        const f = await fresh(`q-${action.name.slice(0, 3)}-${loss.name.slice(0, 5).replace(/\W+/g, '')}`);
        const before = await action.snapshot(f);
        let writerP: Promise<Res> | undefined;
        let pending: Promise<Res> | undefined;

        await prisma.$transaction(async (tx) => {
          await holdRow(tx, 'group_members', f.rows.admin);
          writerP = loss.happen(f);
          writerP.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: loss.waitsIn }); // the writer is parked first...
          pending = action.fire(f, f.admin);
          pending.catch(() => undefined);
          await waitForBlockedBackends(parkedWhenBoth(loss.waitsIn, MEMBER_ROWS_LOCK), { queryLike: MEMBER_ROWS_LOCK }); // ...and the request queues behind it
        }, tx30);

        const [w, resp] = [await writerP!, await pending!];

        expect(w.statusCode, w.body).toBe(200);
        expect(resp.statusCode, resp.body).toBe(403);
        expect(errorMessage(resp)).toBe(loss.message);
        expect(await managerRow(f)).toEqual(loss.row);
        expect(await action.snapshot(f)).toEqual(before);
      }, 60_000);
    }
  }
});

// ─── EXTERNAL ─────────────────────────────────────────────────────────────────

describeIf('EXTERNAL: a writer that bypasses the routes — and so the group lock — is waited for at the manager\'s ROW', () => {
  // The routes serialize on the group row, so a plain read of the manager could hide behind
  // that. Nothing takes the group row here: the writer holds an uncommitted change of the manager's
  // row, and the only thing that can make the request wait for it — and read the result — is the
  // lock on that row.
  const changes: Array<{ name: string; data: Prisma.GroupMemberUpdateInput; message: string }> = [
    { name: 'role MEMBER', data: { role: 'MEMBER' }, message: 'Insufficient permissions' },
    { name: 'status BANNED', data: { status: 'BANNED' }, message: 'You are not a member of this group' },
    { name: 'status MUTED', data: { status: 'MUTED' }, message: 'You are not a member of this group' },
  ];
  for (const action of actions) {
    for (const change of changes) {
      it(`${action.name}: an uncommitted ${change.name} on the manager's row (no group lock taken) is waited for, then refused`, async () => {
        const f = await fresh(`ex-${action.name.slice(0, 3)}-${change.name.slice(-4)}`);
        const before = await action.snapshot(f);
        let pending: Promise<Res> | undefined;

        await prisma.$transaction(async (tx) => {
          await tx.groupMember.update({ where: { id: f.rows.admin }, data: change.data });
          pending = action.fire(f, f.admin); // its plain fast-path read still sees the committed ADMIN
          pending.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK });
        }, tx30);

        const resp = await pending!;

        expect(resp.statusCode, resp.body).toBe(403);
        expect(errorMessage(resp)).toBe(change.message);
        expect(await action.snapshot(f)).toEqual(before);
      }, 60_000);
    }
  }
});

// ─── EXTERNAL TARGET ──────────────────────────────────────────────────────────

describeIf("EXTERNAL TARGET: the target's row is judged on the LOCKED row — a writer that bypasses the routes can make the target the OWNER", () => {
  // No route promotes a BANNED member, but the owner check must not depend on that: the target is
  // read under the lock, after the writer that holds its row has committed. The writer here holds an
  // uncommitted promotion of the target's row to OWNER (no group lock taken); the request parks at
  // that row, and must be refused with the owner message when it gets it — writing nothing.
  const targets: Array<{
    name: string;
    fire: (f: AuthorityFixture) => Promise<Res>;
    row: (f: AuthorityFixture) => string;
    prepare?: (f: AuthorityFixture) => Promise<void>;
    message: string;
  }> = [
    { name: 'ban', fire: (f) => api.ban(f, f.admin, f.member), row: (f) => f.rows.member, message: 'You cannot ban the owner of the group' },
    { name: 'unban', fire: (f) => api.unban(f, f.admin, f.banned), row: (f) => f.rows.banned, message: 'You cannot unban the owner of the group' },
    { name: 'remove member', fire: (f) => api.remove(f, f.admin, f.member), row: (f) => f.rows.member, message: 'You cannot remove the owner of the group' },
    { name: 'change role', fire: (f) => api.role(f, f.admin, f.member, 'MEMBER'), row: (f) => f.rows.member, message: 'You cannot change the role of the owner' },
  ];
  for (const t of targets) {
    it(`${t.name}: the target's row is promoted to OWNER by an uncommitted external write while the request waits at it: 403 "${t.message}", the row exactly as the writer left it`, async () => {
      const f = await fresh(`xt-${t.name.slice(0, 4).replace(/\W+/g, '')}`);
      let pending: Promise<Res> | undefined;
      let writerXmin: string | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.update({ where: { id: t.row(f) }, data: { role: 'OWNER' } });
        // Inside its own transaction the row's xmin is that transaction's id: any LATER write shows as a different one.
        writerXmin = (await tx.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM group_members WHERE id = ${t.row(f)}`)[0].xmin;
        pending = t.fire(f); // its fast path reads the committed, pre-promotion row
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MEMBER_ROWS_LOCK });
      }, tx30);

      const resp = await pending!;
      const after = await prisma.$queryRaw<{ role: string; status: string; xmin: string }[]>`
        SELECT role::text AS role, status::text AS status, xmin::text AS xmin FROM group_members WHERE id = ${t.row(f)}
      `;

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(t.message);
      expect(after).toHaveLength(1);
      expect(after[0].role).toBe('OWNER');
      expect(after[0].xmin, 'the refused request rewrote the row').toBe(writerXmin);
    }, 60_000);
  }
});

// ─── REVERSE ──────────────────────────────────────────────────────────────────

describeIf('REVERSE: the request holds all of its locks; the loss WAITS behind them and applies after', () => {
  // The write gate closes the group's writes for the test's transaction: the request takes its
  // locks (group, subject, manager's row, target's row) and parks INSIDE its own write. The loss
  // then targets the MANAGER's row — which nothing but the request's lock can be holding — and must
  // be observed WAITING there. The request was legitimately authorized at its serialization point:
  // it completes (200) with every effect, and the loss applies afterwards.
  const reverse = losses.filter((l) => l.name !== 'demoted to MODERATOR (PATCH role)');
  for (const action of actions) {
    for (const loss of reverse) {
      it(`${action.name} first (parked in its write): ${loss.name} waits behind it (proven), then applies — the action was legitimately authorized`, async () => {
        const f = await fresh(`rv-${action.name.slice(0, 3)}-${loss.name.slice(0, 5).replace(/\W+/g, '')}`);
        let actionP: Promise<Res> | undefined;
        let writerP: Promise<Res> | undefined;

        await prisma.$transaction(async (tx) => {
          await holdWriteGate(tx, GATE, f.groupId);
          actionP = action.fire(f, f.admin);
          actionP.catch(() => undefined);
          await waitForBlockedBackends(1, { queryLike: action.gateWrite }); // it holds its locks and is about to write

          writerP = loss.happen(f);
          writerP.catch(() => undefined);
          // Waiting behind the request's ROW lock — not parked at the write gate, which the request itself sits in.
          await waitForBlockedBackends(1, { queryLike: loss.waitsIn, waitEvents: ROW_LOCK_WAITS });
        }, tx30);

        const [a, w] = [await actionP!, await writerP!];

        await action.done(f, a);
        expect(w.statusCode, w.body).toBe(200);
        expect(await managerRow(f)).toEqual(loss.row);
      }, 60_000);
    }
  }
});

// ─── behavior that must not change ────────────────────────────────────────────

describeIf('the ordinary behavior of the five actions is unchanged', () => {
  for (const action of actions) {
    it(`${action.name}: an ADMIN and the OWNER can do it, once`, async () => {
      const f = await fresh(`ok-${action.name.slice(0, 3)}`);
      await action.done(f, await action.fire(f, f.admin));

      const g = await fresh(`ok2-${action.name.slice(0, 3)}`);
      await action.done(g, await action.fire(g, g.owner));
    }, 60_000);

    it(`${action.name}: a plain member and an anonymous caller are refused before the transaction, with nothing written`, async () => {
      const f = await fresh(`nm-${action.name.slice(0, 3)}`);
      const before = await action.snapshot(f);

      const asMember = await action.fire(f, f.peer);

      expect(asMember.statusCode, asMember.body).toBe(403);
      expect(errorMessage(asMember)).toBe('Insufficient permissions');
      expect(await action.snapshot(f)).toEqual(before);
    }, 60_000);
  }

  it('an ADMIN may still not assign ADMIN; the OWNER may', async () => {
    const f = await fresh('ceiling');
    const asAdmin = await api.role(f, f.admin, f.member, 'ADMIN');
    expect(asAdmin.statusCode, asAdmin.body).toBe(403);
    expect(errorMessage(asAdmin)).toBe('Only the owner can assign admin roles');
    expect((await membershipSnapshot(f.groupId, f.member.id))?.role).toBe('MEMBER');

    const asOwner = await api.role(f, f.owner, f.member, 'ADMIN');
    expect(asOwner.statusCode, asOwner.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.member.id))?.role).toBe('ADMIN');
  }, 60_000);

  it('nobody can ban, unban, remove or re-role the OWNER, and the OWNER\'s row is not written', async () => {
    const f = await fresh('owner-target');
    const before = await membershipSnapshot(f.groupId, f.owner.id);

    const results = [
      await api.ban(f, f.admin, f.owner),
      await api.unban(f, f.admin, f.owner),
      await api.remove(f, f.admin, f.owner),
      await api.role(f, f.admin, f.owner, 'MEMBER'),
    ];

    expect(results.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(results.map(errorMessage)).toEqual([
      'You cannot ban the owner of the group',
      'You cannot unban the owner of the group',
      'You cannot remove the owner of the group',
      'You cannot change the role of the owner',
    ]);
    expect(await membershipSnapshot(f.groupId, f.owner.id)).toEqual(before);
  }, 60_000);

  it('a request for a target who is not (any more) in the group is a 404, with nothing written', async () => {
    const f = await fresh('gone-target');
    await prisma.groupMember.delete({ where: { id: f.rows.member } });

    const results = [await api.ban(f, f.admin, f.member), await api.remove(f, f.admin, f.member), await api.role(f, f.admin, f.member, 'MODERATOR')];

    expect(results.map((r) => r.statusCode)).toEqual([404, 404, 404]);
    expect(await prisma.notification.count({ where: { userId: f.member.id } })).toBe(0);
    expect((await inviteSnapshot(f.memberInviteId))?.status).toBe('PENDING');
  }, 60_000);

  it('a ban of an already-banned member is an idempotent no-op that touches nothing and tells nobody', async () => {
    const f = await fresh('replay-ban');
    const first = await api.ban(f, f.admin, f.member);
    expect(first.statusCode, first.body).toBe(200);
    const banned = await membershipSnapshot(f.groupId, f.member.id);
    const notifs = await notices(f.member.id);

    const again = await api.ban(f, f.owner, f.member);

    expect(again.statusCode, again.body).toBe(200);
    expect(JSON.parse(again.body).data.message).toBe('Member already banned');
    expect(await membershipSnapshot(f.groupId, f.member.id)).toEqual(banned);
    expect(await notices(f.member.id)).toBe(notifs);
  }, 60_000);

  it('an unban of a member who is not banned is a 409, with nothing written', async () => {
    const f = await fresh('unban-active');
    const before = await membershipSnapshot(f.groupId, f.member.id);

    const resp = await api.unban(f, f.admin, f.member);

    expect(resp.statusCode, resp.body).toBe(409);
    expect(errorMessage(resp)).toBe('This member is not banned');
    expect(await membershipSnapshot(f.groupId, f.member.id)).toEqual(before);
    expect(await notices(f.member.id)).toBe(0);
  }, 60_000);

  it('a rejection of a member who is not PENDING is a 400 "not pending", with nothing written', async () => {
    const f = await fresh('reject-active');
    const before = await membershipSnapshot(f.groupId, f.member.id);

    const resp = await api.reject(f, f.admin, f.member);

    expect(resp.statusCode, resp.body).toBe(400);
    expect(errorMessage(resp)).toBe('This request is not pending');
    expect(await membershipSnapshot(f.groupId, f.member.id)).toEqual(before);
    expect(await notices(f.member.id)).toBe(0);
  }, 60_000);
});
