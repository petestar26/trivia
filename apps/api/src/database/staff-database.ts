import { PrismaClient } from '@socialplay/database';
import {
  DatabaseIdentityError,
  GuardedDatabase,
  ROLE_NAME,
  UnavailableDatabase,
  type GuardableClient,
  type TransactionalDatabase,
  type TransactionOptions,
} from './identity.js';
import type { Prisma } from '@socialplay/database';

/**
 * Staff database selection (dormant).
 *
 * Restricted staff operations (agent provisioning, credential reissue, member
 * status changes) take an explicit StaffDatabase and never import a client.
 * Only the composition root resolves one:
 *
 *   STAFF_DATABASE_ISOLATION unset/empty  -> 'dormant': the explicitly supplied
 *       legacy credential client (today's behaviour, same runtime identity).
 *   STAFF_DATABASE_ISOLATION=enforce      -> 'isolated': STAFF_DATABASE_URL as
 *       STAFF_DATABASE_ROLE, verified in every transaction.
 *   anything else, or enforce without a valid target -> 'unavailable': every
 *       staff transaction is refused (HTTP 503). Never the default client.
 */

export const STAFF_PURPOSE = 'Staff';

export type StaffDatabaseMode = 'dormant' | 'isolated' | 'unavailable';

export interface StaffDatabase extends TransactionalDatabase {
  readonly mode: StaffDatabaseMode;
  verify(): Promise<{ role: string }>;
  $disconnect(): Promise<void>;
}

export interface StaffDatabaseTarget {
  url: string;
  role: string;
  distinctFrom: string[];
}

// Other configured identities a staff identity must never reuse.
const OTHER_IDENTITIES = [
  'DATABASE_URL',
  'NUMBER_WORKER_DATABASE_URL',
  'SOCIAL_WORKER_DATABASE_URL',
  'LEDGER_OWNER_DATABASE_URL',
  'HOUSE_FINANCIAL_OWNER_DATABASE_URL',
] as const;

const refuse = (reason: ConstructorParameters<typeof DatabaseIdentityError>[1]) =>
  new DatabaseIdentityError(STAFF_PURPOSE, reason);

function parsePostgresUrl(source: string | undefined): URL | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    return ['postgres:', 'postgresql:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const port = (url: URL) => url.port || '5432';

/** Validate the enforce-mode target. Throws DatabaseIdentityError; never returns a partial target. */
export function staffDatabaseTarget(env: NodeJS.ProcessEnv): StaffDatabaseTarget {
  if (!env.STAFF_DATABASE_URL || !env.STAFF_DATABASE_ROLE) throw refuse('NOT_CONFIGURED');
  const staff = parsePostgresUrl(env.STAFF_DATABASE_URL);
  const main = parsePostgresUrl(env.DATABASE_URL);
  if (!staff || !main) throw refuse('INVALID_URL');
  const role = env.STAFF_DATABASE_ROLE;
  if (!ROLE_NAME.test(role)) throw refuse('INVALID_ROLE');
  if (decodeURIComponent(staff.username) !== role) throw refuse('ROLE_MISMATCH');
  // Same server and database as the API; only the identity differs.
  if (
    staff.hostname !== main.hostname ||
    port(staff) !== port(main) ||
    staff.pathname !== main.pathname
  )
    throw refuse('TARGET_MISMATCH');
  const distinctFrom = OTHER_IDENTITIES.flatMap((name) => {
    const url = parsePostgresUrl(env[name]);
    return url?.username ? [decodeURIComponent(url.username)] : [];
  });
  if (distinctFrom.includes(role)) throw refuse('SHARED_IDENTITY');
  return { url: env.STAFF_DATABASE_URL, role, distinctFrom };
}

/** Wrap the explicitly supplied legacy client so dormant mode keeps today's behaviour. */
class DormantStaffDatabase implements StaffDatabase {
  readonly mode = 'dormant' as const;
  constructor(private readonly legacy: TransactionalDatabase) {}
  $transaction<R>(
    fn: (tx: Prisma.TransactionClient) => Promise<R>,
    options?: TransactionOptions
  ): Promise<R> {
    return this.legacy.$transaction(fn, options);
  }
  async verify(): Promise<{ role: string }> {
    return this.legacy.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ role: string }[]>`SELECT current_user::text AS role`;
      return { role: row.role };
    });
  }
  // The legacy client is owned by its creator; dormant mode never closes it.
  async $disconnect(): Promise<void> {}
}

export interface ResolveStaffDatabaseOptions {
  /** The client dormant mode uses. Required: there is no implicit default. */
  legacy: TransactionalDatabase;
  /** Builds the isolated client. Defaults to a logger-free PrismaClient for the URL. */
  createClient?: (url: string) => GuardableClient;
}

export function resolveStaffDatabase(
  env: NodeJS.ProcessEnv,
  options: ResolveStaffDatabaseOptions
): StaffDatabase {
  if (!options?.legacy) throw new Error('STAFF_DATABASE_LEGACY_CLIENT_REQUIRED');
  const mode = env.STAFF_DATABASE_ISOLATION ?? '';
  if (mode === '') return new DormantStaffDatabase(options.legacy);
  if (mode !== 'enforce') return new UnavailableDatabase(STAFF_PURPOSE, 'INVALID_MODE');
  let target: StaffDatabaseTarget;
  try {
    target = staffDatabaseTarget(env);
  } catch (error) {
    if (error instanceof DatabaseIdentityError)
      return new UnavailableDatabase(STAFF_PURPOSE, error.reason);
    throw error;
  }
  const createClient =
    options.createClient ??
    ((url: string) => new PrismaClient({ datasourceUrl: url, log: [] }) as GuardableClient);
  return GuardedDatabase.bind(STAFF_PURPOSE, createClient(target.url), {
    role: target.role,
    distinctFrom: target.distinctFrom,
  });
}
