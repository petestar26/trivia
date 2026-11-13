import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';

/**
 * Regression guard for the handoff gap: authentication routes, sessions,
 * referral generation and restricted staff operations must use the client
 * they are given. The default runtime client and the module-level credential
 * client are replaced by tripwires that throw on any use; every flow below is
 * driven only through explicitly injected synthetic clients.
 */
const reached = vi.hoisted(() => [] as string[]);
const tripwire = vi.hoisted(
  () => (name: string) =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop === 'symbol' || prop === 'then') return undefined;
          reached.push(`${name}.${prop}`);
          throw new Error(`DEFAULT_CLIENT_REACHED ${name}.${prop}`);
        },
      }
    )
);
vi.mock('@socialplay/database', () => ({
  prisma: tripwire('prisma'),
  PrismaClient: class {
    constructor() {
      reached.push('new PrismaClient');
      throw new Error('DEFAULT_CLIENT_REACHED new PrismaClient');
    }
  },
}));
vi.mock('../agents/credential-database.js', () => ({ credentialDb: tripwire('credentialDb') }));
vi.mock('@socialplay/config', () => ({
  config: {
    API_PREFIX: '/api/v1',
    JWT_ACCESS_SECRET: 'synthetic-access-secret-at-least-32-chars',
    JWT_REFRESH_SECRET: 'synthetic-refresh-secret-at-least-32-chars',
    JWT_ACCESS_EXPIRY: '15m',
    JWT_REFRESH_EXPIRY: '30d',
    JWT_ISSUER: 'synthetic',
    JWT_AUDIENCE: 'synthetic',
    COOKIE_SECURE: true,
    COOKIE_SAME_SITE: 'lax',
    FRONTEND_URL: 'https://app.example.test',
    CORS_ORIGIN: 'https://app.example.test',
    RATE_LIMIT_AUTH_MAX_REQUESTS: 1000,
    RATE_LIMIT_AUTH_WINDOW_MS: 900000,
  },
}));
vi.mock('../rewards/activity-service.js', () => ({ safeRecordActivity: vi.fn() }));

import { authRoutes } from '../routes/auth.js';
import { ApiError } from '../middleware/api-error.js';
import { hashPassword } from '../utils/auth.js';
import { config } from '@socialplay/config';
import { generateUniqueReferralCode, resolveReferrer } from '../referrals/referral-service.js';
import {
  activateAdminAgent,
  approveExistingMemberAgent,
  createAdminAgent,
  listPendingAgentAccounts,
  reissueAgentPassword,
} from '../agents/admin-account-service.js';
import { setMemberAccountStatus } from '../workspaces/member-status.js';
import { DatabaseIdentityError, UnavailableDatabase } from './identity.js';

const password = 'Synthetic-Member-1!';
const ids = { member: '11111111-1111-4111-8111-111111111111', referrer: '22222222-2222-4222-8222-222222222222' };

function memberClient(passwordHash: string) {
  const user = {
    id: ids.member,
    email: 'member@example.test',
    username: 'synthetic_member',
    displayName: 'Synthetic',
    passwordHash,
    isVerified: false,
    role: 'USER',
    status: 'ACTIVE',
    tokenVersion: 0,
    createdAt: new Date(0),
  };
  const sessions = new Map<string, { id: string; userId: string; expiresAt: Date }>();
  // Transaction client is a distinct object: work done inside a transaction
  // must be visible here and not on the outer client.
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where, select }: any) =>
        where.referralCode && select?.status ? { id: ids.referrer, status: 'ACTIVE' } : null
      ),
      create: vi.fn(async ({ data }: any) => ({ ...user, ...data, id: ids.member })),
      update: vi.fn(async () => user),
    },
    userAuthIdentity: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    referral: { create: vi.fn(async () => ({})) },
    session: {
      create: vi.fn(async ({ data }: any) => {
        sessions.set(data.refreshToken, { id: data.refreshToken, userId: data.userId, expiresAt: data.expiresAt });
        return data;
      }),
      delete: vi.fn(async ({ where }: any) => sessions.delete(where.id)),
    },
  };
  const db = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    user: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async ({ where }: any) =>
        where.email === user.email || where.id === user.id ? user : null
      ),
      update: vi.fn(async () => user),
    },
    userAuthIdentity: { findUnique: vi.fn(async () => null) },
    session: {
      create: tx.session.create,
      findUnique: vi.fn(async ({ where }: any) => {
        const s = sessions.get(where.refreshToken);
        return s ? { ...s, user } : null;
      }),
      deleteMany: vi.fn(async () => ({ count: sessions.size })),
    },
  };
  return { db, tx, user };
}

let server: FastifyInstance;
let member: ReturnType<typeof memberClient>;
const credential = { $transaction: vi.fn(), user: { findUnique: vi.fn() } };

beforeEach(async () => {
  reached.length = 0;
  member = memberClient(await hashPassword(password));
  server = Fastify();
  await server.register(cookie);
  await server.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  await server.register(rateLimit, { max: 1000 });
  server.setErrorHandler((error, _request, reply) => {
    reply.code(error instanceof ApiError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message });
  });
  await server.register(authRoutes, {
    prefix: '/auth',
    db: member.db as never,
    credentialDb: credential as never,
  });
});
afterEach(async () => {
  await server.close();
  expect(reached).toEqual([]);
});

describe('authentication, sessions and referrals use only the injected member client', () => {
  it('registers with a referral: own-code pre-check and attribution run on the registration transaction', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'synthetic_member', email: 'member@example.test', password, referralCode: 'abcd2345' },
    });
    expect(response.statusCode).toBe(201);
    const codeChecks = member.tx.user.findUnique.mock.calls.filter(([args]: any) => args.select?.id && !args.select?.status);
    expect(codeChecks).toHaveLength(1);
    expect(member.db.user.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { referralCode: expect.any(String) } })
    );
    expect(member.tx.referral.create).toHaveBeenCalledWith({
      data: { referredUserId: ids.member, referrerUserId: ids.referrer, referralCode: 'ABCD2345' },
      select: { id: true },
    });
    expect(member.tx.session.create).toHaveBeenCalledTimes(1);
  });

  it('signs in, rotates the session, reads the account and signs out', async () => {
    const login = await server.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'member@example.test', password },
    });
    expect(login.statusCode).toBe(200);
    const { accessToken, refreshToken } = login.json().data;
    expect(member.db.session.create).toHaveBeenCalledTimes(1);

    const refresh = await server.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(refresh.statusCode).toBe(200);
    expect(member.tx.session.delete).toHaveBeenCalledTimes(1);

    const authorization = `Bearer ${accessToken}`;
    expect((await server.inject({ url: '/auth/me', headers: { authorization } })).statusCode).toBe(200);
    const logout = await server.inject({ method: 'POST', url: '/auth/logout', headers: { authorization } });
    expect(logout.statusCode).toBe(200);
    expect(member.db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: ids.member } });
  });

  it('routes password change to the injected credential client', async () => {
    const login = await server.inject({ method: 'POST', url: '/auth/login', payload: { email: 'member@example.test', password } });
    credential.user.findUnique.mockResolvedValue(null);
    const response = await server.inject({
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${login.json().data.accessToken}` },
      payload: { currentPassword: password, newPassword: 'Synthetic-Member-2!' },
    });
    expect(response.statusCode).toBe(403);
    expect(credential.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('refuses to register auth routes without explicit clients', async () => {
    for (const options of [{}, { db: member.db }, { credentialDb: credential }]) {
      const bare = Fastify();
      await expect(bare.register(authRoutes as never, { prefix: '/auth', ...options }).ready()).rejects.toThrow(
        'AUTH_DATABASE_REQUIRED'
      );
      await bare.close();
    }
  });

  it('referral helpers require a client and use only that client', async () => {
    await expect(generateUniqueReferralCode(undefined as never)).rejects.toThrow('REFERRAL_DATABASE_REQUIRED');
    const reader = { user: { findUnique: vi.fn(async () => ({ id: ids.referrer, status: 'ACTIVE' })) } };
    await expect(resolveReferrer(reader as never, 'ABCD2345')).resolves.toEqual({ ok: true, referrerId: ids.referrer });
    expect(reader.user.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('restricted staff operations never fall back', () => {
  const admin = '33333333-3333-4333-8333-333333333333';
  const operations = {
    createAdminAgent: (db: never) =>
      createAdminAgent(db, admin, {
        username: 'synthetic_agent',
        email: 'agent@example.test',
        temporaryPassword: 'Synthetic-Temp-1!',
        displayName: 'Synthetic Agent',
        countryId: '44444444-4444-4444-8444-444444444444',
      }),
    approveExistingMemberAgent: (db: never) =>
      approveExistingMemberAgent(db, admin, {
        email: 'member@example.test',
        displayName: 'Synthetic',
        countryId: '44444444-4444-4444-8444-444444444444',
      }),
    listPendingAgentAccounts: (db: never) => listPendingAgentAccounts(db, admin),
    reissueAgentPassword: (db: never) =>
      reissueAgentPassword(db, admin, ids.member, { temporaryPassword: 'Synthetic-Temp-2!' }),
    setMemberAccountStatus: (db: never) =>
      setMemberAccountStatus(db, admin, ids.member, {
        status: 'SUSPENDED',
        reason: 'synthetic review',
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
  };

  it.each(Object.keys(operations))('%s fails closed when the staff database is unavailable', async (name) => {
    const unavailable = new UnavailableDatabase('Staff', 'NOT_CONFIGURED');
    await expect(operations[name as keyof typeof operations](unavailable as never)).rejects.toBeInstanceOf(
      DatabaseIdentityError
    );
  });

  it.each(Object.keys(operations))('%s refuses to run without an explicit staff database', async (name) => {
    await expect(operations[name as keyof typeof operations](undefined as never)).rejects.toThrow(
      'STAFF_DATABASE_REQUIRED'
    );
  });

  it('runs every staff query, including the administrator check, on the given client', async () => {
    const tx = {
      user: { findUnique: vi.fn(async () => ({ id: admin, role: 'ADMIN', status: 'ACTIVE' })) },
      agentAccountSetup: { findMany: vi.fn(async () => []) },
    };
    const staff = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    await expect(listPendingAgentAccounts(staff as never, admin)).resolves.toEqual([]);
    expect(tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: admin } }));
    expect(tx.agentAccountSetup.findMany).toHaveBeenCalledTimes(1);
  });

  it('agent self-activation uses the credential client it is given, not a staff or default client', async () => {
    const credentialClient = { $transaction: vi.fn(), user: { findUnique: vi.fn(async () => null) } };
    await expect(
      activateAdminAgent(credentialClient as never, {
        email: 'agent@example.test',
        temporaryPassword: 'Synthetic-Temp-1!',
        newPassword: 'Synthetic-Private-1!',
      })
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(credentialClient.user.findUnique).toHaveBeenCalledTimes(1);
    expect(credentialClient.$transaction).not.toHaveBeenCalled();
  });
});

describe('member status under an isolated staff identity uses only the boundary', () => {
  const admin = '33333333-3333-4333-8333-333333333333';
  const input = { status: 'SUSPENDED', reason: 'synthetic review', expectedUpdatedAt: new Date(0).toISOString() };
  function isolated(result: { rows?: unknown[]; error?: unknown }) {
    const tx = {
      user: { findUnique: vi.fn(async () => ({ id: admin, role: 'ADMIN', status: 'ACTIVE' })), update: vi.fn() },
      session: { deleteMany: vi.fn() },
      $queryRaw: vi.fn(async () => {
        if (result.error) throw result.error;
        return result.rows;
      }),
    };
    return { mode: 'isolated', tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  }

  it('returns the boundary result and never updates users directly', async () => {
    const db = isolated({ rows: [{ outcome: 'OK', updated_at: '2026-11-12T00:00:00.001Z' }] });
    await expect(setMemberAccountStatus(db as never, admin, ids.member, input)).resolves.toEqual({
      userId: ids.member,
      status: 'SUSPENDED',
      updatedAt: '2026-11-12T00:00:00.001Z',
    });
    expect(db.tx.user.update).not.toHaveBeenCalled();
    expect(db.tx.session.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID', 400],
    ['SELF', 403],
    ['ACTOR_FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['NOT_MANAGEABLE', 403],
    ['CONFLICT', 409],
    ['SOMETHING_NEW', 500],
  ])('maps boundary outcome %s to HTTP %i', async (outcome, statusCode) => {
    const db = isolated({ rows: [{ outcome, updated_at: null }] });
    await expect(setMemberAccountStatus(db as never, admin, ids.member, input)).rejects.toMatchObject({ statusCode });
  });

  it.each(['42883', '42501'])('fails closed with 503 when the boundary is missing or not granted (%s)', async (code) => {
    const error = Object.assign(new Error('synthetic raw query failure'), { code: 'P2010', meta: { code } });
    const db = isolated({ error });
    await expect(setMemberAccountStatus(db as never, admin, ids.member, input)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('passes other database errors through unchanged', async () => {
    const error = Object.assign(new Error('synthetic'), { code: 'P2010', meta: { code: '40001' } });
    await expect(setMemberAccountStatus(isolated({ error }) as never, admin, ids.member, input)).rejects.toBe(error);
  });
});
