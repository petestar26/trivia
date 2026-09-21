import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';

// Malformed and ambiguous invite paths, against the REAL server.
//
// `GET /groups/invites/:token` carries a bearer-equivalent secret in the path.
// The router refuses a path holding a malformed escape (`%ZZ`, a lone `%`) as a
// bad URL — after Fastify has already written the request line. Two reported
// URLs walked straight through the redaction and put the real token in the log:
//
//   /api/v1/%ZZ%67roups/%69nvites/<token>     `req.url` and "Malformed request URL"
//   /api/v1/%67roups/%ZZ%69nvites/<token>     `req.url` and "Malformed request URL"
//
// Each case below builds the actual `buildServer()` with its logger pointed at
// a capture stream at `trace`, fires four requests — anonymous and
// authenticated, each with a nonexistent token and a REAL one — and inspects
// EVERY string in EVERY record the server wrote, and the response body. For
// every case: the token is absent, the raw URL is absent, the response is the
// generic one for its status, and the status is the native one.
//
// Own file: a fresh server means a fresh rate-limit budget, and every request
// also carries a unique remoteAddress.

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

const PREFIX = config.API_PREFIX; // e.g. /api/v1
const REDACTED = '[REDACTED]';
const EMAIL_PREFIX = 'lrm-';

/** Collects every log line the server emits. */
function captureSink() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

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

type LogRecord = Record<string, unknown> & { msg?: string; url?: string; req?: { url?: string } };

interface Shape {
  name: string;
  /** The request URL for a given token. */
  build: (t: string) => string;
  /** The native status, identical for every token, credential and existence. */
  status: 400 | 404;
  /** What EVERY url field in EVERY log record must read, for a given token. */
  logged: (t: string) => string;
  /** The top-level not-found handler answers (it logs "Route not found"). */
  notFoundLog?: boolean;
}

const failClosed = () => REDACTED;

// The MALFORMED matrix: the router answers 400 before any handler or auth runs.
const malformed: Shape[] = [
  // ── the two reported URLs ──────────────────────────────────────────────────
  { name: 'reported #1: bad escape, then encoded groups and invites', build: (t) => `${PREFIX}/%ZZ%67roups/%69nvites/${t}`, status: 400, logged: failClosed },
  { name: 'reported #2: encoded groups, then bad escape and encoded invites', build: (t) => `${PREFIX}/%67roups/%ZZ%69nvites/${t}`, status: 400, logged: failClosed },
  // ── mixed upper/lower case ────────────────────────────────────────────────
  { name: 'upper-case encoded letters and words', build: (t) => `${PREFIX}/%ZZ%47ROUPS/%49NVITES/${t}`, status: 400, logged: failClosed },
  { name: 'lower-case escaped separators', build: (t) => `${PREFIX}/%67roups%2f%ZZ%69nvites%2f${t}`, status: 400, logged: failClosed },
  { name: 'upper-case escaped separators', build: (t) => `${PREFIX}/%67roups%2F%ZZ%69nvites%2F${t}`, status: 400, logged: failClosed },
  { name: 'mixed-case escaped separators', build: (t) => `${PREFIX}/%ZZ%67roups%2F%69nvites%2f${t}`, status: 400, logged: failClosed },
  { name: 'lower-case hex digits in the bad escape', build: (t) => `${PREFIX}/%zz%67roups/%69nvites/${t}`, status: 400, logged: failClosed },
  // ── malformed BEFORE the route components ─────────────────────────────────
  { name: 'a bad escape glued to "groups"', build: (t) => `${PREFIX}/%ZZgroups/invites/${t}`, status: 400, logged: failClosed },
  { name: 'a bad escape as its own segment before an exact route (precise)', build: (t) => `${PREFIX}/%ZZ/groups/invites/${t}`, status: 400, logged: () => `${PREFIX}/%ZZ/groups/invites/${REDACTED}` },
  // ── malformed INSIDE the route components ─────────────────────────────────
  { name: 'a bad escape inside "groups"', build: (t) => `${PREFIX}/gro%ZZups/invites/${t}`, status: 400, logged: failClosed },
  { name: 'a bad escape inside "invites"', build: (t) => `${PREFIX}/groups/in%ZZvites/${t}`, status: 400, logged: failClosed },
  { name: 'a bad escape inside both, one encoded letter each', build: (t) => `${PREFIX}/g%ZZ%72oups/%69n%ZZvites/${t}`, status: 400, logged: failClosed },
  { name: 'a bad escape between the route words', build: (t) => `${PREFIX}/groups/%ZZ/invites/${t}`, status: 400, logged: failClosed },
  { name: 'two escapes of different widths inside one word', build: (t) => `${PREFIX}/groups/i%ZZn%Zvites/${t}`, status: 400, logged: failClosed },
  { name: 'bad escapes standing in for both separators', build: (t) => `${PREFIX}/groups%ZZinvites%Z${t}`, status: 400, logged: failClosed },
  // ── malformed AFTER the route components ──────────────────────────────────
  { name: 'a bad escape ending the token (precise)', build: (t) => `${PREFIX}/groups/invites/${t}%ZZ`, status: 400, logged: () => `${PREFIX}/groups/invites/${REDACTED}` },
  { name: 'a lone percent ending the token (precise)', build: (t) => `${PREFIX}/groups/invites/${t}%`, status: 400, logged: () => `${PREFIX}/groups/invites/${REDACTED}` },
  { name: 'a bad escape in the token, then more segments (precise)', build: (t) => `${PREFIX}/groups/invites/${t}%ZZ/more/x`, status: 400, logged: () => `${PREFIX}/groups/invites/${REDACTED}/more/x` },
  { name: 'a bad escape in a trailing segment (precise)', build: (t) => `${PREFIX}/groups/invites/${t}/%ZZ`, status: 400, logged: () => `${PREFIX}/groups/invites/${REDACTED}/%ZZ` },
  // ── nested / deep encoding ────────────────────────────────────────────────
  { name: 'double-encoded route words and a bad escape', build: (t) => `${PREFIX}/%ZZ%2567roups/%2569nvites/${t}`, status: 400, logged: failClosed },
  { name: 'triple-encoded route words, bad escape between', build: (t) => `${PREFIX}/%252567roups/%ZZ%252569nvites/${t}`, status: 400, logged: failClosed },
  { name: 'depth-5 encoding (beyond the bound) and a bad escape', build: (t) => `${PREFIX}/%ZZ%252525252567roups/invites/${t}`, status: 400, logged: failClosed },
  // ── repeated separators / trailing components ─────────────────────────────
  { name: 'repeated separators', build: (t) => `${PREFIX}//groups///%ZZ%69nvites//${t}`, status: 400, logged: failClosed },
  { name: 'repeated encoded separators', build: (t) => `${PREFIX}/groups%2F%2F%ZZinvites%2F%2F${t}`, status: 400, logged: failClosed },
  { name: 'trailing components', build: (t) => `${PREFIX}/%ZZ%67roups/%69nvites/${t}/extra/more`, status: 400, logged: failClosed },
  { name: 'trailing dot-dot components', build: (t) => `${PREFIX}/%ZZ%67roups/%69nvites/${t}/more/%2e%2e`, status: 400, logged: failClosed },
  { name: 'backslash separators', build: (t) => `${PREFIX}/groups\\%ZZ%69nvites\\${t}`, status: 400, logged: failClosed },
  { name: 'a second route hidden behind a bad escape after the first', build: (t) => `${PREFIX}/groups/invites/${t}/%ZZ%67roups/%69nvites/${t}`, status: 400, logged: failClosed },
  // ── query strings ─────────────────────────────────────────────────────────
  { name: 'a query string after a fail-closed path', build: (t) => `${PREFIX}/%ZZ%67roups/%69nvites/${t}?a=1&b=%ZZ`, status: 400, logged: failClosed },
  { name: 'the token in the QUERY of a fail-closed path', build: (t) => `${PREFIX}/%ZZ%67roups/%69nvites?token=${t}`, status: 400, logged: failClosed },
  { name: 'a query string after a precise path', build: (t) => `${PREFIX}/groups/invites/${t}%ZZ?a=1`, status: 400, logged: () => `${PREFIX}/groups/invites/${REDACTED}` },
  { name: 'a literal token query after a precise path', build: (t) => `${PREFIX}/groups/invites/${t}%ZZ?token=${t}&x=1`, status: 400, logged: () => `${PREFIX}/groups/invites/${REDACTED}` },
  { name: 'a query with encoded ? and & after a fail-closed path', build: (t) => `${PREFIX}/groups/in%ZZvites/${t}?a%3Fb%26c=${t}`, status: 400, logged: failClosed },
  { name: 'a plus/space-style value after a fail-closed path', build: (t) => `${PREFIX}/%67roups/%ZZ%69nvites/${t}?next=+${t}+`, status: 400, logged: failClosed },
  // ── outside the api prefix ────────────────────────────────────────────────
  { name: 'unprefixed', build: (t) => `/%ZZ%67roups/%69nvites/${t}`, status: 400, logged: failClosed },
];

// WELL-FORMED spellings that still never match a route: 404 from a not-found
// handler, and the same redaction rules apply to what they log.
const wellFormed: Shape[] = [
  { name: 'double-encoded route words, no malformed escape (precise)', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
  { name: 'an encoded percent that turns into a bad escape only after decoding', build: (t) => `${PREFIX}/%25ZZ%67roups/%69nvites/${t}`, status: 404, logged: failClosed },
  { name: 'two routes in one well-formed path: BOTH tokens masked', build: (t) => `${PREFIX}/groups/invites/${t}/groups/invites/${t}/tail`, status: 404, logged: () => `${PREFIX}/groups/invites/${REDACTED}/groups/invites/${REDACTED}/tail` },
  { name: 'an escape nothing can explain beside a literal "invites" (the original safety net)', build: (t) => `${PREFIX}/groups%20/invites/${t}`, status: 404, logged: failClosed },
  { name: 'unprefixed encoded route (the top-level not-found handler)', build: (t) => `/%67roups/invites/${t}`, status: 404, logged: () => `/%67roups/invites/${REDACTED}`, notFoundLog: true },
  // ── query strings and fragments are NEVER retained ─────────────────────────
  // Each path uses the double-encoded spelling so it never MATCHES the invite
  // route (404 from not-found), while the query still holds a token value.
  { name: 'double-encoded route with the token as a query value', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}?token=${t}`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
  { name: 'double-encoded route with an arbitrary-name query value', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}?anything=${t}`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
  { name: 'double-encoded route with the token under a plus/space value', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}?next=+${t}+&x=1`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
  { name: 'double-encoded route with an encoded ? and = in the query', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}?x%3Da%26b%3D${t}`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
  { name: 'an encoded ? that stays inside the token region', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}%3Ftoken%3D${t}&x=1`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
  { name: 'a query after two routes: both masked, no suffix', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}/groups/invites/${t}?tail=1`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}/groups/invites/${REDACTED}` },
  { name: 'a fragment after a precise route', build: (t) => `${PREFIX}/%2567roups/%2569nvites/${t}#frag=${t}`, status: 404, logged: () => `${PREFIX}/%2567roups/%2569nvites/${REDACTED}` },
];

// Malformed URLs that have NOTHING to do with an invite: still a safe 400, and
// logged exactly as before — ordinary logs are not weakened.
const controls: Array<{ name: string; url: string }> = [
  { name: 'a bad escape in a notifications path', url: `${PREFIX}/notifications/%ZZ` },
  { name: 'a bad escape plus a query', url: `${PREFIX}/notifications/%ZZ?x=CONTROLMARKER1` },
  { name: 'a bad escape under groups, no invite', url: `${PREFIX}/groups/%ZZ/members` },
  { name: 'a bad escape glued to a segment that is not a route', url: `${PREFIX}/%ZZgroups/CONTROLMARKER2` },
  { name: 'a lone percent ending an auth path', url: `${PREFIX}/auth/%` },
  { name: 'a bad escape at the root', url: '/%ZZCONTROLMARKER3' },
];

describeIf('real buildServer: malformed and ambiguous invite paths', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  const sink = captureSink();
  let ip = 0;
  const nextIp = () => `10.40.${(ip >> 8) & 255}.${(ip++ & 255) || 1}`;

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
        username: `lrm_${suffix}`.slice(0, 30),
        passwordHash: 'fixture-only-not-a-real-hash',
        status: 'ACTIVE',
        isVerified: true,
      },
    });
    owner = { id: created.id, email: created.email!, username: created.username };
    const group = await prisma.group.create({
      data: { ownerId: owner.id, name: `LogRedMal-${suffix}`, isPrivate: true, status: 'ACTIVE' },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
    });
    realToken = `REALMALFORMEDTOKEN${randomUUID().replaceAll('-', '')}`;
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
    const ids = users.map((u: { id: string }) => u.id);
    if (ids.length) {
      const groups = await prisma.group.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
      const groupIds = groups.map((g: { id: string }) => g.id);
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

  /** Fire a request; return the response and every record it caused. */
  async function fire(url: string, opts: { authed?: boolean; method?: 'GET' | 'POST'; payload?: string; contentType?: string } = {}) {
    const before = sink.lines.length;
    const resp = await server.inject({
      method: opts.method ?? 'GET',
      url,
      headers: {
        ...(opts.authed ? authHeader : {}),
        ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      remoteAddress: nextIp(),
    });
    // The completion line is written as the response finishes; let it land.
    await new Promise((r) => setTimeout(r, 40));
    const text = sink.lines.slice(before).join('');
    const records = text
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as LogRecord);
    return { resp, text, records };
  }

  const urlFields = (records: LogRecord[]) =>
    records.flatMap((r) => [r.url, r.req?.url]).filter((u): u is string => typeof u === 'string');

  /** The response body with the per-request id removed, so two can be compared. */
  const stable = (body: string) => {
    const parsed = JSON.parse(body);
    if (parsed.meta) delete parsed.meta.requestId;
    return parsed;
  };

  const nativeBody: Record<number, { code: string; message: string }> = {
    400: { code: 'BAD_REQUEST', message: 'Bad request' },
    404: { code: 'NOT_FOUND', message: 'Route not found' },
  };

  describe.each([
    ['malformed (router answers 400)', malformed],
    ['well-formed but unmatched (404)', wellFormed],
  ] as Array<[string, Shape[]]>)('%s', (_group, shapes) => {
    it.each(shapes.map((s) => [s.name, s] as [string, Shape]))('%s', async (_name, shape) => {
      let n = 0;
      const results: Array<{ label: string; body: unknown }> = [];

      for (const authed of [false, true]) {
        for (const kind of ['nonexistent', 'real'] as const) {
          const token = kind === 'real' ? realToken : `MALFORMEDLEAK${String(n++).padStart(2, '0')}${randomUUID().replaceAll('-', '')}`;
          const rawUrl = shape.build(token);
          const label = `${shape.name} / ${authed ? 'authenticated' : 'anonymous'} / ${kind} token`;

          const { resp, text, records } = await fire(rawUrl, { authed });

          // ── the response: native status, generic body, nothing reflected ──
          expect(resp.statusCode, `status (${label})`).toBe(shape.status);
          const body = JSON.parse(resp.body);
          expect(body.success, label).toBe(false);
          expect(body.error, `error body (${label})`).toEqual(nativeBody[shape.status]);
          expect(resp.body, `body leaks the token (${label})`).not.toContain(token);
          expect(resp.body, `body echoes the URL (${label})`).not.toContain(rawUrl);
          expect(resp.body, `body echoes the route (${label})`).not.toMatch(/invites/i);
          expect(resp.body, `body echoes an escape (${label})`).not.toMatch(/%[0-9a-z]{2}/i);
          results.push({ label, body: stable(resp.body) });

          // ── the logs: every field of every record ────────────────────────
          expect(records.length, `the capture is capturing (${label})`).toBeGreaterThan(0);
          expect(text, `raw log output carries the token (${label})`).not.toContain(token);
          expect(text, `raw log output carries the raw URL (${label})`).not.toContain(rawUrl);
          for (const record of records) {
            for (const str of allStrings(record)) {
              expect(str, `a log field carries the token (${label})`).not.toContain(token);
              expect(str, `a log field carries the raw URL (${label})`).not.toContain(rawUrl);
            }
          }
          // Where the whole URL is omitted, none of the spelling survives either.
          if (shape.logged(token) === REDACTED) {
            const spelling = rawUrl.slice(0, rawUrl.indexOf(token) === -1 ? rawUrl.length : rawUrl.indexOf(token));
            for (const record of records) {
              for (const str of allStrings(record)) {
                expect(str, `a log field keeps the route spelling (${label})`).not.toContain(spelling);
              }
            }
          }

          // Every URL field reads exactly what the algorithm promises.
          const fields = urlFields(records);
          expect(fields.length, `some url field is written (${label})`).toBeGreaterThan(0);
          for (const field of fields) expect(field, `url field (${label})`).toBe(shape.logged(token));
          // The two log paths this change is about are BOTH present.
          expect(records.find((r) => r.msg === 'incoming request')?.req?.url, `serialized request line (${label})`).toBe(shape.logged(token));
          if (shape.status === 400) {
            expect(records.find((r) => r.msg === 'Malformed request URL')?.url, `malformed-request log (${label})`).toBe(shape.logged(token));
            expect(records.some((r) => r.msg === 'Request error'), `the raw error must not be logged (${label})`).toBe(false);
          }
          if (shape.notFoundLog) {
            expect(records.find((r) => r.msg === 'Route not found')?.url, `not-found log (${label})`).toBe(shape.logged(token));
          }
        }
      }

      // The token's EXISTENCE is not revealed: a real token, a nonexistent one,
      // an anonymous caller and an authenticated one all get the same answer.
      for (const r of results) expect(r.body, r.label).toEqual(results[0].body);
    }, 60_000);
  });

  describe('controls — unrelated malformed URLs', () => {
    it.each(controls.map((c) => [c.name, c] as [string, { name: string; url: string }]))('%s: safe 400, logged as before', async (_name, control) => {
      for (const authed of [false, true]) {
        const { resp, records } = await fire(control.url, { authed });
        expect(resp.statusCode).toBe(400);
        expect(JSON.parse(resp.body).error).toEqual(nativeBody[400]);
        expect(resp.body).not.toContain('CONTROLMARKER');
        // Nothing here is an invite: the URL is logged raw, nothing over-redacted.
        for (const field of urlFields(records)) expect(field).toBe(control.url);
        expect(records.find((r) => r.msg === 'Malformed request URL')?.url).toBe(control.url);
        expect(records.some((r) => allStrings(r).some((s) => s.includes(REDACTED)))).toBe(false);
      }
    }, 30_000);
  });

  it('control: well-formed encoded route words with NO token are not over-redacted (and keep their native validation error)', async () => {
    // `/groups/invites` decodes to GET /groups/:id with id "invites": a schema
    // failure, not a bad URL. There is no token to hide, so nothing is hidden.
    const url = `${PREFIX}/%67roups/%69nvites`;
    for (const authed of [false, true]) {
      const { resp, records } = await fire(url, { authed });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error?.code).toBe('VALIDATION_ERROR');
      for (const field of urlFields(records)) expect(field).toBe(url);
      expect(records.some((r) => allStrings(r).some((s) => s.includes(REDACTED)))).toBe(false);
    }
  });

  describe('controls — native statuses are preserved (the fix must not flatten other errors into a 400)', () => {
    const marker = () => `BODYMARK${randomUUID().replaceAll('-', '')}`;

    it('payload too large stays 413, with its own message', async () => {
      const t = marker();
      const { resp, text } = await fire(`${PREFIX}/auth/logout`, {
        method: 'POST',
        contentType: 'application/json',
        payload: `${'x'.repeat(1024 * 1024 + 256)}${t}`,
      });
      expect(resp.statusCode).toBe(413);
      expect(JSON.parse(resp.body).error?.message).toBe('Request body is too large');
      expect(resp.body).not.toContain(t);
      expect(text).not.toContain(t);
    });

    it('unsupported media type stays 415, with its own message', async () => {
      const t = marker();
      const { resp, text } = await fire(`${PREFIX}/auth/logout`, {
        method: 'POST',
        contentType: 'application/xml',
        payload: `<xml>${t}</xml>`,
      });
      expect(resp.statusCode).toBe(415);
      expect(JSON.parse(resp.body).error?.message).toBe('Unsupported Media Type: application/xml');
      expect(resp.body).not.toContain(t);
      expect(text).not.toContain(t);
    });

    it('invalid JSON stays the established 400 (and is not the malformed-URL answer)', async () => {
      const t = marker();
      const { resp, text } = await fire(`${PREFIX}/auth/logout`, {
        method: 'POST',
        contentType: 'application/json',
        payload: `{"leak":"${t}",`,
      });
      expect(resp.statusCode).toBe(400);
      const error = JSON.parse(resp.body).error;
      expect(error?.message).toMatch(/JSON/);
      expect(error?.message).not.toBe('Bad request');
      expect(resp.body).not.toContain(t);
      expect(text).not.toContain(t);
    });

    it('a schema failure keeps its own 400 VALIDATION_ERROR', async () => {
      const { resp } = await fire(`${PREFIX}/notifications?page=0`, { authed: true });
      expect(resp.statusCode).toBe(400);
      expect(JSON.parse(resp.body).error?.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('an invite link EMBEDDED in an ordinary query value is not logged', () => {
    const nope = () => `EMBEDNOPE${randomUUID().replaceAll('-', '')}`;
    // `?next=` spells a raw or (nested-)encoded invite URL: the ordinary path
    // is clean, but the query would ship the embedded secret, so the query is
    // dropped from every log field while the status stays native.
    it.each<[string, (t: string) => string]>([
      ['raw', (t) => `${PREFIX}/notifications?next=/groups/invites/${t}`],
      ['encoded', (t) => `${PREFIX}/notifications?next=${`%2Fgroups%2Finvites%2F${t}`}`],
      ['nested-encoded', (t) => `${PREFIX}/notifications?next=${`%252Fgroups%252Finvites%252F${t}`}`],
      ['encoded with a host and scheme', (t) => `${PREFIX}/notifications?next=${`https%3A%2F%2Fhost.example%2Fgroups%2Finvites%2F${t}`}`],
    ])('%s next — token never logged, query omitted, status preserved', async (_name, build) => {
      const t = nope();
      const { resp, text, records } = await fire(build(t), { authed: false });
      expect(resp.statusCode).toBe(401); // native auth answer, unchanged
      expect(text, `token leaked (${_name})`).not.toContain(t);
      expect(text).not.toContain('next=');
      for (const record of records) {
        for (const str of allStrings(record)) {
          expect(str, `a log field carries the embedded token (${_name})`).not.toContain(t);
        }
      }
      const fields = urlFields(records);
      for (const field of fields) {
        expect(field, `url field (${_name})`).toBe(`${PREFIX}/notifications`);
      }
    });
  });

  it('a WELL-FORMED, MATCHED request for the real token still resolves, and is still logged redacted', async () => {
    const { resp, text, records } = await fire(`${PREFIX}/%67roups/invites/${realToken}`, { authed: true });
    expect(resp.statusCode).toBe(200);
    expect(text).not.toContain(realToken);
    expect(records.find((r) => r.msg === 'incoming request')?.req?.url).toBe(`${PREFIX}/%67roups/invites/${REDACTED}`);
    expect(records.find((r) => r.msg === 'Incoming request')?.url).toBe(`${PREFIX}/%67roups/invites/${REDACTED}`);
  });

  it('the REAL token appeared in no log line written across this whole suite', () => {
    expect(sink.lines.join('')).not.toContain(realToken);
  });
});
