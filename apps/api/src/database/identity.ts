import type { Prisma } from '@socialplay/database';

/**
 * Database identity guard.
 *
 * A guarded client re-reads the connected PostgreSQL identity inside every
 * transaction, before the caller's work runs, and refuses the transaction when
 * that identity is not exactly the one this consumer was configured for. The
 * check is per transaction (never cached) so a role that is later elevated,
 * renamed or swapped behind a pooled connection is refused on its next use, and
 * a repaired role is accepted again without a restart.
 *
 * Errors carry only a reason code: no role names, hosts or URLs, so they are
 * safe to log.
 */

/** Interactive-transaction capability shared by PrismaClient and guarded clients. */
export interface TransactionalDatabase {
  $transaction<R>(
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options?: TransactionOptions
  ): Promise<R>;
}

export interface TransactionOptions {
  maxWait?: number;
  timeout?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/** A client this module can wrap: interactive transactions plus disconnect. */
export interface GuardableClient extends TransactionalDatabase {
  $disconnect(): Promise<void>;
}

export interface IdentityExpectation {
  /** Exact login role the connection must be, for both current_user and session_user. */
  role: string;
  /** Identities this consumer must never share, e.g. the default API runtime role. */
  distinctFrom: readonly string[];
}

export interface DatabaseIdentity {
  currentUser: string;
  sessionUser: string;
  /** Can act as a superuser, row-security-exempt, role-creating, replication or predefined data-wide role. */
  elevated: boolean;
  /** Can act as the owner of the current database. */
  ownsDatabase: boolean;
  /** Can act as the owner of public.users, which bypasses users_privilege_guard. */
  ownsUsers: boolean;
}

export type IdentityRefusal =
  | 'SHARED_IDENTITY'
  | 'ROLE_SWITCHED'
  | 'ROLE_MISMATCH'
  | 'ELEVATED'
  | 'OWNER';

export type ConfigurationRefusal =
  | 'NOT_CONFIGURED'
  | 'INVALID_MODE'
  | 'INVALID_URL'
  | 'INVALID_ROLE'
  | 'TARGET_MISMATCH'
  | 'ROLE_MISMATCH'
  | 'SHARED_IDENTITY';

export type DatabaseIdentityReason = IdentityRefusal | ConfigurationRefusal | 'UNVERIFIED';

export class DatabaseIdentityError extends Error {
  override readonly name = 'DatabaseIdentityError';
  constructor(
    readonly purpose: string,
    readonly reason: DatabaseIdentityReason,
    options?: { cause?: unknown }
  ) {
    super(`${purpose} database identity refused: ${reason}`, options);
  }
}

export const ROLE_NAME = /^[a-z][a-z0-9_]{1,62}$/;

// Predefined roles that grant data-wide or server-side access. Absent names
// (older PostgreSQL versions) simply never match.
const DATA_WIDE_ROLES = [
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_execute_server_program',
  'pg_read_server_files',
  'pg_write_server_files',
];

/** Read the identity of the connection that runs `db`'s next statement. */
export async function readDatabaseIdentity(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>
): Promise<DatabaseIdentity> {
  const rows = await db.$queryRaw<DatabaseIdentity[]>`
    SELECT current_user::text AS "currentUser",
           session_user::text AS "sessionUser",
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles s
             WHERE (s.rolsuper OR s.rolbypassrls OR s.rolcreaterole OR s.rolreplication
                    OR s.rolname = ANY (${DATA_WIDE_ROLES}::text[]))
               AND pg_catalog.pg_has_role(current_user, s.oid, 'MEMBER')
           ) AS "elevated",
           pg_catalog.pg_has_role(current_user, d.datdba, 'MEMBER') AS "ownsDatabase",
           COALESCE((
             SELECT pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER')
             FROM pg_catalog.pg_class c
             WHERE c.oid = pg_catalog.to_regclass('public.users')
           ), true) AS "ownsUsers"
    FROM pg_catalog.pg_database d
    WHERE d.datname = pg_catalog.current_database()`;
  const [identity] = rows;
  if (!identity) throw new Error('Database identity unavailable');
  return identity;
}

/** The first reason `identity` does not satisfy `expectation`, or null when it does. */
export function identityRefusal(
  identity: DatabaseIdentity,
  expectation: IdentityExpectation
): IdentityRefusal | null {
  if (
    expectation.distinctFrom.includes(identity.currentUser) ||
    expectation.distinctFrom.includes(identity.sessionUser)
  )
    return 'SHARED_IDENTITY';
  if (identity.sessionUser !== identity.currentUser) return 'ROLE_SWITCHED';
  if (identity.currentUser !== expectation.role) return 'ROLE_MISMATCH';
  if (identity.elevated) return 'ELEVATED';
  if (identity.ownsDatabase || identity.ownsUsers) return 'OWNER';
  return null;
}

/**
 * A client bound to one expected database identity. Construct it only through
 * `GuardedDatabase.bind`, which rejects an unusable expectation up front.
 */
export class GuardedDatabase implements GuardableClient {
  readonly mode = 'isolated' as const;
  readonly #client: GuardableClient;
  readonly #expectation: IdentityExpectation;

  private constructor(
    readonly purpose: string,
    client: GuardableClient,
    expectation: IdentityExpectation
  ) {
    this.#client = client;
    this.#expectation = expectation;
  }

  static bind(purpose: string, client: GuardableClient, expectation: IdentityExpectation) {
    if (!ROLE_NAME.test(expectation.role)) throw new DatabaseIdentityError(purpose, 'INVALID_ROLE');
    if (expectation.distinctFrom.includes(expectation.role))
      throw new DatabaseIdentityError(purpose, 'SHARED_IDENTITY');
    return new GuardedDatabase(purpose, client, {
      role: expectation.role,
      distinctFrom: Object.freeze([...expectation.distinctFrom]),
    });
  }

  /**
   * Run `fn` in a transaction whose identity has just been verified. Failures
   * before verification completes (connection, permissions, refusal) surface
   * as DatabaseIdentityError and nothing in `fn` runs. Errors from `fn` itself
   * propagate unchanged so callers keep their own conflict/validation mapping.
   */
  async $transaction<R>(
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options?: TransactionOptions
  ): Promise<R> {
    let verified = false;
    try {
      return await this.#client.$transaction(async (tx) => {
        const refusal = identityRefusal(await readDatabaseIdentity(tx), this.#expectation);
        if (refusal) throw new DatabaseIdentityError(this.purpose, refusal);
        verified = true;
        return fn(tx);
      }, options);
    } catch (error) {
      if (verified || error instanceof DatabaseIdentityError) throw error;
      throw new DatabaseIdentityError(this.purpose, 'UNVERIFIED', { cause: error });
    }
  }

  /** Verify the identity without doing any work; returns the accepted role. */
  verify(): Promise<{ role: string }> {
    return this.$transaction(async () => ({ role: this.#expectation.role }));
  }

  $disconnect(): Promise<void> {
    return this.#client.$disconnect();
  }
}

/** A consumer that must stay closed: every transaction is refused with `reason`. */
export class UnavailableDatabase implements GuardableClient {
  readonly mode = 'unavailable' as const;
  constructor(
    readonly purpose: string,
    readonly reason: DatabaseIdentityReason
  ) {}

  async $transaction<R>(): Promise<R> {
    throw new DatabaseIdentityError(this.purpose, this.reason);
  }

  async verify(): Promise<{ role: string }> {
    throw new DatabaseIdentityError(this.purpose, this.reason);
  }

  async $disconnect(): Promise<void> {}
}
