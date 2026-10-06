import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { buildServer } from '../server.js';
import { quotesInviteTokenRoute, redactUrl } from './log-redaction.js';

// An invite link EMBEDDED in a query parameter (or a fragment) is judged by the
// very same classifier as a path.
//
// A path holding a malformed or unexplained escape next to the word "invites"
// fails closed as a WHOLE url. The query used to be judged by a weaker,
// separate recognizer that only knew the exact and tolerant route readings, so
// the same two reported spellings survived when embedded in a query — as a
// parameter NAME or a VALUE, raw or percent-encoded, and were logged with the
// real token:
//
//   /groups%20/invites/<TOKEN>     (escaped space; nothing is malformed)
//   /groups%ZZinvites/<TOKEN>      (a bad escape standing in for a separator)
//   ?next=%2Fgroups%2520%2Finvites%2F<TOKEN>       and   ?/groups%ZZinvites/<TOKEN>=1
//
// Each spelling below is tried as a path (it must be sensitive), and then as
// a query NAME and VALUE in raw, encoded and nested-encoded forms (it must stay
// sensitive), against the real server, for anonymous and authenticated callers,
// with a live invite token and with nonexistent ones. What is asserted is what
// reaches the logs and the response — every string of every record — never how
// the code happens to get there.
//
// Own file: a fresh server means a fresh rate-limit budget, and every inject()
// request also carries a unique remoteAddress.

const P = config.API_PREFIX; // e.g. /api/v1
const REDACTED = '[REDACTED]';
const EMAIL_PREFIX = 'lrq-';

/** Percent-encode `s` with encodeURIComponent, `n` times over. */
function layer(s: string, n: number): string {
  let out = s;
  for (let i = 0; i < n; i++) out = encodeURIComponent(out);
  return out;
}

interface Spelling {
  name: string;
  /** A path-shaped invite link carrying `t` as its token. */
  build: (t: string) => string;
}

// The two reported spellings.
const REPORTED: Spelling[] = [
  { name: 'A: an escaped space after "groups"', build: (t) => `/groups%20/invites/${t}` },
  { name: 'B: a bad escape standing in for the separator', build: (t) => `/groups%ZZinvites/${t}` },
];

// The same two, with the "i" of "invites" spelled as an escape: NO literal
// "invites" appears anywhere in the raw text, so the RAW-text signal cannot
// help and only the CANONICAL (decoded) reading can recognise them.
const REPORTED_NO_LITERAL_WORD: Spelling[] = [
  { name: 'A with the "i" of invites encoded', build: (t) => `/groups%20/%69nvites/${t}` },
  { name: 'B with the "i" of invites encoded', build: (t) => `/groups%ZZ%69nvites/${t}` },
];

// Further path spellings the path classifier already fails closed on. Whatever
// makes a PATH sensitive must keep making it sensitive once embedded.
const OTHER_SENSITIVE_PATHS: Spelling[] = [
  { name: 'bad escape, then encoded groups and invites', build: (t) => `/%ZZ%67roups/%69nvites/${t}` },
  { name: 'encoded groups, bad escape, encoded invites', build: (t) => `/%67roups/%ZZ%69nvites/${t}` },
  { name: 'a bad escape inside "groups"', build: (t) => `/gro%ZZups/invites/${t}` },
  { name: 'a bad escape inside "invites"', build: (t) => `/groups/in%ZZvites/${t}` },
  { name: 'a bad escape between the route words', build: (t) => `/groups/%ZZ/invites/${t}` },
  { name: 'two escapes of different widths inside one word', build: (t) => `/groups/i%ZZn%Zvites/${t}` },
  { name: 'bad escapes standing in for both separators', build: (t) => `/groups%ZZinvites%Z${t}` },
  { name: 'encoded separators and a bad escape', build: (t) => `/groups%2F%ZZinvites%2F${t}` },
  { name: 'repeated separators', build: (t) => `//groups///%ZZ%69nvites//${t}` },
  { name: 'trailing components', build: (t) => `/%ZZ%67roups/%69nvites/${t}/extra/more` },
  { name: 'a second route hidden behind a bad escape', build: (t) => `/groups/invites/${t}/%ZZ%67roups/%69nvites/${t}` },
  { name: 'backslash separators', build: (t) => `/groups\\%ZZ%69nvites\\${t}` },
  { name: 'upper-case letters', build: (t) => `/%ZZ%47ROUPS/%49NVITES/${t}` },
  { name: 'an escape nothing can explain beside a literal "invites"', build: (t) => `/groups%20/invites/${t}/more` },
  { name: 'an unresolved encoded space', build: (t) => `/groups%2520/invites/${t}` },
  { name: 'a bad escape as the would-be token segment (the real token follows it)', build: (t) => `/groups/invites/%ZZ/${t}` },
  { name: 'the exact route (raw)', build: (t) => `/groups/invites/${t}` },
  { name: 'the exact route, encoded letters', build: (t) => `/%67roups/%69nvites/${t}` },
  { name: 'the exact route, double-encoded words', build: (t) => `/%2567roups/%2569nvites/${t}` },
  { name: 'the exact route, encoded separators', build: (t) => `/groups%2Finvites%2F${t}` },
  { name: 'the exact route with a trailing bad escape on the token', build: (t) => `/groups/invites/${t}%ZZ` },
];

const ALL_SPELLINGS: Spelling[] = [...REPORTED, ...REPORTED_NO_LITERAL_WORD, ...OTHER_SENSITIVE_PATHS];

// Harmless queries: none of them is, or could be, an invite link.
const HARMLESS_URLS = [
  `${P}/notifications?page=2&limit=5`,
  `${P}/notifications?q=hello%20world`,
  `${P}/notifications?q=100%25&sort=desc`,
  `${P}/notifications?redirect=%2Fdashboard%3Ftab%3D1`,
  `${P}/notifications?next=/groups/2f1b0c64-0000-4000-8000-000000000000/members`,
  `${P}/notifications?next=%2Fgroups%2F2f1b0c64-0000-4000-8000-000000000000`,
  `${P}/notifications?q=groups+invites+join`, // the literal words, but no escape anywhere
  `${P}/notifications?tab=invites&page=1`, // a parameter VALUE that is the word, no escape
  `${P}/notifications?q=caf%C3%A9`, // a non-ASCII escape
  `${P}/notifications?x=%ZZ`, // a malformed escape with no invite signal
  `${P}/notifications?x=100%`, // a lone percent
  `${P}/notifications?a=%ZZ&b=%Z&c=%&d=%%`, // several malformed escapes, none invite-ish
  `${P}/notifications?name=%67roups`, // one encoded route word
  `${P}/notifications?tab=%69nvites`, // "invites" spelled with an escape, and nothing after it
  `${P}/notifications?page=2#top`, // a harmless fragment
  `${P}/notifications#section-2`,
  `${P}/notifications?a=1&b=2&c=3`,
];

describe('redactUrl — a query part is judged exactly like a path', () => {
  const T = 'UNITSHAREDCLASSIFIERTOKEN0123456789';

  it.each(ALL_SPELLINGS.map((s) => [s.name, s] as [string, Spelling]))(
    'consistency: "%s" is sensitive as a path, and stays sensitive embedded as a query NAME or VALUE at every nesting depth',
    (_name, spelling) => {
      const link = spelling.build(T);

      // The premise: as a PATH this spelling is not logged raw.
      const asPath = redactUrl(`${P}${link}`);
      expect(asPath, `premise: "${link}" must be sensitive as a path`).not.toBe(`${P}${link}`);

      for (let depth = 0; depth <= 6; depth++) {
        const form = layer(link, depth);
        const urls: Array<[string, string]> = [
          ['VALUE', `${P}/notifications?next=${form}`],
          ['NAME', `${P}/notifications?${form}=1`],
          ['NAME without =', `${P}/notifications?${form}`],
          ['VALUE among other parameters', `${P}/notifications?a=1&next=${form}&b=2`],
          ['NAME among other parameters', `${P}/notifications?a=1&${form}=x&b=2`],
        ];
        for (const [where, url] of urls) {
          const out = redactUrl(url);
          const label = `${where}, nested x${depth}: ${url}`;
          // The complete suffix is omitted — every parameter, not just the guilty one.
          expect(out, label).toBe(`${P}/notifications`);
          expect(out, label).not.toContain(T);
        }
      }
    }
  );

  it.each(REPORTED.map((s) => [s.name, s] as [string, Spelling]))(
    'the reported spelling (%s) — literal reproductions from the actual server are not logged',
    (_name, spelling) => {
      const link = spelling.build(T);
      for (const url of [
        `${P}/notifications?next=${layer(link, 1)}`,
        `${P}/notifications?${layer(link, 1)}=1`,
        `${P}/notifications?next=${link}`,
        `${P}/notifications?${link}=1`,
      ]) {
        expect(redactUrl(url), url).toBe(`${P}/notifications`);
      }
    }
  );

  it('an embedded FULL url (scheme and host) is judged the same way', () => {
    for (const spelling of ALL_SPELLINGS) {
      const link = `https://host.example${spelling.build(T)}`;
      for (let depth = 0; depth <= 3; depth++) {
        const out = redactUrl(`${P}/notifications?next=${layer(link, depth)}`);
        expect(out, `${spelling.name} x${depth}`).toBe(`${P}/notifications`);
      }
    }
  });

  it('a query cannot launder a sensitive PATH: the path is still judged first, on its own', () => {
    // Sensitive path + harmless query -> the path's own verdict; the query is not appended.
    expect(redactUrl(`${P}/groups%ZZinvites/${T}?page=1`)).toBe(REDACTED);
    expect(redactUrl(`${P}/groups%20/invites/${T}?page=1`)).toBe(REDACTED);
    expect(redactUrl(`${P}/groups/invites/${T}?page=1`)).toBe(`${P}/groups/invites/${REDACTED}`);
  });

  it('the raw signal (an escape beside a literal "invites") fails closed even with no token segment — for a path and for a query part', () => {
    // No segment follows "invites", so the canonical-reading rule has nothing to
    // pin down; only the raw signal — an escape somewhere, and the word written
    // out — catches these. A token may still ride in the QUERY of such a path.
    expect(redactUrl(`${P}/groups%20/invites`)).toBe(REDACTED);
    expect(redactUrl(`${P}/groups%20/invites?token=${T}`)).toBe(REDACTED);
    expect(redactUrl(`${P}/groups%20/invites#${T}`)).toBe(REDACTED);
    expect(redactUrl(`${P}/notifications?next=${layer('/groups%20/invites', 1)}`)).toBe(`${P}/notifications`);
    expect(redactUrl(`${P}/notifications?${layer('/groups%20/invites', 1)}=${T}`)).toBe(`${P}/notifications`);
    expect(redactUrl(`${P}/notifications?next=/groups%ZZinvites`)).toBe(`${P}/notifications`);
  });

  it('a fragment is judged like a query part, and the complete suffix is omitted', () => {
    for (const spelling of ALL_SPELLINGS) {
      const link = spelling.build(T);
      for (let depth = 0; depth <= 3; depth++) {
        const form = layer(link, depth);
        for (const url of [
          `${P}/notifications#${form}`,
          `${P}/notifications#next=${form}`,
          `${P}/notifications?a=1#${form}`,
          `${P}/notifications?a=1#next=${form}&b=2`,
        ]) {
          expect(redactUrl(url), `${spelling.name}: ${url}`).toBe(`${P}/notifications`);
        }
      }
    }
  });

  it('the suffix decision is over the RAW delimiters: an escaped "&" cannot hide a sensitive part behind a harmless one', () => {
    for (const spelling of REPORTED) {
      const link = spelling.build(T);
      // one parameter (the escaped ampersand does not split it)…
      expect(redactUrl(`${P}/notifications?a%26next=${layer(link, 1)}`)).toBe(`${P}/notifications`);
      // …and a raw ampersand does, leaving the sensitive one as its own parameter.
      expect(redactUrl(`${P}/notifications?harmless=1&${layer(link, 1)}`)).toBe(`${P}/notifications`);
    }
  });

  it('quotesInviteTokenRoute agrees, so an error message quoting such a URL is not echoed either', () => {
    for (const spelling of ALL_SPELLINGS) {
      const link = spelling.build(T);
      expect(quotesInviteTokenRoute(`'${P}/notifications?next=${layer(link, 1)}' is not a valid url component`)).toBe(true);
    }
    expect(quotesInviteTokenRoute(`'${P}/notifications?page=2' is not a valid url component`)).toBe(false);
  });

  describe('controls — harmless URLs are returned byte for byte', () => {
    it.each(HARMLESS_URLS.map((u) => [u] as [string]))('%s', (url) => {
      expect(redactUrl(url)).toBe(url);
    });

    it('a harmless query survives next to a harmless fragment, and is dropped only when a part is sensitive', () => {
      expect(redactUrl(`${P}/notifications?a=1&b=%ZZ&c=x#frag`)).toBe(`${P}/notifications?a=1&b=%ZZ&c=x#frag`);
      expect(redactUrl(`${P}/notifications?a=1&b=%ZZ&next=${layer(REPORTED[1].build(T), 1)}`)).toBe(`${P}/notifications`);
    });
  });
});

describe('redactUrl — bounded work on long and adversarial input', () => {
  const T = 'UNITBOUNDEDTOKEN0123456789';
  const time = <R>(fn: () => R): { out: R; ms: number } => {
    const start = performance.now();
    const out = fn();
    return { out, ms: performance.now() - start };
  };
  // Generous: the point is "no catastrophic blow-up", not a benchmark. These
  // inputs are far longer than any request line the HTTP parser accepts.
  const BUDGET_MS = 3000;

  it('a very long harmless query is returned unchanged, quickly', () => {
    const url = `${P}/notifications?${Array.from({ length: 20_000 }, (_, i) => `k${i}=v${i}`).join('&')}`;
    const { out, ms } = time(() => redactUrl(url));
    expect(out).toBe(url);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('a very long value of malformed escapes with no invite signal is returned unchanged, quickly', () => {
    const url = `${P}/notifications?x=${'%Z'.repeat(50_000)}&y=${'%ZZ'.repeat(30_000)}`;
    const { out, ms } = time(() => redactUrl(url));
    expect(out).toBe(url);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('worst-case malformed-escape input (the tolerant reader\'s full state space) is classified in linear time', () => {
    // Every letter of "invites" separated by a bad escape, repeated: the
    // reading can begin at every position and every escape may swallow 0-2
    // characters. It IS sensitive — and must not take exponential time.
    const chunk = 'i%Zn%Zv%Zi%Zt%Ze%Zs';
    const url = `${P}/notifications?next=${chunk.repeat(5_000)}/${T}`;
    const { out, ms } = time(() => redactUrl(url));
    expect(out).toBe(`${P}/notifications`);
    expect(ms).toBeLessThan(BUDGET_MS);

    const asPath = time(() => redactUrl(`${P}/${chunk.repeat(5_000)}/${T}`));
    expect(asPath.out).toBe(REDACTED);
    expect(asPath.ms).toBeLessThan(BUDGET_MS);
  });

  it('a sensitive part at the very END of a very long query is still found, and everything is omitted', () => {
    const harmless = Array.from({ length: 20_000 }, (_, i) => `k${i}=v${i}`).join('&');
    for (const spelling of REPORTED) {
      const url = `${P}/notifications?${harmless}&next=${layer(spelling.build(T), 1)}`;
      const { out, ms } = time(() => redactUrl(url));
      expect(out).toBe(`${P}/notifications`);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it('deeply nested encoding is bounded (fixed decode rounds), and an unresolved nest fails closed', () => {
    const link = REPORTED[1].build(T);
    for (const depth of [4, 5, 6, 12, 40]) {
      const { out, ms } = time(() => redactUrl(`${P}/notifications?next=${layer(link, depth)}`));
      expect(out, `depth ${depth}`).toBe(`${P}/notifications`);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it('a very long path is judged in bounded time too', () => {
    const { out, ms } = time(() => redactUrl(`${P}/${'a/'.repeat(100_000)}groups/invites/${T}`));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(T);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

// ─── the real server ──────────────────────────────────────────────────────────

let dbAvailable = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbAvailable = false;
}
const describeIf = dbAvailable ? describe : describe.skip;

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

describeIf('real buildServer: an embedded invite link is never logged, whatever its spelling', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  const sink = captureSink();
  let ip = 0;
  const nextIp = () => `10.60.${(ip >> 8) & 255}.${(ip++ & 255) || 1}`;

  let owner: { id: string; email: string; username: string };
  let realToken: string;
  let authHeader: Record<string, string>;
  let port = 0;

  beforeAll(async () => {
    server = await buildServer({ logStream: sink.stream, logLevel: 'trace' });
    await server.ready();

    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const created = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}own-${suffix}@test.local`,
        username: `lrq_${suffix}`.slice(0, 30),
        passwordHash: 'fixture-only-not-a-real-hash',
        status: 'ACTIVE',
        isVerified: true,
      },
    });
    owner = { id: created.id, email: created.email!, username: created.username };
    const group = await prisma.group.create({
      data: { ownerId: owner.id, name: `LogRedQuery-${suffix}`, isPrivate: true, status: 'ACTIVE' },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
    });
    // A REAL, live invite token: it resolves on the actual route.
    realToken = `REALQUERYTOKEN${randomUUID().replaceAll('-', '')}`;
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
      // Coin provenance/allocation rows are a real foreign key to User —
      // must be cleared before the user row itself can be deleted. Covers
      // both rows this run created AND legacy backfill rows for any stale
      // fixture user left behind by a prior interrupted run (same id set).
      await prisma.coinAllocation.deleteMany({ where: { userId: { in: ids } } });
      await prisma.coinProvenance.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    await server.close();
    await prisma.$disconnect();
  });

  function parseRecords(text: string): LogRecord[] {
    return text
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as LogRecord);
  }

  /** Fire a request with inject(); return the response and every record it caused. */
  async function fire(url: string, opts: { authed?: boolean } = {}) {
    const before = sink.lines.length;
    const resp = await server.inject({
      method: 'GET',
      url,
      headers: opts.authed ? authHeader : {},
      remoteAddress: nextIp(),
    });
    // The completion line is written as the response finishes; let it land.
    await new Promise((r) => setTimeout(r, 40));
    const text = sink.lines.slice(before).join('');
    return { resp: { statusCode: resp.statusCode, body: resp.body }, text, records: parseRecords(text) };
  }

  /**
   * Fire a request over a real socket. inject() drops a URL fragment before the
   * request is built; a hand-written request line keeps it, and the server logs
   * whatever the request line said.
   */
  async function fireRaw(target: string, opts: { authed?: boolean } = {}) {
    if (!port) {
      await server.listen({ port: 0, host: '127.0.0.1' });
      port = (server.server.address() as net.AddressInfo).port;
    }
    const before = sink.lines.length;
    const head = [`GET ${target} HTTP/1.1`, 'Host: localhost', 'Connection: close'];
    if (opts.authed) head.push(`Authorization: ${authHeader.authorization}`);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`${head.join('\r\n')}\r\n\r\n`));
      let buf = '';
      socket.on('data', (d) => (buf += d.toString()));
      socket.on('error', reject);
      socket.on('close', () => resolve(buf));
    });
    await new Promise((r) => setTimeout(r, 60));
    const text = sink.lines.slice(before).join('');
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]);
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    return { resp: { statusCode: status, body }, text, records: parseRecords(text) };
  }

  const urlFields = (records: LogRecord[]) =>
    records.flatMap((r) => [r.url, r.req?.url]).filter((u): u is string => typeof u === 'string');

  /** The parts of a response that must not depend on what was in the query. */
  const essence = (body: string) => {
    const parsed = JSON.parse(body);
    return { success: parsed.success, error: parsed.error, data: parsed.data };
  };

  const baseline: Record<string, { statusCode: number; essence: unknown }> = {};
  async function baselineFor(authed: boolean) {
    const key = authed ? 'authed' : 'anon';
    if (!baseline[key]) {
      const { resp } = await fire(`${P}/notifications`, { authed });
      baseline[key] = { statusCode: resp.statusCode, essence: essence(resp.body) };
    }
    return baseline[key];
  }

  const FORMS: Array<[string, number]> = [
    ['raw', 0],
    ['encoded', 1],
    ['nested-encoded', 2],
  ];
  const SHAPES: Array<[string, (form: string) => string]> = [
    ['as a parameter VALUE', (form) => `?next=${form}`],
    ['as a parameter NAME', (form) => `?${form}=1`],
    ['as a VALUE beside harmless parameters', (form) => `?page=1&next=${form}&limit=5`],
  ];

  describe.each([
    ['the reported spellings', REPORTED],
    ['the reported spellings with the "i" of invites encoded (no literal word in the raw text)', REPORTED_NO_LITERAL_WORD],
  ] as Array<[string, Spelling[]]>)('%s', (_title, spellings) => {
    for (const spelling of spellings) {
      for (const [formName, depth] of FORMS) {
        for (const [shapeName, shape] of SHAPES) {
          it(`${spelling.name} — ${formName}, ${shapeName}: token never logged, query omitted, native status and body`, async () => {
            let n = 0;
            for (const authed of [false, true]) {
              const expected = await baselineFor(authed);
              for (const kind of ['a live', 'a nonexistent'] as const) {
                const token = kind === 'a live' ? realToken : `QUERYLEAK${String(n++).padStart(2, '0')}${randomUUID().replaceAll('-', '')}`;
                const query = shape(layer(spelling.build(token), depth));
                const label = `${spelling.name} / ${formName} / ${shapeName} / ${authed ? 'authenticated' : 'anonymous'} / ${kind} token`;

                const { resp, text, records } = await fire(`${P}/notifications${query}`, { authed });

                // ── the response: unchanged routing, status and body, nothing reflected ──
                expect(resp.statusCode, `status (${label})`).toBe(expected.statusCode);
                expect(essence(resp.body), `body (${label})`).toEqual(expected.essence);
                expect(resp.body, `body reflects the token (${label})`).not.toContain(token);
                expect(resp.body, `body reflects the query (${label})`).not.toContain(query.slice(1));
                expect(resp.body, `body mentions the route (${label})`).not.toMatch(/invites/i);

                // ── the logs: every string of every record ──
                expect(records.length, `the capture is capturing (${label})`).toBeGreaterThan(0);
                expect(text, `raw log output carries the token (${label})`).not.toContain(token);
                expect(text, `raw log output carries the encoded token (${label})`).not.toContain(encodeURIComponent(token));
                expect(text, `raw log output carries the query (${label})`).not.toContain(query.slice(1));
                for (const record of records) {
                  for (const str of allStrings(record)) {
                    expect(str, `a log field carries the token (${label})`).not.toContain(token);
                    expect(str, `a log field carries the query (${label})`).not.toContain(query.slice(1));
                  }
                }
                // Every structured URL field reads exactly the ordinary path.
                const fields = urlFields(records);
                expect(fields.length, `some url field is written (${label})`).toBeGreaterThan(0);
                for (const field of fields) expect(field, `url field (${label})`).toBe(`${P}/notifications`);
                expect(records.find((r) => r.msg === 'incoming request')?.req?.url, `serialized request line (${label})`).toBe(`${P}/notifications`);
                expect(records.find((r) => r.msg === 'Incoming request')?.url, `request-logger line (${label})`).toBe(`${P}/notifications`);
              }
            }
          }, 60_000);
        }
      }
    }
  });

  describe('consistency on the wire: a path that fails closed also fails closed when embedded', () => {
    it.each(OTHER_SENSITIVE_PATHS.map((s) => [s.name, s] as [string, Spelling]))('%s', async (_name, spelling) => {
      for (const depth of [0, 1, 2]) {
        const token = `WIRETOKEN${randomUUID().replaceAll('-', '')}`;
        const query = `?next=${layer(spelling.build(token), depth)}`;
        const { resp, text, records } = await fire(`${P}/notifications${query}`, { authed: true });
        expect(resp.statusCode, `${spelling.name} x${depth}`).toBe(200);
        expect(resp.body).not.toContain(token);
        expect(text, `${spelling.name} x${depth}`).not.toContain(token);
        for (const field of urlFields(records)) expect(field, `${spelling.name} x${depth}`).toBe(`${P}/notifications`);
      }
    }, 60_000);
  });

  it('a path that only ALMOST names the route, with the token in its QUERY, is logged as [REDACTED] and answered as an ordinary 404', async () => {
    for (const authed of [false, true]) {
      for (const token of [realToken, `ALMOSTLEAK${randomUUID().replaceAll('-', '')}`]) {
        const label = `${authed ? 'authenticated' : 'anonymous'} / ${token === realToken ? 'live' : 'nonexistent'} token`;
        const { resp, text, records } = await fire(`${P}/groups%20/invites?token=${token}`, { authed });
        expect(resp.statusCode, `status (${label})`).toBe(404);
        expect(resp.body, `body (${label})`).not.toContain(token);
        expect(text, `raw log output carries the token (${label})`).not.toContain(token);
        const fields = urlFields(records);
        expect(fields.length, `some url field is written (${label})`).toBeGreaterThan(0);
        for (const field of fields) expect(field, `url field (${label})`).toBe(REDACTED);
      }
    }
  });

  describe('a fragment in the request line', () => {
    it.each([
      ['the exact route, raw', (t: string) => `#/groups/invites/${t}`],
      ['the exact route as a parameter of the fragment', (t: string) => `#next=/groups/invites/${t}`],
      ['spelling A', (t: string) => `#${REPORTED[0].build(t)}`],
      ['spelling B', (t: string) => `#${REPORTED[1].build(t)}`],
      ['spelling A, encoded, after a query', (t: string) => `?a=1#next=${layer(REPORTED[0].build(t), 1)}`],
      ['spelling B, encoded, after a query', (t: string) => `?a=1#next=${layer(REPORTED[1].build(t), 1)}`],
    ] as Array<[string, (t: string) => string]>)('%s is never logged', async (_name, build) => {
      for (const authed of [false, true]) {
        for (const token of [realToken, `FRAGLEAK${randomUUID().replaceAll('-', '')}`]) {
          const suffix = build(token);
          const label = `${_name} / ${authed ? 'authenticated' : 'anonymous'}`;
          const { resp, text, records } = await fireRaw(`${P}/notifications${suffix}`, { authed });
          expect(resp.statusCode, `status (${label})`).toBe(authed ? 200 : 401);
          expect(resp.body, `body (${label})`).not.toContain(token);
          expect(text, `raw log output carries the token (${label})`).not.toContain(token);
          const fields = urlFields(records);
          expect(fields.length, `some url field is written (${label})`).toBeGreaterThan(0);
          for (const field of fields) expect(field, `url field (${label})`).toBe(`${P}/notifications`);
        }
      }
    }, 60_000);

    it('a harmless fragment is logged as it came', async () => {
      const { resp, records } = await fireRaw(`${P}/notifications?x=1#top`, { authed: true });
      expect(resp.statusCode).toBe(200);
      for (const field of urlFields(records)) expect(field).toBe(`${P}/notifications?x=1#top`);
    });
  });

  describe('controls — harmless queries are logged byte for byte in every url field', () => {
    it.each(HARMLESS_URLS.filter((u) => !u.includes('#')).map((u) => [u] as [string]))('%s', async (url) => {
      for (const authed of [false, true]) {
        const { resp, records } = await fire(url, { authed });
        expect([200, 400, 401]).toContain(resp.statusCode);
        const fields = urlFields(records);
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) expect(field, `url field (authed=${authed})`).toBe(url);
        expect(records.some((r) => allStrings(r).some((s) => s.includes(REDACTED)))).toBe(false);
      }
    });
  });

  describe('a bounded long-input control against the real request parser', () => {
    // Node's HTTP parser caps the request line (~16 KB), so the real server can
    // only ever be handed this much. It must stay fast and exact.
    it('a ~12 KB harmless query is logged unchanged; the same query with an embedded link at the end is omitted', async () => {
      const harmless = Array.from({ length: 900 }, (_, i) => `k${i}=v${i}`).join('&'); // ~9 KB
      const okUrl = `${P}/notifications?${harmless}`;
      const ok = await fire(okUrl, { authed: true });
      expect(ok.resp.statusCode).toBe(200);
      for (const field of urlFields(ok.records)) expect(field).toBe(okUrl);

      const token = `LONGQUERYLEAK${randomUUID().replaceAll('-', '')}`;
      const badUrl = `${okUrl}&next=${layer(REPORTED[1].build(token), 1)}`;
      const started = Date.now();
      const bad = await fire(badUrl, { authed: true });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(bad.resp.statusCode).toBe(200);
      expect(bad.text).not.toContain(token);
      for (const field of urlFields(bad.records)) expect(field).toBe(`${P}/notifications`);
    });
  });

  it('the live invite token appeared in no log line written across this whole suite', () => {
    expect(sink.lines.join('')).not.toContain(realToken);
  });
});
