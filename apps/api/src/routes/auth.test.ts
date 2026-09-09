import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';
import * as authUtils from '../utils/auth';

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