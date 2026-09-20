import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { redactUrl, redactedRequestSerializer } from './log-redaction.js';
import { requestLogger } from './request-logger.js';

// GET /groups/invites/:token carries a bearer-equivalent secret in the
// path. Logs are shipped, indexed and retained far longer than an invite
// lives, so neither Fastify's automatic request lines nor this codebase's
// own requestLogger may emit the raw token.

describe('redactUrl', () => {
  it('redacts the token segment of an invite-resolution URL', () => {
    expect(redactUrl('/groups/invites/super-secret-token')).toBe('/groups/invites/[REDACTED]');
  });

  it('redacts under an API prefix', () => {
    expect(redactUrl('/api/v1/groups/invites/tok_abc123')).toBe('/api/v1/groups/invites/[REDACTED]');
  });

  it('preserves the query string while redacting the token', () => {
    expect(redactUrl('/api/v1/groups/invites/tok_abc?from=email&x=1')).toBe(
      '/api/v1/groups/invites/[REDACTED]?from=email&x=1'
    );
  });

  it('leaves unrelated group URLs untouched', () => {
    const untouched = [
      '/api/v1/groups',
      '/api/v1/groups/2f1b0c64-0000-4000-8000-000000000000/invites',
      '/api/v1/groups/2f1b0c64-0000-4000-8000-000000000000/members',
      '/api/v1/notifications?page=2',
    ];
    for (const url of untouched) expect(redactUrl(url)).toBe(url);
  });

  it('is case-insensitive on the path and handles empty input', () => {
    expect(redactUrl('/GROUPS/INVITES/SeCrEt')).toBe('/GROUPS/INVITES/[REDACTED]');
    expect(redactUrl('')).toBe('');
  });

  it('serializes a request with the URL redacted but route context intact', () => {
    const out = redactedRequestSerializer({
      method: 'GET',
      url: '/api/v1/groups/invites/leak-me?x=1',
      headers: { host: 'api.test' },
      ip: '127.0.0.1',
      socket: { remotePort: 4321 },
    });
    expect(out.url).toBe('/api/v1/groups/invites/[REDACTED]?x=1');
    expect(out.method).toBe('GET');
    expect(out.host).toBe('api.test');
    expect(out.remoteAddress).toBe('127.0.0.1');
  });
});

/** Collects every log line the server emits so tests can assert on them. */
function captureSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream, text: () => lines.join('\n') };
}

describe('captured logs never contain an invite token', () => {
  // A standalone Fastify instance wired exactly like server.ts (redacting
  // serializer + requestLogger hook), so both log paths are exercised
  // against a real request without depending on a database.
  async function buildLoggingServer() {
    const sink = captureSink();
    const app = Fastify({
      logger: {
        level: 'info',
        serializers: { req: redactedRequestSerializer },
        stream: sink.stream,
      },
    });
    app.addHook('onRequest', requestLogger);
    app.get('/api/v1/groups/invites/:token', async () => ({ success: true }));
    app.get('/api/v1/groups/invites/:token/boom', async () => {
      throw new Error('forced failure');
    });
    app.setNotFoundHandler(async (_req, reply) => reply.status(404).send({ success: false }));
    await app.ready();
    return { app, sink };
  }

  const TOKEN = 'tok_do_not_log_me_0123456789';

  it('redacts the token on a successful request, in both log paths', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `/api/v1/groups/invites/${TOKEN}` });
    expect(resp.statusCode).toBe(200);
    await app.close();

    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[REDACTED]');
    // Fastify's own request line and both custom lines are present, and
    // still carry the information that makes logs useful.
    expect(logged).toContain('Incoming request');
    expect(logged).toContain('Request completed');
    expect(logged).toContain('"method":"GET"');
    expect(logged).toContain('"statusCode":200');
  });

  it('redacts the token on an error response too', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `/api/v1/groups/invites/${TOKEN}/boom` });
    expect(resp.statusCode).toBe(500);
    await app.close();

    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[REDACTED]');
    expect(logged).toContain('"statusCode":500');
  });

  it('redacts the token on a 404 for an unknown token', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `/api/v1/groups/invites/${TOKEN}/nope/deeper` });
    await app.close();

    expect(resp.statusCode).toBe(404);
    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
  });
});

// End-to-end against the real server + real route, so the assertion covers
// the actual wiring in server.ts rather than a reconstruction of it.
let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

describeIf('real server: GET /groups/invites/:token', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  const EMAIL_PREFIX = 'logred-';

  beforeAll(async () => {
    server = await buildServer();
    await server.ready();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      const groups = await prisma.group.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
      const groupIds = groups.map((g) => g.id);
      if (groupIds.length) {
        await prisma.groupInvite.deleteMany({ where: { groupId: { in: groupIds } } });
        await prisma.groupMember.deleteMany({ where: { groupId: { in: groupIds } } });
        await prisma.group.deleteMany({ where: { id: { in: groupIds } } });
      }
      await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await server.close();
    await prisma.$disconnect();
  });

  it('never emits the token through the real route, for a valid or an invalid token', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const owner = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}own-${suffix}@test.local`,
        username: `lr_own_${suffix}`.slice(0, 30),
        passwordHash: 'fixture-only-not-a-real-hash',
        status: 'ACTIVE',
        isVerified: true,
      },
    });
    const group = await prisma.group.create({
      data: { ownerId: owner.id, name: `LogRed-${suffix}`, isPrivate: true, status: 'ACTIVE' },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
    });
    const realToken = `logredtok-${randomUUID().replaceAll('-', '')}`;
    await prisma.groupInvite.create({
      data: {
        groupId: group.id,
        email: `${EMAIL_PREFIX}invitee-${suffix}@test.local`,
        role: 'MEMBER',
        status: 'PENDING',
        token: realToken,
        expiresAt: new Date(Date.now() + 86_400_000),
        invitedBy: owner.id,
      },
    });
    const token = server.jwt.sign({
      sub: owner.id,
      email: owner.email!,
      username: owner.username,
      roles: ['USER'],
    });

    // Capture what the server's own logger writes for these two requests.
    const seen: string[] = [];
    const original = server.log.info.bind(server.log);
    const record = (obj: unknown, msg?: string) => {
      seen.push(JSON.stringify({ obj, msg }));
      return original(obj as never, msg as never);
    };
    (server.log as unknown as { info: typeof record }).info = record;

    const ok = await server.inject({
      method: 'GET',
      url: `${config.API_PREFIX}/groups/invites/${realToken}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const bad = await server.inject({
      method: 'GET',
      url: `${config.API_PREFIX}/groups/invites/definitely-not-a-real-token`,
      headers: { authorization: `Bearer ${token}` },
    });

    (server.log as unknown as { info: typeof original }).info = original;

    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(404);

    const logged = seen.join('\n');
    expect(logged).not.toContain(realToken);
    expect(logged).not.toContain('definitely-not-a-real-token');
    // The response body legitimately carries the invite summary, but it
    // must not echo the token either.
    expect(ok.body).not.toContain(realToken);
  });
});
