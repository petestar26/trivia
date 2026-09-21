import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { errorHandler } from './error-handler.js';
import type { FastifyError } from 'fastify';
import { quotesInviteTokenRoute, redactUrl, redactedRequestSerializer } from './log-redaction.js';
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
      ['quadruple-encoded (%25252567)', `/api/v1/%25252567roups/invites/${T}`, '/api/v1/%25252567roups/invites/[REDACTED]'],
      ['depth-5 encoded path — fail closed entirely', `/api/v1/%252525252567roups/invites/${T}`, '[REDACTED]'],
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

// A malformed escape (`%ZZ`, a lone `%`) makes the router refuse the path — but
// only after the request line was logged, and a real invite link mangled in
// transit is exactly such a path. Two reported URLs walked straight through:
//   /api/v1/%ZZ%67roups/%69nvites/<token>
//   /api/v1/%67roups/%ZZ%69nvites/<token>
// The decoder reached a fixed point that still held `%ZZ`, so it was not
// "truncated"; the exact reading failed (`%ZZgroups` is not `groups`); and the
// fallback looked for the literal word `invites` in the RAW text only — where
// `%69nvites` hides it — and returned the raw, secret-bearing URL.
describe('redactUrl — malformed and ambiguous paths', () => {
  const T = 'SYNTHETICLEAKTOKEN0123456789';
  const P = '/api/v1';
  const FAIL_CLOSED = '[REDACTED]';

  // input -> exact expected output. FAIL_CLOSED means the WHOLE url is omitted:
  // a malformed escape sits where the route is, so the token boundary cannot be
  // trusted. Anything else is the precise form, token only.
  const cases: Array<[string, string, string]> = [
    // ── the two reported URLs ────────────────────────────────────────────────
    ['reported #1: bad escape, then encoded groups and invites', `${P}/%ZZ%67roups/%69nvites/${T}`, FAIL_CLOSED],
    ['reported #2: encoded groups, then bad escape and encoded invites', `${P}/%67roups/%ZZ%69nvites/${T}`, FAIL_CLOSED],
    // ── mixed upper/lower case ──────────────────────────────────────────────
    ['upper-case encoded letters and words', `${P}/%ZZ%47ROUPS/%49NVITES/${T}`, FAIL_CLOSED],
    ['lower-case escaped separators', `${P}/%67roups%2f%ZZ%69nvites%2f${T}`, FAIL_CLOSED],
    ['upper-case escaped separators', `${P}/%67roups%2F%ZZ%69nvites%2F${T}`, FAIL_CLOSED],
    ['mixed-case escaped separators', `${P}/%ZZ%67roups%2F%69nvites%2f${T}`, FAIL_CLOSED],
    ['lower-case hex digits in the bad escape', `${P}/%zz%67roups/%69nvites/${T}`, FAIL_CLOSED],
    // ── malformed BEFORE the route components ───────────────────────────────
    ['a bad escape glued to "groups"', `${P}/%ZZgroups/invites/${T}`, FAIL_CLOSED],
    ['a lone percent glued to "groups"', `${P}/%groups/invites/${T}`, FAIL_CLOSED],
    ['a percent before an encoded letter', `${P}/%%67roups/invites/${T}`, FAIL_CLOSED],
    ['a bad escape as its own segment before an EXACT route: precise', `${P}/%ZZ/groups/invites/${T}`, `${P}/%ZZ/groups/invites/[REDACTED]`],
    ['a bad escape inside the api prefix before an EXACT route: precise', `/api/v%ZZ1/groups/invites/${T}`, '/api/v%ZZ1/groups/invites/[REDACTED]'],
    // ── malformed INSIDE the route components ───────────────────────────────
    ['a bad escape inside "groups"', `${P}/gro%ZZups/invites/${T}`, FAIL_CLOSED],
    ['a bad escape inside "invites"', `${P}/groups/in%ZZvites/${T}`, FAIL_CLOSED],
    ['a bad escape inside both, one encoded letter each', `${P}/g%ZZ%72oups/%69n%ZZvites/${T}`, FAIL_CLOSED],
    ['a bad escape between the route words', `${P}/groups/%ZZ/invites/${T}`, FAIL_CLOSED],
    ['a bad escape where the separator should be', `${P}/groups%ZZinvites/${T}`, FAIL_CLOSED],
    ['a truncated escape inside "invites"', `${P}/groups/invi%2tes/${T}`, FAIL_CLOSED],
    ['two escapes of DIFFERENT widths inside one word', `${P}/groups/i%ZZn%Zvites/${T}`, FAIL_CLOSED],
    ['a lone percent in both words', `${P}/gr%oups/in%vites/${T}`, FAIL_CLOSED],
    ['bad escapes standing in for BOTH separators', `${P}/groups%ZZinvites%Z${T}`, FAIL_CLOSED],
    // ── malformed AFTER the route components ────────────────────────────────
    ['a bad escape ending the token: the exact route is known, token only', `${P}/groups/invites/${T}%ZZ`, `${P}/groups/invites/[REDACTED]`],
    ['a lone percent ending the token', `${P}/groups/invites/${T}%`, `${P}/groups/invites/[REDACTED]`],
    ['a bad escape in the token then more segments', `${P}/groups/invites/${T}%ZZ/more/x`, `${P}/groups/invites/[REDACTED]/more/x`],
    ['a bad escape in a trailing segment', `${P}/groups/invites/${T}/%ZZ`, `${P}/groups/invites/[REDACTED]/%ZZ`],
    ['a bad escape trailing an ENCODED route', `${P}/%67roups/%69nvites/${T}/extra/%ZZ`, `${P}/%67roups/%69nvites/[REDACTED]/extra/%ZZ`],
    // ── nested / deep encoding ──────────────────────────────────────────────
    ['double-encoded route words and a bad escape', `${P}/%ZZ%2567roups/%2569nvites/${T}`, FAIL_CLOSED],
    ['triple-encoded, bad escape between', `${P}/%252567roups/%ZZ%252569nvites/${T}`, FAIL_CLOSED],
    ['depth-5 (beyond the bound) and a bad escape', `${P}/%ZZ%252525252567roups/invites/${T}`, FAIL_CLOSED],
    ['an encoded percent turning into a bad escape', `${P}/%25ZZ%67roups/%69nvites/${T}`, FAIL_CLOSED],
    ['double-encoded route words, well-formed: precise', `${P}/%2567roups/%2569nvites/${T}`, `${P}/%2567roups/%2569nvites/[REDACTED]`],
    // ── repeated separators / trailing components / dot segments ────────────
    ['repeated separators', `${P}//groups///%ZZ%69nvites//${T}`, FAIL_CLOSED],
    ['repeated ENCODED separators', `${P}/groups%2F%2F%ZZinvites%2F%2F${T}`, FAIL_CLOSED],
    ['trailing components', `${P}/%ZZ%67roups/%69nvites/${T}/extra/more`, FAIL_CLOSED],
    ['trailing dot-dot components', `${P}/%ZZ%67roups/%69nvites/${T}/more/%2e%2e`, FAIL_CLOSED],
    ['backslash separators', `${P}/groups\\%ZZ%69nvites\\${T}`, FAIL_CLOSED],
    ['a "." segment in the way', `${P}/groups/./%ZZ%69nvites/${T}`, FAIL_CLOSED],
    // ── query strings and fragments ─────────────────────────────────────────
    ['a query string after a fail-closed path', `${P}/%ZZ%67roups/%69nvites/${T}?a=1&b=%ZZ`, FAIL_CLOSED],
    ['the token in the query of a fail-closed path', `${P}/%ZZ%67roups/%69nvites?token=${T}`, FAIL_CLOSED],
    ['a fragment after a fail-closed path', `${P}/%ZZ%67roups/%69nvites/${T}#f`, FAIL_CLOSED],
    ['a query string after a precise path', `${P}/groups/invites/${T}%ZZ?a=1`, `${P}/groups/invites/[REDACTED]?a=1`],
    // ── no api prefix ───────────────────────────────────────────────────────
    ['unprefixed', `/%ZZ%67roups/%69nvites/${T}`, FAIL_CLOSED],
  ];

  it.each(cases)('%s', (_name, input, expected) => {
    const out = redactUrl(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(T);
    expect(out).not.toBe(input);
  });

  it('an escape nothing can explain, beside a literal "invites", fails closed (the original safety net stays)', () => {
    // Well-formed escapes that decode to something no route spells — a NUL, a
    // space — leave no route to recognize. The word is written out and an
    // escape is present, and that alone is enough to omit the URL.
    expect(redactUrl(`${P}/groups%00/invites/${T}`)).toBe(FAIL_CLOSED);
    expect(redactUrl(`${P}/groups%20/invites/${T}`)).toBe(FAIL_CLOSED);
    expect(redactUrl(`${P}/%67roups/x/invites/${T}`)).toBe(FAIL_CLOSED);
  });

  it('a SECOND route hidden behind a bad escape is caught even though the first is exact', () => {
    expect(redactUrl(`${P}/groups/invites/FIRSTTOKEN/%ZZ%67roups/%69nvites/${T}`)).toBe(FAIL_CLOSED);
    // ...including one whose separator is the bad escape, so no two segments
    // ever read `groups` and `invites`.
    expect(redactUrl(`${P}/groups/invites/FIRSTTOKEN/groups%ZZinvites/${T}`)).toBe(FAIL_CLOSED);
    expect(redactUrl(`${P}/groups/invites/FIRSTTOKEN%ZZ/%69n%Zvites/${T}`)).toBe(FAIL_CLOSED);
  });

  it('the exact route\'s own segments never trigger the fail-closed reading (a bad escape elsewhere stays precise)', () => {
    expect(redactUrl(`${P}/groups/invites/${T}/%ZZ/tail`)).toBe(`${P}/groups/invites/[REDACTED]/%ZZ/tail`);
    expect(redactUrl(`${P}/%ZZ/groups/invites/${T}/%`)).toBe(`${P}/%ZZ/groups/invites/[REDACTED]/%`);
  });

  it('every route in a well-formed path is masked, not just the first', () => {
    const out = redactUrl(`${P}/groups/invites/FIRSTTOKEN/groups/invites/${T}/tail`);
    expect(out).toBe(`${P}/groups/invites/[REDACTED]/groups/invites/[REDACTED]/tail`);
    expect(out).not.toContain(T);
    expect(out).not.toContain('FIRSTTOKEN');
  });

  it('decodes every WELL-FORMED escape even when a malformed one is present', () => {
    // If a bad escape stopped decoding, `%67` and `%69` would stay opaque and
    // the route words would be invisible to every check that follows.
    expect(redactUrl(`${P}/groups/%ZZ/%69nvites/${T}`)).toBe(FAIL_CLOSED);
    expect(redactUrl(`${P}/%67roups/%ZZ/invites/${T}`)).toBe(FAIL_CLOSED);
  });

  describe('controls — malformed URLs that have nothing to do with an invite are NOT over-redacted', () => {
    const untouched = [
      `${P}/notifications/%ZZ`,
      `${P}/notifications/%ZZ?x=1`,
      `${P}/groups/%ZZ/members`,
      `${P}/groups/2f1b0c64-0000-4000-8000-000000000000/%ZZ`,
      `${P}/%ZZgroups/${T}`,
      `${P}/auth/%`,
      `${P}/auth/login%2`,
      `/%ZZ${T}`,
      `${P}/%67roups/%69nvites`, // well-formed, and no token
      `${P}/%67roups`,
      `${P}/groups/%69nvites`,
      `${P}/groups/accept-invite%ZZ`,
    ];
    it.each(untouched)('%s is returned byte for byte', (url) => {
      expect(redactUrl(url)).toBe(url);
    });
  });

  it('does bounded work: a hostile path of thousands of malformed escapes is judged in one pass', () => {
    const hostile = `${P}/` + '%ZZ%67roups/'.repeat(1500) + `%69nvites/${T}`;
    const started = Date.now();
    const out = redactUrl(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toBe(FAIL_CLOSED);
    // ...and a long path with NO signal is left alone, also quickly.
    const benign = `${P}/notifications/` + 'a%ZZ/'.repeat(3000);
    const benignStarted = Date.now();
    expect(redactUrl(benign)).toBe(benign);
    expect(Date.now() - benignStarted).toBeLessThan(2_000);
  });

  it('never throws, and never lets the token out, however a route is corrupted (seeded fuzz)', () => {
    // Deterministic generator: a real `groups` / `invites` / token route whose
    // letters are randomly written raw, upper- or lower-case, or as an escape
    // (upper- or lower-case hex), with malformed escapes of every width dropped
    // in between letters, separators of every kind, and junk before and after.
    // The fragments are chosen so they can never combine with the next letter
    // into a WELL-FORMED escape — that would change the word, not mangle it —
    // and none contains a separator: a slash in the middle of a word makes two
    // words, not one mangled one.
    let seed = 20260921;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pick = <V,>(values: readonly V[]): V => values[next(values.length)];
    const BAD = ['%', '%Z', '%ZZ', '%G1', '%%', '%Z%'] as const;
    const spellWord = (word: string): string => {
      let out = '';
      for (const [i, ch] of [...word].entries()) {
        if (i > 0 && next(3) === 0) out += pick(BAD);
        const code = ch.charCodeAt(0);
        const hex = code.toString(16);
        out += pick([ch, ch.toUpperCase(), `%${hex.toUpperCase()}`, `%${hex}`, `%${code.toString(16).toUpperCase()}`]);
      }
      return out;
    };
    // Includes a malformed escape standing IN PLACE of the separator.
    const SEPS = ['/', '//', '\\', '%2F', '%2f', '/./', '/%ZZ/', '%2F%2F', '%ZZ', '%', '%Z', '/%/'] as const;
    for (let i = 0; i < 5_000; i++) {
      const route = `${spellWord('groups')}${pick(SEPS)}${spellWord('invites')}${pick(SEPS)}${T}`;
      const url = `${P}${pick(['/', '//', '/%ZZ/', '/x/'])}${route}${pick(['', '%ZZ', '/tail', '/%ZZ', '?a=1', '/t/%'])}`;
      let out = '';
      expect(() => { out = redactUrl(url); }, url).not.toThrow();
      expect(out, url).not.toContain(T);
    }
  });

  describe('quotesInviteTokenRoute — the same recognizer, for messages', () => {
    it('recognizes a route quoted in ANY of the spellings the log path handles', () => {
      for (const text of [
        `Route GET:${P}/groups/invites/${T} not found`,
        `bad ${P}/%ZZ%67roups/%69nvites/${T}`,
        `bad ${P}/%67roups/%ZZ%69nvites/${T}`,
      ]) {
        expect(quotesInviteTokenRoute(text), text).toBe(true);
      }
    });

    it('does not fire on ordinary text, or on non-strings', () => {
      for (const text of ['Validation failed', 'Request body is too large', `${P}/notifications/%ZZ`, '', undefined, null, 42]) {
        expect(quotesInviteTokenRoute(text), String(text)).toBe(false);
      }
    });
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
    // DEPTH-5+ ENCODED: the decode bound cannot fully resolve the path,
    // triggering fail-closed — the entire URL is redacted.
    ['depth-5 encoded g in groups', (t) => `${PREFIX}/%252525252567roups/invites/${t}`],
    ['depth-5 encoded i in invites', (t) => `${PREFIX}/groups/%252525252569nvites/${t}`],
    ['depth-5 encoded separator', (t) => `${PREFIX}/groups%2525252525Finvites%2525252525F${t}`],
    // Nested %25, mixed-case %2F/%2f, depth 4, repeated separators, trailing
    // paths: each a different way for the raw text to stop looking like the
    // route while the router still (or narrowly fails to) match it.
    ['nested %25 separators (double-encoded)', (t) => `${PREFIX}/groups%252Finvites%252F${t}`],
    ['mixed-case separators (upper then lower)', (t) => `${PREFIX}/groups%2Finvites%2f${t}`],
    ['mixed-case separators (lower then upper)', (t) => `${PREFIX}/groups%2finvites%2F${t}`],
    ['repeated encoded separators', (t) => `${PREFIX}/groups%2F%2Finvites%2F%2F${t}`],
    ['depth-4 encoded g in groups', (t) => `${PREFIX}/%25252567roups/invites/${t}`],
    ['depth-4 encoded separators', (t) => `${PREFIX}/groups%2525252Finvites%2525252F${t}`],
    ['encoded route with a trailing path', (t) => `${PREFIX}/%67roups/%69nvites/${t}/more/%2e%2e`],
    ['depth-5 with a trailing path and a query', (t) => `${PREFIX}/%252525252567roups/invites/${t}/x?y=1`],
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

  it('response bodies never contain the raw token or echo the request URL — anonymous and authenticated, nonexistent and REAL tokens', async () => {
    let n = 0;
    let requests = 0;
    for (const [name, build] of shapes) {
      for (const authed of [false, true]) {
        for (const kind of ['nonexistent', 'real'] as const) {
          const t = kind === 'real' ? realToken : `BODYLEAK${String(n++).padStart(3, '0')}${randomUUID().replaceAll('-', '')}`;
          const resp = await server.inject({
            method: 'GET',
            url: build(t),
            headers: authed ? authHeader : {},
            remoteAddress: nextIp(),
          });
          requests++;
          const label = `${name} / ${authed ? 'authenticated' : 'anonymous'} / ${kind} token`;
          const body = resp.body;
          expect(body, `response body leaks the token (${label})`).not.toContain(t);
          // No response — success or failure — may echo the request path.
          expect(body, `response body echoes the invite route (${label})`).not.toMatch(/\/invites\//i);
          if (resp.statusCode >= 400) {
            const parsed = JSON.parse(body);
            expect(parsed.success, label).toBe(false);
            expect(parsed.error?.message, `error message echoes route (${label})`).not.toMatch(/\/invites\//i);
            expect(parsed.error?.message, `error message echoes token (${label})`).not.toContain(t);
          }
        }
      }
    }
    expect(requests).toBe(shapes.length * 4);
    // Let every request's completion line reach the sink before the next test
    // reads records; otherwise lagging writes bleed into that window.
    await new Promise((r) => setTimeout(r, 150));
  }, 180_000);

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
    // Scope the completion line to THIS request: a lagging write from an
    // earlier anonymous request could otherwise carry a 401 into this window.
    const completed = byMsg('Request completed').filter((r) => r.url === `${PREFIX}/groups/invites/[REDACTED]`).at(-1);
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

  it('FST_ERR_BAD_URL returns a generic 400 that never reflects the URL or a token', async () => {
    const before = sink.lines.length;
    const t = `BADURL${randomUUID().replaceAll('-', '')}`;
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/groups/%ZZinvites/${t}`,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(400);
    const body = JSON.parse(resp.body);
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('BAD_REQUEST');
    expect(body.error?.message).toBe('Bad request');
    expect(typeof body.meta?.requestId).toBe('string');
    // The raw URL (with the token) must not be reflected anywhere.
    expect(JSON.stringify(body)).not.toContain(t);
    expect(JSON.stringify(body)).not.toContain('/invites/');
    expect(JSON.stringify(body)).not.toContain('%ZZ');

    await new Promise((r) => setTimeout(r, 50));
    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(t);

    // The log carries the REDACTED url on a dedicated line — and the error
    // object, whose message quotes the raw URL, is never logged at all.
    const recs = mine.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    const malformed = recs.find((r) => r.msg === 'Malformed request URL');
    expect(malformed, 'a "Malformed request URL" line is written').toBeDefined();
    // `%ZZinvites` never decodes to the route, so the whole URL fails closed.
    expect(malformed.url).toBe('[REDACTED]');
    expect(recs.some((r) => r.msg === 'Request error'), 'the raw error must not be logged').toBe(false);
  });

  it('a malformed URL on an AUTHENTICATED request gets the same generic 400 (authentication does not change what is reflected)', async () => {
    const before = sink.lines.length;
    const t = `BADURLAUTH${randomUUID().replaceAll('-', '')}`;
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/groups/invites/${t}%`,
      headers: authHeader,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(400);
    expect(JSON.parse(resp.body).error).toEqual({ code: 'BAD_REQUEST', message: 'Bad request' });
    expect(resp.body).not.toContain(t);
    await new Promise((r) => setTimeout(r, 50));
    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(t);
    // Here the route IS recognizable behind the trailing escape, so only the
    // token is masked and the diagnostics survive.
    const recs = mine.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    expect(recs.find((r) => r.msg === 'Malformed request URL')?.url).toBe(`${PREFIX}/groups/invites/[REDACTED]`);
  });

  it('payload-too-large preserves its native 413 status with a safe, secret-free body', async () => {
    const before = sink.lines.length;
    const t = `TOOLARGE${randomUUID().replaceAll('-', '')}`;
    const hugeBody = `${'x'.repeat(1024 * 1024 + 256)}${t}`;
    const resp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { 'content-type': 'application/json' },
      payload: hugeBody,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(413);
    const body = JSON.parse(resp.body);
    expect(body.success).toBe(false);
    // The ESTABLISHED response (identical at e68e474), not the malformed-URL 400.
    expect(body.error?.message).toBe('Request body is too large');
    expect(body.error?.message).not.toBe('Bad request');
    expect(JSON.stringify(body)).not.toContain(t);
    expect(JSON.stringify(body)).not.toContain('/invites/');

    await new Promise((r) => setTimeout(r, 50));
    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(t);
  });

  it('unsupported media type preserves its native 415 status with a safe body', async () => {
    const before = sink.lines.length;
    const t = `UNSUPPORTED${randomUUID().replaceAll('-', '')}`;
    const resp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { 'content-type': 'application/xml' },
      payload: `<xml>${t}</xml>`,
      remoteAddress: nextIp(),
    });
    // Logout demands auth, but the unsupported media type surfaces during body
    // parsing — before auth — so 415 is expected regardless of credentials.
    expect(resp.statusCode).toBe(415);
    const body = JSON.parse(resp.body);
    expect(body.error?.message).toBe('Unsupported Media Type: application/xml');
    expect(JSON.stringify(body)).not.toContain(t);
    expect(JSON.stringify(body)).not.toContain('/invites/');

    await new Promise((r) => setTimeout(r, 50));
    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(t);
  });

  it('invalid JSON preserves the established safe 400 response without reflecting the payload', async () => {
    const before = sink.lines.length;
    const t = `BADJSON${randomUUID().replaceAll('-', '')}`;
    const resp = await server.inject({
      method: 'POST',
      url: `${PREFIX}/auth/logout`,
      headers: { 'content-type': 'application/json' },
      payload: `{"leak":"${t}",`,
      remoteAddress: nextIp(),
    });
    // Malformed JSON is a body-parsing failure surfaced before auth. The
    // established behavior is a 400 with a generic error shape; the parser
    // message may echo a body fragment, so assert the invite token — which
    // lives in the path, never the body — is absent everywhere.
    expect(resp.statusCode).toBe(400);
    const body = JSON.parse(resp.body);
    expect(body.success).toBe(false);
    // The parser's own message — established, and distinct from the generic
    // malformed-URL response.
    expect(body.error?.message).toMatch(/JSON/);
    expect(body.error?.message).not.toBe('Bad request');
    expect(JSON.stringify(body)).not.toContain(t);
    expect(JSON.stringify(body)).not.toContain('/invites/');

    await new Promise((r) => setTimeout(r, 50));
    const mine = sink.lines.slice(before).join('');
    expect(mine).not.toContain(t);
  });

  it('a validation failure keeps its own 400 VALIDATION_ERROR (an unrelated error family is not flattened)', async () => {
    const resp = await server.inject({
      method: 'GET',
      url: `${PREFIX}/notifications?page=0`,
      headers: authHeader,
      remoteAddress: nextIp(),
    });
    expect(resp.statusCode).toBe(400);
    const body = JSON.parse(resp.body);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.message).toBe('Validation failed');
  });

  it('unknown routes answer generically with a 404 — under the API prefix and at the top level — never quoting the URL', async () => {
    for (const url of [
      (t: string) => `${PREFIX}/nope/${t}`,
      (t: string) => `/nope/${t}`,
      (t: string) => `${PREFIX}/groups/invites/${t}/extra/segments/that/do/not/exist`,
    ]) {
      const t = `NOTFOUND${randomUUID().replaceAll('-', '')}`;
      const resp = await server.inject({ method: 'GET', url: url(t), remoteAddress: nextIp() });
      expect(resp.statusCode).toBe(404);
      const body = JSON.parse(resp.body);
      expect(body.error).toEqual({ code: 'NOT_FOUND', message: 'Route not found' });
      expect(resp.body).not.toContain(t);
    }
  });

  it('an UNRELATED framework error — an async routing constraint failing — is NOT flattened into the malformed-URL 400', async () => {
    // FST_ERR_ASYNC_CONSTRAINT is the only other error Fastify routes through
    // the frameworkErrors hook. It must reach the shared error handler and keep
    // its own 500, rather than being answered with the malformed-URL 400.
    const constrained = await buildServer({ logStream: sink.stream, logLevel: 'trace' });
    constrained.addConstraintStrategy({
      name: 'always-fails',
      isAsync: true,
      storage() {
        const handlers = new Map<string, unknown>();
        return { get: (value: string) => handlers.get(value) ?? null, set: (value: string, handler: unknown) => void handlers.set(value, handler) };
      },
      deriveConstraint(_req: unknown, _ctx: unknown, done: (error: Error | null, value?: string) => void) {
        done(new Error('the constraint could not be derived'));
      },
    } as never);
    constrained.get('/zz-constrained', { constraints: { 'always-fails': 'x' } } as never, async () => ({ ok: true }));
    await constrained.ready();
    try {
      const resp = await constrained.inject({ method: 'GET', url: '/zz-constrained', remoteAddress: nextIp() });
      expect(resp.statusCode).toBe(500);
      const body = JSON.parse(resp.body);
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('INTERNAL_ERROR');
      expect(body.error?.message).not.toBe('Bad request');
    } finally {
      await constrained.close();
    }
  });

  it('the REAL invite token never appeared in ANY log line written across this whole suite', () => {
    expect(sink.lines.join('')).not.toContain(realToken);
  });
});

// The shared handler itself, without a server: a FST_ERR_BAD_URL that ever
// reaches it (the frameworkErrors hook in server.ts is the normal route) must
// be answered generically BEFORE anything logs the error, whose message
// quotes the raw URL — and every other error must pass through untouched.
describe('errorHandler — the malformed-URL guard', () => {
  const stubs = (url: string) => {
    const log = { error: vi.fn(), warn: vi.fn() };
    const reply = { status: vi.fn(), send: vi.fn() };
    reply.status.mockReturnValue(reply);
    reply.send.mockReturnValue(reply);
    return { log, reply, request: { url, headers: {}, log } };
  };

  it('answers FST_ERR_BAD_URL with the generic 400, logs only the redacted URL, and never logs the raw error', () => {
    const raw = '/api/v1/groups/invites/UNITSECRET0123456789%';
    const error = Object.assign(new URIError(`'${raw}' is not a valid url component`), {
      code: 'FST_ERR_BAD_URL',
      statusCode: 400,
    }) as FastifyError;
    const { log, reply, request } = stubs(raw);

    errorHandler(error, request as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(400);
    const sent = reply.send.mock.calls[0][0];
    expect(sent.error).toEqual({ code: 'BAD_REQUEST', message: 'Bad request' });
    expect(JSON.stringify(sent)).not.toContain('UNITSECRET');
    expect(log.error).not.toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('UNITSECRET');
    expect(log.warn.mock.calls[0][0]).toEqual({ url: '/api/v1/groups/invites/[REDACTED]' });
  });

  it('leaves every other framework error alone: 413 keeps its status and message', () => {
    const error = Object.assign(new Error('Request body is too large'), {
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      statusCode: 413,
    }) as FastifyError;
    const { log, reply, request } = stubs('/api/v1/auth/logout');

    errorHandler(error, request as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(413);
    expect(reply.send.mock.calls[0][0].error.message).toBe('Request body is too large');
    expect(log.error).toHaveBeenCalled(); // ordinary errors are still logged
  });

  it('an error whose MESSAGE quotes an invite route is answered generically but keeps its own status', () => {
    const error = Object.assign(new Error('Route GET:/api/v1/groups/invites/QUOTED123 not found'), { statusCode: 404 }) as FastifyError;
    const { reply, request } = stubs('/x');

    errorHandler(error, request as never, reply as never);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(JSON.stringify(reply.send.mock.calls[0][0])).not.toContain('QUOTED123');
  });

  // The same recognizer judges a message as judges a URL, so a spelling that
  // cannot slip past the log line cannot slip past the response or the error log.
  const QUOTING_MESSAGES: Array<[string, string]> = [
    ['plain', 'Route GET:/api/v1/groups/invites/UNITTOKEN0123 not found'],
    ['encoded and malformed (reported #1)', 'failed for /api/v1/%ZZ%67roups/%69nvites/UNITTOKEN0123'],
    ['encoded and malformed (reported #2)', 'failed for /api/v1/%67roups/%ZZ%69nvites/UNITTOKEN0123'],
  ];

  it.each(QUOTING_MESSAGES)('an error whose message quotes an invite route (%s) is answered generically and NEVER logged with the route', (_name, message) => {
    const error = Object.assign(new Error(message), { statusCode: 404, code: 'SOME_CODE' }) as FastifyError;
    const { log, reply, request } = stubs('/x');

    errorHandler(error, request as never, reply as never);

    // The response: generic, and the error's own status is kept.
    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send.mock.calls[0][0].error.message).toBe('Bad request');
    expect(JSON.stringify(reply.send.mock.calls)).not.toContain('UNITTOKEN');
    // The log: an error entry IS written (diagnosis is not lost), but what is
    // serialized carries neither the message nor the stack of the original.
    expect(log.error).toHaveBeenCalledTimes(1);
    const logged = log.error.mock.calls[0][0].err as Error & { code?: string; statusCode?: number };
    expect(logged.message).toBe('[REDACTED]');
    expect(`${logged.message}\n${logged.stack}`).not.toContain('UNITTOKEN');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('UNITTOKEN');
    // ...and it keeps what diagnosis needs.
    expect(logged.code).toBe('SOME_CODE');
    expect(logged.statusCode).toBe(404);
  });

  it('an error whose STACK (but not its message) quotes an invite route is not logged with it either', () => {
    const error = Object.assign(new Error('boom'), { statusCode: 500 }) as FastifyError;
    error.stack = 'Error: boom\n    at GET /api/v1/%ZZ%67roups/%69nvites/UNITTOKEN0123 (handler.ts:1:1)';
    const { log, reply, request } = stubs('/x');

    errorHandler(error, request as never, reply as never);

    expect(JSON.stringify(log.error.mock.calls)).not.toContain('UNITTOKEN');
    expect(reply.status).toHaveBeenCalledWith(500);
  });

  it('an ordinary error is logged exactly as before — the very same object', () => {
    const error = Object.assign(new Error('ordinary failure'), { statusCode: 500 }) as FastifyError;
    const { log, reply, request } = stubs('/x');

    errorHandler(error, request as never, reply as never);

    expect(log.error.mock.calls[0][0].err).toBe(error);
    expect(reply.status).toHaveBeenCalledWith(500);
  });
});
