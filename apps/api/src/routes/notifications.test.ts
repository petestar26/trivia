import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

const PREFIX = `${config.API_PREFIX}/notifications`;

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
  if (dbAvailable) await cleanFixtures();
  if (server) await server.close();
  await prisma.$disconnect();
});

const EMAIL_PREFIX = 'notif-';

function uniqueSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 12);
}

async function createUser(tag: string) {
  const suffix = uniqueSuffix();
  const email = `${EMAIL_PREFIX}${tag}-${suffix}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      username: `nt_${tag}_${suffix}`.slice(0, 30),
      passwordHash: 'fixture-only-not-a-real-hash',
      displayName: `NotifTest ${tag} ${suffix}`.slice(0, 100),
      status: 'ACTIVE',
      isVerified: true,
    },
  });
  if (user.email === null) throw new Error('Expected non-null email');
  return { ...user, email: user.email };
}

async function createNotification(
  userId: string,
  overrides: { type?: string; title?: string; body?: string; isRead?: boolean; createdAt?: Date } = {}
) {
  return prisma.notification.create({
    data: {
      userId,
      type: (overrides.type ?? 'SYSTEM') as never,
      title: overrides.title ?? 'Test notification',
      body: overrides.body ?? 'Test body',
      isRead: overrides.isRead ?? false,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

async function cleanFixtures() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function mintToken(user: { id: string; email: string; username: string }) {
  return server.jwt.sign({ sub: user.id, email: user.email, username: user.username, roles: ['USER'] });
}

interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  unreadCount: number;
}

async function listNotifications(token: string, query: Record<string, string | number | boolean> = {}) {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)])).toString();
  const resp = await server.inject({
    method: 'GET',
    url: `${PREFIX}${qs ? `?${qs}` : ''}`,
    headers: authHeader(token),
  });
  const body = JSON.parse(resp.body) as { success: boolean; data: NotificationRow[]; meta: ListMeta };
  return { resp, body };
}

describeIf('notifications/routes', () => {
  describe('authentication', () => {
    it('rejects an unauthenticated list request with 401', async () => {
      const resp = await server.inject({ method: 'GET', url: PREFIX });
      expect(resp.statusCode).toBe(401);
    });

    it('rejects an unauthenticated mark-read request with 401', async () => {
      const resp = await server.inject({ method: 'PATCH', url: `${PREFIX}/${randomUUID()}/read` });
      expect(resp.statusCode).toBe(401);
    });

    it('rejects an unauthenticated mark-all-read request with 401', async () => {
      const resp = await server.inject({ method: 'POST', url: `${PREFIX}/read-all` });
      expect(resp.statusCode).toBe(401);
    });
  });

  describe('GET / — list', () => {
    it('returns an empty list with unreadCount 0 for a user with no notifications', async () => {
      const user = await createUser('empty');
      const token = await mintToken(user);

      const { resp, body } = await listNotifications(token);

      expect(resp.statusCode).toBe(200);
      expect(body.data).toEqual([]);
      expect(body.meta).toEqual<ListMeta>({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
        unreadCount: 0,
      });
    });

    it('lists only the caller\'s own notifications, newest first, with an accurate unreadCount', async () => {
      const caller = await createUser('scope');
      const other = await createUser('scope-other');
      const token = await mintToken(caller);

      const older = await createNotification(caller.id, { title: 'Older', createdAt: new Date('2024-01-01T00:00:00.000Z') });
      const newer = await createNotification(caller.id, { title: 'Newer', createdAt: new Date('2024-01-02T00:00:00.000Z') });
      const readOne = await createNotification(caller.id, { title: 'Already read', isRead: true, createdAt: new Date('2024-01-03T00:00:00.000Z') });
      // Belongs to a different user entirely — must never appear here.
      await createNotification(other.id, { title: 'Not yours' });

      const { resp, body } = await listNotifications(token, { limit: 50 });

      expect(resp.statusCode).toBe(200);
      expect(body.data.map((n) => n.id)).toEqual([readOne.id, newer.id, older.id]);
      expect(body.data.every((n) => n.userId === caller.id)).toBe(true);
      expect(body.data.some((n) => n.title === 'Not yours')).toBe(false);
      expect(body.meta.total).toBe(3);
      expect(body.meta.unreadCount).toBe(2);
    });

    it('unreadCount reflects the caller\'s TOTAL unread notifications, not just the current page', async () => {
      const user = await createUser('unread-total');
      const token = await mintToken(user);
      for (let i = 0; i < 5; i++) {
        await createNotification(user.id, { title: `Unread ${i}` });
      }

      const { body } = await listNotifications(token, { limit: 2, page: 1 });

      expect(body.data).toHaveLength(2);
      expect(body.meta.total).toBe(5);
      expect(body.meta.unreadCount).toBe(5);
      expect(body.meta.totalPages).toBe(3);
      expect(body.meta.hasNextPage).toBe(true);
    });

    it('unreadOnly=true filters to unread notifications only', async () => {
      const user = await createUser('unread-only');
      const token = await mintToken(user);
      await createNotification(user.id, { title: 'Read one', isRead: true });
      const unread = await createNotification(user.id, { title: 'Unread one' });

      const { body } = await listNotifications(token, { unreadOnly: true });

      expect(body.data.map((n) => n.id)).toEqual([unread.id]);
      expect(body.meta.total).toBe(1);
      expect(body.meta.unreadCount).toBe(1);
    });

    it('paginates without duplicates or skips across a page boundary', async () => {
      const user = await createUser('paging');
      const token = await mintToken(user);
      const created = [];
      for (let i = 0; i < 3; i++) {
        created.push(await createNotification(user.id, { title: `Page ${i}` }));
      }

      const page1 = await listNotifications(token, { limit: 2, page: 1 });
      const page2 = await listNotifications(token, { limit: 2, page: 2 });

      expect(page1.body.data).toHaveLength(2);
      expect(page2.body.data).toHaveLength(1);
      const seenIds = [...page1.body.data, ...page2.body.data].map((n) => n.id).sort();
      expect(seenIds).toEqual(created.map((n) => n.id).sort());
    });
  });

  describe('PATCH /:id/read — mark one read', () => {
    it('marks an unread notification as read', async () => {
      const user = await createUser('mark-one');
      const token = await mintToken(user);
      const notification = await createNotification(user.id);

      const resp = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${notification.id}/read`,
        headers: authHeader(token),
      });
      const body = JSON.parse(resp.body);

      expect(resp.statusCode).toBe(200);
      expect(body.data.isRead).toBe(true);
      expect(body.data.readAt).not.toBeNull();

      const row = await prisma.notification.findUnique({ where: { id: notification.id } });
      expect(row?.isRead).toBe(true);
    });

    it('is idempotent — marking an already-read notification again succeeds without changing readAt', async () => {
      const user = await createUser('mark-idempotent');
      const token = await mintToken(user);
      const notification = await createNotification(user.id);

      const first = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${notification.id}/read`,
        headers: authHeader(token),
      });
      const firstReadAt = JSON.parse(first.body).data.readAt;

      const second = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${notification.id}/read`,
        headers: authHeader(token),
      });
      const secondBody = JSON.parse(second.body);

      expect(second.statusCode).toBe(200);
      expect(secondBody.data.isRead).toBe(true);
      expect(secondBody.data.readAt).toBe(firstReadAt);
    });

    it('returns 404 for a nonexistent notification', async () => {
      const user = await createUser('mark-missing');
      const token = await mintToken(user);

      const resp = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${randomUUID()}/read`,
        headers: authHeader(token),
      });

      expect(resp.statusCode).toBe(404);
    });

    it('returns 404 (not 403, not 200) for another user\'s notification, and never marks it read — no existence oracle, no IDOR', async () => {
      const owner = await createUser('idor-owner');
      const attacker = await createUser('idor-attacker');
      const notification = await createNotification(owner.id);
      const attackerToken = await mintToken(attacker);

      const resp = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${notification.id}/read`,
        headers: authHeader(attackerToken),
      });

      expect(resp.statusCode).toBe(404);
      const row = await prisma.notification.findUnique({ where: { id: notification.id } });
      expect(row?.isRead).toBe(false);
    });
  });

  describe('POST /read-all — mark all read', () => {
    it('marks every unread notification read and reports the count updated', async () => {
      const user = await createUser('mark-all');
      const token = await mintToken(user);
      await createNotification(user.id, { title: 'A' });
      await createNotification(user.id, { title: 'B' });
      await createNotification(user.id, { title: 'C', isRead: true });

      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/read-all`,
        headers: authHeader(token),
      });
      const body = JSON.parse(resp.body);

      expect(resp.statusCode).toBe(200);
      expect(body.data.updated).toBe(2);

      const { body: after } = await listNotifications(token);
      expect(after.meta.unreadCount).toBe(0);
    });

    it('does not touch another user\'s unread notifications', async () => {
      const caller = await createUser('mark-all-scope');
      const other = await createUser('mark-all-scope-other');
      await createNotification(caller.id);
      const otherNotification = await createNotification(other.id);
      const token = await mintToken(caller);

      const resp = await server.inject({ method: 'POST', url: `${PREFIX}/read-all`, headers: authHeader(token) });
      expect(resp.statusCode).toBe(200);

      const row = await prisma.notification.findUnique({ where: { id: otherNotification.id } });
      expect(row?.isRead).toBe(false);
    });

    it('is a safe no-op when there is nothing unread', async () => {
      const user = await createUser('mark-all-empty');
      const token = await mintToken(user);

      const resp = await server.inject({ method: 'POST', url: `${PREFIX}/read-all`, headers: authHeader(token) });
      const body = JSON.parse(resp.body);

      expect(resp.statusCode).toBe(200);
      expect(body.data.updated).toBe(0);
    });
  });

  // A notification inbox is per-user private data served over a
  // credentialed request. With no cache directive it is heuristically
  // cacheable, so a shared browser or proxy cache can serve one user's
  // inbox to the next person on the machine. The plugin-scope onSend hook
  // must therefore cover every reply, including the ones that never reach
  // a handler.
  describe('Cache-Control: no-store on every response', () => {
    it('sets no-store on a successful list', async () => {
      const user = await createUser('cc-ok');
      const resp = await server.inject({ method: 'GET', url: PREFIX, headers: authHeader(await mintToken(user)) });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('sets no-store on a 400 produced by schema validation (before the handler runs)', async () => {
      const user = await createUser('cc-400');
      const resp = await server.inject({
        method: 'GET',
        url: `${PREFIX}?page=0`,
        headers: authHeader(await mintToken(user)),
      });
      expect(resp.statusCode).toBe(400);
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('sets no-store on a 401 produced by the authenticate preHandler', async () => {
      const resp = await server.inject({ method: 'GET', url: PREFIX });
      expect(resp.statusCode).toBe(401);
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('sets no-store on a 404 from mark-one-read', async () => {
      const user = await createUser('cc-404');
      const resp = await server.inject({
        method: 'PATCH',
        url: `${PREFIX}/${randomUUID()}/read`,
        headers: authHeader(await mintToken(user)),
      });
      expect(resp.statusCode).toBe(404);
      expect(resp.headers['cache-control']).toBe('no-store');
    });

    it('sets no-store on mark-all-read', async () => {
      const user = await createUser('cc-readall');
      const resp = await server.inject({
        method: 'POST',
        url: `${PREFIX}/read-all`,
        headers: authHeader(await mintToken(user)),
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.headers['cache-control']).toBe('no-store');
    });
  });

  // `page` reaches Prisma as `skip: (page - 1) * limit`, and Prisma's skip
  // is a 32-bit Int. A page like 1e21 is still a valid JSON integer, so it
  // satisfies `type: 'integer'` and used to overflow into a 500.
  describe('pagination bounds', () => {
    it('accepts the valid boundaries', async () => {
      const user = await createUser('page-bounds');
      const token = await mintToken(user);
      for (const qs of ['page=1&limit=1', 'page=1&limit=100', 'page=1000000&limit=100']) {
        const resp = await server.inject({ method: 'GET', url: `${PREFIX}?${qs}`, headers: authHeader(token) });
        expect(resp.statusCode, `expected 200 for ?${qs}`).toBe(200);
      }
    });

    it('rejects overflowing page values with 400, never 500', async () => {
      const user = await createUser('page-overflow');
      const token = await mintToken(user);
      const overflowing = [
        'page=999999999999999999999',
        'page=1000001',
        'page=99999999999',
        'page=9007199254740993',
        'limit=101',
        'page=0',
        'page=-1',
      ];
      for (const qs of overflowing) {
        const resp = await server.inject({ method: 'GET', url: `${PREFIX}?${qs}`, headers: authHeader(token) });
        expect(resp.statusCode, `expected 400 for ?${qs}`).toBe(400);
        expect(resp.headers['cache-control']).toBe('no-store');
      }
    });
  });
});
