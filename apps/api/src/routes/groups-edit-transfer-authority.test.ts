import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { ROW_LOCK_WAITS, waitForBlockedBackends } from '../test/pg-locks.js';
import { cleanFixtures, groupSnapshot, inviteSnapshot, ipAllocator, membershipSnapshot, uniqueSuffix } from '../test/group-admission-fixtures.js';
import {
  authorityApi,
  errorMessage,
  makeAuthorityFixture,
  SQL,
  type AuthorityFixture,
  type AuthorityUser,
  type Res,
} from '../test/group-authority-fixtures.js';
import { holdWriteGate, installWriteGate, removeWriteGate } from '../test/group-write-gate.js';

// EDIT GROUP and OWNERSHIP TRANSFER versus the OWNER's authority — and every manager
// action versus a transfer.
//
// Only the OWNER may edit or transfer a group, and an owner's authority ends in one
// way: they hand the group over (the former owner is then an ADMIN). PUT /groups/:id
// checked "is the caller the owner" with a plain read BEFORE its UPDATE, so a former
// owner whose transfer had committed in between still renamed, re-described and
// re-privatized a group that was no longer theirs.
//
// The fix (group-locks.ts, through the shared authorizeManagerAction): the group row
// FOR NO KEY UPDATE as the edit's FIRST statement, then the caller's own row FOR SHARE,
// and the caller must be groups.ownerId AND an ACTIVE OWNER member.
//
// A transfer is the one action that CHANGES who has authority, so it is also every other
// action's stale-actor race: an owner who transferred is an ADMIN when their in-flight ban,
// removal, role change or invitation reaches the lock. The transfer takes the group row in a
// mode that conflicts with the FOR SHARE every manager action holds from before its first
// member row until commit, so it never overlaps one. The transfer itself now refuses a group
// that is no longer ACTIVE and names the group as it is under the lock in both notifications.
//
// Every schedule is FORCED (a test-held lock or the write gate, proven by pg_stat_activity),
// never raced; the randomized section only adds breadth.
//
// Own file: the API's global rate limit is IP-keyed and shared per server instance, and
// every request below carries a unique remoteAddress.

const EMAIL_PREFIX = 'get-';
const GROUP_PREFIX = 'EdTrAuth-';
const GATE = 'get_write_gate';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(83);
const api = authorityApi(() => server, config.API_PREFIX, nextIp);

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

const fresh = (tag: string, opts: Parameters<typeof makeAuthorityFixture>[3] = {}) =>
  makeAuthorityFixture(EMAIL_PREFIX, GROUP_PREFIX, tag, opts);

const notices = (userId: string, type?: Prisma.NotificationWhereInput['type']) => prisma.notification.count({ where: { userId, ...(type ? { type } : {}) } });
const transferNotices = (f: AuthorityFixture) =>
  prisma.notification.count({ where: { userId: { in: [f.owner.id, f.peer.id, f.member.id, f.admin.id] }, type: 'GROUP_OWNERSHIP_TRANSFERRED' } });

const groupFields = async (f: AuthorityFixture) => {
  const g = await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } });
  return { name: g.name, description: g.description, isPrivate: g.isPrivate, status: g.status, ownerId: g.ownerId };
};

/** The transfer's own writes, done the way the ROUTE does them (owner first, group row first) — parked at the owner's row held by the test. */
interface ParkedTransfer {
  promise: Promise<Res>;
}
/**
 * Start `f.owner`'s transfer to `to` and park it at its demotion of the owner's row (held by the caller's
 * transaction): by then it holds the group row FOR NO KEY UPDATE. Returned as `{ promise }` — never an
 * async function that returns the request, or the caller would await the request itself and deadlock.
 */
async function parkTransferHoldingGroup(tx: Held, f: AuthorityFixture, to: AuthorityUser): Promise<ParkedTransfer> {
  await holdRow(tx, 'group_members', f.rows.owner);
  const promise = api.transfer(f, f.owner, to);
  promise.catch(() => undefined);
  await waitForBlockedBackends(1, { queryLike: SQL.memberUpdate });
  return { promise };
}

// ─── EDIT vs TRANSFER ─────────────────────────────────────────────────────────

describeIf('EDIT vs an ownership transfer by the editing owner', () => {
  it('transfer FIRST (parked holding the group row): the old owner\'s edit waits at the GROUP lock, then is refused (403) — the group is not edited', async () => {
    const f = await fresh('ed-tr-first');
    const before = await groupFields(f);
    let editP: Promise<Res> | undefined;
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      transferP = (await parkTransferHoldingGroup(tx, f, f.peer)).promise;
      // The owner's fast-path checks all pass: they are still the OWNER.
      editP = api.edit(f, f.owner, { name: `${GROUP_PREFIX}stolen-${uniqueSuffix().slice(0, 6)}`, description: 'edited by a former owner', isPrivate: false });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupEdit });
    }, tx30);

    const [t, e] = [await transferP!, await editP!];

    expect(t.statusCode, t.body).toBe(200);
    expect(e.statusCode, e.body).toBe(403);
    expect(errorMessage(e)).toBe('Insufficient permissions');
    // The transfer changed the owner; the refused edit changed nothing else.
    expect(await groupFields(f)).toEqual({ ...before, ownerId: f.peer.id });
    expect((await membershipSnapshot(f.groupId, f.owner.id))?.role).toBe('ADMIN');
  }, 60_000);

  it('REVERSE: the edit first (parked in its write, holding the group row): the transfer WAITS at the group row, then applies — the group was legitimately edited first', async () => {
    const f = await fresh('ed-tr-second');
    const renamed = `${GROUP_PREFIX}edited-${uniqueSuffix().slice(0, 6)}`;
    let editP: Promise<Res> | undefined;
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdWriteGate(tx, GATE, f.groupId);
      editP = api.edit(f, f.owner, { name: renamed, description: 'edited by the owner' });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite }); // it holds the group row and is about to write

      transferP = api.transfer(f, f.owner, f.peer);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite, waitEvents: ROW_LOCK_WAITS }); // the transfer's UPDATE of the group row waits behind the edit's ROW lock (not at the write gate the edit sits in)
    }, tx30);

    const [e, t] = [await editP!, await transferP!];

    expect(e.statusCode, e.body).toBe(200);
    expect(JSON.parse(e.body).data.name).toBe(renamed);
    expect(t.statusCode, t.body).toBe(200);
    expect(await groupFields(f)).toMatchObject({ name: renamed, description: 'edited by the owner', ownerId: f.peer.id });
    // Both notifications name the group as the edit left it.
    const bodies = (await prisma.notification.findMany({ where: { type: 'GROUP_OWNERSHIP_TRANSFERRED', userId: { in: [f.owner.id, f.peer.id] } } })).map((n) => n.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).toContain(renamed);
  }, 60_000);

  it('a group DELETED while the edit waits at the group lock: 404 "Group not found", nothing written', async () => {
    const f = await fresh('ed-deleted');
    let editP: Promise<Res> | undefined;
    let deleteP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      // The deletion is parked at its member rows (holding the group row FOR UPDATE); the edit passes its fast path and waits for it.
      await holdRow(tx, 'group_members', f.rows.member);
      deleteP = api.deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.memberDelete });
      editP = api.edit(f, f.owner, { name: `${GROUP_PREFIX}late-${uniqueSuffix().slice(0, 6)}` });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupEdit });
    }, tx30);

    const [d, e] = [await deleteP!, await editP!];

    expect(d.statusCode, d.body).toBe(200);
    expect(e.statusCode, e.body).toBe(404);
    expect(errorMessage(e)).toBe('Group not found');
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
  }, 60_000);

  it("EXTERNAL: a writer that bypasses the routes demotes the OWNER's row while the edit waits at the AUTHORITY lock: refused, nothing edited", async () => {
    const f = await fresh('ed-external');
    const before = await groupSnapshot(f.groupId);
    let editP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      // An uncommitted role change of the owner's row (say, an operator's UPDATE): no route writes an OWNER row
      // without the group row, so only a LOCKED read of the caller's own row can see it coming. The edit has
      // the group row (free) and parks at the authority lock.
      await tx.groupMember.update({ where: { id: f.rows.owner }, data: { role: 'ADMIN' } });
      editP = api.edit(f, f.owner, { name: `${GROUP_PREFIX}nope-${uniqueSuffix().slice(0, 6)}` });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.actorShare });
    }, tx30);

    const e = await editP!;

    expect(e.statusCode, e.body).toBe(403);
    expect(errorMessage(e)).toBe('Insufficient permissions');
    expect(await groupSnapshot(f.groupId)).toEqual(before);
  }, 60_000);

  it('EXTERNAL: the group\'s ownerId moved on (an operator\'s UPDATE) while the edit waits at the group lock, though the caller\'s member row still says OWNER: refused too', async () => {
    const f = await fresh('ed-owner-column');
    let editP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      editP = api.edit(f, f.owner, { name: `${GROUP_PREFIX}nope-${uniqueSuffix().slice(0, 6)}` });
      editP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupEdit });
      await tx.group.update({ where: { id: f.groupId }, data: { ownerId: f.peer.id } });
    }, tx30);

    const e = await editP!;

    expect(e.statusCode, e.body).toBe(403);
    expect(errorMessage(e)).toBe('Insufficient permissions');
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).name).toBe(f.groupName);
  }, 60_000);

  it('an ADMIN, a plain member and an anonymous caller are refused; the OWNER edits; a group is edited once per request', async () => {
    const f = await fresh('ed-normal');
    const before = await groupSnapshot(f.groupId);

    const asAdmin = await api.edit(f, f.admin, { name: `${GROUP_PREFIX}nope-${uniqueSuffix().slice(0, 6)}` });
    const asMember = await api.edit(f, f.peer, { description: 'nope' });
    const anonymous = await server.inject({ method: 'PUT', url: `${config.API_PREFIX}/groups/${f.groupId}`, payload: { name: 'nope-anon' }, remoteAddress: nextIp() });

    expect(asAdmin.statusCode).toBe(403);
    expect(asMember.statusCode).toBe(403);
    expect(errorMessage(asAdmin)).toBe('Insufficient permissions');
    expect(anonymous.statusCode).toBe(401);
    expect(await groupSnapshot(f.groupId)).toEqual(before);

    const renamed = `${GROUP_PREFIX}ok-${uniqueSuffix().slice(0, 6)}`;
    const ok = await api.edit(f, f.owner, { name: renamed, description: 'fine', isPrivate: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await groupFields(f)).toMatchObject({ name: renamed, description: 'fine', isPrivate: true });
  }, 60_000);
});

// ─── every manager action vs a TRANSFER by the acting owner ───────────────────

describeIf('a transfer by the acting owner versus the manager actions: the former owner is an ADMIN when the action reaches the lock', () => {
  // The transfer is parked at the owner's row (held by the test), so it already holds the group row FOR
  // NO KEY UPDATE; the action passes its fast-path checks — the caller is still the OWNER, the target
  // still a plain member — and PARKS at the group lock (proven). The transfer then commits.
  interface Case {
    name: string;
    fire: (f: AuthorityFixture) => Promise<Res>;
    /** What the action is told once the caller is an ADMIN and the target may be the new OWNER. */
    expected: { status: number; message?: string };
    /** Everything the action would have written: must be untouched when it is refused, and is asserted on when it goes through. */
    snapshot: (f: AuthorityFixture) => Promise<Record<string, unknown>>;
    done?: (f: AuthorityFixture) => Promise<void>;
    /**
     * For an action on the transfer's TARGET, whose row the transfer itself rewrote (so "byte for byte as before" is
     * not the claim): what must hold instead when it is refused.
     */
    refusedLeaves?: (f: AuthorityFixture) => Promise<void>;
  }
  const targetRow = async (f: AuthorityFixture, u: AuthorityUser) => membershipSnapshot(f.groupId, u.id);
  const cases: Case[] = [
    {
      name: 'ban a member: an ADMIN may',
      fire: (f) => api.ban(f, f.owner, f.member),
      expected: { status: 200 },
      snapshot: async (f) => ({ member: await targetRow(f, f.member), invite: await inviteSnapshot(f.memberInviteId), notices: await notices(f.member.id, 'MODERATION') }),
      done: async (f) => {
        expect((await targetRow(f, f.member))?.status).toBe('BANNED');
        expect((await inviteSnapshot(f.memberInviteId))?.status).toBe('REVOKED');
      },
    },
    {
      name: 'unban a member: an ADMIN may',
      fire: (f) => api.unban(f, f.owner, f.banned),
      expected: { status: 200 },
      snapshot: async (f) => ({ banned: await targetRow(f, f.banned), notices: await notices(f.banned.id, 'MODERATION') }),
      done: async (f) => expect((await targetRow(f, f.banned))?.status).toBe('LEFT'),
    },
    {
      name: 'remove a member: an ADMIN may',
      fire: (f) => api.remove(f, f.owner, f.member),
      expected: { status: 200 },
      snapshot: async (f) => ({ member: await targetRow(f, f.member) }),
      done: async (f) => expect(await targetRow(f, f.member)).toBeNull(),
    },
    {
      name: 'revoke an invite: an ADMIN may',
      fire: (f) => api.revoke(f, f.owner, f.outsiderInviteId),
      expected: { status: 200 },
      snapshot: async (f) => ({ invite: await inviteSnapshot(f.outsiderInviteId) }),
      done: async (f) => expect((await inviteSnapshot(f.outsiderInviteId))?.status).toBe('REVOKED'),
    },
    {
      name: 'reject a request: an ADMIN may',
      fire: (f) => api.reject(f, f.owner, f.pending),
      expected: { status: 200 },
      snapshot: async (f) => ({ pending: await targetRow(f, f.pending), notices: await notices(f.pending.id) }),
      done: async (f) => expect(await targetRow(f, f.pending)).toBeNull(),
    },
    {
      name: 'change a role to MODERATOR: an ADMIN may',
      fire: (f) => api.role(f, f.owner, f.member, 'MODERATOR'),
      expected: { status: 200 },
      snapshot: async (f) => ({ member: await targetRow(f, f.member) }),
      done: async (f) => expect((await targetRow(f, f.member))?.role).toBe('MODERATOR'),
    },
    {
      name: 'change a role to ADMIN: an ADMIN may NOT (the ceiling is judged on the LOCKED role)',
      fire: (f) => api.role(f, f.owner, f.member, 'ADMIN'),
      expected: { status: 403, message: 'Only the owner can assign admin roles' },
      snapshot: async (f) => ({ member: await targetRow(f, f.member) }),
    },
    {
      name: 'ban the transfer\'s TARGET: refused, they are the OWNER now',
      fire: (f) => api.ban(f, f.owner, f.peer),
      expected: { status: 403, message: 'You cannot ban the owner of the group' },
      snapshot: async (f) => ({ notices: await notices(f.peer.id, 'MODERATION') }),
      refusedLeaves: async (f) => {
        const row = await targetRow(f, f.peer);
        expect({ status: row?.status, role: row?.role }).toEqual({ status: 'ACTIVE', role: 'OWNER' });
        expect(await notices(f.peer.id, 'MODERATION')).toBe(0);
      },
    },
    {
      name: 'remove the transfer\'s TARGET: refused, they are the OWNER now',
      fire: (f) => api.remove(f, f.owner, f.peer),
      expected: { status: 403, message: 'You cannot remove the owner of the group' },
      snapshot: async () => ({}),
      refusedLeaves: async (f) => {
        const row = await targetRow(f, f.peer);
        expect({ status: row?.status, role: row?.role }).toEqual({ status: 'ACTIVE', role: 'OWNER' });
      },
    },
    {
      name: 'change the role of the transfer\'s TARGET: refused, they are the OWNER now',
      fire: (f) => api.role(f, f.owner, f.peer, 'MEMBER'),
      expected: { status: 403, message: 'You cannot change the role of the owner' },
      snapshot: async () => ({}),
      refusedLeaves: async (f) => {
        const row = await targetRow(f, f.peer);
        expect({ status: row?.status, role: row?.role }).toEqual({ status: 'ACTIVE', role: 'OWNER' });
      },
    },
  ];
  for (const c of cases) {
    it(`transfer first: ${c.name}`, async () => {
      const f = await fresh(`tm-${c.name.slice(0, 8).replace(/\W+/g, '')}-${c.expected.status}`);
      const before = await c.snapshot(f);
      let transferP: Promise<Res> | undefined;
      let actionP: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        transferP = (await parkTransferHoldingGroup(tx, f, f.peer)).promise;
        actionP = c.fire(f);
        actionP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.lockGroupShare });
      }, tx30);

      const [t, a] = [await transferP!, await actionP!];

      expect(t.statusCode, t.body).toBe(200);
      expect(a.statusCode, a.body).toBe(c.expected.status);
      if (c.expected.message) expect(errorMessage(a)).toBe(c.expected.message);
      if (c.expected.status === 200) await c.done!(f);
      else if (c.refusedLeaves) await c.refusedLeaves(f);
      else expect(await c.snapshot(f), 'a refused action left something behind').toEqual(before);
      expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.peer.id);
    }, 60_000);
  }
});

describeIf('REVERSE: the action holds the group row FOR SHARE (parked inside its write); the transfer WAITS at the group row, then applies or is refused', () => {
  it('a role change of the transfer\'s target first: the transfer waits behind it (proven), then completes', async () => {
    const f = await fresh('rv-role');
    let actionP: Promise<Res> | undefined;
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdWriteGate(tx, GATE, f.groupId);
      actionP = api.role(f, f.owner, f.peer, 'MODERATOR');
      actionP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.memberUpdate });
      transferP = api.transfer(f, f.owner, f.peer);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite, waitEvents: ROW_LOCK_WAITS }); // behind the role change's FOR SHARE on the group row
    }, tx30);

    const [a, t] = [await actionP!, await transferP!];

    expect(a.statusCode, a.body).toBe(200);
    expect(t.statusCode, t.body).toBe(200);
    expect((await membershipSnapshot(f.groupId, f.peer.id))?.role).toBe('OWNER');
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.peer.id);
  }, 60_000);

  for (const kind of ['ban', 'remove'] as const) {
    it(`a ${kind} of the transfer's target first: the transfer waits behind it (proven), then is refused (409), and NOTHING it wrote survives`, async () => {
      const f = await fresh(`rv-${kind}`);
      let actionP: Promise<Res> | undefined;
      let transferP: Promise<Res> | undefined;
      const ownerBefore = await membershipSnapshot(f.groupId, f.owner.id);
      const groupBefore = await groupSnapshot(f.groupId);

      await prisma.$transaction(async (tx) => {
        await holdWriteGate(tx, GATE, f.groupId);
        actionP = kind === 'ban' ? api.ban(f, f.owner, f.peer) : api.remove(f, f.owner, f.peer);
        actionP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: kind === 'ban' ? SQL.memberUpdate : SQL.memberDelete });
        transferP = api.transfer(f, f.owner, f.peer); // its fast path still sees an ACTIVE target
        transferP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.groupWrite, waitEvents: ROW_LOCK_WAITS }); // behind the action's FOR SHARE on the group row
      }, tx30);

      const [a, t] = [await actionP!, await transferP!];

      expect(a.statusCode, a.body).toBe(200);
      expect(t.statusCode, t.body).toBe(409);
      expect(errorMessage(t)).toBe('Target user is no longer an active member');
      // The transfer's group UPDATE and the owner's demotion were rolled back with it.
      expect(await membershipSnapshot(f.groupId, f.owner.id)).toEqual(ownerBefore);
      expect(await groupSnapshot(f.groupId)).toEqual(groupBefore);
      expect(await transferNotices(f)).toBe(0);
    }, 60_000);
  }
});

// ─── the transfer itself ──────────────────────────────────────────────────────

describeIf('the transfer: state, the target, the names and the second transfer', () => {
  it('the group is ARCHIVED while the transfer waits at the group row: 400 "Group is not active", nothing written', async () => {
    const f = await fresh('t-archived');
    const ownerBefore = await membershipSnapshot(f.groupId, f.owner.id);
    const peerBefore = await membershipSnapshot(f.groupId, f.peer.id);
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      transferP = api.transfer(f, f.owner, f.peer); // its fast path still sees an ACTIVE group
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite });
      await tx.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });
    }, tx30);

    const t = await transferP!;

    expect(t.statusCode, t.body).toBe(400);
    expect(errorMessage(t)).toBe('Group is not active');
    expect(await membershipSnapshot(f.groupId, f.owner.id)).toEqual(ownerBefore);
    expect(await membershipSnapshot(f.groupId, f.peer.id)).toEqual(peerBefore);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.owner.id);
    expect(await transferNotices(f)).toBe(0);
  }, 60_000);

  it('the group is DELETED while the transfer waits at the group row: the same controlled 409 as before, nothing written', async () => {
    const f = await fresh('t-deleted');
    let deleteP: Promise<Res> | undefined;
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'group_members', f.rows.member);
      deleteP = api.deleteGroup(f, f.owner);
      deleteP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.memberDelete });
      transferP = api.transfer(f, f.owner, f.peer);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite });
    }, tx30);

    const [d, t] = [await deleteP!, await transferP!];

    expect(d.statusCode, d.body).toBe(200);
    expect(t.statusCode, t.body).toBe(409);
    expect(errorMessage(t)).toBe('Concurrent ownership change detected; please retry');
    expect(await prisma.notification.count({ where: { type: 'GROUP_OWNERSHIP_TRANSFERRED', userId: { in: [f.owner.id, f.peer.id] } } })).toBe(0);
  }, 60_000);

  it('EXTERNAL: the groups.ownerId column is changed directly (bypassing every route) while the transfer waits at the group row: refused, the external write\'s owner stands', async () => {
    // f.owner's OWN membership row is never touched here — only the groups.ownerId column
    // is. That isolates the transfer's FIRST guard (its own updateMany's `ownerId:
    // actorUserId` predicate) from its second (the old-owner row's `role: 'OWNER', status:
    // 'ACTIVE'` guard, covered by the "t-external" test below): only the ownerId predicate
    // can be what refuses this.
    const f = await fresh('t-owner-column');
    const ownerBefore = await membershipSnapshot(f.groupId, f.owner.id);
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      transferP = api.transfer(f, f.owner, f.member); // its fast path still sees f.owner as the OWNER
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite });
      await tx.group.update({ where: { id: f.groupId }, data: { ownerId: f.peer.id } });
    }, tx30);

    const t = await transferP!;

    expect(t.statusCode, t.body).toBe(409);
    expect(errorMessage(t)).toBe('Concurrent ownership change detected; please retry');
    // The external write's owner stands: the transfer neither overwrote ownerId nor
    // touched either membership row.
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.peer.id);
    expect(await membershipSnapshot(f.groupId, f.owner.id)).toEqual(ownerBefore);
    expect((await membershipSnapshot(f.groupId, f.member.id))?.role).toBe('MEMBER');
    expect(await transferNotices(f)).toBe(0);
  }, 60_000);

  it('the target LEAVES while the transfer is parked (holding the group row): 409 "no longer an active member", the demotion of the owner rolled back', async () => {
    const f = await fresh('t-leaves');
    const ownerBefore = await membershipSnapshot(f.groupId, f.owner.id);
    const groupBefore = await groupSnapshot(f.groupId);
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      transferP = (await parkTransferHoldingGroup(tx, f, f.peer)).promise;
      const left = await api.leave(f, f.peer); // takes no group lock: it goes straight through
      expect(left.statusCode, left.body).toBe(200);
    }, tx30);

    const t = await transferP!;

    expect(t.statusCode, t.body).toBe(409);
    expect(errorMessage(t)).toBe('Target user is no longer an active member');
    expect(await membershipSnapshot(f.groupId, f.owner.id)).toEqual(ownerBefore);
    expect(await groupSnapshot(f.groupId)).toEqual(groupBefore);
    expect((await membershipSnapshot(f.groupId, f.peer.id))?.status).toBe('LEFT');
    expect(await transferNotices(f)).toBe(0);
  }, 60_000);

  it('a second transfer by the same (former) owner, queued behind the first at the group row: exactly one wins, the other is the 409 "concurrent ownership change", nothing extra written', async () => {
    const f = await fresh('t-double');
    let first: Promise<Res> | undefined;
    let second: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      first = (await parkTransferHoldingGroup(tx, f, f.peer)).promise;
      second = api.transfer(f, f.owner, f.member);
      second.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite }); // its UPDATE of the group row waits for the first's (which holds it, parked at the owner's row)
    }, tx30);

    const [a, b] = [await first!, await second!];

    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(409);
    expect(errorMessage(b)).toBe('Concurrent ownership change detected; please retry');
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.peer.id);
    expect((await membershipSnapshot(f.groupId, f.member.id))?.role).toBe('MEMBER');
    expect(await transferNotices(f)).toBe(2); // the first transfer's two, and no more
  }, 60_000);

  it('a rename that commits while the transfer waits at the group row is the name BOTH notifications carry', async () => {
    const f = await fresh('t-name');
    const renamed = `${GROUP_PREFIX}Renamed-${uniqueSuffix().slice(0, 8)}`;
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      transferP = api.transfer(f, f.owner, f.peer);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.groupWrite });
      await tx.group.update({ where: { id: f.groupId }, data: { name: renamed } });
    }, tx30);

    const t = await transferP!;

    expect(t.statusCode, t.body).toBe(200);
    const bodies = (await prisma.notification.findMany({ where: { type: 'GROUP_OWNERSHIP_TRANSFERRED', userId: { in: [f.owner.id, f.peer.id] } } })).map((n) => n.body);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain(`"${renamed}"`);
      expect(body).not.toContain(f.groupName);
    }
  }, 60_000);

  it("EXTERNAL: the OWNER's row is left (an operator's UPDATE, no group lock) while the transfer's demotion waits on it: 409, and the group row's ownerId write is rolled back with it", async () => {
    const f = await fresh('t-external');
    const groupBefore = await groupSnapshot(f.groupId);
    const peerBefore = await membershipSnapshot(f.groupId, f.peer.id);
    let transferP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      // The operator's uncommitted change of the owner's row. The transfer takes the group row (free), then waits at ITS demotion of that row.
      await tx.groupMember.update({ where: { id: f.rows.owner }, data: { status: 'LEFT' } });
      transferP = api.transfer(f, f.owner, f.peer);
      transferP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.memberUpdate });
    }, tx30);

    const t = await transferP!;

    expect(t.statusCode, t.body).toBe(409);
    expect(errorMessage(t)).toBe('Concurrent ownership change detected; please retry');
    expect(await groupSnapshot(f.groupId)).toEqual(groupBefore);
    expect(await membershipSnapshot(f.groupId, f.peer.id)).toEqual(peerBefore);
    expect(await transferNotices(f)).toBe(0);
  }, 60_000);

  it('an ordinary transfer: 200, one OWNER matching groups.ownerId, the former owner an ADMIN, two notifications', async () => {
    const f = await fresh('t-normal');

    const t = await api.transfer(f, f.owner, f.peer);

    expect(t.statusCode, t.body).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } })).ownerId).toBe(f.peer.id);
    expect((await membershipSnapshot(f.groupId, f.peer.id))?.role).toBe('OWNER');
    expect((await membershipSnapshot(f.groupId, f.owner.id))?.role).toBe('ADMIN');
    expect(await transferNotices(f)).toBe(2);
  }, 60_000);

  it('a transfer to oneself, by a non-owner, and to a non-active member are refused before the transaction, nothing written', async () => {
    const f = await fresh('t-refused');
    const groupBefore = await groupSnapshot(f.groupId);

    const toSelf = await api.transfer(f, f.owner, f.owner);
    const byAdmin = await api.transfer(f, f.admin, f.peer);
    const toBanned = await api.transfer(f, f.owner, f.banned);

    expect([toSelf.statusCode, byAdmin.statusCode, toBanned.statusCode]).toEqual([400, 403, 400]);
    expect(errorMessage(byAdmin)).toBe('Only the owner can transfer ownership');
    expect(await groupSnapshot(f.groupId)).toEqual(groupBefore);
    expect(await transferNotices(f)).toBe(0);
  }, 60_000);
});

// ─── randomized breadth ───────────────────────────────────────────────────────

describeIf('randomized breadth: whichever order wins, nothing 500s and the group keeps exactly one OWNER', () => {
  const ROUNDS = 12;

  async function expectOneOwnerMatchingGroup(f: AuthorityFixture) {
    const group = await prisma.group.findUniqueOrThrow({ where: { id: f.groupId } });
    const owners = await prisma.groupMember.findMany({ where: { groupId: f.groupId, role: 'OWNER', status: 'ACTIVE' } });
    expect(owners.length, 'ACTIVE OWNER rows').toBe(1);
    expect(owners[0].userId, 'the OWNER row matches groups.ownerId').toBe(group.ownerId);
  }

  const rivals: Array<{ name: string; go: (f: AuthorityFixture) => Promise<Res>; targetsPeer?: boolean }> = [
    { name: 'edit', go: (f) => api.edit(f, f.owner, { description: `edited ${uniqueSuffix().slice(0, 6)}` }) },
    { name: 'ban of the target', go: (f) => api.ban(f, f.owner, f.peer), targetsPeer: true },
    { name: 'removal of the target', go: (f) => api.remove(f, f.owner, f.peer), targetsPeer: true },
    { name: 'role change of the target', go: (f) => api.role(f, f.owner, f.peer, 'MODERATOR') },
    { name: 'ban of a member', go: (f) => api.ban(f, f.owner, f.member) },
    { name: 'role change to ADMIN', go: (f) => api.role(f, f.owner, f.member, 'ADMIN') },
  ];
  for (const rival of rivals) {
    it(`transfer vs the owner's ${rival.name}`, async () => {
      let went = 0;
      let refused = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const f = await fresh(`rz-${rival.name.slice(0, 6).replace(/\W+/g, '')}-${i}`);
        const [t, r] = await raceWithJitter(() => api.transfer(f, f.owner, f.peer), () => rival.go(f));
        expect(t.statusCode, `round ${i} transfer: ${t.body}`).toBeLessThan(500);
        expect(r.statusCode, `round ${i} ${rival.name}: ${r.body}`).toBeLessThan(500);
        if (t.statusCode === 200) {
          went++;
          // A transfer that went through made the target the OWNER: a ban or removal of them can only have come BEFORE it (and would have refused it).
          if (rival.targetsPeer) expect(r.statusCode, `round ${i} ${rival.name} after a transfer: ${r.body}`).toBe(403);
        } else {
          refused++;
          // 400: the rival had already committed when the transfer read its target; 409: it committed in between.
          expect([400, 409], `round ${i} transfer: ${t.body}`).toContain(t.statusCode);
          expect(await transferNotices(f), `round ${i}: a refused transfer announced something`).toBe(0);
        }
        await expectOneOwnerMatchingGroup(f);
      }
      console.log(`transfer vs ${rival.name}: transfer went through=${went} refused=${refused}`);
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
