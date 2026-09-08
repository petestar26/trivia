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
});