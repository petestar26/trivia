import type { Prisma } from '@socialplay/database';

/**
 * Locking protocol for group admission (invite acceptance), invite creation,
 * and group-level bans and unbans.
 *
 * These writers race on overlapping rows and, before this protocol, could
 * both admit an account that had just been restricted and deadlock each other
 * (measured: an accept holding the invite row while waiting for the member
 * row, against a ban holding the member row while waiting for the invite row,
 * produced PostgreSQL 40P01 and a 500 for the ban while the target was
 * admitted anyway).
 *
 * ── Lock order ────────────────────────────────────────────────────────────
 * Every transaction that takes more than one of these takes them in THIS
 * order, skipping the levels it does not need. Consistent ordering is what
 * rules out a wait-for cycle.
 *
 *   1. users row               FOR SHARE   (the account gate)
 *   2. (group, email) advisory lock         (the invite subject)
 *   3. group_members row(s)
 *   4. group_invites row(s)
 *   5. notifications (inserts only; nothing waits on them)
 *
 * ── Who takes what ────────────────────────────────────────────────────────
 *   accept-invite   1 → 2 → 3/4        holds both through commit
 *   ban             2 → 3 → 4          (level 1 is not needed: it only READS
 *                                       the target's email, without a lock)
 *   unban           2 → 3 → 5          (ban's order without level 4: it never
 *                                       touches invites, so the ones a ban
 *                                       revoked stay revoked)
 *   create invite   2 → 3(read) → 4
 *   account status  1 only             any writer that changes users.status
 *   writers                            (UPDATE takes the row lock implicitly)
 *                                      MUST update the users row FIRST and
 *                                      touch anything else afterwards. A
 *                                      writer that took a group_members lock
 *                                      before the users row would invert the
 *                                      order and reintroduce the cycle.
 *
 * ── Level 4 and the clock ─────────────────────────────────────────────────
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
 * ── Why level 2 is an advisory lock and not a row lock ────────────────────
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

/** The lock key for a (group, invitee email) subject. Emails are compared case-insensitively. */
export function inviteSubjectLockKey(groupId: string, email: string): string {
  return `group-invite:${groupId}:${email.toLowerCase()}`;
}

/**
 * Level 2: take the transaction-scoped advisory lock for a (group, email)
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
 * Level 4: lock the invite row and return what it holds NOW. Waits behind any
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
