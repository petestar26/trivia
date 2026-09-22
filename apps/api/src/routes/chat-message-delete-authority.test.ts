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
  installFailingMessageUpdateTrigger,
  makeChatFixture,
  messageSnapshot,
  removeFailingMessageUpdateTrigger,
  type ChatFixture,
  type ChatUser,
} from '../test/chat-message-fixtures.js';

// DELETE /groups/:id/messages/:messageId versus the ACTOR's authority and the
// message's own state.
//
// The route judged everything with plain reads, then wrote unconditionally:
//
//   const membership = await assertActiveMember(groupId, userId);  // no lock
//   const message = await getMessageInGroup(groupId, messageId);   // no lock
//   ... isOwn/isManager on that stale read ...
//   if (message.voiceMessage) await deleteVoiceMessageStorage(message.id);  // BEFORE the write
//   await prisma.message.update({ where: { id: message.id }, data: { isDeleted: true } });
//   emitToGroup(groupId, 'message:deleted', ...);
//
// A manager demoted, banned, muted or removed after the membership read still
// deleted another member's message; a soft-delete that failed to commit had
// already deleted the voice audio out from under a message that still looked
// live; and the event fired even when nothing was written.
//
// The fix (group-locks.ts, "delete message"; lockGroupMessageForDeletion): inside
// one transaction, lock the group row (level 2, FOR SHARE), the ACTOR's own
// membership row (level 4, FOR SHARE) and the message row SCOPED TO THIS GROUP
// (level 5, FOR NO KEY UPDATE), and decide on what they hold NOW. The message's
// own author may always delete it — the actor row is still locked, for the same
// order every transaction at this level takes, but its value gates nothing on
// that branch; anyone else must be, RIGHT NOW, an ACTIVE OWNER or ADMIN. Voice
// storage cleanup and the broadcast now run ONLY after the transaction commits.
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

afterAll(async () => {
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

// ─── self-delete: the author's own current state never gates it ──────────────

describeIf('self-delete: the message author may always delete it, regardless of their current membership', () => {
  it('a plain MEMBER deletes their own message', async () => {
    const f = await fresh('self-member');
    spyOnSideEffects();
    await expectDeleted(f.messageId, await deleteMessage(f, f.author), f.groupId);
  });

  it('a BANNED author can still delete their own message', async () => {
    const f = await fresh('self-banned');
    const b = await ban(f, f.owner, f.author);
    expect(b.statusCode, b.body).toBe(200);
    spyOnSideEffects();
    await expectDeleted(f.messageId, await deleteMessage(f, f.author), f.groupId);
  });

  it('a REMOVED author (no membership row left at all) can still delete their own message', async () => {
    const f = await fresh('self-removed');
    const r = await remove(f, f.owner, f.author);
    expect(r.statusCode, r.body).toBe(200);
    expect(await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: f.groupId, userId: f.author.id } } })).toBeNull();
    spyOnSideEffects();
    await expectDeleted(f.messageId, await deleteMessage(f, f.author), f.groupId);
  });

  it('an author who LEFT can still delete their own message', async () => {
    const f = await fresh('self-left');
    const l = await leave(f, f.author);
    expect(l.statusCode, l.body).toBe(200);
    spyOnSideEffects();
    await expectDeleted(f.messageId, await deleteMessage(f, f.author), f.groupId);
  });
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

  it('a caller with no membership row at all is "You are not a member of this group"', async () => {
    const f = await fresh('stranger');
    const stranger = await createUser(EMAIL_PREFIX, 'stranger-str');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, stranger);

    expect(resp.statusCode, resp.body).toBe(403);
    expect(errorMessage(resp)).toBe('You are not a member of this group');
    await expectNothingHappened(f.messageId, before, spies);
  });

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

  it('a message that belongs to ANOTHER group is "Message not found" (cross-group IDOR): the other group\'s message is untouched', async () => {
    const a = await fresh('idor-a');
    const b = await fresh('idor-b');
    const before = await messageSnapshot(a.messageId);
    const spies = spyOnSideEffects();

    // b.admin is a legitimate manager of group B, attempting to delete a message that lives in group A.
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
  it('a forced failure of the UPDATE rolls the whole delete back: 500, isDeleted still false, no broadcast', async () => {
    const f = await freshFailing('db-fail');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.admin);

    expect(resp.statusCode).toBe(500);
    // xmin included: the aborted UPDATE left the original row version in force.
    expect(await messageSnapshot(f.messageId)).toEqual(before);
    expect(before?.isDeleted).toBe(false);
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('a forced failure on a SELF-delete rolls back the same way (the self path still writes inside the same transaction)', async () => {
    const f = await freshFailing('db-fail-self');
    const before = await messageSnapshot(f.messageId);
    const spies = spyOnSideEffects();

    const resp = await deleteMessage(f, f.author);

    expect(resp.statusCode).toBe(500);
    expect(await messageSnapshot(f.messageId)).toEqual(before);
    expect(spies.broadcastSpy).not.toHaveBeenCalled();
  }, 60_000);

  it('a forced failure on a message WITH a voice attachment leaves the audio file exactly where it was: storage.delete is never called — proves the DB commit is what gates storage cleanup, not the other way around', async () => {
    const f = await freshFailing('db-fail-voice');
    const { messageId, storageKey } = await addVoiceMessage(f, f.author, 'db-fail-voice');
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
  it('storage.delete rejecting does not fail the request: the message is still deleted and announced, and storage.delete was actually attempted', async () => {
    const f = await fresh('storage-fail');
    const { messageId, storageKey } = await addVoiceMessage(f, f.author, 'storage-fail');
    const spies = spyOnSideEffects();
    spies.storageSpy.mockRejectedValueOnce(new Error('simulated storage outage'));

    const resp = await deleteMessage(f, f.admin, messageId);

    expect(resp.statusCode, resp.body).toBe(200);
    expect((await messageSnapshot(messageId))?.isDeleted).toBe(true);
    expect(spies.broadcastSpy).toHaveBeenCalledWith(f.groupId, 'message:deleted', { messageId });
    expect(spies.storageSpy).toHaveBeenCalledWith(expect.objectContaining({ key: storageKey }));
  }, 60_000);

  it('an ordinary voice-message delete really does clean up storage: the file is gone afterwards', async () => {
    const f = await fresh('storage-ok');
    const { messageId, storageKey } = await addVoiceMessage(f, f.author, 'storage-ok');

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
