/**
 * URL redaction for logs.
 *
 * `GET /groups/invites/:token` carries a bearer-equivalent secret in the
 * path: anyone holding that token can redeem the invitation. Request URLs
 * reach logs from three places — Fastify's own automatic request/response
 * lines (via the `req` serializer), this codebase's `requestLogger`, and the
 * not-found handler — and log sinks are routinely shipped, indexed, and
 * retained far longer than the invite's own expiry. None may emit the raw
 * token.
 *
 * ── Why a plain regex on the raw URL is not enough ────────────────────────
 * The router matches on the DECODED path, so a request can reach (or narrowly
 * miss) the token route while the raw string spells it differently:
 *
 *   /api/v1/%67roups/invites/TOKEN        %67 is "g"
 *   /api/v1/groups/%69nvites/TOKEN        %69 is "i"
 *   /api/v1/groups/in%76ites/TOKEN        partially encoded
 *   /api/v1/%2567roups/invites/TOKEN      double-encoded
 *   /api/v1/groups%2Finvites%2FTOKEN      encoded separators
 *   /api/v1//groups///invites//TOKEN      repeated separators
 *
 * A literal `groups/invites/` pattern misses the encoded-letter forms, and
 * measured against the real server every one of them logged the token.
 *
 * ── Approach: canonicalize to DETECT, redact the RAW span ────────────────
 * 1. Decode percent-escapes that stand for ASCII characters — only those,
 *    and never throwing: a malformed escape (`%ZZ`, a trailing `%`) is left
 *    exactly as it is, and an escape for a non-ASCII byte is left encoded, so
 *    this cannot fail on bad input or fabricate a lone surrogate. It repeats
 *    (bounded) so double-encoding is undone too.
 * 2. Every canonical character remembers the raw span it came from, so
 *    detection on the canonical form can be turned back into an exact raw
 *    range.
 * 3. Detect `groups` followed by `invites` followed by a token segment
 *    (case-insensitive; `/` and `\` both separate; repeated separators and
 *    `.` segments are ignored).
 * 4. Replace the raw token region — from the token's first raw character up
 *    to the next literal `/`, or the end of the path — with a marker.
 *
 * The result keeps the raw prefix and any trailing segments, so logs stay
 * useful for debugging (method, route, status and even how the client spelled
 * the URL) and only the secret is removed. The query string and fragment are
 * NEVER appended after a recognized invite route — a request URL that carried
 * an invite token has already proven it can carry the secret in its query too
 * (`?...token=<token>`), so nothing after the path is logged. A URL that
 * contains no token route is returned UNCHANGED, byte for byte, UNLESS its
 * query or fragment carries an invite link (see "One classifier" below), in
 * which case the whole suffix is omitted.
 *
 * The token region deliberately runs to the next LITERAL slash rather than to
 * the next canonical separator: a token spelled with an encoded slash
 * (`TOK%2FEN`) is one region and is redacted whole, not split with its tail
 * left in the clear.
 *
 * ── Malformed and ambiguous paths ─────────────────────────────────────────
 * The router refuses a path holding a malformed escape (`%ZZ`, a lone `%`) as
 * a bad URL, but only AFTER Fastify has logged the request line — and a real
 * invite link mangled in transit (a paste, a mail client, a shortener) is
 * exactly such a path. It carries the real token, so it gets the strictest
 * treatment, not the loosest. The rules, in order:
 *
 *   1. Decoding is TOLERANT. Every well-formed escape is decoded whatever else
 *      the path holds; a malformed escape is left where it is and RECORDED, and
 *      does not stop the rest of the path from being understood. (Reading
 *      "malformed" as "give up decoding" is how `%ZZ%67roups/%69nvites/TOKEN`
 *      once slipped through: `%ZZ` and `%67` sit side by side, and the route
 *      words are only visible if `%67` and `%69` are decoded around it.)
 *   2. If the CANONICAL text spells the route exactly, only the token is
 *      masked, as above. A malformed escape elsewhere in the path — before the
 *      route, in the token, after it — does not stop that.
 *   3. If a malformed escape COULD be hiding the route — the route appears
 *      once each malformed escape is erased, together with up to two
 *      characters it may have swallowed — the boundary of the token cannot be
 *      trusted, so the WHOLE URL is omitted (`[REDACTED]`), never logged raw.
 *      Every escape's reach is chosen independently (see couldRead), so the
 *      outcome does not depend on how a particular typo happened to be
 *      spelled.
 *   4. Both representations are inspected, never just one: the RAW text
 *      (`invites` written out) and the CANONICAL text (`invites` only after
 *      decoding, or once a malformed escape is erased). Either one showing the
 *      word in a path that holds an escape is enough to fail closed — the
 *      canonical one, when nothing is malformed, only if a further segment
 *      follows the word (a would-be token: `/groups%20/%69nvites/<token>`), so
 *      that `/groups/%69nvites` on its own, with no token to hide, is left alone.
 *   5. A URL with no such signal — no escape at all, or a malformed one in a
 *      path that never mentions an invite — is returned byte for byte, so
 *      ordinary logs lose nothing.
 *
 * ── One classifier for every part of the URL ──────────────────────────────
 * The rules above are a single function, classifyInvitePath, and it judges
 * every piece of a request URL that could carry an invite link:
 *
 *   - the PATH;
 *   - each query parameter NAME and each query parameter VALUE;
 *   - the FRAGMENT.
 *
 * It answers `route` (the canonical text spells the route exactly, and where
 * each token starts is known), `ambiguous` (a route may be there, mangled, and
 * its token boundary cannot be trusted) or `clean`. A path that is `ambiguous`
 * fails closed as the whole URL. A query or fragment part that is `route` OR
 * `ambiguous` — any single one — omits the WHOLE suffix (every parameter, not
 * just the guilty one), keeping the clean path.
 *
 * Judging a query part by the same function is what keeps a link that fails
 * closed as a path (`/groups%20/invites/<token>`, `/groups%ZZinvites/<token>`)
 * from being logged when the very same text is pasted into `?next=` — as a
 * name or a value, raw or percent-encoded, nested or not. Nothing here calls
 * redactUrl, and nothing calls itself: a query part is never re-parsed as a
 * URL, so there is no recursion to bound.
 *
 * The suffix is split on the RAW `?`, `#` and `&` FIRST, and only then is each
 * part canonicalized and judged, so an escape that decodes to a delimiter
 * (`%26` -> `&`) cannot spawn a second parameter after this already classified
 * the first as safe.
 *
 * Work is bounded throughout: at most MAX_DECODE_ROUNDS passes to decode, then
 * one linear pass per segment for the tolerant reading; there is no loop that
 * runs until the input stops changing. A suffix is judged part by part, each
 * part once, so the total is linear in its length.
 */

const REDACTED = '[REDACTED]';
const MAX_DECODE_ROUNDS = 4;

/** One character of the canonical form, and the raw span it came from. */
interface CanonicalChar {
  ch: string;
  /** Index of the first raw UTF-16 unit this character stands for. */
  start: number;
  /** Index one past the last raw unit this character stands for. */
  end: number;
}

const isHexDigit = (ch: string): boolean => /^[0-9a-fA-F]$/.test(ch);

interface CanonicalResult {
  chars: CanonicalChar[];
  /** True when the decode bound was reached while there was still work to do
   *  (the last round changed something). In this case the canonical form may
   *  still encode the invite route, so the caller must fail-closed. */
  truncated: boolean;
}

/**
 * Decode ASCII percent-escapes to a fixed point, keeping a raw-span map.
 * Never throws; anything not a well-formed ASCII escape is left as it is.
 * Returns both the decoded characters and a flag indicating whether the
 * bounded decoder stopped before reaching a fixpoint.
 */
function canonicalize(raw: string): CanonicalResult {
  let chars: CanonicalChar[] = [];
  for (let i = 0; i < raw.length; i++) chars.push({ ch: raw[i], start: i, end: i + 1 });

  let truncated = true;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next: CanonicalChar[] = [];
    let changed = false;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (c.ch === '%' && i + 2 < chars.length && isHexDigit(chars[i + 1].ch) && isHexDigit(chars[i + 2].ch)) {
        const code = parseInt(chars[i + 1].ch + chars[i + 2].ch, 16);
        if (code < 0x80) {
          next.push({ ch: String.fromCharCode(code), start: c.start, end: chars[i + 2].end });
          i += 2;
          changed = true;
          continue;
        }
      }
      next.push(c);
    }
    chars = next;
    if (!changed) {
      truncated = false;
      break;
    }
  }
  return { chars, truncated };
}

const isSeparator = (ch: string): boolean => ch === '/' || ch === '\\';

/**
 * True when `chars[i]` is a `%` that does not begin a well-formed `%XX` escape:
 * bad hex digits, or a `%` cut short by the end of the path. (A well-formed
 * escape for a non-ASCII byte is NOT malformed; it is left encoded on purpose.)
 */
function isMalformedEscape(chars: readonly CanonicalChar[], i: number): boolean {
  return (
    chars[i].ch === '%' &&
    !(i + 2 < chars.length && isHexDigit(chars[i + 1].ch) && isHexDigit(chars[i + 2].ch))
  );
}

/** How many characters after its `%` a malformed escape may plausibly have swallowed. */
const MAX_ESCAPE_TAIL = 2;

interface Segment {
  text: string;
  firstChar: CanonicalChar;
  /** For each character of `text`: does it begin a malformed escape? */
  malformedAt: boolean[];
}

/** Split a canonical path into non-empty segments, ignoring '.' segments. */
function segmentsOf(pathChars: readonly CanonicalChar[]): Segment[] {
  const segments: Segment[] = [];
  let current: number[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((k) => pathChars[k].ch).join('');
    if (text !== '.') {
      segments.push({
        text,
        firstChar: pathChars[current[0]],
        malformedAt: current.map((k) => isMalformedEscape(pathChars, k)),
      });
    }
    current = [];
  };
  pathChars.forEach((c, k) => {
    if (isSeparator(c.ch)) flush();
    else current.push(k);
  });
  flush();
  return segments;
}

/**
 * Whether `segment` COULD read as `word` — as the whole segment, or (`within`)
 * as a run somewhere inside it — once each malformed escape in it is erased
 * together with 0 to MAX_ESCAPE_TAIL characters it may have swallowed. Every
 * escape's reach is chosen independently, so `i%ZZn%Zvites` (two escapes of
 * different widths in one word) reads as `invites`, and no particular
 * spelling of the mangling is what decides the outcome.
 *
 * A small dynamic program over the segment, one bitmask of reachable word
 * positions per index: linear in the segment, bounded by the word's length.
 */
function couldRead(segment: Segment, word: string, mode: 'whole' | 'within'): boolean {
  if (!segment.malformedAt.some(Boolean)) {
    const text = segment.text.toLowerCase();
    return mode === 'whole' ? text === word : text.includes(word);
  }
  const n = segment.text.length;
  const goal = 1 << word.length;
  const reach = new Array<number>(n + 1).fill(0);
  reach[0] = 1;
  for (let i = 0; i < n; i++) {
    if (mode === 'within') reach[i] |= 1; // a run may begin anywhere
    const here = reach[i];
    if (here === 0) continue;
    if (segment.malformedAt[i]) {
      for (let tail = 0; tail <= MAX_ESCAPE_TAIL && i + 1 + tail <= n; tail++) reach[i + 1 + tail] |= here;
    }
    const ch = segment.text[i].toLowerCase();
    for (let j = 0; j < word.length; j++) {
      if (here & (1 << j) && ch === word[j]) reach[i + 1] |= 1 << (j + 1);
    }
  }
  return mode === 'whole' ? (reach[n] & goal) !== 0 : reach.some((mask) => (mask & goal) !== 0);
}

/**
 * Raw index where the token of EVERY `/groups/invites/<token>` route in the
 * path begins (empty when there is none). All of them, not just the first: a
 * second route further along — a link pasted twice, trailing components that
 * spell another one — is just as secret.
 *
 * `tolerant` reads each word the way {@link couldRead} does, and skips a
 * segment that is nothing BUT malformed escapes (it may be erased to nothing).
 */
function findTokenStarts(segments: readonly Segment[], tolerant: boolean, consumed?: Set<number>): number[] {
  const list = tolerant ? segments.filter((seg) => !couldRead(seg, '', 'whole')) : segments;
  const isWord = (seg: Segment, word: string) =>
    tolerant ? couldRead(seg, word, 'whole') : seg.text.toLowerCase() === word;
  const starts: number[] = [];
  for (let i = 0; i + 2 < list.length; i++) {
    if (isWord(list[i], 'groups') && isWord(list[i + 1], 'invites')) {
      starts.push(list[i + 2].firstChar.start);
      // (Indices are into `segments` only for the exact reading, where
      // `list` is `segments`; the tolerant reading never asks for them.)
      consumed?.add(i).add(i + 1).add(i + 2);
    }
  }
  return starts;
}

/**
 * Replace the token region of each route with a marker. A region runs from the
 * token's first raw character to the next LITERAL `/` (or the end of the path);
 * overlapping regions are merged. Returns the PATH ONLY — the caller decides
 * whether the query string and fragment may follow it, so no raw suffix can be
 * smuggled out after a recognized invite path.
 */
function maskTokenRegions(url: string, pathEnd: number, starts: readonly number[]): string {
  const sorted = [...starts].sort((a, b) => a - b);
  let out = '';
  let cursor = 0;
  for (const start of sorted) {
    if (start < cursor) continue; // inside a region already masked
    const nextSlash = url.indexOf('/', start);
    const end = nextSlash === -1 || nextSlash > pathEnd ? pathEnd : nextSlash;
    out += url.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return out + url.slice(cursor, pathEnd);
}

/** The verdict of {@link classifyInvitePath} on one piece of text. */
type InviteVerdict =
  /** No invite signal. */
  | { kind: 'clean' }
  /** A route may be present, mangled: its token boundary cannot be trusted. */
  | { kind: 'ambiguous' }
  /** The canonical text spells the route exactly; the RAW index where each token begins. */
  | { kind: 'route'; tokenStarts: number[] };

const CLEAN: InviteVerdict = { kind: 'clean' };
const AMBIGUOUS: InviteVerdict = { kind: 'ambiguous' };

/**
 * THE invite-path sensitivity classifier — one bounded function for a URL path,
 * a query parameter name, a query parameter value and a fragment alike (see
 * "One classifier for every part of the URL" in the file header). `text` is the
 * RAW text of ONE such piece; nothing else is consulted.
 *
 * The rules, in order (each is a fail-closed reading, and only an ambiguity is
 * ever resolved toward "sensitive"):
 *   1. bounded decoding left an escape unresolved — the route may be hiding
 *      under another layer of encoding;
 *   2. with a malformed escape in the text: a route that shows only once the
 *      escape is erased, or any segment the exact reading did not account for
 *      that could read `invites`, means the token boundary is unknowable;
 *   3. otherwise the exact reading decides: `route`;
 *   4. with no route recognized and an escape in the text: the RAW text writes
 *      `invites` out, or the CANONICAL text writes it (`%69nvites`) in a
 *      segment that another segment follows — a would-be token.
 */
function classifyInvitePath(text: string): InviteVerdict {
  // Cheap exit for the overwhelming majority of text: with no escape, no
  // backslash and no "invites" anywhere, there is nothing to find.
  if (!text.includes('%') && !text.includes('\\') && !/invites/i.test(text)) return CLEAN;

  const { chars, truncated } = canonicalize(text);

  // If the decode bound was reached before the text settled, the canonical form
  // may still hide the invite route under another layer of encoding. A
  // remaining '%' means an escape was not fully resolved — the raw text need not
  // spell "invites" at all (`%2Fgroups%2Finvites%2F<token>` decodes to it, and
  // past MAX_DECODE_ROUNDS no longer resolves), so the unresolved escapes are
  // the only signal there is. Fail closed rather than return the raw text.
  if (truncated && chars.some((c) => c.ch === '%')) return AMBIGUOUS;

  const segments = segmentsOf(chars);

  // The exact reading: the canonical text spells the route. `consumed` collects
  // the segments a recognized route accounts for — its two words and its token.
  const consumed = new Set<number>();
  const starts = findTokenStarts(segments, false, consumed);

  // The tolerant reading, only when a malformed escape is present. It runs
  // even when the exact reading succeeded, because a malformed escape may hide
  // a SECOND route the exact reading knows nothing about:
  //   - a route that shows only once the escape is erased means the escape sits
  //     in the route, so where its token starts cannot be trusted;
  //   - any other segment that could read `invites` — `invites` written out,
  //     decoded (`%69nvites`) or with a malformed escape erased (`in%ZZvites`,
  //     or one standing in for a separator, `groups%ZZinvites`) — is
  //     invite-looking with nothing to pin down its token.
  // Both fail closed. The raw text alone cannot show either, which is the whole
  // point: reading only the raw text is what let the reported URLs out.
  if (chars.some((_, k) => isMalformedEscape(chars, k))) {
    const exact = new Set(starts);
    if (findTokenStarts(segments, true).some((start) => !exact.has(start))) return AMBIGUOUS;
    if (segments.some((seg, i) => !consumed.has(i) && couldRead(seg, 'invites', 'within'))) return AMBIGUOUS;
  }

  // A recognized route: the caller masks each token, so it needs where they start.
  if (starts.length > 0) return { kind: 'route', tokenStarts: starts };

  // No route recognized. With an escape somewhere in the text, an `invites` that
  // nothing can explain is still a route-shaped secret with an unknowable
  // boundary — `/groups%20/invites/<token>` (nothing malformed, but "groups "
  // is not "groups"):
  if (text.includes('%')) {
    // RAW signal, kept as it was: the text writes `invites` out.
    if (/invites/i.test(text)) return AMBIGUOUS;
    // CANONICAL signal: `invites` appears only once decoded (`%69nvites`), and a
    // further segment follows it — a would-be token. A lone trailing `invites`
    // (`/groups/%69nvites`, no token to hide) is left alone.
    if (segments.some((seg, i) => i + 1 < segments.length && seg.text.toLowerCase().includes('invites'))) {
      return AMBIGUOUS;
    }
  }

  return CLEAN;
}

/**
 * Whether the raw suffix (`?query`, `#fragment`, or both) of a URL whose PATH is
 * clean carries an invite link in ANY of its query parameter NAMES, its
 * parameter VALUES or its fragment. Each is judged by {@link classifyInvitePath}
 * — the same rules as a path — and a single `route` or `ambiguous` verdict is
 * enough: the caller then omits the whole suffix, not just that part.
 *
 * A parameter may smuggle the link in either its NAME or its VALUE (a name is
 * only "harmless" if it says so after decoding), and a request line can carry a
 * fragment (a client, proxy or hand-written request need not strip it), which
 * Fastify then logs like any other URL.
 */
function suffixCarriesInviteLink(rawSuffix: string): boolean {
  const hashAt = rawSuffix.indexOf('#');
  const query = rawSuffix[0] === '?' ? rawSuffix.slice(1, hashAt === -1 ? undefined : hashAt) : '';
  const fragment = hashAt === -1 ? '' : rawSuffix.slice(hashAt + 1);
  const sensitive = (part: string) => part !== '' && classifyInvitePath(part).kind !== 'clean';

  if (sensitive(fragment)) return true;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    // Without a "=", the whole pair is the NAME (and there is no value).
    if (eq === -1 ? sensitive(pair) : sensitive(pair.slice(0, eq)) || sensitive(pair.slice(eq + 1))) return true;
  }
  return false;
}

/**
 * Replace the invite token in a URL (or path) with a redaction marker.
 * Returns the input unchanged — the very same string — when it carries none.
 *
 * The PATH is judged first, by {@link classifyInvitePath}:
 *   - `ambiguous` returns the marker for the WHOLE url: the bounded decoder
 *     could not fully resolve it, or a malformed escape could be hiding a route
 *     whose token boundary is unknowable, or it holds an escape and writes
 *     `invites` out with no route recognized. See "Malformed and ambiguous
 *     paths" in the file header.
 *   - `route` masks each token and omits the query string and fragment: the
 *     token's boundary is known, but the URL carried an invite secret, so
 *     nothing after the path is returned.
 *   - `clean` keeps the path, and the suffix with it — unless
 *     {@link suffixCarriesInviteLink} finds an invite link in it, in which case
 *     the whole suffix is dropped. Retention is decided by that classification,
 *     never by the text that happens to remain.
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;

  // Cheap exit for the overwhelming majority of requests: with no escape, no
  // backslash and no "invites" anywhere, there is nothing to find.
  if (!url.includes('%') && !url.includes('\\') && !/invites/i.test(url)) return url;

  // The query string and fragment are never part of the route. Split them off
  // on the RAW string, the way the router does; each is judged on its own.
  const queryStart = url.search(/[?#]/);
  const pathEnd = queryStart === -1 ? url.length : queryStart;
  const rawPath = url.slice(0, pathEnd);
  const rawSuffix = url.slice(pathEnd);

  const path = classifyInvitePath(rawPath);
  if (path.kind === 'ambiguous') return REDACTED;
  // A recognized invite route: mask the token AND drop the query string and
  // fragment. The boundary is known, so the path itself is safe to keep — but
  // this URL carried an invite secret, so nothing after it is appended.
  if (path.kind === 'route') return maskTokenRegions(url, pathEnd, path.tokenStarts);

  // The path is clean. A query name or value, or the fragment, may still carry
  // an invite link (raw or encoded — `/ordinary?next=/groups/invites/<token>`),
  // and logging the suffix would ship the embedded secret.
  if (rawSuffix !== '' && suffixCarriesInviteLink(rawSuffix)) return rawPath;

  return url;
}

/**
 * Whether `text` — an error message, say — quotes a path that is, or could be,
 * an invite-token route, in any spelling {@link redactUrl} recognizes. Sharing
 * the one recognizer means a message and a URL are judged by the same rules:
 * a spelling that cannot slip past the log cannot slip past the response.
 */
export function quotesInviteTokenRoute(text: unknown): boolean {
  return typeof text === 'string' && redactUrl(text) !== text;
}

/**
 * Pino `req` serializer mirroring Fastify's default shape, with the URL
 * passed through {@link redactUrl}. Registering this replaces Fastify's
 * built-in serializer, which would otherwise log `req.url` verbatim.
 */
export function redactedRequestSerializer(request: {
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remotePort?: number };
}) {
  return {
    method: request.method,
    url: redactUrl(request.url ?? ''),
    host: request.headers?.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
