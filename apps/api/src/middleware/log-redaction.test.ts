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

  it('redacts tokens in paths with repeated separators', () => {
    expect(redactUrl('//groups//invites//TOKEN')).toBe('//groups//invites//[REDACTED]');
    expect(redactUrl('///groups///invites///TOKEN')).toBe('///groups///invites///[REDACTED]');
  });

  it('redacts tokens in paths with doubled prefix', () => {
    expect(redactUrl('/api/v1/groups/invites/abc123')).toBe('/api/v1/groups/invites/[REDACTED]');
    expect(redactUrl('/api/v1/groups//invites/abc123')).toBe('/api/v1/groups//invites/[REDACTED]');
  });

  it('redacts tokens with percent-encoded separators', () => {
    expect(redactUrl('/api/v1/groups%2Finvites%2FTOKEN')).toBe('/api/v1/groups%2Finvites%2F[REDACTED]');
    expect(redactUrl('/api/v1/groups/invites/TOKEN%3Ffoo')).toBe('/api/v1/groups/invites/[REDACTED]');
  });

  describe('encoded, malformed and unusual spellings of the token route', () => {
    const T = 'SYNTHETICLEAKTOKEN0123456789';

    // input -> exact expected output. The RAW prefix (however the client
    // spelled it) and everything after the token region is preserved.
    const cases: Array<[string, string, string]> = [
      ['encoded g in "groups"', `/api/v1/%67roups/invites/${T}`, '/api/v1/%67roups/invites/[REDACTED]'],
      ['encoded uppercase G (%47)', `/api/v1/%47roups/invites/${T}`, '/api/v1/%47roups/invites/[REDACTED]'],
      ['encoded i in "invites"', `/api/v1/groups/%69nvites/${T}`, '/api/v1/groups/%69nvites/[REDACTED]'],
      ['partially encoded "invites"', `/api/v1/groups/in%76ites/${T}`, '/api/v1/groups/in%76ites/[REDACTED]'],
      ['both words encoded', `/api/v1/%67roups/%69nvites/${T}`, '/api/v1/%67roups/%69nvites/[REDACTED]'],
      ['lowercase hex escapes', `/api/v1/%67roups/%69nvites/${T}`.toLowerCase().replace(T.toLowerCase(), T), '/api/v1/%67roups/%69nvites/[REDACTED]'],
      ['double-encoded (%2567)', `/api/v1/%2567roups/invites/${T}`, '/api/v1/%2567roups/invites/[REDACTED]'],
      ['triple-encoded (%252567)', `/api/v1/%252567roups/invites/${T}`, '/api/v1/%252567roups/invites/[REDACTED]'],
      ['encoded separators, upper', `/api/v1/groups%2Finvites%2F${T}`, '/api/v1/groups%2Finvites%2F[REDACTED]'],
      ['encoded separators, lower', `/api/v1/groups%2finvites%2f${T}`, '/api/v1/groups%2finvites%2f[REDACTED]'],
      ['encoded letters AND separators', `/api/v1/%67roups%2F%69nvites%2F${T}`, '/api/v1/%67roups%2F%69nvites%2F[REDACTED]'],
      ['repeated separators', `/api/v1//groups///invites//${T}`, '/api/v1//groups///invites//[REDACTED]'],
      ['backslash separators', `/api/v1/groups\\invites\\${T}`, '/api/v1/groups\\invites\\[REDACTED]'],
      ['a "." segment in the way', `/api/v1/groups/./invites/${T}`, '/api/v1/groups/./invites/[REDACTED]'],
      ['an encoded "." segment', `/api/v1/groups/%2e/invites/${T}`, '/api/v1/groups/%2e/invites/[REDACTED]'],
      ['upper-case route words', `/API/V1/GROUPS/INVITES/${T}`, '/API/V1/GROUPS/INVITES/[REDACTED]'],
      ['trailing segments survive', `/api/v1/groups/invites/${T}/extra/more`, '/api/v1/groups/invites/[REDACTED]/extra/more'],
      ['query string survives', `/api/v1/groups/invites/${T}?a=1&b=2`, '/api/v1/groups/invites/[REDACTED]?a=1&b=2'],
      ['fragment survives', `/api/v1/groups/invites/${T}#frag`, '/api/v1/groups/invites/[REDACTED]#frag'],
      ['encoded letters + query', `/api/v1/%67roups/invites/${T}?a=1`, '/api/v1/%67roups/invites/[REDACTED]?a=1'],
      ['malformed escape after the token', `/api/v1/groups/invites/${T}%ZZ`, '/api/v1/groups/invites/[REDACTED]'],
      ['truncated escape after the token', `/api/v1/groups/invites/${T}%`, '/api/v1/groups/invites/[REDACTED]'],
      ['half an escape after the token', `/api/v1/groups/invites/${T}%2`, '/api/v1/groups/invites/[REDACTED]'],
      ['non-ASCII escape after the token', `/api/v1/groups/invites/${T}%C3%A9`, '/api/v1/groups/invites/[REDACTED]'],
      ['encoded "?" inside the token stays in the token', `/api/v1/groups/invites/${T}%3Fx=1`, '/api/v1/groups/invites/[REDACTED]'],
      ['an encoded slash INSIDE the token redacts it whole', '/api/v1/groups/invites/HEADPART%2FTAILPART', '/api/v1/groups/invites/[REDACTED]'],
    ];

    it.each(cases)('%s', (_name, input, expected) => {
      const out = redactUrl(input);
      expect(out).toBe(expected);
      expect(out).not.toContain(T);
    });

    it('never throws on malformed input, and never leaks when the route is recognizable', () => {
      const hostile = [
        '%', '%%', '%%%', '%2', '%ZZ', '%00', '%FF', '%C0%AF', '%E0%A4%A', '\\', '///', '?', '#', '?#',
        `/groups/invites/${T}%`, `/groups/invites/${T}%E0%A4%A`, `/%67roups/invites/${T}%ZZ%`,
        '/'.repeat(5000) + 'groups/invites/' + T,
        '%67roups/'.repeat(500) + 'invites/' + T,
      ];
      for (const url of hostile) {
        let out = '';
        expect(() => { out = redactUrl(url); }).not.toThrow();
        if (url.includes(T)) expect(out, url.slice(0, 40)).not.toContain(T);
      }
    });

    it('leaves URLs that carry no token route BYTE-FOR-BYTE unchanged', () => {
      const untouched = [
        '/', '/health', '/api/v1/groups', '/api/v1/groups?query=invites',
        '/api/v1/groups/2f1b0c64-0000-4000-8000-000000000000/invites',
        '/api/v1/groups/2f1b0c64-0000-4000-8000-000000000000/invites/2f1b0c64-0000-4000-8000-000000000001',
        '/api/v1/groups/invites', '/api/v1/groups/invites/', '/api/v1/groups//invites//',
        '/api/v1/notifications?page=2&limit=20', '/api/v1/%67roups', '/api/v1/groups/%69nvites',
        '/api/v1/groups/accept-invite',
      ];
      for (const url of untouched) expect(redactUrl(url), url).toBe(url);
    });
  });

  it('does not change HTTP status or behavior', () => {
    const input = '/api/v1/groups/invites/abc123';
    expect(redactUrl(input)).toBe('/api/v1/groups/invites/[REDACTED]');
    // The replacement is purely textual; the method/status/headers are untouched.
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

  it('redacts the token in malformed paths with repeated separators', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `//groups//invites//${TOKEN}` });
    expect(resp.statusCode).toBe(404);
    await app.close();

    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[REDACTED]');
    expect(logged).toContain('Incoming request');
    expect(logged).toContain('Request completed');
  });

  it('redacts the token in malformed paths with percent-encoded separators', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `/api/v1/groups%2Finvites%2F${TOKEN}` });
    expect(resp.statusCode).toBe(404);
    await app.close();

    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[REDACTED]');
    expect(logged).toContain('Request completed');
  });

  it('redacts the token in malformed paths with lowercase %2f separators', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `/api/v1/groups%2finvites%2f${TOKEN}` });
    expect(resp.statusCode).toBe(404);
    await app.close();

    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[REDACTED]');
    expect(logged).toContain('Request completed');
  });

  it('redacts the token in a doubled-prefix path', async () => {
    const { app, sink } = await buildLoggingServer();
    const resp = await app.inject({ method: 'GET', url: `/api/v1/groups//invites/${TOKEN}` });
    expect(resp.statusCode).toBe(404);
    await app.close();

    const logged = sink.text();
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('[REDACTED]');
  });

  it('leaves unrelated routes unchanged in log output', async () => {
    const sink = captureSink();
    const app = Fastify({
      logger: {
        level: 'info',
        serializers: { req: redactedRequestSerializer },
        stream: sink.stream,
      },
    });
    app.addHook('onRequest', requestLogger);
    app.get('/api/v1/notifications', async () => ({ success: true }));
    await app.ready();

    const resp = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(resp.statusCode).toBe(200);
    await app.close();

    const logged = sink.text();
    expect(logged).toContain('Incoming request');
    expect(logged).toContain('Request completed');
    expect(logged).not.toContain('[REDACTED]');
    expect(logged).not.toContain(TOKEN);
  });
});

// ─── The REAL server ────────────────────────────────────────────────────────
//
// Everything above tests pieces in isolation. These build the actual
// `buildServer()` — real serializer, real requestLogger hook, real not-found
// handlers, real routes — with its logger pointed at a capture stream at
// `trace`, so EVERY line and EVERY serialized field it writes is inspected.
//
// The seam is `buildServer({ logStream, logLevel })`; production calls it with
// no arguments.

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

/** Every string anywhere in a parsed log record — keys and values, nested. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      allStrings(v, out);
    }
  }
  return out;
}

describeIf('real buildServer: no log field ever carries an invite token', () => {
  const EMAIL_PREFIX = 'logred-';
  let server: Awaited<ReturnType<typeof buildServer>>;
  const sink = captureSink();
  let ip = 0;
  const nextIp = () => `10.30.${(ip >> 8) & 255}.${(ip++ & 255) || 1}`;

  // A REAL invite, so a matched, authenticated request actually resolves it.
  let owner: { id: string; email: string; username: string };
  let realToken: string;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    server = await buildServer({ logStream: sink.stream, logLevel: 'trace' });
    await server.ready();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const created = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}own-${suffix}@test.local`,
        username: `lr_${suffix}`.slice(0, 30),
        passwordHash: 'fixture-only-not-a-real-hash',
        status: 'ACTIVE',
        isVerified: true,
      },
    });
    owner = { id: created.id, email: created.email!, username: created.username };
    const group = await prisma.group.create({
      data: { ownerId: owner.id, name: `LogRed-${suffix}`, isPrivate: true, status: 'ACTIVE' },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
    });
    realToken = `REALINVITETOKEN${randomUUID().replaceAll('-', '')}`;
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
    authHeader = {
      authorization: `Bearer ${server.jwt.sign({ sub: owner.id, email: owner.email, username: owner.username, roles: ['USER'] })}`,
    };
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

  /** Fire a request and return every serialized record the server wrote so far. */
  const records = () =>
    sink.lines
      .join('')
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  const PREFIX = config.API_PREFIX; // e.g. /api/v1

  // Each request gets its OWN token so a leak is attributable to a request.
  const shapes: Array<[string, (t: string) => string]> = [
    ['plain', (t) => `${PREFIX}/groups/invites/${t}`],
    ['%67roups (the reported bypass)', (t) => `${PREFIX}/%67roups/invites/${t}`],
    ['%47roups (upper-case escape)', (t) => `${PREFIX}/%47roups/invites/${t}`],
    ['%2567roups (double-encoded)', (t) => `${PREFIX}/%2567roups/invites/${t}`],
    ['%69nvites', (t) => `${PREFIX}/groups/%69nvites/${t}`],
    ['partially encoded "invites"', (t) => `${PREFIX}/groups/in%76ites/${t}`],
    ['both words encoded', (t) => `${PREFIX}/%67roups/%69nvites/${t}`],
    ['encoded letters with a query string', (t) => `${PREFIX}/%67roups/invites/${t}?a=1&b=2`],
    ['encoded separators (upper)', (t) => `${PREFIX}/groups%2Finvites%2F${t}`],
    ['encoded separators (lower)', (t) => `${PREFIX}/groups%2finvites%2f${t}`],
    ['repeated separators', (t) => `${PREFIX}//groups///invites//${t}`],
    ['trailing segments', (t) => `${PREFIX}/groups/invites/${t}/extra/more`],
    ['plain with a query string', (t) => `${PREFIX}/groups/invites/${t}?x=1`],
    ['malformed escape after the token', (t) => `${PREFIX}/groups/invites/${t}%ZZ`],
    ['truncated escape after the token', (t) => `${PREFIX}/groups/invites/${t}%`],
    ['malformed escape before the route words', (t) => `${PREFIX}/%ZZgroups/invites/${t}`],
    // OUTSIDE the API prefix: these reach the top-level not-found handler in
    // server.ts, which the prefixed routes/index.ts handler otherwise shadows.
    ['unprefixed plain', (t) => `/groups/invites/${t}`],
    ['unprefixed %67roups', (t) => `/%67roups/invites/${t}`],
    ['unprefixed encoded separators', (t) => `/groups%2Finvites%2F${t}`],
  ];

  it('matrix: every spelling x {anonymous, authenticated} — the token appears in NO field of NO record', async () => {
    const tokens: string[] = [];
    let n = 0;
    for (const [, build] of shapes) {
      for (const authed of [false, true]) {
        const t = `SYNTHTOKEN${String(n++).padStart(3, '0')}${randomUUID().replaceAll('-', '')}`;
        tokens.push(t);
        await server.inject({
          method: 'GET',
          url: build(t),
          headers: authed ? authHeader : {},
          remoteAddress: nextIp(),
        });
      }
    }

    // Records are written as requests finish; give the last completions a tick.
    await new Promise((r) => setTimeout(r, 100));

    const recs = records();
    expect(recs.length).toBeGreaterThan(tokens.length); // the capture really is capturing
    const raw = sink.lines.join('');
    for (const t of tokens) {
      expect(raw, `raw output contains ${t}`).not.toContain(t);
      const stringsHoldingIt = recs.filter((r) => allStrings(r).some((s) => s.includes(t)));
      expect(stringsHoldingIt, `a serialized field carries ${t}`).toEqual([]);
    }
  }, 120_000);

  it('a MATCHED, authenticated request for a REAL token resolves 200 and logs it redacted in all three sinks', async () => {
    const before = sink.lines.length;
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/groups/invites/${realToken}`,
      headers: authHeader,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(realToken);

    const recs = sink.lines.slice(before).join('').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    const byMsg = (msg: string) => recs.filter((r) => r.msg === msg);

    // Fastify's automatic line, and both custom lines, all present and redacted.
    expect(byMsg('incoming request')[0]?.req.url).toBe(`${PREFIX}/groups/invites/[REDACTED]`);
    expect(byMsg('Incoming request')[0]?.url).toBe(`${PREFIX}/groups/invites/[REDACTED]`);
    const completed = byMsg('Request completed')[0];
    expect(completed?.url).toBe(`${PREFIX}/groups/invites/[REDACTED]`);
    // ...and the diagnostics that make the line useful survive.
    expect(completed?.method).toBe('GET');
    expect(completed?.statusCode).toBe(200);
  });

  it('the same REAL token spelled with an encoded letter still resolves AND is still redacted', async () => {
    const before = sink.lines.length;
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/%67roups/invites/${realToken}`,
      headers: authHeader,
      remoteAddress: nextIp(),
    });
    // The router matches on the decoded path, which is exactly why the raw
    // string cannot be trusted to look like "groups".
    expect(resp.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(realToken);
    expect(mine).toContain('%67roups/invites/[REDACTED]');
  });

  it('an UNAUTHENTICATED request to the token route (401) is redacted too', async () => {
    const before = sink.lines.length;
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/%67roups/invites/${realToken}`,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 50));

    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(realToken);
    expect(mine).toContain('[REDACTED]');
    expect(mine).toContain('"statusCode":401');
  });

  it("the top-level not-found handler logs a redacted URL ('Route not found') with method and route intact", async () => {
    const t = `NOTFOUNDTOKEN${randomUUID().replaceAll('-', '')}`;
    const before = sink.lines.length;
    const resp = await server.inject({
      method: 'GET',
      url: `/%67roups/invites/${t}`,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(404);
    await new Promise((r) => setTimeout(r, 50));

    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(t);
    const recs = mine.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    const notFound = recs.find((r) => r.msg === 'Route not found');
    expect(notFound).toBeDefined();
    expect(notFound.url).toBe('/%67roups/invites/[REDACTED]');
  });

  it('unrelated routes are logged exactly as before — nothing is over-redacted', async () => {
    const before = sink.lines.length;
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/notifications?page=2&limit=5`,
      headers: authHeader,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const mine = sink.lines.slice(before).join('');
    expect(mine).toContain(`${PREFIX}/notifications?page=2&limit=5`);
    expect(mine).not.toContain('[REDACTED]');
  });
});
