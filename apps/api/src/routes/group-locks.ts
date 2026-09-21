import type { Prisma } from '@socialplay/database';

/**
 * Locking protocol for group admission (invite acceptance and join approval),
 * invite creation, group-level bans and unbans, and the group-level writers
 * that share rows with them (ownership transfer, group edit and deletion, an
 * external status change).
 *
 * These writers race on overlapping rows and, without a protocol, admit an
 * account that was just restricted, admit into a group that was just archived,
 * and deadlock each other (measured: an accept holding the invite row while
 * waiting for the member row, against a ban holding the member row while
 * waiting for the invite row, produced PostgreSQL 40P01 and a 500 for the ban
 * while the target was admitted anyway; and an acceptance that read the group
 * ACTIVE, then waited on the invite row, committed a membership after an
 * external writer had already committed ARCHIVED).
 *
 * ── Lock order ────────────────────────────────────────────────────────────
 * Every transaction that takes more than one of these takes them in THIS
 * order, skipping the levels it does not need. Consistent ordering is what
 * rules out a wait-for cycle.
 *
 *   1. users row               FOR SHARE   (the account gate)
 *   2. groups row              FOR SHARE for admission; the row lock an UPDATE
 *                              takes for transfer, edit and status changes;
 *                              FOR UPDATE for deletion   (the group gate)
 *   3. (group, email) advisory lock                     (the invite subject)
 *   4. group_members row(s)
 *   5. group_invites row(s)
 *   6. notifications (inserts only; nothing waits on them)
 *
 * ── Who takes what — the writer audit ─────────────────────────────────────
 * Every transaction in the API that touches a group, group_members or
 * group_invites row, and where it sits in the order:
 *
 *   accept-invite    1 → 2 (SHARE) → 3 → 5 → 4 → 6
 *                    holds all of them through commit. (The invite row is
 *                    claimed before the membership row is written: both are
 *                    behind the subject lock, so no other admission, ban or
 *                    invite creation for this subject can interleave.)
 *   approve request  1 (the APPLICANT) → 2 (SHARE) → 4 → 6
 *   create invite    2 (SHARE) → 3 → 4 (read only) → 5 → 6
 *   ban              3 → 4 → 5 → 6     (never level 1 or 2: it only READS the
 *                                       target's email; its writes are
 *                                       UPDATEs that change no foreign key, so
 *                                       they take no lock on the group row)
 *   unban            3 → 4 → 6         (ban's order without level 5: it never
 *                                       touches invites, so the ones a ban
 *                                       revoked stay revoked)
 *   transfer         2 (UPDATE, its FIRST statement: the ownerId guard) → 4 → 6
 *   delete group     2 (FOR UPDATE, explicit and FIRST) → 4 → cascade: the
 *                    group's invites (5), messages and competitions. It used to
 *                    delete the members BEFORE taking the group row: the inverse
 *                    of transfer (group row, then members), so the two could
 *                    deadlock, and of admission, where a delete holding member
 *                    rows would wait for a group row that an admission held
 *                    while that admission waited for the member rows.
 *   edit group       2 only            (one statement)
 *   external group   2 only            (an UPDATE of groups.status by an
 *   status change                       operator or a moderation tool)
 *   account status   1 only            any writer that changes users.status
 *   writers                            (UPDATE takes the row lock implicitly)
 *                                      MUST update the users row FIRST and
 *                                      touch anything else afterwards — the
 *                                      groups row included. A writer that took
 *                                      a group_members or groups lock before
 *                                      the users row would invert the order
 *                                      and reintroduce the cycle.
 *   reject request   4 → 6
 *   request to join  (INSERT or UPDATE of one member row) → 6
 *   leave, remove, role change, revoke invite, public join
 *                    one statement on one row; they hold nothing while waiting
 *   chat messages, competitions
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
 *     no admission can be inside its transaction (admission holds the group row
 *     FOR SHARE from before any member, invite or advisory lock until commit).
 *     Admission is never caught holding one of those while waiting for the
 *     group row; all it can hold at that point is a users row, FOR SHARE, which
 *     no group writer takes.
 *   - Admission (accept, approve) and creating an invite hold level 2 in a
 *     compatible mode, so they never wait on each other there. Accept and
 *     create for one subject then serialize on level 3, and take the rest in
 *     the same direction.
 *   - Accept takes the INVITE row (5) before the MEMBER row (4) — the clock
 *     rule below needs the invite locked before it is read — while ban and
 *     delete take member rows before invite rows (4 → 5). That inversion is safe
 *     only because every transaction holding both is excluded from running
 *     alongside an accept by a lock taken EARLIER: the subject lock (3) for ban
 *     and create, the group row (2) for delete and transfer.
 *   - Approve holds a member row and nothing after it that any other writer
 *     holds (a notification insert takes only FOR KEY SHARE on a users row,
 *     which conflicts with nothing but a DELETE of that user).
 *   - Ban and unban never wait for level 2 or level 1, and hold 3-5 in the
 *     order admission does; single-statement writers hold one lock at a time.
 *
 * ── Level 2 and a group that stops being ACTIVE ───────────────────────────
 * Admission must not commit a membership into a group that is no longer
 * ACTIVE. A plain read of groups.status taken before the transaction — or
 * anywhere in it without a lock — can be stale by the time the membership is
 * written, because every later lock (subject, member, invite) can make the
 * transaction wait for as long as another one holds it. So the group row is
 * locked (lockGroupForAdmission) and its status read AFTER the lock is held,
 * and the lock is kept until commit: an external status change then either
 * commits BEFORE the lock is granted (admission reads the new status and is
 * rejected, nothing written) or waits for admission to commit (admission was
 * legitimately admitted into an ACTIVE group at its serialization point).
 * FOR SHARE is the weakest mode that blocks a status UPDATE; it does not block
 * other admissions, which take it too, so admissions to one group still run in
 * parallel.
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
}

/**
 * Level 2, for admission and invite creation: lock the group row FOR SHARE and
 * return what it holds NOW — status and name, read after the lock is granted.
 * Returns null if the group is gone.
 *
 * The lock is held to commit, so the status this returns stays true for the
 * whole transaction: an external UPDATE of the row waits behind it. Waiting for
 * the lock (behind such an UPDATE, or a FOR UPDATE) and then re-reading is what
 * makes the answer authoritative — under READ COMMITTED the statement returns
 * the latest COMMITTED version of the row once the lock is granted.
 *
 * FOR SHARE, not FOR KEY SHARE: KEY SHARE does not conflict with an UPDATE that
 * leaves the key alone, which is exactly what a status change is. It is not
 * FOR UPDATE either, which would serialize every admission to a group.
 */
export async function lockGroupForAdmission(tx: Tx, groupId: string): Promise<LockedGroup | null> {
  const rows = await tx.$queryRaw<LockedGroup[]>`
    SELECT "id", "name", "status"::text AS "status"
    FROM "groups"
    WHERE "id" = ${groupId}
    FOR SHARE
  `;
  return rows[0] ?? null;
}

/**
 * Level 2, for deletion: lock the group row FOR UPDATE — the mode a DELETE
 * takes — as a deleter's FIRST statement, before it touches a member row.
 * Returns false if the group is already gone.
 */
export async function lockGroupForDeletion(tx: Tx, groupId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "groups"
    WHERE "id" = ${groupId}
    FOR UPDATE
  `;
  return rows.length > 0;
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
