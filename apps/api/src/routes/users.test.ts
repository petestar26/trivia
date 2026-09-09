import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server';

const PREFIX = `${config.API_PREFIX}/users`;

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const describeIf = dbAvailable ? describe : describe.skip;

let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  if (!dbAvailable) return;
  server = await buildServer();
  await server.ready();
});

afterAll(async () => {
  if (dbAvailable) await cleanUserSearchFixtures();
  if (server) await server.close();
  await prisma.$disconnect();
});

// ─── Fixtures ──────────────────────────────────────────────────

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string, overrides: { status?: string; email?: string } = {}) {
  const suffix = uniqueSuffix();
  const email = overrides.email ?? `usearch-${tag}-${suffix}@test.local`;
  const existing = await prisma.user.findUnique({ where: { email } });
  const user =
    existing ??
    (await prisma.user.create({
      data: {
        email,
        username: `usrch_${tag}_${suffix}`.slice(0, 30),
        passwordHash: 'fixture-only-not-a-real-hash',
        displayName: `UserSearch Test ${tag} ${suffix}`.slice(0, 100),
        status: (overrides.status as any) ?? 'ACTIVE',
      },
    }));

  // Prisma truthfully returns email: string | null. This fixture always
  // stores a known non-null email, so narrow it once at the fixture boundary.
  if (user.email === null) {
    throw new Error('Test fixture expected non-null email');
  }

  return {
    ...user,
    email: user.email,
  };
}

async function cleanUserSearchFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: 'usearch-' } } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.gameChallenge.deleteMany({
      where: { OR: [{ challengerId: { in: userIds } }, { challengedId: { in: userIds } }] },
    });
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.walletTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string; role?: string }) {
  return server.jwt.sign({
    sub: user.id,
    email: user.email,
    username: user.username,
    roles: [user.role ?? 'USER'],
  });
}

// ─── Tests ─────────────────────────────────────────────────────

describeIf('users/routes', () => {
  describe('AUTH', () => {
    it('rejects unauthenticated request with 401', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        payload: { q: 'alice' },
      });
      expect(resp.statusCode).toBe(401);
    });

    it('ACTIVE caller can access the route', async () => {
      const caller = await createUser('auth_active');
      const token = await mintToken(caller);
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(token),
        payload: { q: 'nonexistent_xyz_abc' },
      });
      expect(resp.statusCode).toBe(200);
      expect(JSON.parse(resp.body).success).toBe(true);
    });

    for (const status of ['INACTIVE', 'SUSPENDED', 'BANNED', 'PENDING_VERIFICATION']) {
      it(`${status} caller gets 403 "Account is not active"`, async () => {
        const caller = await createUser(`auth_${status.toLowerCase()}`, { status });
        const token = await mintToken(caller);
        const resp = await server.inject({
          method: 'POST',
          url: `${PREFIX}/search`,
          headers: authHeader(token),
          payload: { q: 'anything' },
        });
        expect(resp.statusCode).toBe(403);
        expect(JSON.parse(resp.body).error.message).toBe('Account is not active');
      });
    }

    it('deleted JWT subject gets 403', async () => {
      const caller = await createUser('auth_deleted');
      const token = await mintToken(caller);
      await prisma.user.delete({ where: { id: caller.id } });
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(token),
        payload: { q: 'anything' },
      });
      expect(resp.statusCode).toBe(403);
    });
  });

  describe('VALIDATION', () => {
    let callerToken: string;

    beforeEach(async () => {
      await cleanUserSearchFixtures();
      const caller = await createUser('val_caller');
      callerToken = await mintToken(caller);
    });

    it('missing q returns 400 "Search query is required"', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: {},
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('Search query is required');
    });

    it('non-string q returns 400 "Invalid search request"', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 123 },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('Invalid search request');
    });

    it('empty string returns 400 "Search query is required"', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: '' },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('Search query is required');
    });

    it('whitespace-only q returns 400 "Search query is required"', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: '   \t\n  ' },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('Search query is required');
    });

    it('>255 raw chars returns 400', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'a'.repeat(256) },
      });
      expect(resp.statusCode).toBe(400);
    });

    it('extra fields returns 400 "Invalid search request"', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'alice', extra: 'field' },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe('Invalid search request');
    });

    it('valid whitespace trimming proceeds with search', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: '  alice  ' },
      });
      expect(resp.statusCode).toBe(200);
    });

    it('username <3 chars returns 400', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'ab' },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe(
        'Username search must be 3-30 letters, numbers, or underscores'
      );
    });

    it('username >30 chars returns 400', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'a'.repeat(31) },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe(
        'Username search must be 3-30 letters, numbers, or underscores'
      );
    });

    it('invalid username chars returns 400', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'user name!' },
      });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error.message).toBe(
        'Username search must be 3-30 letters, numbers, or underscores'
      );
    });

    it('malformed email returns 400', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'not-an-email' },
      });
      expect(resp.statusCode).toBe(400);
    });
  });

  describe('USERNAME', () => {
    let caller: { id: string; email: string; username: string };
    let callerToken: string;

    beforeEach(async () => {
      await cleanUserSearchFixtures();
      caller = await createUser('uname_caller');
      callerToken = await mintToken(caller);
    });

    it('exact username match works', async () => {
      const target = await createUser('uname_exact');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: target.username },
      });
      expect(resp.statusCode).toBe(200);
      const body = JSON.parse(resp.body);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(target.id);
    });

    it('prefix match works', async () => {
      const prefix = `pfx_${uniqueSuffix()}`;
      const a = await createUser(`uname_pfx_a`);
      await prisma.user.update({ where: { id: a.id }, data: { username: `${prefix}_a` } });
      const b = await createUser(`uname_pfx_b`);
      await prisma.user.update({ where: { id: b.id }, data: { username: `${prefix}_b` } });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: prefix },
      });
      expect(resp.statusCode).toBe(200);
      const data = JSON.parse(resp.body).data;
      expect(data.length).toBeGreaterThanOrEqual(2);
    });

    it('exact match is ranked first', async () => {
      const prefix = `rk_${uniqueSuffix()}`;
      const exact = await createUser('uname_rk_exact');
      await prisma.user.update({ where: { id: exact.id }, data: { username: prefix } });
      const pfx1 = await createUser('uname_rk_pfx1');
      await prisma.user.update({ where: { id: pfx1.id }, data: { username: `${prefix}_x` } });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: prefix },
      });
      const data = JSON.parse(resp.body).data;
      expect(data[0].id).toBe(exact.id);
    });

    it('prefix matches sorted by username asc, id asc', async () => {
      const prefix = `srt_${uniqueSuffix()}`;
      const users: { id: string; username: string }[] = [];
      for (let i = 0; i < 3; i++) {
        const u = await createUser(`uname_srt_${i}`);
        await prisma.user.update({ where: { id: u.id }, data: { username: `${prefix}_${i}` } });
        users.push({ ...u, username: `${prefix}_${i}` });
      }
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: prefix },
      });
      const data = JSON.parse(resp.body).data;
      const prefixed = data.filter((d: any) => d.username.startsWith(prefix));
      for (let i = 1; i < prefixed.length; i++) {
        expect(prefixed[i].username >= prefixed[i - 1].username).toBe(true);
      }
    });

    it('caller is excluded from results', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: caller.username },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.find((d: any) => d.id === caller.id)).toBeUndefined();
    });

    it('non-ACTIVE targets are excluded', async () => {
      const inactive = await createUser('uname_inactive', { status: 'INACTIVE' });
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: inactive.username },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.find((d: any) => d.id === inactive.id)).toBeUndefined();
    });

    it('returns at most 10 results', async () => {
      const prefix = `max_${uniqueSuffix()}`;
      for (let i = 0; i < 12; i++) {
        const u = await createUser(`uname_max_${i}`);
        await prisma.user.update({ where: { id: u.id }, data: { username: `${prefix}_${String(i).padStart(2, '0')}` } });
      }
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: prefix },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.length).toBeLessThanOrEqual(10);
    });

    it('exact match consumes one slot leaving nine prefix slots', async () => {
      const prefix = `slot_${uniqueSuffix()}`;
      const exact = await createUser('uname_slot_exact');
      await prisma.user.update({ where: { id: exact.id }, data: { username: prefix } });
      for (let i = 0; i < 10; i++) {
        const u = await createUser(`uname_slot_${i}`);
        await prisma.user.update({ where: { id: u.id }, data: { username: `${prefix}_p${i}` } });
      }
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: prefix },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.length).toBeLessThanOrEqual(10);
      expect(data[0].id).toBe(exact.id);
    });

    it('underscore is literal in LIKE matching', async () => {
      const prefix = `uscr_${uniqueSuffix()}`;
      const literal = await createUser('uname_uliteral');
      await prisma.user.update({ where: { id: literal.id }, data: { username: `${prefix}_real` } });
      const wildcard = await createUser('uname_uwildcard');
      await prisma.user.update({ where: { id: wildcard.id }, data: { username: `${prefix}Xuser` } });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: `${prefix}_` },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.find((d: any) => d.id === literal.id)).toBeDefined();
      expect(data.find((d: any) => d.id === wildcard.id)).toBeUndefined();
    });

    it('username search is case-sensitive', async () => {
      const suffix = uniqueSuffix();
      const target = await createUser('uname_case');
      await prisma.user.update({ where: { id: target.id }, data: { username: `CamelCase${suffix}` } });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: `camelcase${suffix}` },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.find((d: any) => d.id === target.id)).toBeUndefined();
    });
  });

  describe('EMAIL', () => {
    let caller: { id: string; email: string; username: string };
    let callerToken: string;

    beforeEach(async () => {
      await cleanUserSearchFixtures();
      caller = await createUser('email_caller');
      callerToken = await mintToken(caller);
    });

    it('exact stored-case email works', async () => {
      const target = await createUser('email_exact');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: target.email },
      });
      expect(resp.statusCode).toBe(200);
      const data = JSON.parse(resp.body).data;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(target.id);
    });

    it('differently-cased email misses', async () => {
      const target = await createUser('email_case');
      const upperEmail = target.email.toUpperCase();
      if (upperEmail === target.email) return; // skip if already uppercase
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: upperEmail },
      });
      const data = JSON.parse(resp.body).data;
      expect(data).toHaveLength(0);
    });

    it('self is excluded from email results', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: caller.email },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.find((d: any) => d.id === caller.id)).toBeUndefined();
    });

    it('nonexistent email returns empty array', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: `doesnotexist_${uniqueSuffix()}@test.local` },
      });
      expect(JSON.parse(resp.body).data).toEqual([]);
    });

    it('non-ACTIVE exact email target returns empty', async () => {
      const target = await createUser('email_inactive', { status: 'INACTIVE' });
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: target.email },
      });
      const data = JSON.parse(resp.body).data;
      expect(data).toEqual([]);
    });

    it('email is absent from response', async () => {
      const target = await createUser('email_privacy');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: target.email },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.length).toBe(1);
      expect(data[0].email).toBeUndefined();
    });
  });

  describe('PRIVACY', () => {
    let callerToken: string;

    beforeEach(async () => {
      await cleanUserSearchFixtures();
      const caller = await createUser('priv_caller');
      callerToken = await mintToken(caller);
    });

    it('every result contains exactly id, username, displayName, avatarUrl', async () => {
      const target = await createUser('priv_target');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: target.username },
      });
      const data = JSON.parse(resp.body).data;
      expect(data.length).toBe(1);
      const keys = Object.keys(data[0]);
      expect(keys.sort()).toEqual(['avatarUrl', 'displayName', 'id', 'username']);
    });

    it('no email, status, role, phone, timestamp, q echo, or match metadata in response', async () => {
      const target = await createUser('priv_nosecrets');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: target.username },
      });
      const body = JSON.parse(resp.body);
      const data = body.data[0];
      expect(data.email).toBeUndefined();
      expect(data.status).toBeUndefined();
      expect(data.role).toBeUndefined();
      expect(data.phone).toBeUndefined();
      expect(data.createdAt).toBeUndefined();
      expect(data.updatedAt).toBeUndefined();
      expect(body.meta).toBeUndefined();
      expect(body.q).toBeUndefined();
    });

    it('Cache-Control: no-store on 200 success', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: { q: 'any_valid_query_xyz' },
      });
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('Cache-Control: no-store on 400 validation failure', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(callerToken),
        payload: {},
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('Cache-Control: no-store on 401 unauthenticated', async () => {
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        payload: { q: 'alice' },
      });
      expect(resp.statusCode).toBe(401);
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('Cache-Control: no-store on 429 rate limit', async () => {
      const caller = await createUser('priv_ratelimit');
      const token = await mintToken(caller);
      // Exhaust the rate limit bucket
      for (let i = 0; i < 12; i++) {
        const r = await server.inject({
          method: 'POST',
          url: `${PREFIX}/search`,
          headers: authHeader(token),
          payload: { q: `ratelim_${i}_${uniqueSuffix()}` },
          remoteAddress: `10.0.0.${i + 1}`,
        });
        if (r.statusCode === 429) {
          expect(r.headers['cache-control']).toBe('no-store');
          return;
        }
      }
      // If we get here, the rate limit test failed to trigger — fail explicitly
      expect(true).toBe(false);
    });

    it('forced unexpected failure gives sanitized 500 without q in response', async () => {
      // Force a genuine unexpected failure in the route's first DB call.
      // The prisma user delegate method is monkeypatched to reject and
      // restored afterwards (vi.spyOn cannot safely restore Prisma
      // delegates, so restore manually).
      const delegate = prisma.user as unknown as {
        findUnique: typeof prisma.user.findUnique;
      };
      const orig = delegate.findUnique;
      delegate.findUnique = (() =>
        Promise.reject(new Error('forced-internal-failure'))) as unknown as typeof prisma.user.findUnique;
      try {
        const resp = await server.inject({
          method: 'POST',
          url: `${PREFIX}/search`,
          headers: authHeader(callerToken),
          payload: { q: 'sentinel_q_do_not_echo' },
        });
        expect(resp.statusCode).toBe(500);
        const body = JSON.parse(resp.body);
        expect(body.success).toBe(false);
        expect(body.error.code).toBe('INTERNAL_ERROR');
        // The query string must never echo back in an error response.
        expect(JSON.stringify(body)).not.toContain('sentinel_q_do_not_echo');
      } finally {
        delegate.findUnique = orig;
      }
    });
  });

  describe('RATE LIMIT', () => {
    it('10 requests from same caller succeed, 11th returns 429', async () => {
      const caller = await createUser('rl_caller');
      const token = await mintToken(caller);

      // 10 successful requests
      for (let i = 0; i < 10; i++) {
        const resp = await server.inject({
          method: 'POST',
          url: `${PREFIX}/search`,
          headers: authHeader(token),
          payload: { q: `rltest_${uniqueSuffix()}` },
          remoteAddress: `10.0.0.${(i % 250) + 1}`,
        });
        expect(resp.statusCode).toBe(200);
      }

      // 11th request from the same caller should be rate-limited
      const eleventh = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(token),
        payload: { q: `rltest_eleventh_${uniqueSuffix()}` },
        remoteAddress: '10.0.0.99',
      });
      expect(eleventh.statusCode).toBe(429);
      expect(eleventh.headers['x-ratelimit-limit']).toBe('10');
    });

    it('second caller gets independent bucket', async () => {
      const callerA = await createUser('rl_callerA');
      const tokenA = await mintToken(callerA);

      // Exhaust bucket A
      for (let i = 0; i < 11; i++) {
        await server.inject({
          method: 'POST',
          url: `${PREFIX}/search`,
          headers: authHeader(tokenA),
          payload: { q: `rlA_${i}_${uniqueSuffix()}` },
        });
      }

      // Bucket B should be fresh
      const callerB = await createUser('rl_callerB');
      const tokenB = await mintToken(callerB);
      const respB = await server.inject({
        method: 'POST',
        url: `${PREFIX}/search`,
        headers: authHeader(tokenB),
        payload: { q: `rlB_${uniqueSuffix()}` },
      });
      expect(respB.statusCode).toBe(200);
    });
  });
});
