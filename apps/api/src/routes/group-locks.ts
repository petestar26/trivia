import type { Prisma } from '@socialplay/database';

/**
 * Locking protocol for the group's membership, invitation, message and
 * management writers: admission (invite acceptance, join approval, public join,
 * request to join), invite creation and revocation, bans and unbans, removal,
 * role changes, request rejection, ownership transfer, group edit and deletion,
 * chat message deletion, and an external status change. Every one that acts on
 * behalf of a MANAGER re-checks that manager's authority — and the group's
 * state — under a lock (see "Level 4 and the actor" below).
 *
 * These writers race on overlapping rows and, without a protocol, admit an
 * account that was just restricted, admit into a group that was just archived,
 * let a manager who was just demoted, banned or replaced finish an action, and
 * deadlock each other (measured: an accept holding the invite row while waiting
 * for the member row, against a ban holding the member row while waiting for the
 * invite row, produced PostgreSQL 40P01 and a 500 for the ban while the target
 * was admitted anyway; and an acceptance that read the group ACTIVE, then waited
 * on the invite row, committed a membership after an external writer had
 * already committed ARCHIVED).
 *
 * ── Lock order ────────────────────────────────────────────────────────────
 * Every transaction that takes more than one of these takes them in THIS
 * order, skipping the levels it does not need, with two exceptions that are
 * safe and explained below: the recipient's users row locked by a notification
 * insert, and invite acceptance, which takes its invite row (5) before its
 * member row (4). Consistent ordering is what rules out a wait-for cycle.
 *
 *   1. users row               FOR SHARE   (the account gate)
 *   2. groups row              FOR SHARE for admission and every manager action;
 *                              FOR NO KEY UPDATE for edit (and the row lock an
 *                              UPDATE takes for transfer and status changes);
 *                              FOR UPDATE for deletion   (the group gate)
 *   3. (group, email) advisory lock                     (the invite subject)
 *   4. group_members row(s): the ACTOR's row and the TARGET's, locked TOGETHER,
 *      in ONE statement, in ASCENDING id order (lockActorAndTarget) — or the
 *      actor's row alone, FOR SHARE (lockActorMembership), when the action
 *      writes no other member row
 *   5. group_invites row(s)
 *   6. notifications (inserts only; nothing waits on them)
 *
 * One lock is taken deliberately out of this order, and is safe: the foreign key
 * of a notification insert takes FOR KEY SHARE on the RECIPIENT's users row —
 * a users lock, after the member rows (level 6 after level 4). FOR KEY SHARE
 * conflicts with nothing but FOR UPDATE, which only a DELETE of that user or an
 * UPDATE of one of its key columns takes; no writer named here does either
 * (an account-status writer's UPDATE takes FOR NO KEY UPDATE). A writer that DID
 * key-update a users row and then touched group rows would have to be added to
 * this audit. The INSERT of a member row likewise takes FOR KEY SHARE on the
 * group row and on the member's users row, which the admission routes already
 * hold FOR SHARE — the same rows in a stronger mode, so it can never wait.
 *
 * ── Who takes what — the writer audit ─────────────────────────────────────
 * Every transaction in the API's group routes that touches a group,
 * group_members or group_invites row, and where it sits in the order:
 *
 *   accept-invite    1 → 2 (SHARE) → 3 → 5 → 4 → 6
 *                    holds all of them through commit. (The invite row is
 *                    claimed before the membership row is written: both are
 *                    behind the subject lock, so no other admission, ban,
 *                    invite creation or revocation for this subject can
 *                    interleave.)
 *   join (public)    1 (the CALLER) → 2 (SHARE) → 4
 *                    one member row: an INSERT, or a guarded UPDATE of a LEFT
 *                    row (status LEFT, role not OWNER). No notification. The
 *                    GROUP_JOIN activity is recorded after commit.
 *   request to join  1 (the CALLER) → 2 (SHARE) → 4 → 6
 *                    one member row: an INSERT, or a guarded UPDATE of a LEFT
 *                    row; then a notification for each manager. No activity.
 *
 *   Manager actions — each re-reads the actor's authority under the locks:
 *   approve request  1 (the APPLICANT) → 2 (SHARE) → 4 (ACTOR + applicant) → 6
 *   reject request   2 (SHARE, ACTIVE) → 4 (ACTOR + applicant) → 6
 *   create invite    2 (SHARE, ACTIVE + private) → 3 → 4 (the ACTOR, SHARE)
 *                    → 5 → 6
 *   revoke invite    2 (SHARE) → 3 → 4 (the ACTOR, SHARE) → 5
 *   ban              2 (SHARE, ACTIVE) → 3 → 4 (ACTOR + target) → 5 → 6
 *   unban            2 (SHARE, ACTIVE) → 3 → 4 (ACTOR + target) → 6
 *                    (ban's order without level 5: it never touches invites,
 *                    so the ones a ban revoked stay revoked)
 *   remove member    2 (SHARE) → 4 (ACTOR + target)
 *   change role      2 (SHARE) → 4 (ACTOR + target)
 *   edit group       2 (FOR NO KEY UPDATE) → 4 (the ACTOR, SHARE) → its own UPDATE
 *   delete group     2 (FOR UPDATE) → 4 (the ACTOR, SHARE) → 4 (every member row)
 *                    → cascade: the group's invites (5), messages and
 *                    competitions. It used to delete the members BEFORE taking
 *                    the group row: the inverse of transfer (group row, then
 *                    members), so the two could deadlock, and of admission,
 *                    where a delete holding member rows would wait for a group
 *                    row that an admission held while that admission waited
 *                    for the member rows.
 *   transfer         2 (an UPDATE, its FIRST statement, guarded on ownerId AND
 *                    ACTIVE: a group that is not ACTIVE is a 400, one whose owner
 *                    or existence changed a 409) → 4 (the owner's row, its
 *                    demotion guarded on being an ACTIVE OWNER, then the target's
 *                    promotion guarded on being ACTIVE) → 6. The group's name for
 *                    the notifications is read AFTER that UPDATE, from the row it
 *                    holds.
 *
 *   delete message   2 (SHARE) → 4 (the ACTOR, SHARE) → 5 (the message row,
 *   (routes/chat.ts) FOR NO KEY UPDATE). Authorized on the locked actor's row
 *                    UNLESS the message is the actor's own, which needs no role:
 *                    the actor row is still locked, for the same order every
 *                    transaction at this level takes, but its value only gates
 *                    someone deleting ANOTHER member's message.
 *
 *   leave            4 only  one statement on the caller's OWN row; it holds
 *                            nothing while it waits and takes no group lock
 *   external group   2 only  (an UPDATE of groups.status by an operator or a
 *   status change            moderation tool)
 *   account status   1 only  any writer that changes users.status (UPDATE
 *   writers                  takes the row lock implicitly) MUST update the
 *                            users row FIRST and touch anything else afterwards
 *                            — the groups row included. A writer that took a
 *                            group_members or groups lock before the users row
 *                            would invert the order and reintroduce the cycle.
 *   chat message create, competitions
 *                    INSERTs whose foreign key takes only FOR KEY SHARE on the
 *                    groups row, which conflicts with nothing but FOR UPDATE
 *                    (deletion). Neither holds anything a deleter needs.
 *
 * Why there is no cycle. A deadlock needs two transactions that each hold
 * something the other wants, so it is enough to check every pair of writers
 * that can hold overlapping locks at once:
 *
 *   - Level 2 in a CONFLICTING mode (transfer, edit, delete, a status change)
 *     is always a writer's FIRST lock: it holds nothing while it waits for the
 *     group row, so nothing can be waiting for it — and once it holds the row,
 *     no admission or manager action can be inside its transaction (they hold
 *     the group row FOR SHARE from before any advisory, member or invite lock
 *     until commit). None is ever caught holding one of those while waiting for
 *     the group row; all it can hold at that point is a users row, FOR SHARE,
 *     which no group writer takes.
 *   - Admission (accept, approve, join, request), the manager actions and
 *     creating an invite hold level 2 in a compatible mode, so they never wait
 *     on each other there. Writers for one subject then serialize on level 3
 *     (accept, create, revoke, ban and unban all take it), and take the rest in
 *     the same direction.
 *   - TWO MEMBER ROWS. Approve, reject, ban, unban, remove and change role each
 *     hold the actor's row and a target's at once; transfer holds two; delete
 *     holds them all. Transfer and delete take the group row in a conflicting
 *     mode, so they never overlap with the other six. Among the six, both rows
 *     are locked in ONE statement, in ascending id order, whichever of them is
 *     the actor: two of them can never each hold the row the other is waiting
 *     for — including two managers acting on each other (A bans B while B bans
 *     A, A demotes B while B removes A), and one manager approving and rejecting
 *     the same request. (Locking "the actor first, then the target" is exactly
 *     the order that lets those two deadlock.)
 *   - Join and request take levels 1 and 2 (SHARE) before their member row and
 *     hold them to commit, and take NO level 3 and NO level 5: they never touch
 *     an invite, and their membership write is one guarded UPDATE or INSERT of
 *     one row. A ban or unban that races them meets them only on that row, where
 *     the guard makes each order coherent — ban first, and the join is refused
 *     and the member stays BANNED; join first, and the ban applies afterwards —
 *     and neither waits for anything the other holds (a ban holds levels 2-4
 *     and then wants invite rows and a notification; join and request hold
 *     levels 1-2 and want only the member row — and, for a request, the
 *     notification inserts). That is why the (group, email) advisory lock is
 *     not needed here. Accept meets them on the member row only.
 *   - Accept takes the INVITE row (5) before the MEMBER row (4) — the clock
 *     rule below needs the invite locked before it is read — while ban, create
 *     and revoke take member rows before invite rows (4 → 5). That inversion is
 *     safe only because every transaction holding both is excluded from running
 *     alongside an accept by a lock taken EARLIER: the subject lock (3) for
 *     ban, create and revoke, the group row (2) for delete and transfer.
 *   - Create, revoke, edit and delete lock the actor's row alone, FOR SHARE,
 *     and never upgrade it (delete deletes it, but holds the group row FOR
 *     UPDATE, which excludes every other holder). Create and revoke then want
 *     invite rows, which only the writers holding the same subject lock also
 *     take before their own member rows.
 *   - Approve, join and request hold a member row and nothing after it that any
 *     other writer holds (see the note on notification inserts above).
 *   - Leave is one statement on one row.
 *   - Delete message holds level 2 in the SAME compatible mode admission and the
 *     manager actions do (FOR SHARE), so bullet two already excludes it from
 *     waiting on any of them there, and excludes a group DELETE — level 2 in a
 *     CONFLICTING mode — from being mid-flight while it holds the group row. It
 *     then locks the actor's row alone, FOR SHARE, exactly like create, revoke
 *     and edit (never upgraded, so two deletions by one member queue but cannot
 *     deadlock), and only then wants the MESSAGE row. Nothing else locks a
 *     message row: creating one is an INSERT whose foreign key takes FOR KEY
 *     SHARE on the group row and nothing on any member row, and a group DELETE's
 *     cascade removal of it is excluded by the group-row argument above. Two
 *     deletions of the SAME message queue on that row; the second sees it
 *     already isDeleted and no-ops.
 *
 * ── Level 2 and a group that stops being ACTIVE (or changes privacy) ─────
 * Admission must not commit a membership into a group that is no longer
 * ACTIVE, and the two direct routes must not run against the wrong kind of
 * group: join needs a PUBLIC group and request a PRIVATE one. Ban, unban, reject
 * and transfer refuse an inactive group too, and invite creation needs one that
 * is ACTIVE and PRIVATE. A plain read of groups.status or groups.isPrivate taken
 * before the transaction — or anywhere in it without a lock — can be stale by the
 * time the write happens, because every later lock (subject, member, invite) can
 * make the transaction wait for as long as another one holds it. So the group
 * row is locked (lockGroupForAdmission) and its status and privacy read AFTER the
 * lock is held, and the lock is kept until commit: an external status or privacy
 * change then either commits BEFORE the lock is granted (the action reads the new
 * state and is rejected, nothing written) or waits for the action to commit (it
 * was legitimately performed on an ACTIVE group of the right kind at its
 * serialization point). The same holds for the account row (level 1): a
 * restriction commits before the lock is granted and refuses the call, or waits
 * for it and applies after. FOR SHARE is the weakest mode that blocks a status or
 * privacy UPDATE; it does not block other admissions or manager actions, which
 * take it too, so admissions and manager actions on one group still run in parallel.
 *
 * ── Level 4 and the actor ─────────────────────────────────────────────────
 * A manager's authority — an ADMIN or OWNER membership that is ACTIVE — is read
 * by every one of these routes with a plain query BEFORE the transaction (the
 * fast path, assertManager). It can be stale by the time the transaction writes:
 * the manager can be demoted, banned, muted, removed or leave, and an owner can
 * hand the group over (and so become an ADMIN, who may not mint ADMIN invites or
 * promote to ADMIN, and may not edit or delete the group), all after that read.
 * So the transaction locks the ACTOR's own membership row, re-reads role and
 * status from it, applies the very same rules (assertActorAuthority, through the
 * one shared authorizeManagerAction) and holds the lock to commit. A demotion,
 * ban, leave or removal — each an UPDATE or DELETE of that row — then either
 * commits BEFORE the lock is granted (the action is refused, nothing written) or
 * waits for the action to commit (it was legitimately authorized at its
 * serialization point). Anything the action then decides about the actor — the
 * ADMIN ceiling on invites and role changes — is decided on the LOCKED role.
 *
 * Deleting a chat message is the one action at this level with a SELF path: the
 * message's own author may always delete it, so the locked actor row is taken —
 * for the same order every transaction at this level takes, and because a stale
 * MANAGER deleting someone else's message is exactly the same race — but its
 * role and status only gate the non-author branch. A member banned, muted,
 * removed or demoted mid-flight can still finish deleting their OWN message; the
 * same race against someone ELSE's message is refused exactly like every other
 * manager action here.
 *
 * Modes and order at level 4:
 *   - An action that writes a target member row locks the actor's row and the
 *     target's together, FOR NO KEY UPDATE (the lock the write takes anyway), in
 *     ONE statement ordered by id. One statement, so the order cannot depend on
 *     which of the two is the actor; ascending id, so every such action agrees.
 *   - An action that writes no other member row (create and revoke an invite,
 *     edit, delete, delete message) locks the actor's row alone, FOR SHARE: two
 *     such actions by one manager do not queue behind each other.
 *   - AFTER level 3. Ban, unban, accept and revoke take the (group, email)
 *     subject lock and only then a member row; an invite creation that held the
 *     actor's row while waiting for that subject lock could wait for a ban that
 *     waits for the same row. So the subject lock comes first, the member rows
 *     second, in every writer.
 *   - Nobody holds an actor's row while waiting for another writer's target row
 *     in the opposite order: see "Two member rows" above.
 *   - The price of locking the manager's row in the target's mode: two of these
 *     actions by ONE manager (two approvals, a ban and a role change) queue on the
 *     manager's own row for the length of one short transaction. Nothing waits for
 *     anything else while it holds that row, so they cannot deadlock; they only
 *     serialize. Invite creation and revocation, edit and delete take the row FOR
 *     SHARE and do not queue behind each other.
 *
 * Deletion and edit also re-read the OWNER from the locked group row (ownerId):
 * the caller must be groups.ownerId AND an ACTIVE OWNER member. The group row
 * lock is what makes that stable — a transfer rewrites ownerId and both owners'
 * rows only while holding the group row.
 *
 * Not under this protocol: manager checks OUTSIDE the group routes — the
 * competition functions createCompetition, updateCompetition, cancelCompetition
 * and finalizeCompetition (competitions/competition-service.ts, assertGroupRole).
 * They still trust a plain read of the actor, and their transactions move wallet
 * balances, so they need their own audit before they take group locks. Chat's
 * DELETE /groups/:id/messages/:messageId (routes/chat.ts) is now under this
 * protocol too (see "delete message" above and lockGroupMessageForDeletion
 * below) — the sole exception is that its actor-row lock gates the check only
 * when the caller is not the message's own author (see "Level 4 and the actor").
 *
 * ── Level 5 and the clock ─────────────────────────────────────────────────
 * The invite row lock is not just ordering. Acceptance decides "is this invite
 * still live?" against the clock, and every lock above can make it wait — for
 * as long as a competing transaction holds it — so an invite that was valid
 * when acceptance started can be past its deadline by the time the last lock is
 * held. Two rules follow, and both are needed:
 *
 *   - Take the invite row lock (lockInviteRow) BEFORE reading the clock. A
 *     bare `UPDATE ... WHERE "expiresAt" > <clock>` is not enough: its WHERE
 *     is evaluated before the row lock wait, and PostgreSQL re-evaluates it
 *     afterwards only if the row was UPDATED meanwhile — a lock-only holder
 *     (a SELECT ... FOR UPDATE, any explicit row lock) leaves the stale answer
 *     in place. Locking first makes the later UPDATE wait-free.
 *   - Read a real clock (a fresh `new Date()`, or clock_timestamp()) AFTER
 *     that lock is held. Never the transaction-start now() / CURRENT_TIMESTAMP,
 *     which are frozen at BEGIN and would call a long-blocked, long-expired
 *     invite live.
 *
 * ── Why level 1 is FOR SHARE ──────────────────────────────────────────────
 * Admission needs the account's status/email/verification to stay put until
 * it commits, but it never writes the users row. FOR SHARE blocks a
 * concurrent status UPDATE (which needs FOR NO KEY UPDATE, and conflicts with
 * SHARE) while still letting two admissions for the same account proceed in
 * parallel.
 *
 * ── Why level 3 is an advisory lock and not a row lock ────────────────────
 * The subject a ban and an invite contend for may have NO row to lock yet: an
 * invitee with no membership can be invited, then send a join request that a
 * manager bans, all before any lockable row exists at the moment the invite
 * checks. Keying a transaction-scoped advisory lock on (group, lowercased
 * email) serializes those writers regardless of which rows exist, and — since
 * accept, ban and create all take it — makes their later row-level lock
 * orders irrelevant to each other.
 *
 * ── What a re-read under the lock does and does not prove ────────────────
 * A plain read taken BEFORE the lock (the fast-path checks in the routes) is
 * only an optimization: it can be stale the moment it returns. Authority
 * comes from reading the row AFTER acquiring the lock, inside the same
 * transaction, and keeping the lock until commit. Reading twice without
 * holding a lock between the read and the write does NOT close the race.
 */

export type Tx = Prisma.TransactionClient;

/**
 * The only account status permitted to be admitted. This is the codebase's
 * canonical "usable account" test (login, user search, challenges and
 * withdrawal disputes all require status === 'ACTIVE'); a blacklist of
 * restricted states would silently admit any state added later, and would
 * already admit PENDING_VERIFICATION.
 */
export const ADMISSION_PERMITTED_USER_STATUSES = ['ACTIVE'] as const;

export interface LockedAccount {
  id: string;
  email: string | null;
  isVerified: boolean;
  status: string;
}

/** Level 1: lock and re-read the account row. Returns null if it is gone. */
export async function lockAccountForAdmission(tx: Tx, userId: string): Promise<LockedAccount | null> {
  const rows = await tx.$queryRaw<LockedAccount[]>`
    SELECT "id", "email", "isVerified", "status"::text AS "status"
    FROM "users"
    WHERE "id" = ${userId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

/**
 * The only group status that admits new members: an INACTIVE, ARCHIVED or
 * BANNED group admits nobody (and one added later would not either — this is an
 * allow-list, like the account one above).
 */
export const ADMISSION_PERMITTED_GROUP_STATUSES = ['ACTIVE'] as const;

export interface LockedGroup {
  id: string;
  name: string;
  status: string;
  isPrivate: boolean;
  ownerId: string;
}

/**
 * Level 2, for admission, invite creation and every manager action that only
 * needs the group to stay as it is: lock the group row FOR SHARE and return what
 * it holds NOW — status, privacy, name and owner, read after the lock is granted.
 * Returns null if the group is gone.
 *
 * The lock is held to commit, so what this returns stays true for the whole
 * transaction: an external UPDATE of the row waits behind it. Waiting for the
 * lock (behind such an UPDATE, or a FOR UPDATE) and then re-reading is what makes
 * the answer authoritative — under READ COMMITTED the statement returns the
 * latest COMMITTED version of the row once the lock is granted.
 *
 * FOR SHARE, not FOR KEY SHARE: KEY SHARE does not conflict with an UPDATE that
 * leaves the key alone, which is exactly what a status change is. It is not
 * FOR UPDATE either, which would serialize every admission to a group.
 */
export async function lockGroupForAdmission(tx: Tx, groupId: string): Promise<LockedGroup | null> {
  const rows = await tx.$queryRaw<LockedGroup[]>`
    SELECT "id", "name", "status"::text AS "status", "isPrivate", "ownerId"
    FROM "groups"
    WHERE "id" = ${groupId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

/**
 * Level 2, for an EDIT: lock the group row FOR NO KEY UPDATE — the mode the
 * UPDATE takes anyway — as the editor's FIRST statement, and return what it
 * holds NOW. Conflicts with every FOR SHARE holder, so nothing is admitted,
 * banned, promoted or transferred while the edit is in flight. Null if gone.
 */
export async function lockGroupForEdit(tx: Tx, groupId: string): Promise<LockedGroup | null> {
  const rows = await tx.$queryRaw<LockedGroup[]>`
    SELECT "id", "name", "status"::text AS "status", "isPrivate", "ownerId"
    FROM "groups"
    WHERE "id" = ${groupId}
    FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Level 2, for deletion: lock the group row FOR UPDATE — the mode a DELETE
 * takes — as a deleter's FIRST statement, before it touches a member row, and
 * return what it holds NOW (who owns the group among it: stable for as long as
 * the lock is held, because a transfer needs this row). Null if already gone.
 */
export async function lockGroupForDeletion(tx: Tx, groupId: string): Promise<LockedGroup | null> {
  const rows = await tx.$queryRaw<LockedGroup[]>`
    SELECT "id", "name", "status"::text AS "status", "isPrivate", "ownerId"
    FROM "groups"
    WHERE "id" = ${groupId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export interface LockedMembership {
  id: string;
  userId: string;
  role: string;
  status: string;
}

/**
 * Level 4, for an ACTOR whose action writes NO other member row (create or
 * revoke an invite, edit, delete): lock the actor's own membership row in the
 * group FOR SHARE and return what it holds NOW — role and status, read after the
 * lock is granted. Returns null if the actor has no membership in the group.
 *
 * The lock is held to commit, so the authority this returns stays true for the
 * whole transaction: a demotion, ban, leave or removal of the actor waits behind
 * it. Under READ COMMITTED the statement returns the latest COMMITTED version of
 * the row once the lock is granted, and no row if it was deleted meanwhile.
 * FOR SHARE, not FOR UPDATE: nothing here writes the row, and two actions by the
 * same manager must not queue behind each other. See "Level 4 and the actor" in
 * the header for where in the order it goes.
 */
export async function lockActorMembership(tx: Tx, groupId: string, userId: string): Promise<LockedMembership | null> {
  const rows = await tx.$queryRaw<LockedMembership[]>`
    SELECT "id", "userId", "role"::text AS "role", "status"::text AS "status"
    FROM "group_members"
    WHERE "groupId" = ${groupId} AND "userId" = ${userId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

export interface LockedActorAndTarget {
  actor: LockedMembership | null;
  target: LockedMembership | null;
}

/**
 * Level 4, for an action that writes ANOTHER member's row (approve, reject, ban,
 * unban, remove, change role): lock the ACTOR's row and the TARGET's together, in
 * ONE statement, in ASCENDING id order, and return what each holds NOW. A row that
 * does not exist comes back null.
 *
 * ONE statement and ORDER BY "id" are the point. If each action locked "its own
 * row first, then the other's" two managers acting on each other (A bans B while
 * B bans A) would each hold the row the other is waiting for — PostgreSQL 40P01
 * and a 500. Ordering by row id makes every such action agree, whichever of the
 * two rows is the actor's. LockRows sits above the Sort node, so the rows are
 * locked in the order they are returned.
 *
 * FOR NO KEY UPDATE is what the write takes on the target anyway (the deletes
 * upgrade it to FOR UPDATE, which nothing else can be holding), and on the actor's
 * row it blocks the same demotions, bans, leaves and removals FOR SHARE does.
 * When actor and target are the same account, one row comes back for both.
 */
export async function lockActorAndTarget(
  tx: Tx,
  groupId: string,
  actorUserId: string,
  targetUserId: string
): Promise<LockedActorAndTarget> {
  const rows = await tx.$queryRaw<LockedMembership[]>`
    SELECT "id", "userId", "role"::text AS "role", "status"::text AS "status"
    FROM "group_members"
    WHERE "groupId" = ${groupId} AND "userId" IN (${actorUserId}, ${targetUserId})
    ORDER BY "id"
    FOR NO KEY UPDATE
  `;
  return {
    actor: rows.find((r) => r.userId === actorUserId) ?? null,
    target: rows.find((r) => r.userId === targetUserId) ?? null,
  };
}

/** The lock key for a (group, invitee email) subject. Emails are compared case-insensitively. */
export function inviteSubjectLockKey(groupId: string, email: string): string {
  return `group-invite:${groupId}:${email.toLowerCase()}`;
}

/**
 * Level 3: take the transaction-scoped advisory lock for a (group, email)
 * subject. Released automatically at commit or rollback.
 *
 * `$executeRaw`, not `$queryRaw`: pg_advisory_xact_lock returns void, which
 * Prisma cannot deserialize as a result column.
 */
export async function lockInviteSubject(tx: Tx, groupId: string, email: string): Promise<void> {
  const key = inviteSubjectLockKey(groupId, email);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

export interface LockedInvite {
  id: string;
  status: string;
  expiresAt: Date;
}

/**
 * Level 5: lock the invite row and return what it holds NOW. Waits behind any
 * other transaction that has locked or is writing the row, so whatever it
 * returns is authoritative for as long as the caller's transaction lasts.
 *
 * FOR NO KEY UPDATE is exactly the lock an UPDATE of this row would take, so
 * the claim that follows conflicts with nothing new — and, being wait-free
 * (the row is already ours), can safely be judged against a clock read AFTER
 * this call returns. Returns null if the row is gone.
 */
export async function lockInviteRow(tx: Tx, inviteId: string): Promise<LockedInvite | null> {
  const rows = await tx.$queryRaw<LockedInvite[]>`
    SELECT "id", "status"::text AS "status", "expiresAt"
    FROM "group_invites"
    WHERE "id" = ${inviteId}
    FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Level 5, for a REVOCATION: lock the invite row of THIS group and return what it
 * holds NOW. Like lockInviteRow, but the group is part of the lookup, so an invite
 * of another group is indistinguishable from a missing one (null).
 */
export async function lockInviteForRevocation(tx: Tx, groupId: string, inviteId: string): Promise<LockedInvite | null> {
  const rows = await tx.$queryRaw<LockedInvite[]>`
    SELECT "id", "status"::text AS "status", "expiresAt"
    FROM "group_invites"
    WHERE "id" = ${inviteId} AND "groupId" = ${groupId}
    FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}

export interface LockedGroupMessage {
  id: string;
  groupId: string;
  userId: string;
  isDeleted: boolean;
}

/**
 * Level 5, for a chat MESSAGE DELETION (routes/chat.ts): lock the message row of
 * THIS group and return what it holds NOW. Like lockInviteForRevocation, the group
 * is part of the lookup, so a message that belongs to ANOTHER group is
 * indistinguishable from a missing one (null) — cross-group access stays opaque.
 *
 * FOR NO KEY UPDATE is the mode the soft-delete UPDATE that follows takes anyway.
 * It is taken AFTER the actor's own membership row (level 4): the message this
 * action writes is not a member row, so it sits at the same tier group_invites
 * occupies for invite actions — "the row the action's own effect writes, after the
 * actor is authorized". Nothing else in the codebase writes a messages row under a
 * lock, so there is no ordering hazard to resolve on this side: the only two
 * transactions that can hold this row at once are two deletions of the SAME
 * message (the second sees it already isDeleted and no-ops) and a group DELETE,
 * whose cascade removes it — see "Level 2" below for why that can't cycle with
 * this action.
 */
export async function lockGroupMessageForDeletion(tx: Tx, groupId: string, messageId: string): Promise<LockedGroupMessage | null> {
  const rows = await tx.$queryRaw<LockedGroupMessage[]>`
    SELECT "id", "groupId", "userId", "isDeleted"
    FROM "messages"
    WHERE "id" = ${messageId} AND "groupId" = ${groupId}
    FOR NO KEY UPDATE
  `;
  return rows[0] ?? null;
}
