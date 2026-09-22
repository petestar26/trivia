import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma, type Prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { storage } from '@socialplay/storage';
import { STORAGE_BUCKETS } from '@socialplay/shared';
import * as broadcast from '../realtime/broadcast.js';
import { waitForBlockedBackends, ROW_LOCK_WAITS } from '../test/pg-locks.js';
import { cleanFixtures, createUser, ipAllocator, uniqueSuffix } from '../test/group-admission-fixtures.js';
import { SQL } from '../test/group-authority-fixtures.js';
import { holdWriteGate, installWriteGate, removeWriteGate } from '../test/group-write-gate.js';
import {
  addVoiceMessage,
  cleanupVoiceFixtureFiles,
  installFailingMessageUpdateTrigger,
  makeChatFixture,
  messageSnapshot,
  removeFailingMessageUpdateTrigger,
  type ChatFixture,
  type ChatUser,
  type VoiceFixture,
} from '../test/chat-message-fixtures.js';

// DELETE /groups/:id/messages/:messageId versus the ACTOR's authority, the
// message's own state, and two P2s a review (Sol) found in the FIRST fix:
//
//   1. A NONMEMBER EXISTENCE ORACLE. The first fix locked the actor row, then
//      read the message, then decided: for someone else's message, ONLY THEN
//      checking ACTIVE + role. A caller with no membership at all reached the
//      message lookup too, so a stranger could tell a live message (403) apart
//      from a missing or cross-group one (404) — an oracle for message
//      existence that a non-member must never be handed. ACTIVE membership is
//      now checked immediately after the actor row is locked, BEFORE the
//      message is ever read: a nonmember gets the SAME 403 whichever of those
//      three the id actually is.
//   2. AN INCOMPLETE POST-COMMIT ERROR BOUNDARY. The first fix called
//      deleteVoiceMessageStorage(messageId) after commit — a helper that looks
//      the voice message up ITSELF, with that lookup query uncaught. If that
//      query failed (a DB blip, a provider error) after the soft delete had
//      already committed and the event had already fired, the exception would
//      propagate out of the route handler and Fastify would answer 500 for a
//      deletion that had, in fact, succeeded. The storage key is now captured
//      INSIDE the transaction, while the message row is locked and the delete
//      is already authorized, so nothing outside the transaction ever queries
//      for it again; post-commit, the broadcast fires first and unconditionally,
//      and storage cleanup runs inside its own complete try/catch that discards
//      every failure — nothing after commit can turn a successful deletion into
//      a 500 or suppress the event that already announced it.
//
// Authorization, current state (chat.ts, "AUTHORITATIVE CHECKS"): lock the group
// row (level 2, FOR SHARE), then the ACTOR's own membership row (level 4, FOR
// SHARE) and require it ACTIVE, THEN lock the message row SCOPED TO THIS GROUP
// (level 5, FOR NO KEY UPDATE). The message's own author may delete it with no
// additional role; anyone else must be, RIGHT NOW, an ACTIVE OWNER or ADMIN.
//
// Because the actor row is locked and HELD (not combined with the message row
// in one ORDER BY id statement the way ban/unban/remove/role lock the actor and
// a target together), there is no "FORWARD" schedule here distinct from REVERSE:
// once the request has the actor row, any writer of that SAME row must wait for
// it. The three schedules below are QUEUED (the loss is already queued for the
// actor row when the request arrives), EXTERNAL (an uncommitted write that takes
// no group lock at all) and REVERSE (the request holds the actor row while
// parked elsewhere; the loss is seen WAITING on a real row lock).
//
// Every schedule is FORCED, never raced: a test-held lock (or the write gate)
// parks a request at a known point, and pg_stat_activity PROVES it is parked
// there before the competing writer is let through.
//
// Every real .ogg file a voice fixture writes to local storage is swept in
// afterAll (trackedVoiceMessage / cleanupVoiceFixtureFiles), regardless of
// which path each test took — a route genuinely cleaning up, a mocked-rejecting
// storage.delete, or a forced database failure that never reaches cleanup at all.
//
// Own file: the API's global rate limit is IP-keyed and shared per server
// instance, and every request below carries a unique remoteAddress.

const PREFIX = `${config.API_PREFIX}/groups`;
const EMAIL_PREFIX = 'cmd-';
const GROUP_PREFIX = 'ChatDel-';
const GATE = 'cmd_write_gate';
const FAIL_TRIGGER = 'cmd_fail_message_update';
const FAIL_MARKER = 'CmdFail-';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;
const nextIp = ipAllocator(84);

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
  await installWriteGate(GATE, GROUP_PREFIX);
  await installFailingMessageUpdateTrigger(FAIL_TRIGGER, FAIL_MARKER);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every REAL .ogg file addVoiceMessage wrote to local storage, so afterAll can
 * sweep whichever ones the test under it did not already delete (a route
 * genuinely cleaning up, or the fixture's OWN best-effort sweep of a file a
 * mocked-rejecting storage.delete never actually removed).
 */
const voiceFixtureKeys: string[] = [];
async function trackedVoiceMessage(f: ChatFixture, author: ChatUser, tag: string): Promise<VoiceFixture> {
  const v = await addVoiceMessage(f, author, tag);
  voiceFixtureKeys.push(v.storageKey);
  return v;
}

afterAll(async () => {
  await cleanupVoiceFixtureFiles(voiceFixtureKeys);
  if (dbAvailable) {
    await removeWriteGate(GATE);
    await removeFailingMessageUpdateTrigger(FAIL_TRIGGER);
    await cleanFixtures(EMAIL_PREFIX);
  }
  if (server) await server.close();
  await prisma.$disconnect();
});

interface Res {
  statusCode: number;
  body: string;
}
type Held = Prisma.TransactionClient;
const tx30 = { timeout: 30_000, maxWait: 30_000 };

const errorMessage = (resp: Res): string => JSON.parse(resp.body).error?.message as string;
const fresh = (tag: string) => makeChatFixture(EMAIL_PREFIX, GROUP_PREFIX, tag);

const asUser = (user: ChatUser) => ({
  authorization: `Bearer ${server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] })}`,
});
const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, as?: ChatUser, payload?: Record<string, unknown>): Promise<Res> =>
  server.inject({ method, url, headers: as ? asUser(as) : undefined, payload, remoteAddress: nextIp() });

const deleteMessage = (f: ChatFixture, as: ChatUser, messageId: string = f.messageId) =>
  call('DELETE', `${PREFIX}/${f.groupId}/messages/${messageId}`, as);
const ban = (f: ChatFixture, as: ChatUser, target: ChatUser) => call('POST', `${PREFIX}/${f.groupId}/members/${target.id}/ban`, as);
const role = (f: ChatFixture, as: ChatUser, target: ChatUser, r: 'ADMIN' | 'MODERATOR' | 'MEMBER') =>
  call('PATCH', `${PREFIX}/${f.groupId}/members/${target.id}/role`, as, { role: r });
const remove = (f: ChatFixture, as: ChatUser, target: ChatUser) => call('DELETE', `${PREFIX}/${f.groupId}/members/${target.id}`, as);
const leave = (f: ChatFixture, as: ChatUser) => call('POST', `${PREFIX}/${f.groupId}/leave`, as);

const holdRow = (tx: Held, table: 'group_members' | 'groups' | 'messages', id: string) =>
  tx.$queryRawUnsafe(`SELECT "id" FROM "${table}" WHERE "id" = $1 FOR UPDATE`, id);

/** The lock on a SINGLE message row (level 5, group-locks.ts "delete message"). */
const MESSAGE_LOCK = '%FROM "messages"%FOR NO KEY UPDATE%';
const MESSAGE_UPDATE = '%UPDATE "public"."messages"%';

async function actorRow(f: ChatFixture) {
  const rows = await prisma.$queryRaw<{ status: string; role: string }[]>`
    SELECT status::text AS status, role::text AS role FROM group_members WHERE id = ${f.adminRowId}
  `;
  return rows[0] ?? null;
}

/** Spies on the two post-commit side effects: the socket broadcast and the storage delete. */
function spyOnSideEffects() {
  const broadcastSpy = vi.spyOn(broadcast, 'emitToGroup');
  const storageSpy = vi.spyOn(storage, 'delete');
  return { broadcastSpy, storageSpy };
}

/** Everything a REFUSED delete must not have produced: the message untouched (xmin included), no broadcast, no storage call. */
async function expectNothingHappened(
  messageId: string,
  before: Awaited<ReturnType<typeof messageSnapshot>>,
  spies: ReturnType<typeof spyOnSideEffects>
) {
  expect(await messageSnapshot(messageId)).toEqual(before);
  expect(before?.isDeleted).toBe(false);
  expect(spies.broadcastSpy).not.toHaveBeenCalled();
  expect(spies.storageSpy).not.toHaveBeenCalled();
}

async function expectDeleted(messageId: string, resp: Res, groupId: string) {
  expect(resp.statusCode, resp.body).toBe(200);
  expect((await messageSnapshot(messageId))?.isDeleted).toBe(true);
  expect(broadcast.emitToGroup).toHaveBeenCalledWith(groupId, 'message:deleted', { messageId });
}

// ─── the ways the manager (an ADMIN) loses authority ─────────────────────────

interface Loss {
  name: string;
  happen: (f: ChatFixture) => Promise<Res>;
  message: string;
  row: { status: string; role: string } | null;
  /** The statement the competing writer itself waits in when it queues behind a lock on the manager's row. */
  waitsIn: string;
}

const losses: Loss[] = [
  { name: 'demoted to MEMBER', happen: (f) => role(f, f.owner, f.admin, 'MEMBER'), message: 'Insufficient permissions', row: { status: 'ACTIVE', role: 'MEMBER' }, waitsIn: SQL.memberRowsLock },
  { name: 'banned', happen: (f) => ban(f, f.owner, f.admin), message: 'You are not a member of this group', row: { status: 'BANNED', role: 'ADMIN' }, waitsIn: SQL.memberRowsLock },
  { name: 'removed', happen: (f) => remove(f, f.owner, f.admin), message: 'You are not a member of this group', row: null, waitsIn: SQL.memberRowsLock },
  { name: 'left the group', happen: (f) => leave(f, f.admin), message: 'You are not a member of this group', row: { status: 'LEFT', role: 'ADMIN' }, waitsIn: SQL.memberUpdate },
];

// ─── QUEUED: the delete waits on the MANAGER's row behind a writer that queued first ──

describeIf("QUEUED: the delete of someone else's message waits on the MANAGER's row behind a writer that queued first", () => {
  for (const loss of losses) {
    it(`${loss.name} queued first at the manager's row: the delete is refused once it gets the row`, async () => {
      const f = await fresh(`q-${loss.name.slice(0, 6).replace(/\W+/g, '')}`);
      const before = await messageSnapshot(f.messageId);
      const spies = spyOnSideEffects();
      let writerP: Promise<Res> | undefined;
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdRow(tx, 'group_members', f.adminRowId);
        writerP = loss.happen(f);
        writerP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: loss.waitsIn }); // the writer is parked first...
        pending = deleteMessage(f, f.admin); // deletes the AUTHOR's message, not the admin's own
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.actorShare }); // ...and the delete queues behind it, on the manager's row
      }, tx30);

      const [w, resp] = [await writerP!, await pending!];

      expect(w.statusCode, w.body).toBe(200);
      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(loss.message);
      expect(await actorRow(f)).toEqual(loss.row);
      await expectNothingHappened(f.messageId, before, spies);
    }, 60_000);
  }
});

// ─── EXTERNAL: a writer that bypasses the routes — and so the group lock — is waited for at the manager's ROW ──

describeIf("EXTERNAL: a writer that bypasses the routes is waited for at the manager's ROW", () => {
  const changes: Array<{ name: string; data: Prisma.GroupMemberUpdateInput; message: string }> = [
    { name: 'role MEMBER', data: { role: 'MEMBER' }, message: 'Insufficient permissions' },
    { name: 'status BANNED', data: { status: 'BANNED' }, message: 'You are not a member of this group' },
    { name: 'status MUTED', data: { status: 'MUTED' }, message: 'You are not a member of this group' },
  ];
  for (const change of changes) {
    it(`an uncommitted ${change.name} on the manager's row (no group lock taken) is waited for, then refused`, async () => {
      const f = await fresh(`ex-${change.name.slice(-4)}`);
      const before = await messageSnapshot(f.messageId);
      const spies = spyOnSideEffects();
      let pending: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.groupMember.update({ where: { id: f.adminRowId }, data: change.data });
        pending = deleteMessage(f, f.admin); // its plain fast-path checks (if any) still see the committed ADMIN
        pending.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: SQL.actorShare });
      }, tx30);

      const resp = await pending!;

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe(change.message);
      await expectNothingHappened(f.messageId, before, spies);
    }, 60_000);
  }
});

// ─── REVERSE: the delete holds the manager's row; the loss WAITS behind it and applies after ──

describeIf("REVERSE: the delete holds the manager's row through commit (parked in its own write); the loss WAITS behind it, then applies", () => {
  for (const loss of losses) {
    it(`the delete first (parked in its write): ${loss.name} waits behind it (proven, a real row-lock wait), then applies — the delete was legitimately authorized`, async () => {
      const f = await fresh(`rv-${loss.name.slice(0, 6).replace(/\W+/g, '')}`);
      spyOnSideEffects();
      let deleteP: Promise<Res> | undefined;
      let writerP: Promise<Res> | undefined;

      await prisma.$transaction(async (tx) => {
        await holdWriteGate(tx, GATE, f.groupId);
        deleteP = deleteMessage(f, f.admin);
        deleteP.catch(() => undefined);
        await waitForBlockedBackends(1, { queryLike: MESSAGE_UPDATE }); // it holds the group row, its own actor row and the message row, and is about to write

        writerP = loss.happen(f);
        writerP.catch(() => undefined);
        // Waiting behind the delete's ROW lock on the manager — not merely parked at the write gate, which the delete itself sits in.
        await waitForBlockedBackends(1, { queryLike: loss.waitsIn, waitEvents: ROW_LOCK_WAITS });
      }, tx30);

      const [d, w] = [await deleteP!, await writerP!];

      await expectDeleted(f.messageId, d, f.groupId);
      expect(w.statusCode, w.body).toBe(200);
      expect(await actorRow(f)).toEqual(loss.row);
    }, 60_000);
  }
});

// ─── self-delete: needs ACTIVE membership like anyone else; no additional role once they have it ──

describeIf('self-delete: an author needs ACTIVE membership BEFORE the message is ever read — the same gate everyone else passes through', () => {
  it('an ACTIVE MEMBER deletes their own message, no manager role required', async () => {
    const f = await fresh('self-member');
    spyOnSideEffects();
    await expectDeleted(f.messageId, await deleteMessage(f, f.author), f.groupId);
  });

  const nonActive: Array<{ name: string; make: (f: ChatFixture) => Promise<void> }> = [
    {
      name: 'BANNED',
      make: async (f) => {
        const b = await ban(f, f.owner, f.author);
        expect(b.statusCode, b.body).toBe(200);
      },
    },
    {
      name: 'MUTED',
      // No route sets MUTED directly today; an operator/future route is the only writer, so
      // this is exercised the same way the group-moderation suites test it: a direct write.
      make: async (f) => {
        await prisma.groupMember.update({ where: { id: f.authorRowId }, data: { status: 'MUTED' } });
      },
    },
    {
      name: 'LEFT',
      make: async (f) => {
        const l = await leave(f, f.author);
        expect(l.statusCode, l.body).toBe(200);
      },
    },
    {
      name: 'REMOVED (no membership row left at all)',
      make: async (f) => {
        const r = await remove(f, f.owner, f.author);
        expect(r.statusCode, r.body).toBe(200);
        expect(await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: f.groupId, userId: f.author.id } } })).toBeNull();
      },
    },
  ];
  for (const c of nonActive) {
    it(`${c.name}: the author cannot delete their own message — refused before the message is even read, nothing written`, async () => {
      const f = await fresh(`self-${c.name.slice(0, 4).toLowerCase()}`);
      await c.make(f);
      const before = await messageSnapshot(f.messageId);
      const spies = spyOnSideEffects();

      const resp = await deleteMessage(f, f.author);

      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe('You are not a member of this group');
      await expectNothingHappened(f.messageId, before, spies);
    }, 60_000);
  }
});

// ─── ordinary behavior and refusals that must not change ─────────────────────

describeIf('ordinary behavior of deleting someone ELSE\'s message is unchanged', () => {
  it('an ADMIN and the OWNER can delete another member\'s message', async () => {
    const f = await fresh('ok-admin');
    spyOnSideEffects();
    await expectDeleted(f.messageId, await deleteMessage(f, f.admin), f.groupId);

    const g = await fresh('ok-owner');
    spyOnSideEffects();
    await expectDeleted(g.messageId, await deleteMessage(g, g.owner), g.groupId);
  });

  it('a plain member (not the author, not a manager) cannot delete someone else\'s message', async () => {
    const f = await fresh('bystander');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.bystander);

    expect(resp.statusCode, resp.body).toBe(403);
    expect(errorMessage(resp)).toBe('Insufficient permissions');
    await expectNothingHappened(f.messageId, before, spies);
  });

  it('a nonmember gets the IDENTICAL refusal for a live message, a missing id, and a message in another group — no existence oracle', async () => {
    // ACTIVE membership is checked BEFORE the message is ever read (chat.ts, "AUTHORITATIVE
    // CHECKS"): a stranger's response must not depend on whether the message id is real, in
    // THIS group, or gone — all three would otherwise let a non-member learn something about
    // this group's messages just by comparing 403 against 404.
    const f = await fresh('oracle-a');
    const other = await fresh('oracle-b');
    const stranger = await createUser(EMAIL_PREFIX, 'oracle-str');
    const beforeLive = await messageSnapshot(f.messageId);
    const beforeOther = await messageSnapshot(other.messageId);
    const spies = spyOnSideEffects();

    const live = await deleteMessage(f, stranger, f.messageId);
    const missing = await deleteMessage(f, stranger, uniqueSuffixUuid());
    const crossGroup = await deleteMessage(f, stranger, other.messageId);

    for (const resp of [live, missing, crossGroup]) {
      expect(resp.statusCode, resp.body).toBe(403);
      expect(errorMessage(resp)).toBe('You are not a member of this group');
    }
    // Identical in everything but the per-request id Fastify's error handler stamps on every
    // response regardless of cause: strip it and the three bodies must be byte for byte the same.
    const withoutRequestId = (resp: Res) => {
      const parsed = JSON.parse(resp.body);
      delete parsed.meta?.requestId;
      return JSON.stringify(parsed);
    };
    expect(withoutRequestId(live)).toBe(withoutRequestId(missing));
    expect(withoutRequestId(missing)).toBe(withoutRequestId(crossGroup));
    expect(await messageSnapshot(f.messageId)).toEqual(beforeLive);
    expect(await messageSnapshot(other.messageId)).toEqual(beforeOther);
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
    expect(spies.storageSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('an anonymous (unauthenticated) caller is 401, nothing written', async () => {
    const f = await fresh('anon');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await server.inject({ method: 'DELETE', url: `${PREFIX}/${f.groupId}/messages/${f.messageId}`, remoteAddress: nextIp() });

    expect(resp.statusCode).toBe(401);
    await expectNothingHappened(f.messageId, before, spies);
  });

  it('a bogus group id is "Group not found"', async () => {
    const f = await fresh('bogus-group');
    const bad = await server.inject({
      method: 'DELETE',
      url: `${PREFIX}/${uniqueSuffixUuid()}/messages/${f.messageId}`,
      headers: asUser(f.admin),
      remoteAddress: nextIp(),
    });
    expect(bad.statusCode).toBe(404);
    expect(errorMessage(bad)).toBe('Group not found');
  });

  it('a GENUINE member of group B gets "Message not found" (404, not 403) for a message that lives in group A: cross-group safety for a real member', async () => {
    // Distinct from the nonmember-oracle test above: b.admin IS an ACTIVE member (of group B),
    // so they pass the membership gate and reach the message lookup, which is scoped to THEIR
    // group and correctly reports group A's message as not found there.
    const a = await fresh('idor-a');
    const b = await fresh('idor-b');
    const before = await messageSnapshot(a.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(b, b.admin, a.messageId);

    expect(resp.statusCode, resp.body).toBe(404);
    expect(errorMessage(resp)).toBe('Message not found');
    await expectNothingHappened(a.messageId, before, spies);
  });

  it('a message that is already deleted is "Message not found" on a second delete', async () => {
    const f = await fresh('redelete');
    const first = await deleteMessage(f, f.admin);
    expect(first.statusCode, first.body).toBe(200);
    const spies = spyOnSideEffects();

    const again = await deleteMessage(f, f.owner);

    expect(again.statusCode, again.body).toBe(404);
    expect(errorMessage(again)).toBe('Message not found');
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
  });

  it('two simultaneous deletes of the SAME message, both queued at its lock: exactly one succeeds, the other is 404, the event fires exactly once', async () => {
    const f = await fresh('dup-delete');
    const spies = spyOnSideEffects();
    let p1: Promise<Res> | undefined;
    let p2: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'messages', f.messageId);
      p1 = deleteMessage(f, f.admin);
      p2 = deleteMessage(f, f.owner);
      p1.catch(() => undefined);
      p2.catch(() => undefined);
      await waitForBlockedBackends(2, { queryLike: MESSAGE_LOCK });
    }, tx30);

    const results = [await p1!, await p2!];

    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' | ')).toEqual([200, 404]);
    expect(errorMessage(results.find((r) => r.statusCode === 404)!)).toBe('Message not found');
    expect((await messageSnapshot(f.messageId))?.isDeleted).toBe(true);
    expect(spies.broadcastSpy).toHaveBeenCalledTimes(1);
  }, 60_000);
});

// ─── GROUP STATE: the group row is genuinely locked, not just read ────────────

describeIf('GROUP STATE: the delete waits at the group row (level 2), not just a plain read', () => {
  it('parked on the GROUP row (held FOR UPDATE by the test): the delete waits there, then succeeds once released — proof the group is really locked, not just read', async () => {
    const f = await fresh('group-lock-proof');
    let pending: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = deleteMessage(f, f.admin);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupShare });
    }, tx30);

    const resp = await pending!;
    expect(resp.statusCode, resp.body).toBe(200);
  }, 60_000);

  it('the group is DELETED while the delete waits at the group row: "Group not found", not a 500', async () => {
    const f = await fresh('group-gone');
    const before = await messageSnapshot(f.messageId);
    let pending: Promise<Res> | undefined;

    await prisma.$transaction(async (tx) => {
      await holdRow(tx, 'groups', f.groupId);
      pending = deleteMessage(f, f.admin);
      pending.catch(() => undefined);
      await waitForBlockedBackends(1, { queryLike: SQL.lockGroupShare });
      await tx.group.delete({ where: { id: f.groupId } });
    }, tx30);

    const resp = await pending!;

    expect(resp.statusCode, resp.body).toBe(404);
    expect(errorMessage(resp)).toBe('Group not found');
    expect(await prisma.group.findUnique({ where: { id: f.groupId } })).toBeNull();
    expect(before?.isDeleted).toBe(false);
  }, 60_000);
});

// ─── database failure: the write does not commit, so nothing downstream runs ──

// A separate fixture-group prefix: the trigger raises for any message-update in a
// group whose NAME starts with it (chat-message-fixtures.ts), so these fixtures
// must live in THAT group, not the suite's ordinary GROUP_PREFIX one.
const freshFailing = (tag: string) => makeChatFixture(EMAIL_PREFIX, FAIL_MARKER, tag);

describeIf('DATABASE FAILURE: a soft-delete that does not commit leaves storage and the broadcast untouched', () => {
  it('a forced failure of the UPDATE rolls the whole delete back: 500, isDeleted still false, no event, no storage call', async () => {
    const f = await freshFailing('db-fail');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.admin);

    expect(resp.statusCode).toBe(500);
    // xmin included: the aborted UPDATE left the original row version in force.
    expect(await messageSnapshot(f.messageId)).toEqual(before);
    expect(before?.isDeleted).toBe(false);
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
    expect(spies.storageSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('a forced failure on a SELF-delete rolls back the same way (the self path still writes inside the same transaction): no event, no storage call', async () => {
    const f = await freshFailing('db-fail-self');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.author);

    expect(resp.statusCode).toBe(500);
    expect(await messageSnapshot(f.messageId)).toEqual(before);
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
    expect(spies.storageSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('a forced failure on a message WITH a voice attachment leaves the audio file exactly where it was: storage.delete is never called — proves the DB commit is what gates storage cleanup, not the other way around', async () => {
    const f = await freshFailing('db-fail-voice');
    const { messageId, storageKey } = await trackedVoiceMessage(f, f.author, 'db-fail-voice');
    const before = await messageSnapshot(messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.admin, messageId);

    expect(resp.statusCode).toBe(500);
    expect(await messageSnapshot(messageId)).toEqual(before);
    expect(before?.isDeleted).toBe(false);
    // The old order deleted the audio BEFORE the (here, failing) database write; the fixed
    // order never reaches storage cleanup unless the transaction actually committed.
    expect(spies.storageSpy).not.toHaveBeenCalled();
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
    await expect(storage.fileExists(STORAGE_BUCKETS.VOICE_MESSAGES, storageKey)).resolves.toBe(true);
  }, 60_000);
});

// ─── voice storage failure: best-effort, after commit, never fails the request ──

describeIf('VOICE STORAGE FAILURE: cleanup is best-effort and runs AFTER the database commit', () => {
  // "Every" post-commit storage failure: a plain Error (a network/provider outage), a bare
  // non-Error rejection value (nothing in the route may assume `instanceof Error`), and a
  // Node-style fs error object (what a real ENOENT from the local provider looks like). All
  // three must be swallowed by the SAME complete error boundary — 200, one event, the key
  // storage.delete was actually called with.
  const failureModes: Array<{ name: string; reject: unknown }> = [
    { name: 'a generic Error (network/provider outage)', reject: new Error('simulated storage outage') },
    { name: 'a non-Error rejection value (a bare string)', reject: 'boom' },
    { name: 'a Node-style fs error object (ENOENT)', reject: Object.assign(new Error('no such file or directory'), { code: 'ENOENT' }) },
  ];
  for (const mode of failureModes) {
    it(`storage.delete rejecting with ${mode.name} still returns 200 with exactly one event, and storage.delete was actually attempted`, async () => {
      const f = await fresh(`storage-fail-${mode.name.slice(0, 4).replace(/\W+/g, '')}`);
      const { messageId, storageKey } = await trackedVoiceMessage(f, f.author, 'storage-fail');
      const spies = spyOnSideEffects();
      spies.storageSpy.mockRejectedValueOnce(mode.reject);

      const resp = await deleteMessage(f, f.admin, messageId);

      expect(resp.statusCode, resp.body).toBe(200);
      expect((await messageSnapshot(messageId))?.isDeleted).toBe(true);
      expect(spies.broadcastSpy).toHaveBeenCalledTimes(1);
      expect(spies.broadcastSpy).toHaveBeenCalledWith(f.groupId, 'message:deleted', { messageId });
      expect(spies.storageSpy).toHaveBeenCalledWith(expect.objectContaining({ key: storageKey }));
    }, 60_000);
  }

  it('a post-commit database lookup failing (the regression Finding 2 fixed: the key was looked up AGAIN, outside the transaction) must not turn a successful deletion into a 500 — the committed delete and its event stand regardless', async () => {
    // The fixed route never queries the database again after commit: the storage key is
    // captured inside the transaction, so `prisma.voiceMessage.findUnique` (the top-level
    // client — distinct from the `tx` used inside the transaction) is never called here at
    // all. Mocking it to reject pins that: this is the regression guard for CB4 in the
    // mutation battery, which reintroduces exactly the unguarded post-commit lookup this
    // fixes, and Finding 2's requirement that a database failure after commit — not just a
    // storage failure — must never surface as a 500 for a deletion that already succeeded.
    const f = await fresh('post-commit-db-fail');
    const { messageId } = await trackedVoiceMessage(f, f.author, 'post-commit-db-fail');
    const spies = spyOnSideEffects();
    const dbSpy = vi.spyOn(prisma.voiceMessage, 'findUnique').mockRejectedValueOnce(new Error('simulated post-commit DB blip'));

    const resp = await deleteMessage(f, f.admin, messageId);

    expect(resp.statusCode, resp.body).toBe(200);
    expect((await messageSnapshot(messageId))?.isDeleted).toBe(true);
    expect(spies.broadcastSpy).toHaveBeenCalledTimes(1);
    dbSpy.mockRestore();
  }, 60_000);

  it('an ordinary voice-message delete really does clean up storage: the file is gone afterwards', async () => {
    const f = await fresh('storage-ok');
    const { messageId, storageKey } = await trackedVoiceMessage(f, f.author, 'storage-ok');

    const resp = await deleteMessage(f, f.admin, messageId);

    expect(resp.statusCode, resp.body).toBe(200);
    await expect(storage.fileExists(STORAGE_BUCKETS.VOICE_MESSAGES, storageKey)).resolves.toBe(false);
  }, 60_000);

  it('a text message (no voice attachment) does not touch storage at all', async () => {
    const f = await fresh('no-voice');
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.admin);

    expect(resp.statusCode, resp.body).toBe(200);
    expect(spies.storageSpy).not.toHaveBeenCalled();
  }, 60_000);
});

function uniqueSuffixUuid(): string {
  const s = uniqueSuffix();
  return `${s.slice(0, 8)}-0000-4000-8000-${s.padEnd(12, '0').slice(0, 12)}`;
}
