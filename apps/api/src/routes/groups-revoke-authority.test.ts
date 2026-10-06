import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { lockInviteSubject } from './group-locks.js';
import { ROW_LOCK_WAITS, waitForBlockedBackends } from '../test/pg-locks.js';
import { cleanFixtures, createUser, inviteSnapshot, ipAllocator, membershipSnapshot, uniqueSuffix } from '../test/group-admission-fixtures.js';
import {
  authorityApi,
  authorityLosses,
  errorMessage,
  makeAuthorityFixture,
  managerRow,
  SQL,
  type AuthorityFixture,
  type Res,
} from '../test/group-authority-fixtures.js';
import { holdWriteGate, installWriteGate, removeWriteGate } from '../test/group-write-gate.js';

// REVOKE INVITE versus the ACTOR's authority and the invite's real state — and the
// group name in an invitation.
//
// DELETE /groups/:id/invites/:inviteId judged the manager once, with a plain read
// BEFORE its write, and then wrote unconditionally: `UPDATE ... SET status =
// 'REVOKED' WHERE id = ...`. Two things followed.
//   - A manager demoted, banned, muted, removed or gone after that read still revoked
//     the invite.
//   - The write did not look at the invite's status either: a revocation that read
//     PENDING and wrote after the invitee had ACCEPTED turned an ACCEPTED invite into
//     a REVOKED one (and left the member admitted).
//
// The fix (group-locks.ts, through the shared authorizeManagerAction): group row FOR
// SHARE, then the (group, email) subject lock every writer of that subject takes (ban,
// unban, invite creation, acceptance), then the manager's row FOR SHARE, then the
// invite row FOR NO KEY UPDATE — and the status is judged on the LOCKED invite: only a
// PENDING one is revoked.
//
// POST /groups/:id/invites also announced the invitation with the group name it had read
// before its transaction; it now uses the name of the locked group row.
//
// Every schedule is FORCED (a test-held lock or the write gate, proven by
// pg_stat_activity), never raced; the randomized section only adds breadth.
//
// Own file: the API's global rate limit is IP-keyed and shared per server instance,
// and every request below carries a unique remoteAddress.

const EMAIL_PREFIX = 'gra-';
const GROUP_PREFIX = 'RevAuth-';
const GATE = 'gra_write_gate';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(82);
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

const fresh = (tag: string, opts: Parameters<typeof makeAuthorityFixture>[3] = {}) =>
  makeAuthorityFixture(EMAIL_PREFIX, GROUP_PREFIX, tag, opts);

const revokeIt = (f: AuthorityFixture) => api.revoke(f, f.admin, f.outsiderInviteId);

/** Everything a REFUSED revocation must not have changed: the invite exactly as stored, xmin included. */
const inviteState = (f: AuthorityFixture) => inviteSnapshot(f.outsiderInviteId);

async function expectRevoked(f: AuthorityFixture, resp: Res) {
  expect(resp.statusCode, resp.body).toBe(200);
  expect(JSON.parse(resp.body).data.message).toBe('Invite revoked');
  expect((await inviteState(f))?.status).toBe('REVOKED');
}

// ─── FORWARD ──────────────────────────────────────────────────────────────────

describeIf('FORWARD: a manager whose authority ended after the fast-path read cannot revoke', () => {
  // The revocation has passed its fast-path checks and waits at the (group, email) subject lock —
  // level 3, before it takes the manager's row. The loss goes through its real route and COMMITS;
  // only then is the revocation released.
  for (const loss of losses) {
    it(`the manager is ${loss.name} while the revocation waits at the subject lock: refused (403 "${loss.message}"), the invite untouched`, async () => {
      const f = await fresh(`fw-${loss.name.slice(0, 6).replace(/\W+/g, '')}`);
      const before = await inviteState(f);
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await lockInviteSubject(tx, f.groupId, f.outsiderEmail);
        pending = revokeIt(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.subjectLock });

        const resp = await loss.happen(f);
        expect(resp.statusCode, `${loss.name}: ${resp.body}`).toBe(200);
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(loss.message);
      expect(await managerRow(f)).toEqual(loss.row);
      expect(await inviteState(f)).toEqual(before);
      expect(before?.status).toBe('PENDING');
    }, 60_000);
  }
});

// ─── QUEUED ───────────────────────────────────────────────────────────────────

describeIf("QUEUED: the revocation waits on the MANAGER's row behind a writer that queued first", () => {
  // The manager's row is locked FOR SHARE by a revocation, so a demotion, ban or leave — which write
  // it — queue against that lock and a revocation that queues BEHIND them waits for them.
  const queued = losses.filter((l) => ['demoted to MEMBER (PATCH role)', 'banned (POST ban)', 'left the group (POST leave)'].includes(l.name));
  for (const loss of queued) {
    it(`${loss.name} queued first at the manager's row: the revocation is refused once it gets the row`, async () => {
      const f = await fresh(`q-${loss.name.slice(0, 6).replace(/\W+/g, '')}`);
      const before = await inviteState(f);
      let writerP: Promise<Res> | undefined;
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'group_members', f.rows.admin);
        writerP = loss.happen(f);
        writerP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: loss.waitsIn });
        pending = revokeIt(f);
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.actorShare }); // it takes the manager's row FOR SHARE, and waits for the writer
      }, tx30);

      const [w, resp] = [await writerP!, await pending!];

      expect(w.statusCode, w.body).toBe(200);
      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(loss.message);
      expect(await inviteState(f)).toEqual(before);
    }, 60_000);
  }
});

// ─── EXTERNAL ─────────────────────────────────────────────────────────────────

describeIf("EXTERNAL: a writer that bypasses the routes — and so the group lock — is waited for at the manager's ROW", () => {
  const changes: Array<{ name: string; data: Prisma.GroupMemberUpdateInput; message: string }> = [
    { name: 'role MEMBER', data: { role: 'MEMBER' }, message: 'Insufficient permissions' },
    { name: 'status BANNED', data: { status: 'BANNED' }, message: 'You are not a member of this group' },
  ];
  for (const change of changes) {
    it(`an uncommitted ${change.name} on the manager's row (no group lock taken) is waited for, then refused`, async () => {
      const f = await fresh(`ex-${change.name.slice(-4)}`);
      const before = await inviteState(f);
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.update({ where: { id: f.rows.admin }, data: change.data });
        pending = revokeIt(f); // its plain fast-path read still sees the committed ADMIN
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.actorShare });
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(change.message);
      expect(await inviteState(f)).toEqual(before);
    }, 60_000);
  }
});

// ─── REVERSE ──────────────────────────────────────────────────────────────────

describeIf('REVERSE: the revocation holds every lock (parked inside its write); the loss WAITS behind it and applies after', () => {
  // The write gate parks the revocation inside its UPDATE of the invite, after the group row, the
  // subject lock, the manager's row (FOR SHARE) and the invite row. A writer of the manager's row
  // needs FOR NO KEY UPDATE, which conflicts with that SHARE: it must be observed WAITING.
  const reverse = losses.filter((l) => l.name !== 'demoted to MODERATOR (PATCH role)');
  for (const loss of reverse) {
    it(`the revocation first: ${loss.name} waits behind it (proven), then applies — the revocation was legitimately authorized`, async () => {
      const f = await fresh(`rv-${loss.name.slice(0, 6).replace(/\W+/g, '')}`);
      let revokeP: Promise<Res> | undefined;
      let writerP: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdWriteGate(tx, GATE, f.groupId);
        revokeP = revokeIt(f);
        revokeP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.inviteUpdate }); // it holds its locks and is about to write

        writerP = loss.happen(f);
        writerP.catch(() => undefined);
        // Waiting behind the revocation's ROW lock on the manager — not parked at the write gate.
        await waitForBlockedBackends(1, { queryLike: loss.waitsIn, waitEvents: ROW_LOCK_WAITS });
      }, tx30);

      const [r, w] = [await revokeP!, await writerP!];

      await expectRevoked(f, r);
      expect(w.statusCode, w.body).toBe(200);
      expect(await managerRow(f)).toEqual(loss.row);
    }, 60_000);
  }
});

// ─── the invite's own state ───────────────────────────────────────────────────

describeIf("the invite's own state is judged on the LOCKED invite row", () => {
  it('REVOKE vs ACCEPT, the acceptance first (parked holding the subject lock and the invite row): the revocation waits, then is told "not active" — the ACCEPTED invite is NOT turned into a REVOKED one', async () => {
    const f = await fresh('acc-first');
    const invitee = f.peer;
    // A LEFT membership, so the acceptance reactivates a row (an UPDATE) instead of inserting one.
    await prisma.groupMember.update({ where: { id: f.rows.peer }, data: { status: 'LEFT' } });
    const invite = await prisma.groupInvite.create({
      data: {
        groupId: f.groupId,
        email: invitee.email!.toLowerCase(),
        role: 'MEMBER',
        status: 'PENDING',
        token: `${EMAIL_PREFIX}tok-${uniqueSuffix()}${uniqueSuffix()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: f.owner.id,
      },
    });
    let acceptP: Promise<Res> | undefined;
    let revokeP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdWriteGate(tx, GATE, f.groupId);
      acceptP = api.acceptInvite(invitee, invite.token);
      acceptP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.inviteUpdate }); // it holds the subject lock and the invite row, and is about to claim the invite

      revokeP = api.revoke(f, f.admin, invite.id); // its fast-path read still sees PENDING
      revokeP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.subjectLock });
    }, tx30);

    const [a, r] = [await acceptP!, await revokeP!];

    expect(a.statusCode, a.body).toBe(200);
    expect(r.statusCode, r.body).toBe(400);
    expect(errorMessage(r)).toBe('Invite is not active');
    const after = await inviteSnapshot(invite.id);
    expect(after?.status).toBe('ACCEPTED');
    expect(after?.acceptedBy).toBe(invitee.id);
    expect((await membershipSnapshot(f.groupId, invitee.id))?.status).toBe('ACTIVE');
  }, 60_000);

  it('REVOKE vs ACCEPT, the revocation first (parked in its write): the acceptance waits at the subject lock, then is told the invite was revoked; nobody is admitted', async () => {
    const f = await fresh('rev-first');
    const invitee = f.peer;
    await prisma.groupMember.update({ where: { id: f.rows.peer }, data: { status: 'LEFT' } });
    const invite = await prisma.groupInvite.create({
      data: {
        groupId: f.groupId,
        email: invitee.email!.toLowerCase(),
        role: 'MEMBER',
        status: 'PENDING',
        token: `${EMAIL_PREFIX}tok-${uniqueSuffix()}${uniqueSuffix()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: f.owner.id,
      },
    });
    const memberBefore = await membershipSnapshot(f.groupId, invitee.id);
    let revokeP: Promise<Res> | undefined;
    let acceptP: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdWriteGate(tx, GATE, f.groupId);
      revokeP = api.revoke(f, f.admin, invite.id);
      revokeP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.inviteUpdate });

      acceptP = api.acceptInvite(invitee, invite.token); // its fast-path read still sees PENDING
      acceptP.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.subjectLock });
    }, tx30);

    const [r, a] = [await revokeP!, await acceptP!];

    expect(r.statusCode, r.body).toBe(200);
    expect(a.statusCode, a.body).toBe(409);
    expect(errorMessage(a)).toBe('This invite has been revoked');
    expect((await inviteSnapshot(invite.id))?.status).toBe('REVOKED');
    expect(await membershipSnapshot(f.groupId, invitee.id)).toEqual(memberBefore);
  }, 60_000);

  const banAndRevoke: Array<{ first: 'ban' | 'revoke'; expectBan: string; expectRevoke: { status: number; message?: string } }> = [
    { first: 'ban', expectBan: 'Member banned', expectRevoke: { status: 400, message: 'Invite is not active' } },
    { first: 'revoke', expectBan: 'Member banned', expectRevoke: { status: 200 } },
  ];
  for (const c of banAndRevoke) {
    it(`a ban of the invitee and a revocation of their invite queue at the subject lock, the ${c.first} first: both are coherent, the invite ends REVOKED once`, async () => {
      const f = await fresh(`br-${c.first}`);
      const runBan = () => api.ban(f, f.admin, f.member);
      const runRevoke = () => api.revoke(f, f.admin, f.memberInviteId);
      let firstP: Promise<Res> | undefined;
      let secondP: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await lockInviteSubject(tx, f.groupId, f.member.email!);
        firstP = c.first === 'ban' ? runBan() : runRevoke();
        firstP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.subjectLock });
        secondP = c.first === 'ban' ? runRevoke() : runBan();
        secondP.catch(() => undefined);
        await waitForBlockedBackends(2, { queryLike: SQL.subjectLock });
      }, tx30);

      const [r1, r2] = [await firstP!, await secondP!];
      const ban = c.first === 'ban' ? r1 : r2;
      const revoke = c.first === 'ban' ? r2 : r1;

      expect(ban.statusCode, ban.body).toBe(200);
      expect(JSON.parse(ban.body).data.message).toBe(c.expectBan);
      expect(revoke.statusCode, revoke.body).toBe(c.expectRevoke.status);
      if (c.expectRevoke.message) expect(errorMessage(revoke)).toBe(c.expectRevoke.message);
      expect((await inviteSnapshot(f.memberInviteId))?.status).toBe('REVOKED');
      expect((await membershipSnapshot(f.groupId, f.member.id))?.status).toBe('BANNED');
    }, 60_000);
  }

  it('EXTERNAL: an uncommitted ACCEPTANCE of the invite by a writer that takes no subject lock is waited for at the INVITE ROW: "not active", the invite exactly as the writer left it', async () => {
    const f = await fresh('ext-accepted');
    let pending: Promise<Res> | undefined;
    let writerXmin: string | undefined;

    await prisma.$transaction(async (tx) => {
      // The subject lock serializes the ROUTES that write this invite; this writer is not one of them. Only the
      // lock on the invite row itself can make the revocation wait for it and read what it wrote.
      await tx.groupInvite.update({ where: { id: f.outsiderInviteId }, data: { status: 'ACCEPTED', acceptedBy: f.peer.id } });
      writerXmin = (await tx.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM group_invites WHERE id = ${f.outsiderInviteId}`)[0].xmin;
      pending = revokeIt(f); // its fast-path read still sees the committed PENDING invite
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.inviteLock, waitEvents: ROW_LOCK_WAITS });
    }, tx30);

    const resp = await pending!;
    const after = await inviteState(f);

    expect(resp.statusCode, resp.body).toBe(400);
    expect(errorMessage(resp)).toBe('Invite is not active');
    expect(after?.status).toBe('ACCEPTED');
    expect(after?.acceptedBy).toBe(f.peer.id);
    expect(after?.xmin, 'the refused revocation rewrote the invite').toBe(writerXmin);
  }, 60_000);

  it("EXTERNAL: the invite is moved to ANOTHER group by a writer that bypasses the routes while the revocation waits at its row: 404 \"Invite not found\", the other group's invite untouched", async () => {
    const f = await fresh('ext-moved');
    const other = await fresh('ext-moved-other');
    let pending: Promise<Res> | undefined;
    let writerXmin: string | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.groupInvite.update({ where: { id: f.outsiderInviteId }, data: { groupId: other.groupId } });
      writerXmin = (await tx.$queryRaw<{ xmin: string }[]>`SELECT xmin::text AS xmin FROM group_invites WHERE id = ${f.outsiderInviteId}`)[0].xmin;
      pending = revokeIt(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.inviteLock, waitEvents: ROW_LOCK_WAITS });
    }, tx30);

    const resp = await pending!;
    const after = await inviteState(f);

    expect(resp.statusCode, resp.body).toBe(404);
    expect(errorMessage(resp)).toBe('Invite not found');
    expect(after?.status).toBe('PENDING');
    expect(after?.xmin, 'a revocation of ANOTHER group\'s invite went through this group\'s route').toBe(writerXmin);
  }, 60_000);

  it('two managers revoking the same invite, both waiting at the subject lock: exactly one wins, the other is "not active"', async () => {
    const f = await fresh('two-revokes');
    let a: Promise<Res> | undefined;
    let b: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await lockInviteSubject(tx, f.groupId, f.outsiderEmail);
      a = api.revoke(f, f.admin, f.outsiderInviteId);
      a.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.subjectLock });
      b = api.revoke(f, f.admin2, f.outsiderInviteId);
      b.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: SQL.subjectLock });
    }, tx30);

    const [ra, rb] = [await a!, await b!];

    expect([ra.statusCode, rb.statusCode], `${ra.body} | ${rb.body}`).toEqual([200, 400]);
    expect(errorMessage(rb)).toBe('Invite is not active');
    expect((await inviteState(f))?.status).toBe('REVOKED');
  }, 60_000);
});

// ─── group state ──────────────────────────────────────────────────────────────

describeIf('the group', () => {
  it('a group DELETED while the revocation waits at the group row: 404 "Group not found", nothing written', async () => {
    const f = await fresh('gone');
    let pending: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = revokeIt(f);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupShare });
      await tx.group.delete({ where: { id: f.groupId } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode, resp.body).toBe(404);
    expect(errorMessage(resp)).toBe('Group not found');
  }, 60_000);

  it('revoking never needed an ACTIVE group: an ARCHIVED group still lets a manager revoke (unchanged)', async () => {
    const f = await fresh('archived');
    await prisma.group.update({ where: { id: f.groupId }, data: { status: 'ARCHIVED' } });

    await expectRevoked(f, await revokeIt(f));
  }, 60_000);
});

// ─── behavior that must not change ────────────────────────────────────────────

describeIf('the ordinary behavior of revoking is unchanged', () => {
  it('an ADMIN and the OWNER can revoke, once; a replay is "not active"', async () => {
    const f = await fresh('ok');
    await expectRevoked(f, await revokeIt(f));

    const again = await api.revoke(f, f.owner, f.outsiderInviteId);
    expect(again.statusCode, again.body).toBe(400);
    expect(errorMessage(again)).toBe('Invite is not active');

    const g = await fresh('ok2');
    await expectRevoked(g, await api.revoke(g, g.owner, g.outsiderInviteId));
  }, 60_000);

  it('a plain member is refused, the invite of ANOTHER group is a 404, and nothing is written', async () => {
    const f = await fresh('refuse');
    const other = await fresh('refuse-other');
    const before = await inviteState(f);
    const otherBefore = await inviteSnapshot(other.outsiderInviteId);

    const asMember = await api.revoke(f, f.peer, f.outsiderInviteId);
    const foreign = await api.revoke(f, f.admin, other.outsiderInviteId);

    expect(asMember.statusCode, asMember.body).toBe(403);
    expect(errorMessage(asMember)).toBe('Insufficient permissions');
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(errorMessage(foreign)).toBe('Invite not found');
    expect(await inviteState(f)).toEqual(before);
    expect(await inviteSnapshot(other.outsiderInviteId)).toEqual(otherBefore);
  }, 60_000);
});

// ─── the group name in an invitation ──────────────────────────────────────────

describeIf('GROUP NAME: the invitation notification carries the name the LOCKED group row has', () => {
  it('a rename that commits while the invitation waits at the group row is what the invitee is told (message and data)', async () => {
    const f = await fresh('name');
    const invitee = await createUser(EMAIL_PREFIX, 'name-inv');
    const renamed = `${GROUP_PREFIX}Renamed-${uniqueSuffix().slice(0, 8)}`;
    let pending: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = api.createInvite(f, f.admin, invitee.email!);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupShare });
      await tx.group.update({ where: { id: f.groupId }, data: { name: renamed } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode, resp.body).toBe(200);
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: invitee.id, type: 'GROUP_INVITE' } });
    expect(notification.body).toBe(`You have been invited to join "${renamed}"`);
    expect((notification.data as { groupName?: string }).groupName).toBe(renamed);
    expect(notification.body).not.toContain(f.groupName);
  }, 60_000);
});

describeIf('GROUP NAME: the acceptance notification carries the name the LOCKED group row has', () => {
  // (Pinned rather than fixed: acceptance has always announced the group it locked. It is the third
  // invitation notification — created, accepted — and the same rule holds for all of them.)
  it('a rename that commits while an acceptance waits at the group row is the name the inviter is told', async () => {
    const f = await fresh('name-accept');
    const invitee = await createUser(EMAIL_PREFIX, 'name-acc');
    const invite = await prisma.groupInvite.create({
      data: {
        groupId: f.groupId,
        email: invitee.email!.toLowerCase(),
        role: 'MEMBER',
        status: 'PENDING',
        token: `${EMAIL_PREFIX}tok-${uniqueSuffix()}${uniqueSuffix()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: f.owner.id,
      },
    });
    const renamed = `${GROUP_PREFIX}Renamed-${uniqueSuffix().slice(0, 8)}`;
    let pending: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = api.acceptInvite(invitee, invite.token);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupShare });
      await tx.group.update({ where: { id: f.groupId }, data: { name: renamed } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode, resp.body).toBe(200);
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: f.owner.id, type: 'GROUP_INVITE_ACCEPTED' } });
    expect(notification.body).toContain(`"${renamed}"`);
    expect(notification.body).not.toContain(f.groupName);
  }, 60_000);
});

// ─── randomized breadth ───────────────────────────────────────────────────────

describeIf('randomized breadth: whichever order wins, nothing 500s and the outcomes are coherent', () => {
  const ROUNDS = 12;
  const writers = losses.filter((l) => ['demoted to MEMBER (PATCH role)', 'banned (POST ban)', 'left the group (POST leave)', 'removed (DELETE member)'].includes(l.name));
  for (const loss of writers) {
    it(`revocation vs the manager's ${loss.name}`, async () => {
      let went = 0;
      let refused = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const f = await fresh(`rz-${loss.name.slice(0, 5).replace(/\W+/g, '')}-${i}`);
        const before = await inviteState(f);
        const [r, w] = await raceWithJitter(() => revokeIt(f), () => loss.happen(f));
        expect(r.statusCode, `round ${i} revoke: ${r.body}`).toBeLessThan(500);
        expect(w.statusCode, `round ${i} ${loss.name}: ${w.body}`).toBe(200);
        expect(await managerRow(f), `round ${i}`).toEqual(loss.row);
        if (r.statusCode === 200) {
          went++;
          expect((await inviteState(f))?.status, `round ${i}`).toBe('REVOKED');
        } else {
          refused++;
          expect(r.statusCode, `round ${i}: ${r.body}`).toBe(403);
          expect(await inviteState(f), `round ${i}: a refused revocation left something behind`).toEqual(before);
        }
      }
      console.log(`revoke vs ${loss.name}: went through=${went} refused=${refused}`);
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
