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
 * contains no token route is returned UNCHANGED, byte for byte, UNLESS a query
 * VALUE itself spells an invite-token route (raw or encoded
 * `?next=/groups/invites/<token>`), in which case the query is omitted.
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
 *      word in a path that holds an escape is enough to fail closed.
 *   5. A URL with no such signal — no escape at all, or a malformed one in a
 *      path that never mentions an invite — is returned byte for byte, so
 *      ordinary logs lose nothing.
 *
 * Work is bounded throughout: at most MAX_DECODE_ROUNDS passes to decode, then
 * one linear pass per segment for the tolerant reading; there is no loop that
 * runs until the input stops changing.
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

/**
 * Whether a single raw query part — a parameter NAME or VALUE — is or
 * contains an invite-token route once its escapes are decoded: a bare
 * `/groups/invites/<token>` or a full URL with one embedded. Shared
 * recognizer with the path, so the same spellings (raw, encoded,
 * double-encoded, malformed-escape-tolerant) cannot slip into a logged query.
 * Fully decode-bounded; a part whose escapes could not be fully resolved fails
 * closed, because a fully percent-encoded route may be hidden under the very
 * layers the bounded decoder had to leave alone.
 */
function valueSpellsInviteRoute(value: string): boolean {
  if (!value.includes('%') && !value.includes('\\') && !/invites/i.test(value)) return false;
  const { chars, truncated } = canonicalize(value);
  const segments = segmentsOf(chars);
  if (findTokenStarts(segments, true).length > 0) return true;
  // Fail closed: bounded decoding left percent escapes unresolved, so the part
  // may still hide a FULLY percent-encoded invite route under another layer of
  // encoding. The raw text need not spell "invites" — `%2Fgroups%2Finvites%2F
  // <token>` decodes to it, and past MAX_DECODE_ROUNDS no longer resolves, so
  // the unresolved escapes are the only signal there is.
  if (truncated && chars.some((c) => c.ch === '%')) return true;
  return false;
}

/**
 * Whether a raw query+fragment suffix (`?...` or `#...`) carries an
 * invite-token route inside one of its query parameter NAMES or VALUES — a
 * parameter may smuggle the link in either (its NAME is only "harmless" if it
 * says so after decoding). Every part is judged by the same recognizer.
 *
 * Delimiter order matters. The suffix is split on RAW `?`, `#` and `&` FIRST,
 * and only then is each part canonicalized and judged, so an escape that
 * decodes to a delimiter (`%26` → `&`) cannot spawn a second parameter after
 * this already classified the first as safe.
 */
function queryCarriesInviteLink(rawSuffix: string): boolean {
  if (rawSuffix[0] !== '?') return false; // a bare fragment has no parameters
  const hashAt = rawSuffix.indexOf('#');
  const query = hashAt === -1 ? rawSuffix.slice(1) : rawSuffix.slice(1, hashAt);
  if (query === '') return false;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? pair : pair.slice(eq + 1);
    if (name !== '' && valueSpellsInviteRoute(name)) return true;
    if (value !== '' && valueSpellsInviteRoute(value)) return true;
  }
  return false;
}

/**
 * Replace the invite token in a URL (or path) with a redaction marker.
 * Returns the input unchanged — the very same string — when it carries none.
 *
 * Fail-closed cases, each returning the marker for the WHOLE url:
 *   - the bounded decoder could not fully resolve the path;
 *   - the path holds a malformed escape and, with that escape erased, spells a
 *     token route the exact reading did not (the token boundary is unknowable);
 *   - the path holds a malformed escape and some segment the exact reading did
 *     not account for could read `invites`;
 *   - the path holds an escape and writes `invites` out, but no route was
 *     recognized.
 * See "Malformed and ambiguous paths" in the file header.
 *
 * Whenever an invite route IS recognized precisely, the query string and
 * fragment are omitted: the token's boundary is known, but the URL carried an
 * invite secret, so nothing after the path is returned. A non-invite path
 * keeps its query only when no query VALUE spells an invite route — retention
 * is decided by that classification, not by the text that happens to remain.
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;

  // Cheap exit for the overwhelming majority of requests: with no escape, no
  // backslash and no "invites" anywhere, there is nothing to find.
  if (!url.includes('%') && !url.includes('\\') && !/invites/i.test(url)) return url;

  // The query string and fragment are never part of the route. Split them off
  // on the RAW string, the way the router does.
  const queryStart = url.search(/[?#]/);
  const pathEnd = queryStart === -1 ? url.length : queryStart;
  const rawPath = url.slice(0, pathEnd);
  const rawSuffix = url.slice(pathEnd);

  const { chars: allChars, truncated } = canonicalize(url);
  const pathChars = allChars.filter((c) => c.end <= pathEnd);

  // If the decode bound was reached before the path settled, the canonical
  // form may still hide the invite route under another layer of encoding.
  // A remaining '%' in the canonical path chars means an escape was not fully
  // resolved — fail closed rather than returning the raw URL.
  if (truncated && pathChars.some((c) => c.ch === '%')) {
    return REDACTED;
  }

  const segments = segmentsOf(pathChars);

  // The exact reading: the canonical text spells the route. `consumed` collects
  // the segments a recognized route accounts for — its two words and its token.
  const consumed = new Set<number>();
  const starts = findTokenStarts(segments, false, consumed);

  // The tolerant reading, only when a malformed escape is on the path. It runs
  // even when the exact reading succeeded, because a malformed escape may hide
  // a SECOND route the exact reading knows nothing about:
  //   - a route that shows only once the escape is erased means the escape sits
  //     in the route, so where its token starts cannot be trusted;
  //   - any other segment that could read `invites` — `invites` written out,
  //     decoded (`%69nvites`) or with a malformed escape erased (`in%ZZvites`,
  //     or one standing in for a separator) — is invite-looking with nothing
  //     to pin down its token.
  // Both fail closed. The raw text alone cannot show either, which is the whole
  // point: reading only the raw text is what let the reported URLs out.
  const malformed = pathChars.some((_, k) => isMalformedEscape(pathChars, k));
  if (malformed) {
    if (findTokenStarts(segments, true).some((start) => !starts.includes(start))) return REDACTED;
    if (segments.some((seg, i) => !consumed.has(i) && couldRead(seg, 'invites', 'within'))) return REDACTED;
  }

  if (starts.length > 0) {
    // A recognized invite route: mask the token AND drop the query string and
    // fragment. The boundary is known, so the path itself is safe to keep —
    // but this URL carried an invite secret, so nothing after it is appended.
    return maskTokenRegions(url, pathEnd, starts);
  }

  // No route recognized. RAW signal, kept as it was: the path holds an escape
  // (of any kind) and writes `invites` out.
  if (rawPath.includes('%') && /invites/i.test(rawPath)) return REDACTED;

  // No invite route on the path. A query VALUE may still spell an invite-token
  // route (raw or encoded — `/ordinary?next=/groups/invites/<token>`), and
  // logging the query would ship the embedded secret. Surf the suffix only
  // when the classification says it is safe.
  if (rawSuffix !== '' && queryCarriesInviteLink(rawSuffix)) return rawPath;

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
