import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  DatabaseIdentityError,
  GuardedDatabase,
  UnavailableDatabase,
  identityRefusal,
  type DatabaseIdentity,
  type GuardableClient,
} from './identity.js';
import { resolveStaffDatabase, staffDatabaseTarget } from './staff-database.js';
import { errorHandler } from '../middleware/error-handler.js';
import { ApiError } from '../middleware/api-error.js';

// Synthetic identities and URLs only; nothing here connects to a database.
const accepted: DatabaseIdentity = {
  currentUser: 'synthetic_staff',
  sessionUser: 'synthetic_staff',
  elevated: false,
  ownsDatabase: false,
  ownsUsers: false,
};
const expectation = { role: 'synthetic_staff', distinctFrom: ['synthetic_runtime'] };

/** A client whose transactions report `identity()` and record what ran. */
function fakeClient(identity: () => DatabaseIdentity | Error) {
  const ran: string[] = [];
  const client: GuardableClient = {
    async $transaction(fn) {
      const tx = {
        $queryRaw: async () => {
          const value = identity();
          if (value instanceof Error) throw value;
          return [value];
        },
      };
      return fn(tx as never);
    },
    $disconnect: vi.fn(async () => {}),
  };
  return { client, ran };
}

describe('identityRefusal', () => {
  it('accepts exactly the expected, unelevated, non-owner identity', () => {
    expect(identityRefusal(accepted, expectation)).toBeNull();
  });
  it.each([
    ['SHARED_IDENTITY', { currentUser: 'synthetic_runtime', sessionUser: 'synthetic_runtime' }],
    ['SHARED_IDENTITY', { sessionUser: 'synthetic_runtime' }],
    ['ROLE_SWITCHED', { currentUser: 'synthetic_other' }],
    ['ROLE_MISMATCH', { currentUser: 'synthetic_other', sessionUser: 'synthetic_other' }],
    ['ELEVATED', { elevated: true }],
    ['OWNER', { ownsDatabase: true }],
    ['OWNER', { ownsUsers: true }],
  ] as const)('refuses %s', (reason, change) => {
    expect(identityRefusal({ ...accepted, ...change }, expectation)).toBe(reason);
  });
});

describe('GuardedDatabase', () => {
  it('rejects an unusable expectation at construction', () => {
    const { client } = fakeClient(() => accepted);
    expect(() => GuardedDatabase.bind('Staff', client, { role: 'Bad-Role', distinctFrom: [] })).toThrow(
      expect.objectContaining({ reason: 'INVALID_ROLE' })
    );
    expect(() =>
      GuardedDatabase.bind('Staff', client, { role: 'synthetic_runtime', distinctFrom: ['synthetic_runtime'] })
    ).toThrow(expect.objectContaining({ reason: 'SHARED_IDENTITY' }));
  });

  it('runs work only after the identity is verified in the same transaction', async () => {
    const { client } = fakeClient(() => accepted);
    const db = GuardedDatabase.bind('Staff', client, expectation);
    await expect(db.$transaction(async () => 'done')).resolves.toBe('done');
    await expect(db.verify()).resolves.toEqual({ role: 'synthetic_staff' });
  });

  it('refuses a wrong identity before any work runs', async () => {
    const { client } = fakeClient(() => ({ ...accepted, elevated: true }));
    const work = vi.fn();
    await expect(
      GuardedDatabase.bind('Staff', client, expectation).$transaction(work)
    ).rejects.toMatchObject({ name: 'DatabaseIdentityError', reason: 'ELEVATED' });
    expect(work).not.toHaveBeenCalled();
  });

  it('re-verifies every transaction: later elevation is refused and a repair is accepted', async () => {
    let current: DatabaseIdentity = accepted;
    const { client } = fakeClient(() => current);
    const db = GuardedDatabase.bind('Staff', client, expectation);
    await expect(db.verify()).resolves.toBeTruthy();
    current = { ...accepted, ownsUsers: true };
    await expect(db.verify()).rejects.toMatchObject({ reason: 'OWNER' });
    current = accepted;
    await expect(db.verify()).resolves.toBeTruthy();
  });

  it('reports failures before verification as UNVERIFIED without exposing the cause in the message', async () => {
    const cause = new Error('connect failed for synthetic_staff@db.invalid');
    const { client } = fakeClient(() => cause);
    const error = await GuardedDatabase.bind('Staff', client, expectation)
      .$transaction(async () => 'never')
      .catch((e) => e);
    expect(error).toBeInstanceOf(DatabaseIdentityError);
    expect(error).toMatchObject({ reason: 'UNVERIFIED', cause });
    expect(error.message).not.toContain('synthetic_staff');
    expect(error.message).not.toContain('db.invalid');
  });

  it('passes errors from the work itself through unchanged', async () => {
    const { client } = fakeClient(() => accepted);
    const db = GuardedDatabase.bind('Staff', client, expectation);
    const conflict = ApiError.conflict('duplicate');
    await expect(db.$transaction(async () => Promise.reject(conflict))).rejects.toBe(conflict);
    const unique = Object.assign(new Error('unique'), { code: 'P2002' });
    await expect(db.$transaction(async () => Promise.reject(unique))).rejects.toBe(unique);
  });

  it('an unavailable database refuses every transaction and runs nothing', async () => {
    const work = vi.fn();
    const db = new UnavailableDatabase('Staff', 'NOT_CONFIGURED');
    await expect(db.$transaction()).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    await expect(db.verify()).rejects.toBeInstanceOf(DatabaseIdentityError);
    expect(work).not.toHaveBeenCalled();
  });
});

const main = 'postgresql://synthetic_runtime:x@db.invalid:5432/synthetic';
const staff = 'postgresql://synthetic_staff:y@db.invalid:5432/synthetic';
const enforce = {
  DATABASE_URL: main,
  STAFF_DATABASE_ISOLATION: 'enforce',
  STAFF_DATABASE_URL: staff,
  STAFF_DATABASE_ROLE: 'synthetic_staff',
};

describe('staffDatabaseTarget', () => {
  it('accepts a distinct role on the same server and database', () => {
    expect(staffDatabaseTarget(enforce)).toEqual({
      url: staff,
      role: 'synthetic_staff',
      distinctFrom: ['synthetic_runtime'],
    });
  });
  it.each([
    ['NOT_CONFIGURED', { STAFF_DATABASE_URL: undefined }],
    ['NOT_CONFIGURED', { STAFF_DATABASE_ROLE: '' }],
    ['INVALID_URL', { STAFF_DATABASE_URL: 'not a url' }],
    ['INVALID_URL', { STAFF_DATABASE_URL: 'mysql://synthetic_staff@db.invalid/synthetic' }],
    ['INVALID_URL', { DATABASE_URL: undefined }],
    ['INVALID_ROLE', { STAFF_DATABASE_ROLE: 'Staff-Role' }],
    ['ROLE_MISMATCH', { STAFF_DATABASE_ROLE: 'synthetic_other' }],
    ['TARGET_MISMATCH', { STAFF_DATABASE_URL: 'postgresql://synthetic_staff:y@other.invalid:5432/synthetic' }],
    ['TARGET_MISMATCH', { STAFF_DATABASE_URL: 'postgresql://synthetic_staff:y@db.invalid:6543/synthetic' }],
    ['TARGET_MISMATCH', { STAFF_DATABASE_URL: 'postgresql://synthetic_staff:y@db.invalid:5432/elsewhere' }],
    ['SHARED_IDENTITY', { STAFF_DATABASE_URL: main, STAFF_DATABASE_ROLE: 'synthetic_runtime' }],
    ['SHARED_IDENTITY', { NUMBER_WORKER_DATABASE_URL: 'postgresql://synthetic_staff:z@db.invalid/synthetic' }],
    ['SHARED_IDENTITY', { SOCIAL_WORKER_DATABASE_URL: 'postgresql://synthetic_staff:z@db.invalid/synthetic' }],
    ['SHARED_IDENTITY', { LEDGER_OWNER_DATABASE_URL: 'postgresql://synthetic_staff:z@db.invalid/synthetic' }],
    // Malformed percent-escapes in a login role (decodeURIComponent would throw URIError).
    ['INVALID_URL', { STAFF_DATABASE_URL: 'postgresql://synthetic%E0%A4%A:y@db.invalid:5432/synthetic' }],
    ['INVALID_URL', { STAFF_DATABASE_URL: 'postgresql://synthetic_staff%ZZ:y@db.invalid:5432/synthetic' }],
    ['INVALID_URL', { DATABASE_URL: 'postgresql://synthetic%E0%A4%A:x@db.invalid:5432/synthetic' }],
    ['INVALID_URL', { DATABASE_URL: 'postgresql://runtime%:x@db.invalid:5432/synthetic' }],
    ['INVALID_URL', { NUMBER_WORKER_DATABASE_URL: 'postgresql://worker%ZZ:z@db.invalid/synthetic' }],
    ['INVALID_URL', { SOCIAL_WORKER_DATABASE_URL: 'postgresql://worker%E0%A4%A:z@db.invalid/synthetic' }],
  ] as const)('refuses %s', (reason, change) => {
    expect(() => staffDatabaseTarget({ ...enforce, ...change })).toThrow(
      expect.objectContaining({ reason })
    );
  });
  it('still decodes a well-formed percent-encoded login', () => {
    expect(
      staffDatabaseTarget({
        ...enforce,
        STAFF_DATABASE_URL: 'postgresql://synthetic%5Fstaff:y@db.invalid:5432/synthetic',
      }).role
    ).toBe('synthetic_staff');
  });

  it('never puts URLs or role names in its errors', () => {
    let error: Error | undefined;
    try {
      staffDatabaseTarget({ ...enforce, STAFF_DATABASE_ROLE: 'synthetic_other' });
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toMatch(/synthetic|db\.invalid|postgres/);
  });
});

describe('resolveStaffDatabase', () => {
  const legacy = { $transaction: vi.fn(async (fn: (tx: never) => unknown) => fn({} as never)) };

  it('requires an explicit legacy client: there is no implicit default', () => {
    expect(() => resolveStaffDatabase({}, undefined as never)).toThrow(
      'STAFF_DATABASE_LEGACY_CLIENT_REQUIRED'
    );
  });

  it.each([{}, { STAFF_DATABASE_ISOLATION: '' }, { STAFF_DATABASE_URL: staff, STAFF_DATABASE_ROLE: 'synthetic_staff' }])(
    'stays dormant (legacy client, no new connection) for %o',
    async (env) => {
      const createClient = vi.fn();
      const db = resolveStaffDatabase(env, { legacy: legacy as never, createClient });
      expect(db.mode).toBe('dormant');
      expect(createClient).not.toHaveBeenCalled();
      await db.$transaction(async () => 'ok');
      expect(legacy.$transaction).toHaveBeenCalled();
    }
  );

  it('enforce binds a guarded client to the staff URL only', () => {
    const { client } = fakeClient(() => accepted);
    const createClient = vi.fn(() => client);
    const db = resolveStaffDatabase(enforce, { legacy: legacy as never, createClient });
    expect(db.mode).toBe('isolated');
    expect(createClient).toHaveBeenCalledWith(staff);
  });

  it.each([
    ['INVALID_MODE', { STAFF_DATABASE_ISOLATION: 'Enforce' }],
    ['INVALID_MODE', { STAFF_DATABASE_ISOLATION: 'true' }],
    ['INVALID_MODE', { STAFF_DATABASE_ISOLATION: 'off' }],
    ['NOT_CONFIGURED', { STAFF_DATABASE_URL: undefined }],
    ['SHARED_IDENTITY', { STAFF_DATABASE_URL: main, STAFF_DATABASE_ROLE: 'synthetic_runtime' }],
    ['INVALID_URL', { STAFF_DATABASE_URL: 'postgresql://synthetic%E0%A4%A:y@db.invalid:5432/synthetic' }],
    ['INVALID_URL', { DATABASE_URL: 'postgresql://runtime%ZZ:x@db.invalid:5432/synthetic' }],
  ] as const)('fails closed (%s) instead of falling back', async (reason, change) => {
    legacy.$transaction.mockClear();
    const createClient = vi.fn();
    const db = resolveStaffDatabase({ ...enforce, ...change }, { legacy: legacy as never, createClient });
    expect(db.mode).toBe('unavailable');
    await expect(db.$transaction(async () => 'never')).rejects.toMatchObject({ reason });
    expect(legacy.$transaction).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe('resolveStaffDatabase never throws on configuration', () => {
  it('a client constructor that throws closes staff operations as UNVERIFIED', async () => {
    const legacy = { $transaction: vi.fn() };
    const db = resolveStaffDatabase(enforce, {
      legacy: legacy as never,
      createClient: () => {
        throw new Error('synthetic constructor failure for synthetic_staff');
      },
    });
    expect(db.mode).toBe('unavailable');
    await expect(db.verify()).rejects.toMatchObject({ reason: 'UNVERIFIED' });
    expect(legacy.$transaction).not.toHaveBeenCalled();
  });
});

describe('error handler', () => {
  it('maps a refused database identity to 503 without detail', async () => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    app.get('/staff', async () => {
      throw new DatabaseIdentityError('Staff', 'ELEVATED');
    });
    const response = await app.inject({ url: '/staff' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toEqual({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Staff operations are temporarily unavailable',
    });
    expect(response.body).not.toContain('ELEVATED');
    await app.close();
  });
});
