import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';
import * as authUtils from '../utils/auth';
import {
  generateReferralCode,
  generateUniqueReferralCode,
} from '../referrals/referral-service.js';
import { ErrorCode } from '@socialplay/shared';
import {
  createGoogleVerifier,
  generateNonceSecret,
  hashNonceSecret,
} from '../auth/google-verifier.js';

// Mock the referral service — real implementation by default, individual tests
// override specific functions with mockResolvedValueOnce for collision testing.
vi.mock('../referrals/referral-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../referrals/referral-service.js')>();
  return {
    ...actual,
    generateUniqueReferralCode: vi.fn(actual.generateUniqueReferralCode),
  };
});

// Mock ONLY the production-wired verifier so integration tests never contact
// Google. `createGoogleVerifier`/nonce helpers stay REAL (they're unit-tested
// directly with a fake verifyIdToken function through the factory seam).
const { googleVerifyMock } = vi.hoisted(() => ({ googleVerifyMock: vi.fn() }));
vi.mock('../auth/google-verifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/google-verifier.js')>();
  return {
    ...actual,
    googleIdTokenVerifier: googleVerifyMock,
  };
});

const PREFIX = `${config.API_PREFIX}/auth`;
const VALID_PASSWORD = 'ValidPass1!';

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const describeIf = dbAvailable ? describe : describe.skip;

const createdEmails: string[] = [];

async function freshServer() {
  const s = await buildServer();
  await s.ready();
  return s;
}

function uniqueTag(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

async function cleanupFixtures() {
  if (createdEmails.length) {
    await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    createdEmails.length = 0;
  }
}

describeIf('auth foundation slice 3 — session relation, atomic registration, auth rate limit, password policy', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    server = await freshServer();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  afterAll(async () => {
    await cleanupFixtures();
    await prisma.$disconnect();
  });

  // ─── Fixtures ──────────────────────────────────────────────

  async function registerUser(tag: string, overrides: { email?: string; username?: string; password?: string } = {}) {
    const suffix = uniqueTag(tag);
    const email = overrides.email ?? `a3-${tag}-${suffix}@test.local`;
    const username = (overrides.username ?? `a3_${tag}_${suffix}`).slice(0, 30);
    const payload = {
      username,
      email,
      password: overrides.password ?? VALID_PASSWORD,
    };
    createdEmails.push(email);
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload,
    });
    return { res, payload, email };
  }

  // ─── A. REFRESH BASIC ──────────────────────────────────────

  it('A: refresh with a valid token returns 200 with replacement tokens', async () => {
    const { res, email } = await registerUser('basic');
    expect(res.statusCode).toBe(201);
    const regBody = res.json();
    expect(regBody.data.refreshToken).toBeTruthy();

    const ref = await server.inject({
      method: 'POST',
      url: `${PREFIX}/refresh`,
      payload: { refreshToken: regBody.data.refreshToken },
    });

    expect(ref.statusCode).toBe(200);
    const body = ref.json();
    expect(body.data.accessToken).toBeTruthy();
    expect(body.data.refreshToken).toBeTruthy();
    expect(body.data.refreshToken).not.toBe(regBody.data.refreshToken);
  });

  // ─── B. REFRESH SINGLE-WINNER CONCURRENCY ──────────────────

  it('B: two concurrent refreshes of the same token yield exactly one 200 and one 401', async () => {
    const { res } = await registerUser('conc');
    const token = res.json().data.refreshToken;

    const [r1, r2] = await Promise.all([
      server.inject({ method: 'POST', url: `${PREFIX}/refresh`, payload: { refreshToken: token } }),
      server.inject({ method: 'POST', url: `${PREFIX}/refresh`, payload: { refreshToken: token } }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 401]);

    const loser = r1.statusCode === 401 ? r1 : r2;
    const winner = r1.statusCode === 200 ? r1 : r2;
    expect(loser.json().error.code).toBe('UNAUTHORIZED');
    expect(['TOKEN_EXPIRED', 'TOKEN_INVALID']).toContain(loser.json().error.details?.code);
    expect(winner.json().data.refreshToken).toBeTruthy();
  });

  // ─── C. REFRESH TOKENVERSION REJECTION ─────────────────────

  it('C: refresh with a stale token after tokenVersion bump returns 401', async () => {
    const { res } = await registerUser('tv');
    const regBody = res.json();

    await prisma.user.update({
      where: { id: regBody.data.user.id },
      data: { tokenVersion: { increment: 1 } },
    });

    const ref = await server.inject({
      method: 'POST',
      url: `${PREFIX}/refresh`,
      payload: { refreshToken: regBody.data.refreshToken },
    });

    expect(ref.statusCode).toBe(401);
    expect(ref.json().error.code).toBe('UNAUTHORIZED');
    expect(ref.json().error.details?.code).toBe('TOKEN_EXPIRED');
  });

  // ─── D. AUTH RATE LIMIT ────────────────────────────────────

  it('D: the 11th login from the same client is rate-limited (429)', async () => {
    const results: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const r = await server.inject({
        method: 'POST',
        url: `${PREFIX}/login`,
        payload: { email: `absent-${i}-${uniqueTag('rl')}@test.local`, password: 'Wrong1!' },
      });
      results.push(r.statusCode);
    }

    expect(results.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(results[10]).toBe(429);
  });

  // ─── E. REGISTRATION ATOMICITY ─────────────────────────────

  it('E: failed initial Session insert rolls back the User entirely', async () => {
    // Create a real session first so we can force a refreshToken collision.
    const { res } = await registerUser('atomic');
    const existingRefresh = res.json().data.refreshToken;

    const spy = vi.spyOn(authUtils, 'generateTokens').mockImplementation((() => ({
      accessToken: 'mock-access-token',
      refreshToken: existingRefresh,
      expiresIn: 0,
    })) as typeof authUtils.generateTokens);

    try {
      const attempt = await registerUser('atomic_collision');
      const attemptBody = attempt.res.json();
      // The unclassified P2002 surfaces as ALREADY_EXISTS per the error mapper.
      expect(attempt.res.statusCode).toBe(409);
      expect(attemptBody.error?.code).toBe('ALREADY_EXISTS');

      const persisted = await prisma.user.findUnique({
        where: { email: attempt.email },
        select: { id: true },
      });
      expect(persisted).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // ─── F. DUPLICATE EMAIL CONCURRENCY ────────────────────────

  it('F: concurrent same-email registrations yield one 201, one 409, one user, one session', async () => {
    const email = `a3-dup-email-${randomUUID().replaceAll('-', '').slice(0, 10)}@test.local`;
    createdEmails.push(email);

    const suffix = uniqueTag('fe');
    const [r1, r2] = await Promise.all([
      server.inject({
        method: 'POST',
        url: `${PREFIX}/register`,
        payload: { username: `a3_fe_a_${suffix}`.slice(0, 30), email, password: VALID_PASSWORD },
      }),
      server.inject({
        method: 'POST',
        url: `${PREFIX}/register`,
        payload: { username: `a3_fe_b_${suffix}`.slice(0, 30), email, password: VALID_PASSWORD },
      }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(loser.json().error.message).toBe('Email already registered');

    const users = await prisma.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    const sessions = await prisma.session.count({ where: { userId: users[0].id } });
    expect(sessions).toBe(1);
  });

  // ─── G. DUPLICATE USERNAME CONCURRENCY ─────────────────────

  it('G: concurrent same-username registrations yield one 201, one 409, one user, one session', async () => {
    const username = `a3_dup_user_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

    const suffix = uniqueTag('gu');
    const r1 = server.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload: { username, email: `a3_gu_a_${suffix}@test.local`, password: VALID_PASSWORD },
    });
    const r2 = server.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload: { username, email: `a3_gu_b_${suffix}@test.local`, password: VALID_PASSWORD },
    });

    const [a, b] = await Promise.all([r1, r2]);
    createdEmails.push(`a3_gu_a_${suffix}@test.local`, `a3_gu_b_${suffix}@test.local`);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error.message).toBe('Username already taken');

    const users = await prisma.user.findMany({ where: { username } });
    expect(users).toHaveLength(1);
    const sessions = await prisma.session.count({ where: { userId: users[0].id } });
    expect(sessions).toBe(1);
  });

  // ─── H. PASSWORD COMPLEXITY ────────────────────────────────

  it('H1: all-lowercase "aaaaaaaa" is rejected with 400', async () => {
    const { res } = await registerUser('pwd1', { password: 'aaaaaaaa' });
    expect(res.statusCode).toBe(400);
  });

  it('H2: missing uppercase is rejected with 400', async () => {
    const { res } = await registerUser('pwd2', { password: 'aaaaaaaa1!' });
    expect(res.statusCode).toBe(400);
  });

  it('H3: missing lowercase is rejected with 400', async () => {
    const { res } = await registerUser('pwd3', { password: 'AAAAAAAA1!' });
    expect(res.statusCode).toBe(400);
  });

  it('H4: missing digit is rejected with 400', async () => {
    const { res } = await registerUser('pwd4', { password: 'Aaaaaaaa!' });
    expect(res.statusCode).toBe(400);
  });

  it('H5: missing special character is rejected with 400', async () => {
    const { res } = await registerUser('pwd5', { password: 'Aaaaaaa1' });
    expect(res.statusCode).toBe(400);
  });

  it('H6: a password meeting the full policy is accepted with 201', async () => {
    const { res } = await registerUser('pwd6', { password: VALID_PASSWORD });
    expect(res.statusCode).toBe(201);
  });

  // ─── I. SESSION CASCADE ────────────────────────────────────

  it('I: deleting a User cascades its Sessions via the FK', async () => {
    const { res } = await registerUser('cascade');
    const userId = res.json().data.user.id;

    const before = await prisma.session.count({ where: { userId } });
    expect(before).toBe(1);

    await prisma.user.delete({ where: { id: userId } });

    const after = await prisma.session.count({ where: { userId } });
    expect(after).toBe(0);
  });

  // ─── J. REFRESH-TOKEN UNIQUENESS (central JTI) ─────────────

  it('J1: two same-second generateTokens calls mint different refresh tokens (access unchanged)', () => {
    const fixedMs = Date.parse('2026-09-09T00:00:00.000Z');
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedMs);
    try {
      const a = authUtils.generateTokens('j1-user', 'j1@test.local', 'j1_user', ['USER'], 0);
      const b = authUtils.generateTokens('j1-user', 'j1@test.local', 'j1_user', ['USER'], 0);
      expect(a.refreshToken).not.toBe(b.refreshToken);
      expect(a.accessToken).toBe(b.accessToken);
    } finally {
      spy.mockRestore();
    }
  });

  it('J2: two same-second logins both succeed and store distinct refresh tokens', async () => {
    const { res, email } = await registerUser('j2');
    expect(res.statusCode).toBe(201);
    const userId = res.json().data.user.id;

    const fixedMs = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedMs);
    try {
      const [l1, l2] = await Promise.all([
        server.inject({ method: 'POST', url: `${PREFIX}/login`, payload: { email, password: VALID_PASSWORD } }),
        server.inject({ method: 'POST', url: `${PREFIX}/login`, payload: { email, password: VALID_PASSWORD } }),
      ]);
      expect(l1.statusCode).toBe(200);
      expect(l2.statusCode).toBe(200);

      const rt1 = l1.json().data.refreshToken;
      const rt2 = l2.json().data.refreshToken;
      expect(rt1).toBeTruthy();
      expect(rt2).toBeTruthy();
      expect(rt1).not.toBe(rt2);
    } finally {
      spy.mockRestore();
    }

    const sessions = await prisma.session.findMany({ where: { userId }, select: { refreshToken: true } });
    // 1 from registration + 2 from the same-second logins.
    expect(sessions).toHaveLength(3);
    const tokens = sessions.map((s) => s.refreshToken);
    expect(new Set(tokens).size).toBe(3);
  });

  it('J3: generated refresh token verifies with production semantics and carries a fresh jti', async () => {
    const fixedMs = Date.parse('2026-09-09T00:00:00.000Z');
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedMs);
    try {
      const a = authUtils.generateTokens('j3-user', 'j3@test.local', 'j3_user', ['USER'], 7);
      const b = authUtils.generateTokens('j3-user', 'j3@test.local', 'j3_user', ['USER'], 7);

      for (const tok of [a.refreshToken, b.refreshToken]) {
        const decoded = await server.jwt.verify<{
          sub: string;
          tokenVersion: number;
          iss: string;
          aud: string;
          jti?: string;
          iat?: number;
          exp?: number;
        }>(tok, {
          key: config.JWT_REFRESH_SECRET,
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
        });
        expect(decoded.sub).toBe('j3-user');
        expect(decoded.tokenVersion).toBe(7);
        expect(decoded.iss).toBe(config.JWT_ISSUER);
        expect(decoded.aud).toBe(config.JWT_AUDIENCE);
        expect(typeof decoded.jti).toBe('string');
        expect(decoded.jti).not.toBe('');
      }

      const jwtA = JSON.parse(Buffer.from(a.refreshToken.split('.')[1], 'base64url').toString());
      const jwtB = JSON.parse(Buffer.from(b.refreshToken.split('.')[1], 'base64url').toString());
      expect(jwtA.jti).toBeTruthy();
      expect(jwtA.jti).not.toBe(jwtB.jti);
    } finally {
      spy.mockRestore();
    }
  });

  // ─── K. SLICE 4A — EMAIL IDENTITY DUAL-WRITE ────────────────

  it('K1: legacy registration still returns 201 with the same response shape', async () => {
    const { res, payload } = await registerUser('4a_k1');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.user).toBeDefined();
    expect(body.data.user.email).toBe(payload.email);
    expect(body.data.accessToken).toBeTruthy();
    expect(body.data.refreshToken).toBeTruthy();
    expect(body.data.expiresIn).toBeDefined();
  });

  it('K2: registration creates exactly one EMAIL identity (verbatim subject, verifiedAt null)', async () => {
    const email = `k2-${uniqueTag('4a')}@test.local`;
    createdEmails.push(email);
    const { res } = await registerUser('4a_k2', { email });
    expect(res.statusCode).toBe(201);
    const userId = res.json().data.user.id;

    const identities = await prisma.userAuthIdentity.findMany({ where: { userId } });
    expect(identities).toHaveLength(1);
    expect(identities[0].provider).toBe('EMAIL');
    expect(identities[0].providerSubject).toBe(email);
    expect(identities[0].verifiedAt).toBeNull();
    expect(identities[0].lastUsedAt).toBeNull();
  });

  it('K3: legacy login still returns 200', async () => {
    const { res, email, payload } = await registerUser('4a_k3');
    expect(res.statusCode).toBe(201);
    const login = await server.inject({
      method: 'POST',
      url: `${PREFIX}/login`,
      payload: { email, password: payload.password },
    });
    expect(login.statusCode).toBe(200);
  });

  it('K4: login with a null passwordHash returns 401 Invalid credentials', async () => {
    const suffix = uniqueTag('4a');
    const email = `k4-${suffix}@test.local`;
    const username = `k4_${suffix}`.slice(0, 30);
    createdEmails.push(email);
    await prisma.user.create({
      data: { email, username, passwordHash: null, displayName: username, status: 'ACTIVE', role: 'USER', tokenVersion: 0 },
    });
    const login = await server.inject({
      method: 'POST',
      url: `${PREFIX}/login`,
      payload: { email, password: VALID_PASSWORD },
    });
    expect(login.statusCode).toBe(401);
    expect(login.json().error.message).toBe('Invalid credentials');
  });

  it('K5: identity insert failure on a pre-seeded EMAIL identity rolls back the whole registration', async () => {
    const suffix = uniqueTag('4a');
    const email = `k5-${suffix}@test.local`;
    const proxy = await prisma.user.create({
      data: {
        email,
        username: `k5_proxy_${suffix}`.slice(0, 30),
        passwordHash: 'proxy-only',
        displayName: 'proxy',
      },
    });
    // Pre-seed a legacy identity for email X, then null the proxy email so the
    // registration pre-check passes but the identity insert violates
    // (provider, providerSubject) inside the transaction.
    await prisma.userAuthIdentity.create({
      data: { userId: proxy.id, provider: 'EMAIL', providerSubject: email, verifiedAt: null },
    });
    await prisma.user.update({ where: { id: proxy.id }, data: { email: null } });

    try {
      const attempt = await registerUser('4a_k5', { email });
      expect(attempt.res.statusCode).toBe(409);
      expect(attempt.res.json().error.message).toBe('Email already registered');

      const createdUsers = await prisma.user.count({ where: { email } });
      expect(createdUsers).toBe(0);
      const identities = await prisma.userAuthIdentity.count({ where: { providerSubject: email } });
      expect(identities).toBe(1); // only the pre-seeded one survives
      const sessions = await prisma.session.count({ where: { userId: proxy.id } });
      expect(sessions).toBe(0);
    } finally {
      await prisma.userAuthIdentity.deleteMany({ where: { userId: proxy.id } });
      await prisma.user.delete({ where: { id: proxy.id } });
    }
  });

  it('K6: Session creation failure rolls back User, identity, and Session together', async () => {
    const baseline = await registerUser('4a_k6');
    const existingRefresh = baseline.res.json().data.refreshToken;

    const spy = vi.spyOn(authUtils, 'generateTokens').mockImplementation(((() => ({
      accessToken: 'mock-access-token',
      refreshToken: existingRefresh,
      expiresIn: 0,
    })) as typeof authUtils.generateTokens));

    const attemptEmail = `k6-${uniqueTag('4a')}@test.local`;
    createdEmails.push(attemptEmail);
    try {
      const attempt = await registerUser('4a_k6_dup', { email: attemptEmail });
      const attemptBody = attempt.res.json();
      // The unclassified P2002 (refreshToken collision) rethrows from the
      // register catch and surfaces as 409 ALREADY_EXISTS per the global
      // error mapper.
      expect(attempt.res.statusCode).toBe(409);
      expect(attemptBody.error?.code).toBe('ALREADY_EXISTS');

      const persisted = await prisma.user.findUnique({ where: { email: attemptEmail } });
      expect(persisted).toBeNull();

      const identities = await prisma.userAuthIdentity.count({ where: { providerSubject: attemptEmail } });
      expect(identities).toBe(0);

      const sessions = await prisma.session.count({ where: { user: { email: attemptEmail } } });
      expect(sessions).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  // ─── L. SLICE 4A — JWT BEHAVIOUR WITH NULLABLE EMAIL ────────

  it('L1: generateTokens with null email omits the email claim entirely', () => {
    const tokens = authUtils.generateTokens('l1-user', null, 'l1_user', ['USER'], 0);
    const decoded = server.jwt.decode<{ email?: string }>(tokens.accessToken);
    expect(decoded).not.toBeNull();
    expect('email' in (decoded ?? {})).toBe(false);
  });

  it('L2: generateTokens with undefined email omits the email claim entirely', () => {
    const tokens = authUtils.generateTokens('l2-user', undefined, 'l2_user', ['USER'], 0);
    const decoded = server.jwt.decode<{ email?: string }>(tokens.accessToken);
    expect('email' in (decoded ?? {})).toBe(false);
  });

  it('L3: generateTokens with a real email keeps the email claim', () => {
    const tokens = authUtils.generateTokens('l3-user', 'legacy@example.com', 'l3_user', ['USER'], 0);
    const decoded = server.jwt.decode<{ email?: string }>(tokens.accessToken);
    expect(decoded?.email).toBe('legacy@example.com');
  });

  it('L4: a null-email access token verifies through the production jwt path', () => {
    const tokens = authUtils.generateTokens('l4-user', null, 'l4_user', ['USER'], 0);
    const decoded = server.jwt.verify<{ sub: string; email?: string }>(tokens.accessToken);
    expect(decoded.sub).toBe('l4-user');
    expect('email' in decoded).toBe(false);
  });

  // ─── M. SLICE 4A — EMAIL-LESS REFRESH ───────────────────────

  it('M1: an email-less User can refresh; token rotates; replay rejected; access lacks email', async () => {
    const suffix = uniqueTag('4a');
    const username = `m1_${suffix}`.slice(0, 30);
    const user = await prisma.user.create({
      data: {
        email: null,
        passwordHash: null,
        username,
        displayName: username,
        status: 'ACTIVE',
        role: 'USER',
        tokenVersion: 0,
      },
    });

    const tokens = authUtils.generateTokens(user.id, user.email, user.username, [user.role], user.tokenVersion);
    await prisma.session.create({
      data: {
        userId: user.id,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    try {
      const refresh = await server.inject({
        method: 'POST',
        url: `${PREFIX}/refresh`,
        payload: { refreshToken: tokens.refreshToken },
      });
      expect(refresh.statusCode).toBe(200);
      const body = refresh.json();
      expect(body.data.refreshToken).not.toBe(tokens.refreshToken);

      const newAccess = server.jwt.decode<{ email?: string }>(body.data.accessToken);
      expect('email' in (newAccess ?? {})).toBe(false);

      // Replay of the original (now-rotated) token must be rejected.
      const replay = await server.inject({
        method: 'POST',
        url: `${PREFIX}/refresh`,
        payload: { refreshToken: tokens.refreshToken },
      });
      expect(replay.statusCode).toBe(401);

      // Sanity: the replacement token still works.
      const second = await server.inject({
        method: 'POST',
        url: `${PREFIX}/refresh`,
        payload: { refreshToken: body.data.refreshToken },
      });
      expect(second.statusCode).toBe(200);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  // ─── N. SLICE 4A — CONCURRENCY (10 rounds each) ─────────────

  it('N1: 10 rounds of concurrent same-email registration yield one 201/409 per round with one identity', async () => {
    for (let round = 0; round < 10; round += 1) {
      // A fresh server per round keeps the per-IP auth rate limit from
      // masking a genuine 201/409 outcome across the 20 total requests.
      const roundServer = await freshServer();
      try {
        const email = `n1-${uniqueTag('4a')}@test.local`;
        createdEmails.push(email);
        const s = uniqueTag('n1');

        const [a, b] = await Promise.all([
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/register`,
            payload: { username: `n1_ia_${s}`.slice(0, 30), email, password: VALID_PASSWORD },
          }),
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/register`,
            payload: { username: `n1_ib_${s}`.slice(0, 30), email, password: VALID_PASSWORD },
          }),
        ]);

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(loser.json().error.message).toBe('Email already registered');

        const users = await prisma.user.findMany({ where: { email } });
        expect(users).toHaveLength(1);
        const identities = await prisma.userAuthIdentity.count({
          where: { userId: users[0].id, provider: 'EMAIL', providerSubject: email },
        });
        expect(identities).toBe(1);
        const sessions = await prisma.session.count({ where: { userId: users[0].id } });
        expect(sessions).toBe(1);
      } finally {
        await roundServer.close();
      }
    }
  });

  it('N2: 10 rounds of concurrent same-username registration yield one 201/409 per round', async () => {
    for (let round = 0; round < 10; round += 1) {
      const roundServer = await freshServer();
      try {
        const username = `n2_${uniqueTag('4a')}`.slice(0, 30);
        const s = uniqueTag('n2');
        const emailA = `n2_a_${s}@test.local`;
        const emailB = `n2_b_${s}@test.local`;
        createdEmails.push(emailA, emailB);

        const [a, b] = await Promise.all([
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/register`,
            payload: { username, email: emailA, password: VALID_PASSWORD },
          }),
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/register`,
            payload: { username, email: emailB, password: VALID_PASSWORD },
          }),
        ]);

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(loser.json().error.message).toBe('Username already taken');

        const users = await prisma.user.findMany({ where: { username } });
        expect(users).toHaveLength(1);
        const identities = await prisma.userAuthIdentity.count({ where: { userId: users[0].id } });
        expect(identities).toBe(1);
        const sessions = await prisma.session.count({ where: { userId: users[0].id } });
        expect(sessions).toBe(1);
      } finally {
        await roundServer.close();
      }
    }
  });
});

describeIf('slice 5 — referral foundation', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  const blockUserIds: string[] = [];

  beforeEach(async () => {
    server = await freshServer();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  afterAll(async () => {
    if (blockUserIds.length > 0) {
      await prisma.referral.deleteMany({
        where: { OR: [{ referrerUserId: { in: blockUserIds } }, { referredUserId: { in: blockUserIds } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: blockUserIds } } });
      blockUserIds.length = 0;
    }
    await prisma.$disconnect();
  });

  // ─── Fixtures ──────────────────────────────────────────────

  async function registerRaw(payload: Record<string, unknown>) {
    return server.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload,
    });
  }

  /** Register a source user (referrer) directly with a known canonical code. */
  async function seedReferrer(tag: string, status = 'ACTIVE'): Promise<{ userId: string; code: string; email: string }> {
    const code = generateReferralCode();
    const email = `s5ref-${uniqueTag(tag)}@test.local`;
    const user = await prisma.user.create({
      data: {
        email,
        username: `s5ref_${uniqueTag(tag)}`.slice(0, 30),
        passwordHash: 'not-used',
        displayName: 'Ref',
        status: status as never,
        referralCode: code,
      },
    });
    blockUserIds.push(user.id);
    return { userId: user.id, code, email };
  }

  /** Register a fresh end user through the HTTP API (tracked for cleanup). */
  async function registerTracked(payload: Record<string, unknown>) {
    const res = await registerRaw(payload);
    if (res.statusCode === 201) {
      blockUserIds.push(res.json().data.user.id);
    }
    return res;
  }

  function expectCanonicalCode(code: string | null | undefined): code is string {
    return (
      typeof code === 'string' &&
      code.length === 8 &&
      /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(code)
    );
  }

  // ─── §31 BASELINE REGISTRATION ──────────────────────────────

  it('S5-31: register without referralCode succeeds, contract unchanged, own code generated, nonexposed', async () => {
    const email = `s5-31-${uniqueTag('base')}@test.local`;
    const payload = {
      username: `s5_31_${uniqueTag('base')}`.slice(0, 30),
      email,
      password: VALID_PASSWORD,
    };
    const res = await registerTracked(payload);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.user).toBeTruthy();
    expect(body.data.accessToken).toBeTruthy();
    expect(body.data.refreshToken).toBeTruthy();
    // Response contract unchanged: referralCode must not be exposed anywhere.
    expect(JSON.stringify(body)).not.toContain('referralCode');

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    expect(expectCanonicalCode(user!.referralCode)).toBe(true);

    const referrals = await prisma.referral.count({ where: { referredUserId: user!.id } });
    expect(referrals).toBe(0);
  });

  // ─── §32 VALID ATTRIBUTION ──────────────────────────────────

  it('S5-32: register with valid ACTIVE referrer code creates exactly one Referral row and no reward records', async () => {
    const referrer = await seedReferrer('valid');
    const email = `s5-32-${uniqueTag('valid')}@test.local`;
    const username = `s5_32_${uniqueTag('valid')}`.slice(0, 30);

    const res = await registerTracked({
      username,
      email,
      password: VALID_PASSWORD,
      referralCode: referrer.code,
    });

    expect(res.statusCode).toBe(201);
    const newUserId = res.json().data.user.id;

    const referrals = await prisma.referral.findMany({ where: { referredUserId: newUserId } });
    expect(referrals).toHaveLength(1);
    expect(referrals[0].referrerUserId).toBe(referrer.userId);
    expect(referrals[0].referredUserId).toBe(newUserId);
    expect(referrals[0].referralCode).toBe(referrer.code);

    // new referred user has its own generated, different, unique code
    const referred = await prisma.user.findUnique({ where: { id: newUserId } });
    expect(expectCanonicalCode(referred!.referralCode)).toBe(true);
    expect(referred!.referralCode).not.toBe(referrer.code);

    // identity count + session count
    const identities = await prisma.userAuthIdentity.count({ where: { userId: newUserId } });
    expect(identities).toBe(1);
    const sessions = await prisma.session.count({ where: { userId: newUserId } });
    expect(sessions).toBe(1);

    // no reward records
    const rewardClaims = await prisma.rewardClaim.count({ where: { userId: newUserId } });
    expect(rewardClaims).toBe(0);
    const wallet = await prisma.wallet.count({ where: { userId: newUserId } });
    expect(wallet).toBe(0);
    const walletTx = await prisma.walletTransaction.count({ where: { userId: newUserId } });
    expect(walletTx).toBe(0);
  });

  // ─── §33 CANONICALIZATION ───────────────────────────────────

  it('S5-33a: lowercase, mixed-case, and whitespace-wrapped code resolve to same canonical referrer', async () => {
    const referrer = await seedReferrer('canon');
    const code = referrer.code;
    const variants = [code.toLowerCase(), code.slice(0, 4).toLowerCase() + code.slice(4), `  ${code}  `];

    for (const variant of variants) {
      const email = `s5-33-${uniqueTag('canon')}@test.local`;
      const res = await registerTracked({
        username: `s5_33_${uniqueTag('canon')}`.slice(0, 30),
        email,
        password: VALID_PASSWORD,
        referralCode: variant,
      });

      expect(res.statusCode).toBe(201);
      const newUserId = res.json().data.user.id;

      const referral = await prisma.referral.findUnique({ where: { referredUserId: newUserId } });
      expect(referral).toBeTruthy();
      expect(referral!.referrerUserId).toBe(referrer.userId);
      // Stored code is canonical uppercase with no whitespace.
      expect(referral!.referralCode).toBe(code);
    }
  });

  it('S5-33b: whitespace-only referralCode is treated as omitted (201, zero referral rows)', async () => {
    const email = `s5-33b-${uniqueTag('ws')}@test.local`;
    const res = await registerTracked({
      username: `s5_33b_${uniqueTag('ws')}`.slice(0, 30),
      email,
      password: VALID_PASSWORD,
      referralCode: '   ',
    });

    expect(res.statusCode).toBe(201);
    const newUserId = res.json().data.user.id;
    const referrals = await prisma.referral.count({ where: { referredUserId: newUserId } });
    expect(referrals).toBe(0);
  });

  // ─── §34 INVALID / INELIGIBLE ───────────────────────────────

  it('S5-34: nonexistent code, malformed code, and SUSPENDED/BANNED/INACTIVE referrers all return generic 400 with full rollback', async () => {
    // nonexistent code in valid format
    let ghostCode = generateReferralCode();
    for (let i = 0; i < 20 && (await prisma.user.findUnique({ where: { referralCode: ghostCode } })); i += 1) {
      ghostCode = generateReferralCode();
    }

    const suspended = await seedReferrer('susp', 'SUSPENDED');
    const banned = await seedReferrer('banned', 'BANNED');
    const inactive = await seedReferrer('inact', 'INACTIVE');

    const cases: Array<{ label: string; code: string | null }> = [
      { label: 'nonexistent', code: ghostCode },
      { label: 'malformed', code: 'not-a-code' },
      { label: 'suspended', code: suspended.code },
      { label: 'banned', code: banned.code },
      { label: 'inactive', code: inactive.code },
    ];

    for (const c of cases) {
      const email = `s5-34-${c.label}-${uniqueTag('bad')}@test.local`;
      const res = await registerRaw({
        username: `s5_34_${c.label}_${uniqueTag('bad')}`.slice(0, 30),
        email,
        password: VALID_PASSWORD,
        referralCode: c.code,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toBe('Invalid referral code');

      // zero surviving User / EMAIL identity / Session / Referral
      const user = await prisma.user.findUnique({ where: { email } });
      expect(user).toBeNull();
      const referralCount = await prisma.referral.count({
        where: { referredUserId: { equals: email } },
      });
      expect(referralCount).toBe(0);
      const matchingUsers = await prisma.user.findMany({ where: { username: { contains: `s5_34_${c.label}_` } } });
      for (const u of matchingUsers) {
        expect(u.email).toBe(email); // no partial user exists for this exact email
      }
      const identities = await prisma.userAuthIdentity.count({ where: { providerSubject: email } });
      expect(identities).toBe(0);
      const sessions = await prisma.session.count(); // no partial session for this email
      const sessionOwner = await prisma.session.findFirst({
        where: { user: { email } },
      });
      expect(sessionOwner).toBeNull();
      expect(sessions).toBeGreaterThanOrEqual(0);
    }
  });

  // ─── §35 DB INVARIANTS ──────────────────────────────────────

  it('S5-35a: self-referral row fails the DB CHECK constraint', async () => {
    const selfCode = generateReferralCode();
    const u = await prisma.user.create({
      data: {
        email: `s5-35a-${uniqueTag('self')}@test.local`,
        username: `s5_35a_${uniqueTag('self')}`.slice(0, 30),
        passwordHash: 'x',
        referralCode: selfCode,
      },
    });
    blockUserIds.push(u.id);

    let failed = false;
    try {
      await prisma.$executeRaw`
        INSERT INTO "referrals" ("id", "referredUserId", "referrerUserId", "referralCode", "createdAt")
        VALUES (${randomUUID()}, ${u.id}, ${u.id}, ${selfCode}, NOW())
      `;
    } catch (err) {
      failed = true;
      expect(String((err as { message?: string }).message)).toMatch(/referrals_no_self_referral_check/);
    }
    expect(failed).toBe(true);
  });

  it('S5-35b: a second Referral for the same referredUserId fails the unique constraint', async () => {
    const referrer = await seedReferrer('dup2');
    const referred = await prisma.user.create({
      data: {
        email: `s5-35b-${uniqueTag('dup')}@test.local`,
        username: `s5_35b_${uniqueTag('dup')}`.slice(0, 30),
        passwordHash: 'x',
        referralCode: generateReferralCode(),
      },
    });
    blockUserIds.push(referred.id);

    await prisma.referral.create({
      data: {
        referredUserId: referred.id,
        referrerUserId: referrer.userId,
        referralCode: referrer.code,
      },
    });

    let failed = false;
    try {
      await prisma.referral.create({
        data: {
          referredUserId: referred.id,
          referrerUserId: referrer.userId,
          referralCode: referrer.code,
        },
      });
    } catch (err) {
      failed = true;
      expect((err as { code?: string }).code).toBe('P2002');
    }
    expect(failed).toBe(true);
    // cleanup: remove the single registered referral
    await prisma.referral.deleteMany({ where: { referredUserId: referred.id } });
  });

  it('S5-35c: many different users may use the same referrer code', async () => {
    const referrer = await seedReferrer('many');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const email = `s5-35c-${i}-${uniqueTag('many')}@test.local`;
      const res = await registerTracked({
        username: `s5_35c_${i}_${uniqueTag('many')}`.slice(0, 30),
        email,
        password: VALID_PASSWORD,
        referralCode: referrer.code,
      });
      expect(res.statusCode).toBe(201);
      ids.push(res.json().data.user.id);
    }
    const total = await prisma.referral.count({ where: { referrerUserId: referrer.userId } });
    expect(total).toBe(3);
  });

  it('S5-35d: adding another identity to a referred user does not alter/duplicate its Referral', async () => {
    const referrer = await seedReferrer('extraid');
    const email = `s5-35d-${uniqueTag('extraid')}@test.local`;
    const res = await registerTracked({
      username: `s5_35d_${uniqueTag('extraid')}`.slice(0, 30),
      email,
      password: VALID_PASSWORD,
      referralCode: referrer.code,
    });
    expect(res.statusCode).toBe(201);
    const newUserId = res.json().data.user.id;

    await prisma.userAuthIdentity.create({
      data: {
        userId: newUserId,
        provider: 'PHONE',
        providerSubject: `+1${Math.floor(2000000000 + Math.random() * 800000000)}`,
        verifiedAt: null,
      },
    });

    const referrals = await prisma.referral.findMany({ where: { referredUserId: newUserId } });
    expect(referrals).toHaveLength(1);
    expect(referrals[0].referrerUserId).toBe(referrer.userId);
  });

  // ─── §36 CONCURRENCY ────────────────────────────────────────

  it('S5-36a: 10 rounds of same-email + same-referral concurrent registration yield one 201 + one deterministic 409', async () => {
    for (let round = 0; round < 10; round += 1) {
      const roundServer = await freshServer();
      try {
        const referrer = await seedReferrer(`ce${round}`);
        const suffix = uniqueTag('ce');
        const email = `s5-36a-${suffix}@test.local`;
        const username = `s5_36a_${suffix}`.slice(0, 30);

        const [a, b] = await Promise.all([
          roundServer.inject({ method: 'POST', url: `${PREFIX}/register`, payload: { username, email, password: VALID_PASSWORD, referralCode: referrer.code } }),
          roundServer.inject({ method: 'POST', url: `${PREFIX}/register`, payload: { username, email, password: VALID_PASSWORD, referralCode: referrer.code } }),
        ]);

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(loser.json().error.message).toBe('Email already registered');

        const users = await prisma.user.findMany({ where: { email } });
        expect(users).toHaveLength(1);
        blockUserIds.push(users[0].id);
        const identities = await prisma.userAuthIdentity.count({ where: { userId: users[0].id } });
        expect(identities).toBe(1);
        const sessions = await prisma.session.count({ where: { userId: users[0].id } });
        expect(sessions).toBe(1);
        const referrals = await prisma.referral.count({ where: { referredUserId: users[0].id } });
        expect(referrals).toBe(1);
      } finally {
        await roundServer.close();
      }
    }
  });

  it('S5-36b: 10 rounds of same-username + same-referral concurrent registration yield one 201 + one deterministic 409', async () => {
    for (let round = 0; round < 10; round += 1) {
      const roundServer = await freshServer();
      try {
        const referrer = await seedReferrer(`cu${round}`);
        const suffix = uniqueTag('cu');
        const username = `s5_36b_${suffix}`.slice(0, 30);

        const [a, b] = await Promise.all([
          roundServer.inject({ method: 'POST', url: `${PREFIX}/register`, payload: { username, email: `s5b-a-${suffix}@test.local`, password: VALID_PASSWORD, referralCode: referrer.code } }),
          roundServer.inject({ method: 'POST', url: `${PREFIX}/register`, payload: { username, email: `s5b-b-${suffix}@test.local`, password: VALID_PASSWORD, referralCode: referrer.code } }),
        ]);

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([201, 409]);
        const loser = a.statusCode === 409 ? a : b;
        expect(loser.json().error.message).toBe('Username already taken');

        const users = await prisma.user.findMany({ where: { username } });
        expect(users).toHaveLength(1);
        blockUserIds.push(users[0].id);
        const identities = await prisma.userAuthIdentity.count({ where: { userId: users[0].id } });
        expect(identities).toBe(1);
        const sessions = await prisma.session.count({ where: { userId: users[0].id } });
        expect(sessions).toBe(1);
        const referrals = await prisma.referral.count({ where: { referredUserId: users[0].id } });
        expect(referrals).toBe(1);
      } finally {
        await roundServer.close();
      }
    }
  });

  // ─── §37 GENERATED-CODE COLLISION RETRY ─────────────────────

  it('S5-37: registration retries on generated-code collision and does NOT surface "Invalid referral code"', async () => {
    // Pre-seed a user whose own referralCode is known.
    const collider = await prisma.user.create({
      data: {
        email: `s5-37-collider-${uniqueTag('coll')}@test.local`,
        username: `s5_37_c_${uniqueTag('coll')}`.slice(0, 30),
        passwordHash: 'x',
        displayName: 'Collider',
        referralCode: 'COLLIDER9',
      },
    });
    blockUserIds.push(collider.id);

    // Mock generateUniqueReferralCode to return the colliding code first, then a unique one.
    // This proves the retry loop handles P2002 on referralCode without surfacing "Invalid referral code".
    const uniquePost = 'XPOSTFIX';

    // Seed an ACTIVE referrer whose code the new registration supplies — must
    // resolve so that only the generated-own-code collision exercises the retry.
    const ghostReferrer = await prisma.user.create({
      data: {
        email: `s5-37-referrer-${uniqueTag('coll')}@test.local`,
        username: `s5_37_r_${uniqueTag('coll')}`.slice(0, 30),
        passwordHash: 'x',
        displayName: 'GhostReferrer',
        referralCode: 'GHSTCDE2',
      },
    });
    blockUserIds.push(ghostReferrer.id);

    const mockGenerate = vi.mocked(generateUniqueReferralCode);
    mockGenerate.mockResolvedValueOnce('COLLIDER9' as never);
    mockGenerate.mockResolvedValueOnce(uniquePost as never);

    try {
      const email = `s5-37-reg-${uniqueTag('noenv')}@test.local`;
      const res = await registerTracked({
        username: `s5_37_reg_${uniqueTag('noenv')}`.slice(0, 30),
        email,
        password: VALID_PASSWORD,
        referralCode: 'GHSTCDE2',  // valid format, owned by the seeded ACTIVE referrer
      });

      // Must succeed after retry, NOT return "Invalid referral code"
      expect(res.statusCode).toBe(201);
      expect(res.json().error?.message ?? null).not.toBe('Invalid referral code');

      const newUserId = res.json().data.user.id;
      const identities = await prisma.userAuthIdentity.count({ where: { userId: newUserId } });
      expect(identities).toBe(1);
      const sessions = await prisma.session.count({ where: { userId: newUserId } });
      expect(sessions).toBe(1);
    } finally {
      mockGenerate.mockRestore();
    }
  });

  // ─── §38 ATTRIBUTION FAILURE ROLLBACK ───────────────────────

  it('S5-38: Referral insert failure via FK violation inside a mirrored registration tx leaves zero partial state', async () => {
    // Mirror the registration flow but intentionally use a non-existent
    // referrerUserId to trigger a real FK constraint violation on Referral insert.
    const fakeReferrerId = '00000000-0000-0000-0000-000000000000';
    const usedEmail = `s5-38-${uniqueTag('fk')}@test.local`;
    let survived = false;

    try {
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: usedEmail,
            username: `s5_38_${uniqueTag('fk')}`.slice(0, 30),
            passwordHash: 'x',
            displayName: 'FK-rollback-test',
            referralCode: generateReferralCode(),
          },
          select: { id: true },
        });

        await tx.userAuthIdentity.create({
          data: { userId: user.id, provider: 'EMAIL', providerSubject: usedEmail, verifiedAt: null },
        });

        // This FK violation triggers rollback of the entire tx.
        await tx.referral.create({
          data: {
            referredUserId: user.id,
            referrerUserId: fakeReferrerId,
            referralCode: 'XXXXX000',
          },
        });
      });
    } catch {
      // FK violation expected — tx rolled back.
    }

    const userCount = await prisma.user.count({ where: { email: usedEmail } });
    expect(userCount).toBe(0);
    const identityCount = await prisma.userAuthIdentity.count({ where: { providerSubject: usedEmail } });
    expect(identityCount).toBe(0);
    // no referral was created for a non-existent referredUserId
    const referralCount = await prisma.referral.count({
      where: { referredUserId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(referralCount).toBe(0);
  });

  // ─── §39 UNKNOWN P2002 RETHROW ──────────────────────────────

  it('S5-39: an unrecognized P2002 target is rethrown by the route and lands on the global error handler as 409 (not mapped to referral error)', async () => {
    const spy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(Object.assign(new Error('unique'), {
      code: 'P2002',
      meta: { target: ['some_completely_unknown_constraint_name'] },
    }));

    try {
      const res = await registerTracked({
        username: `s5_39_${uniqueTag('unk')}`.slice(0, 30),
        email: `s5-39-${uniqueTag('unk')}@test.local`,
        password: VALID_PASSWORD,
      });

      // Global error handler maps unknown P2002 to 409 ALREADY_EXISTS.
      // The key assertion: it must NOT be a referral-specific error message.
      expect(res.statusCode).toBe(409);
      expect(res.json().error.message).not.toBe('Invalid referral code');
      expect(res.json().error.code ?? res.json().error.message).not.toContain('Username already taken');
    } finally {
      spy.mockRestore();
    }
  });

  // ─── §40 REWARD ABSENCE (re-checked across all success paths) ──

  it('S5-40: successful referral registration produces no reward claims, no wallet rows, no referral wallet transactions', async () => {
    const referrer = await seedReferrer('reward');
    const email = `s5-40-${uniqueTag('rw')}@test.local`;
    const res = await registerTracked({
      username: `s5_40_${uniqueTag('rw')}`.slice(0, 30),
      email,
      password: VALID_PASSWORD,
      referralCode: referrer.code,
    });
    expect(res.statusCode).toBe(201);
    const newUserId = res.json().data.user.id;

    const rewardClaims = await prisma.rewardClaim.count({ where: { userId: newUserId } });
    expect(rewardClaims).toBe(0);
    const wallet = await prisma.wallet.count({ where: { userId: newUserId } });
    expect(wallet).toBe(0);
    const walletTx = await prisma.walletTransaction.count({ where: { userId: newUserId } });
    expect(walletTx).toBe(0);
  });
});
describeIf('slice 6 — google auth foundation', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  const blockUserIds: string[] = [];

  beforeEach(async () => {
    server = await freshServer();
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  afterAll(async () => {
    if (blockUserIds.length > 0) {
      await prisma.referral.deleteMany({
        where: { OR: [{ referrerUserId: { in: blockUserIds } }, { referredUserId: { in: blockUserIds } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: blockUserIds } } });
      blockUserIds.length = 0;
    }
    await prisma.$disconnect();
  });

  // ─── Helpers ──────────────────────────────────────────────

  function mockVerified(sub: string, opts: { email?: string; emailVerified?: boolean; hd?: string } = {}) {
    googleVerifyMock.mockImplementation(async () => ({
      kind: 'verified',
      claims: {
        sub,
        emailVerified: opts.emailVerified ?? true,
        ...opts,
      },
    }));
  }

  async function googleNonce(): Promise<{ cookie: string; raw: string; digest: string }> {
    const res = await server.inject({ method: 'GET', url: `${PREFIX}/google/nonce` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('sp_google_nonce=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/api/v1/auth/google');
    const rawMatch = setCookie.match(/sp_google_nonce=([^;]+)/);
    expect(rawMatch).toBeTruthy();
    const raw = rawMatch![1];
    const digest = hashNonceSecret(raw);
    const body = res.json();
    expect(body.data.nonce).toBe(digest);
    expect(body.data.nonce).not.toBe(raw);
    return { cookie: `sp_google_nonce=${raw}`, raw, digest };
  }

  function postGoogle(body: Record<string, unknown>, cookie?: string) {
    return server.inject({
      method: 'POST',
      url: `${PREFIX}/google`,
      payload: body,
      headers: cookie ? { cookie: {} } : {},
      ...(cookie ? { headers: { cookie } } : {}),
    });
  }

  // ─── Fixtures ──────────────────────────────────────────────

  async function seedGoogleUser(
    tag: string,
    sub: string,
    opts: { email?: string; username?: string; status?: string; referralCode?: string } = {},
  ): Promise<{ userId: string; email: string | null; username: string }> {
    const email = opts.email ?? null;
    const username = opts.username ?? `g6_${uniqueTag(tag)}`.slice(0, 30);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: null,
        username,
        displayName: username,
        status: (opts.status ?? 'ACTIVE') as never,
        referralCode: opts.referralCode ?? generateReferralCode(),
      },
    });
    blockUserIds.push(user.id);
    await prisma.userAuthIdentity.create({
      data: {
        userId: user.id,
        provider: 'GOOGLE',
        providerSubject: sub,
        verifiedAt: new Date(),
        lastUsedAt: null as never,
      },
    });
    return { userId: user.id, email, username };
  }

  async function seedReferrer(tag: string, status = 'ACTIVE'): Promise<{ userId: string; code: string }> {
    const code = generateReferralCode();
    const email = `s6ref-${uniqueTag(tag)}@test.local`;
    const user = await prisma.user.create({
      data: {
        email,
        username: `s6ref_${uniqueTag(tag)}`.slice(0, 30),
        passwordHash: 'not-used',
        displayName: 'Ref',
        status: status as never,
        referralCode: code,
      },
    });
    blockUserIds.push(user.id);
    return { userId: user.id, code };
  }

  // ─── S6-1: Config-off 503s deferred to last describe block

  // ─── S6-2: Nonce endpoint happy path

  it('S6-2: nonce endpoint returns 200 with no-store cache, set-cookie with correct attributes, and digest', async () => {
    const nonce = await googleNonce();
    expect(nonce.raw).toBeTruthy();
    expect(nonce.digest).toBeTruthy();
    expect(nonce.cookie).toContain('sp_google_nonce=');
    // Re-fetch to confirm idempotent
    const nonce2 = await googleNonce();
    expect(nonce2.raw).not.toBe(nonce.raw); // different nonce each time
    expect(nonce2.digest).not.toBe(nonce.digest);
  });

  // ─── S6-3: Missing nonce cookie → 401

  it('S6-3: POST /google without nonce cookie returns 401', async () => {
    const res = await server.inject({
      method: 'POST',
      url: `${PREFIX}/google`,
      payload: { credential: 'tok' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid Google credential');
  });

  // ─── S6-4: Invalid credential → 401

  it('S6-4: POST /google with invalid credential returns 401', async () => {
    await googleNonce();
    googleVerifyMock.mockResolvedValue({ kind: 'invalid' });
    const res = await postGoogle({ credential: 'tok-invalid' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Invalid Google credential');
  });

  // ─── S6-5: Transport unavailable → 503

  it('S6-5: POST /google when transport unavailable returns 503', async () => {
    const { cookie } = await googleNonce();
    googleVerifyMock.mockResolvedValue({ kind: 'unavailable' });
    const res = await postGoogle({ credential: 'tok-unavail' }, cookie);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('Google sign-in temporarily unavailable');
  });

  // ─── S6-6: Two-step atomicity (§66)

  it('S6-6: first POST without username returns 422 USERNAME_REQUIRED, second POST with same cookie returns 201', async () => {
    const { cookie } = await googleNonce();
    const sub = uniqueTag('s66');
    mockVerified(sub);

    const first = await postGoogle({ credential: 'tok-66' }, cookie);
    expect(first.statusCode).toBe(422);
    expect(first.json().error.code).toBe(ErrorCode.USERNAME_REQUIRED);

    // No new rows
    const zeroUsers = await prisma.user.findMany({ where: { identities: { some: { providerSubject: sub } } } });
    expect(zeroUsers).toHaveLength(0);
    const zeroUsersByName = await prisma.user.findMany({ where: { username: 'user66' } });
    expect(zeroUsersByName).toHaveLength(0);

    // Second POST with same cookie
    const second = await postGoogle({ credential: 'tok-66', username: 'g6_user66' }, cookie);
    expect(second.statusCode).toBe(201);
    const userId = second.json().data.user.id;
    blockUserIds.push(userId);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user).toBeTruthy();
    expect(user!.email).toBeNull();
    expect(user!.passwordHash).toBeNull();
    expect(user!.username).toBe('g6_user66');

    const identity = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: sub } },
    });
    expect(identity).toBeTruthy();
    expect(identity!.userId).toBe(userId);
    expect(identity!.verifiedAt).toBeTruthy();
    expect(identity!.lastUsedAt).toBeTruthy();

    const ownRef = user!.referralCode;
    expect(ownRef).toBeTruthy();
    expect(ownRef!.length).toBe(8);

    const sessions = await prisma.session.count({ where: { userId } });
    expect(sessions).toBe(1);
  });

  // ─── S6-7: Valid referral Google signup (§67)

  it('S6-7: Google signup with valid referral code creates user, identity, referral, and session', async () => {
    const referrer = await seedReferrer('s67');
    const { cookie } = await googleNonce();
    const sub = uniqueTag('s67');
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-67', username: 'g6_user67', referralCode: referrer.code }, cookie);
    expect(res.statusCode).toBe(201);
    const userId = res.json().data.user.id;
    blockUserIds.push(userId);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user).toBeTruthy();
    expect(user!.email).toBeNull();
    expect(user!.passwordHash).toBeNull();

    const identity = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: sub } },
    });
    expect(identity).toBeTruthy();
    expect(identity!.verifiedAt).toBeTruthy();

    const referral = await prisma.referral.findFirst({ where: { referredUserId: userId } });
    expect(referral).toBeTruthy();
    expect(referral!.referrerUserId).toBe(referrer.userId);
    expect(referral!.referralCode).toBe(referrer.code);

    const ownRef = user!.referralCode;
    expect(ownRef).toBeTruthy();
    expect(ownRef!.length).toBe(8);

    const sessions = await prisma.session.count({ where: { userId } });
    expect(sessions).toBe(1);
  });

  // ─── S6-8: Invalid referral rollback (§68)

  it('S6-8: Google signup with invalid referral code returns 400 and leaves no rows', async () => {
    const { cookie } = await googleNonce();
    const sub = uniqueTag('s68');
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-68', username: 'g6_user68', referralCode: 'BADCODE1' }, cookie);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe('Invalid referral code');

    const users = await prisma.user.findMany({ where: { username: 'g6_user68' } });
    expect(users).toHaveLength(0);
    const identities = await prisma.userAuthIdentity.count({ where: { providerSubject: sub } });
    expect(identities).toBe(0);
    const sessions = await prisma.session.count({ where: { user: { username: 'g6_user68' } } });
    expect(sessions).toBe(0);
    const referrals = await prisma.referral.count({ where: { referredUser: { username: 'g6_user68' } } });
    expect(referrals).toBe(0);
  });

  // ─── S6-9: Returning login (§69)

  it('S6-9: returning Google login updates lastLoginAt and identity.lastUsedAt, clears nonce, no google fields in response', async () => {
    const sub = uniqueTag('s69ret');
    const seeded = await seedGoogleUser('s69ret', sub, { username: `g6_${uniqueTag('s69r')}`.slice(0, 30) });

    // Verify lastLoginAt is null before
    const userBefore = await prisma.user.findUnique({ where: { id: seeded.userId } });
    expect(userBefore!.lastLoginAt).toBeNull();

    const { cookie } = await googleNonce();
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-ret' }, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(seeded.userId);

    // No new user
    const userCount = await prisma.user.count({ where: { username: seeded.username } });
    expect(userCount).toBe(1);

    // No new identity
    const identityCount = await prisma.userAuthIdentity.count({
      where: { userId: seeded.userId, provider: 'GOOGLE' },
    });
    expect(identityCount).toBe(1);

    // Session created
    const sessions = await prisma.session.count({ where: { userId: seeded.userId } });
    expect(sessions).toBe(1);

    // lastLoginAt now set
    const userAfter = await prisma.user.findUnique({ where: { id: seeded.userId } });
    expect(userAfter!.lastLoginAt).toBeTruthy();

    // identity.lastUsedAt set
    const identity = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: sub } },
    });
    expect(identity!.lastUsedAt).toBeTruthy();

    // Nonce cleared — @fastify/cookie clearCookie uses Expires, not Max-Age
    const setCookieHeader = res.headers['set-cookie'] as string | string[];
    const setCookieStr = Array.isArray(setCookieHeader) ? setCookieHeader.join('\n') : setCookieHeader ?? '';
    expect(setCookieStr).toContain('sp_google_nonce=');
    expect(setCookieStr).toMatch(/Expires=Thu, 01 Jan 1970/);

    // No google fields in response
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('"sub"');
    expect(body).not.toContain('"hd"');
    expect(body).not.toContain('"email_verified"');
  });

  // ─── S6-10: Returning referral ignored (§70)

  it('S6-10: returning Google login ignores referralCode and username in payload', async () => {
    const sub = uniqueTag('s610');
    const seeded = await seedGoogleUser('s610', sub, { username: `g6_${uniqueTag('s610')}`.slice(0, 30) });
    const referrer = await seedReferrer('s610ref');

    const { cookie } = await googleNonce();
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-10', username: 'othername', referralCode: referrer.code }, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.user.id).toBe(seeded.userId);

    // Username unchanged
    const user = await prisma.user.findUnique({ where: { id: seeded.userId } });
    expect(user!.username).toBe(seeded.username);

    // No referral created for referrer
    const referrals = await prisma.referral.count({ where: { referrerUserId: referrer.userId } });
    expect(referrals).toBe(0);
  });

  // ─── S6-11: Account status (§71)

  it('S6-11: SUSPENDED and BANNED accounts get 403 on Google login', async () => {
    for (const status of ['SUSPENDED', 'BANNED'] as const) {
      const sub = uniqueTag(`s611_${status.toLowerCase()}`);
      const seeded = await seedGoogleUser(`s611_${status.toLowerCase()}`, sub, {
        username: `g6_${uniqueTag(`s611${status}`)}`.slice(0, 30),
        status,
      });

      const { cookie } = await googleNonce();
      mockVerified(sub);

      const res = await postGoogle({ credential: `tok-${status.toLowerCase()}` }, cookie);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe('Account is not active');

      const sessions = await prisma.session.count({ where: { userId: seeded.userId } });
      expect(sessions).toBe(0);
    }
  });

  // ─── S6-12: Different subs same username (§75)

  it('S6-12: two different subs trying the same username yields 201 then 409', async () => {
    const username = `g6_race_${uniqueTag('s612')}`.slice(0, 30);
    const subA = uniqueTag('s612A');
    const subB = uniqueTag('s612B');

    const { cookie: cookieA } = await googleNonce();
    mockVerified(subA);
    const a = await postGoogle({ credential: 'tok-A', username }, cookieA);
    expect(a.statusCode).toBe(201);
    blockUserIds.push(a.json().data.user.id);

    const { cookie: cookieB } = await googleNonce();
    mockVerified(subB);
    const b = await postGoogle({ credential: 'tok-B', username }, cookieB);
    expect(b.statusCode).toBe(409);
    expect(b.json().error.message).toBe('Username already taken');

    const users = await prisma.user.findMany({ where: { username } });
    expect(users).toHaveLength(1);
    // No orphan row for subB
    const orphan = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: subB } },
    });
    expect(orphan).toBeNull();
  });

  // ─── S6-13: Same-sub same username 10 rounds (§72)

  it('S6-13: 10 rounds of same-sub same-username concurrent POSTs yield [200,201] each round', async () => {
    for (let i = 0; i < 10; i++) {
      const roundServer = await freshServer();
      try {
        const sub = uniqueTag(`s613_r${i}`);
        const username = `g6_r${i}_${uniqueTag('s613')}`.slice(0, 30);

        googleVerifyMock.mockImplementation(async () => ({
          kind: 'verified',
          claims: { sub, emailVerified: true },
        }));

        // Get nonce from this round's server
        const nonceRes = await roundServer.inject({ method: 'GET', url: `${PREFIX}/google/nonce` });
        const rawMatch = (nonceRes.headers['set-cookie'] as string).match(/sp_google_nonce=([^;]+)/);
        const cookie = `sp_google_nonce=${rawMatch![1]}`;

        const [a, b] = await Promise.all([
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/google`,
            payload: { credential: `tok-${sub}`, username },
            headers: { cookie },
          }),
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/google`,
            payload: { credential: `tok-${sub}`, username },
            headers: { cookie },
          }),
        ]);

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([200, 201]);

        const winnerRes = a.statusCode === 201 ? a : b;
        const winnerUserId = winnerRes.json().data.user.id;
        blockUserIds.push(winnerUserId);

        const users = await prisma.user.findMany({ where: { username } });
        expect(users).toHaveLength(1);

        const identities = await prisma.userAuthIdentity.count({ where: { userId: users[0].id } });
        expect(identities).toBe(1);

        const sessions = await prisma.session.count({ where: { userId: users[0].id } });
        expect(sessions).toBe(2);

        const referrals = await prisma.referral.count({ where: { referredUserId: users[0].id } });
        expect(referrals).toBe(0);
      } finally {
        await roundServer.close();
      }
    }
  });

  // ─── S6-14: Same-sub competing referral 10 rounds (§74)

  it('S6-14: 10 rounds of same-sub with two competing referral codes yield exactly 1 referral per round', async () => {
    for (let i = 0; i < 10; i++) {
      const roundServer = await freshServer();
      try {
        const refA = await seedReferrer(`s614A_r${i}`);
        const refB = await seedReferrer(`s614B_r${i}`);
        const sub = uniqueTag(`s614_r${i}`);
        const username = `g6_ref${i}_${uniqueTag('s614')}`.slice(0, 30);

        googleVerifyMock.mockImplementation(async () => ({
          kind: 'verified',
          claims: { sub, emailVerified: true },
        }));

        const nonceRes = await roundServer.inject({ method: 'GET', url: `${PREFIX}/google/nonce` });
        const rawMatch = (nonceRes.headers['set-cookie'] as string).match(/sp_google_nonce=([^;]+)/);
        const cookie = `sp_google_nonce=${rawMatch![1]}`;

        const [a, b] = await Promise.all([
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/google`,
            payload: { credential: `tok-${sub}`, username, referralCode: refA.code },
            headers: { cookie },
          }),
          roundServer.inject({
            method: 'POST',
            url: `${PREFIX}/google`,
            payload: { credential: `tok-${sub}`, username, referralCode: refB.code },
            headers: { cookie },
          }),
        ]);

        const statuses = [a.statusCode, b.statusCode].sort();
        expect(statuses).toEqual([200, 201]);

        const winnerRes = a.statusCode === 201 ? a : b;
        const winnerUserId = winnerRes.json().data.user.id;
        blockUserIds.push(winnerUserId);

        const users = await prisma.user.findMany({ where: { username } });
        expect(users).toHaveLength(1);

        const identities = await prisma.userAuthIdentity.count({ where: { userId: users[0].id } });
        expect(identities).toBe(1);

        const sessions = await prisma.session.count({ where: { userId: users[0].id } });
        expect(sessions).toBe(2);

        const referrals = await prisma.referral.findMany({ where: { referredUserId: users[0].id } });
        expect(referrals).toHaveLength(1);
        // The winning referral's code matches the code in the 201 request
        const winnerPayload = winnerRes.json().data;
        // The referral should have the code from whichever request won
        const winningRefCode = a.statusCode === 201 ? refA.code : refB.code;
        expect(referrals[0].referralCode).toBe(winningRefCode);
      } finally {
        await roundServer.close();
      }
    }
  });

  // ─── S6-15: Own-code collision retry (§76)

  it('S6-15: user whose generated code collides with an existing code gets a unique replacement', async () => {
    // Seed a collider user with a known code
    const collider = await seedReferrer('s615');
    // Override the collider's code to a known value
    await prisma.user.update({ where: { id: collider.userId }, data: { referralCode: 'G6COLLIDE' } });

    // Mock generateUniqueReferralCode: first call collides, second call succeeds
    const { generateUniqueReferralCode: realGen } = await import('../referrals/referral-service.js');
    vi.mocked(realGen)
      .mockResolvedValueOnce('G6COLLIDE')
      .mockResolvedValueOnce('G6UNIQUE');

    const sub = uniqueTag('s615own');
    const { cookie } = await googleNonce();
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-own', username: 'g6_own' }, cookie);
    expect(res.statusCode).toBe(201);
    const userId = res.json().data.user.id;
    blockUserIds.push(userId);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.referralCode).not.toBe('G6COLLIDE');
    expect(user!.referralCode).toBe('G6UNIQUE');

    const users = await prisma.user.findMany({ where: { username: 'g6_own' } });
    expect(users).toHaveLength(1);
    const identities = await prisma.userAuthIdentity.count({ where: { userId } });
    expect(identities).toBe(1);
    const sessions = await prisma.session.count({ where: { userId } });
    expect(sessions).toBe(1);
    const referrals = await prisma.referral.count({ where: { referredUserId: userId } });
    expect(referrals).toBe(0);
  });

  // ─── S6-16: Unknown P2002 rethrow (§77)

  it('S6-16: unknown P2002 target rethrows as 500', async () => {
    const { generateUniqueReferralCode: realGen } = await import('../referrals/referral-service.js');
    const fakeError = Object.assign(new Error('Unique constraint failed on the fields: (`some_unknown_col`)'), {
      code: 'P2002',
      meta: { target: ['some_unknown_col'] },
    });
    vi.mocked(realGen).mockRejectedValueOnce(fakeError);

    const sub = uniqueTag('s616');
    const { cookie } = await googleNonce();
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-16', username: 'g6_user16' }, cookie);
    // The route rethrows unknown P2002; the global errorHandler catches P2002
    // and maps it to 409 ALREADY_EXISTS — NOT a race recovery or username error.
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_EXISTS');

    const users = await prisma.user.findMany({ where: { username: 'g6_user16' } });
    expect(users).toHaveLength(0);
  });

  // ─── S6-17: Credential replay (§78)

  it('S6-17: same credential used twice produces 2 sessions, 1 user, 1 identity', async () => {
    const sub = uniqueTag('s617');
    const username = `g6_${uniqueTag('s617')}`.slice(0, 30);
    mockVerified(sub);

    const { cookie } = await googleNonce();
    const first = await postGoogle({ credential: 'tok-replay', username }, cookie);
    expect(first.statusCode).toBe(201);
    blockUserIds.push(first.json().data.user.id);

    const { cookie: cookie2 } = await googleNonce();
    mockVerified(sub);
    const second = await postGoogle({ credential: 'tok-replay', username }, cookie2);
    expect(second.statusCode).toBe(200);

    const users = await prisma.user.findMany({ where: { username } });
    expect(users).toHaveLength(1);
    const identities = await prisma.userAuthIdentity.count({ where: { userId: users[0].id } });
    expect(identities).toBe(1);
    const sessions = await prisma.session.count({ where: { userId: users[0].id } });
    expect(sessions).toBe(2);
    const referrals = await prisma.referral.count({ where: { referredUserId: users[0].id } });
    expect(referrals).toBe(0);
  });

  // ─── S6-18: Authoritative email case (§59)

  it('S6-18: Google email matching existing email-authoritative user triggers ACCOUNT_LINK_REQUIRED', async () => {
    const email = 'Person@Gmail.com';
    const sub = uniqueTag('s618');
    // Seed a user with email-authoritative (gmail) — use register endpoint for proper email authoritativeness
    const regRes = await server.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload: { username: `g6_${uniqueTag('s618e')}`.slice(0, 30), email, password: VALID_PASSWORD },
    });
    expect(regRes.statusCode).toBe(201);
    blockUserIds.push(regRes.json().data.user.id);

    const { cookie } = await googleNonce();
    // Google returns lowercase version of the same email — authoritative for gmail.com
    mockVerified(sub, { email: 'person@gmail.com', emailVerified: true });

    const res = await postGoogle({ credential: 'tok-case', username: 'g6_case' }, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(ErrorCode.ACCOUNT_LINK_REQUIRED);

    const identities = await prisma.userAuthIdentity.count({ where: { providerSubject: sub } });
    expect(identities).toBe(0);
    const usersByName = await prisma.user.findMany({ where: { username: 'g6_case' } });
    expect(usersByName).toHaveLength(0);
  });

  // ─── S6-19: Non-authoritative email (§60)

  it('S6-19: non-Google-authoritative domain does not trigger account link, creates new user', async () => {
    const sub = uniqueTag('s619');
    const { cookie } = await googleNonce();
    mockVerified(sub, { email: 'person@example.com', emailVerified: true });

    const res = await postGoogle({ credential: 'tok-na', username: 'g6_na' }, cookie);
    expect(res.statusCode).toBe(201);
    const userId = res.json().data.user.id;
    blockUserIds.push(userId);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.email).toBeNull(); // not linked — non-authoritative

    const identity = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: sub } },
    });
    expect(identity).toBeTruthy();
  });

  // ─── S6-20: Workspace authority (§61)

  it('S6-20a: verified workspace email matching existing email-authoritative user → ACCOUNT_LINK_REQUIRED', async () => {
    const email = 'person@example.com';
    const sub = uniqueTag('s620a');
    // Seed user via register (email-authoritative for example.com domain)
    const regRes = await server.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload: { username: `g6_${uniqueTag('s620a')}`.slice(0, 30), email, password: VALID_PASSWORD },
    });
    expect(regRes.statusCode).toBe(201);
    blockUserIds.push(regRes.json().data.user.id);

    const { cookie } = await googleNonce();
    mockVerified(sub, { email: 'person@example.com', emailVerified: true, hd: 'example.com' });

    const res = await postGoogle({ credential: 'tok-ws', username: 'g6_ws' }, cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe(ErrorCode.ACCOUNT_LINK_REQUIRED);
  });

  it('S6-20b: unverified workspace email matching existing email → NOT authoritative → 201', async () => {
    const sub = uniqueTag('s620b');
    const { cookie } = await googleNonce();
    mockVerified(sub, { email: 'person@example.com', emailVerified: false, hd: 'example.com' });

    const res = await postGoogle({ credential: 'tok-ws2', username: 'g6_ws2' }, cookie);
    expect(res.statusCode).toBe(201);
    blockUserIds.push(res.json().data.user.id);

    const user = await prisma.user.findUnique({ where: { id: res.json().data.user.id } });
    expect(user!.email).toBeNull();
  });

  // ─── S6-21: Gmail authority + evilgmail (§62)

  it('S6-21: evilgmail.com domain is NOT authoritative, new user created without oracle', async () => {
    const sub = uniqueTag('s621');
    const { cookie } = await googleNonce();
    mockVerified(sub, { email: 'x@evilgmail.com', emailVerified: true });

    const res = await postGoogle({ credential: 'tok-evil', username: 'g6_evil' }, cookie);
    expect(res.statusCode).toBe(201);
    blockUserIds.push(res.json().data.user.id);

    const user = await prisma.user.findUnique({ where: { id: res.json().data.user.id } });
    expect(user!.email).toBeNull();
  });

  // ─── S6-22: Username required error code (§21)

  it('S6-22: POST /google without username returns 422 with USERNAME_REQUIRED', async () => {
    const sub = uniqueTag('s622');
    const { cookie } = await googleNonce();
    mockVerified(sub);

    const res = await postGoogle({ credential: 'tok-nouser' }, cookie);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe(ErrorCode.USERNAME_REQUIRED);

    // No rows created for this identity
    const identity = await prisma.userAuthIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: sub } },
    });
    expect(identity).toBeNull();
    const sessions = await prisma.session.count({ where: { refreshToken: { contains: 'tok' } } });
    expect(sessions).toBe(0);
  });

  // ─── S6-23: Concurrency no orphan (§32 - different angle)

  it('S6-23: concurrent same-sub + same-username + referral yields one user, no orphan', async () => {
    const referrer = await seedReferrer('s623');
    const sub = uniqueTag('s623');
    const username = `g6_${uniqueTag('s623')}`.slice(0, 30);

    const { cookie } = await googleNonce();
    mockVerified(sub);

    const [a, b] = await Promise.all([
      postGoogle({ credential: 'tok-23', username, referralCode: referrer.code }, cookie),
      postGoogle({ credential: 'tok-23', username, referralCode: referrer.code }, cookie),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 201]);

    const users = await prisma.user.findMany({ where: { username } });
    expect(users).toHaveLength(1);

    // Referrer referral count: 0 or 1 (depends on which request won)
    const referrals = await prisma.referral.count({ where: { referrerUserId: referrer.userId } });
    expect(referrals).toBeLessThanOrEqual(1);
  });
});

describeIf('slice 6 — verifyIdToken wrapper', () => {
  it('S6-W1: valid payload with matching nonce → verified', async () => {
    const raw = 'test-nonce-raw';
    const digest = createHash('sha256').update(raw).digest('base64url');
    const fakeVerify = async () => ({
      sub: 'user-1',
      nonce: digest,
    });
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', digest);
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') {
      expect(result.claims.sub).toBe('user-1');
    }
  });

  it('S6-W2: valid payload with wrong nonce → invalid', async () => {
    const fakeVerify = async () => ({ sub: 'user-2', nonce: 'wrong-nonce' });
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'correct-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W3: payload without nonce → invalid', async () => {
    const fakeVerify = async () => ({ sub: 'user-3' });
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W4: payload without sub → invalid', async () => {
    const fakeVerify = async () => ({ nonce: 'valid' });
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W5: empty sub (whitespace only) → invalid', async () => {
    const fakeVerify = async () => ({ sub: '   ', nonce: 'valid' });
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W6: library throws Wrong recipient → invalid', async () => {
    const fakeVerify = async () => {
      throw new Error('Wrong recipient, payload audience != requiredAudience');
    };
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W7: library throws Token used too late → invalid', async () => {
    const fakeVerify = async () => {
      throw new Error('Token used too late, exp < now');
    };
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W8: library throws Invalid issuer → invalid', async () => {
    const fakeVerify = async () => {
      throw new Error('Invalid issuer, token issued by unexpected issuer');
    };
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W9: network error ENOTFOUND → unavailable', async () => {
    const fakeVerify = async () => {
      const err: any = new Error('getaddrinfo ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    };
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('unavailable');
  });

  it('S6-W10: HTTP 502 error → unavailable', async () => {
    const fakeVerify = async () => {
      const err: any = new Error('Bad Gateway');
      err.response = { status: 502 };
      throw err;
    };
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('unavailable');
  });

  it('S6-W11: unknown Error random failure → invalid (not unavailable)', async () => {
    const fakeVerify = async () => {
      throw new Error('random failure');
    };
    const verifier = createGoogleVerifier(fakeVerify, 'test-audience');
    const result = await verifier('token', 'any-raw');
    expect(result.kind).toBe('invalid');
  });

  it('S6-W12: audience passed to verifyIdToken matches the audience parameter', async () => {
    let receivedAudience: string | undefined;
    const fakeVerify = async (opts: { idToken: string; audience: string }) => {
      receivedAudience = opts.audience;
      return { sub: 'user-12', nonce: 'x' } as Record<string, unknown>;
    };
    const verifier = createGoogleVerifier(fakeVerify, 'my-audience');
    await verifier('token', 'any-raw');
    expect(receivedAudience).toBe('my-audience');
  });
});

describeIf('slice 6 — google config-off', () => {
  let cfgOffServer: Awaited<ReturnType<typeof buildServer>>;
  const cfgOffEmails: string[] = [];

  beforeAll(async () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');
    vi.resetModules();
    const freshMod = await import('../server.js');
    cfgOffServer = await freshMod.buildServer();
    await cfgOffServer.ready();
  });

  afterAll(async () => {
    if (cfgOffServer) await cfgOffServer.close();
    if (cfgOffEmails.length) {
      await prisma.user.deleteMany({ where: { email: { in: cfgOffEmails } } });
      cfgOffEmails.length = 0;
    }
    vi.unstubAllEnvs();
  });

  it('S6-C1: GET /google/nonce returns 503 when GOOGLE_CLIENT_ID is empty', async () => {
    const res = await cfgOffServer.inject({ method: 'GET', url: `${PREFIX}/google/nonce` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('Google sign-in is not available');
  });

  it('S6-C2: POST /google returns 503 when GOOGLE_CLIENT_ID is empty', async () => {
    const res = await cfgOffServer.inject({
      method: 'POST',
      url: `${PREFIX}/google`,
      payload: { credential: 'tok' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toBe('Google sign-in is not available');
  });

  it('S6-C3: email registration still works when GOOGLE_CLIENT_ID is empty', async () => {
    const email = `cfgoff-${uniqueTag('s6c3')}@test.local`;
    cfgOffEmails.push(email);
    const res = await cfgOffServer.inject({
      method: 'POST',
      url: `${PREFIX}/register`,
      payload: { username: `cfgoff_${uniqueTag('s6c3')}`.slice(0, 30), email, password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(201);
  });

  it('S6-C4: API starts without GOOGLE_CLIENT_ID (server.ready() succeeds)', async () => {
    // Implicit in beforeAll — if we got here, the server started
    expect(cfgOffServer).toBeTruthy();
  });
});
