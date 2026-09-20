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
 * The result keeps the raw prefix, any trailing segments, and the query
 * string, so logs stay useful for debugging (method, route, status and even
 * how the client spelled the URL) and only the secret is removed. A URL that
 * contains no token route is returned UNCHANGED, byte for byte.
 *
 * The token region deliberately runs to the next LITERAL slash rather than to
 * the next canonical separator: a token spelled with an encoded slash
 * (`TOK%2FEN`) is one region and is redacted whole, not split with its tail
 * left in the clear.
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

/**
 * Decode ASCII percent-escapes to a fixed point, keeping a raw-span map.
 * Never throws; anything not a well-formed ASCII escape is left as it is.
 */
function canonicalize(raw: string): CanonicalChar[] {
  let chars: CanonicalChar[] = [];
  for (let i = 0; i < raw.length; i++) chars.push({ ch: raw[i], start: i, end: i + 1 });

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
    if (!changed) break;
  }
  return chars;
}

const isSeparator = (ch: string): boolean => ch === '/' || ch === '\\';

/**
 * Raw index where the token of a `/groups/invites/<token>` route begins, or
 * -1 when the path is not such a route.
 */
function findTokenStart(pathChars: CanonicalChar[]): number {
  // Split the canonical path into non-empty segments, ignoring '.' segments.
  interface Segment {
    text: string;
    firstChar: CanonicalChar;
  }
  const segments: Segment[] = [];
  let current: CanonicalChar[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((c) => c.ch).join('');
    if (text !== '.') segments.push({ text, firstChar: current[0] });
    current = [];
  };
  for (const c of pathChars) {
    if (isSeparator(c.ch)) flush();
    else current.push(c);
  }
  flush();

  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i].text.toLowerCase() === 'groups' && segments[i + 1].text.toLowerCase() === 'invites') {
      return segments[i + 2].firstChar.start;
    }
  }
  return -1;
}

/**
 * Replace the invite token in a URL (or path) with a redaction marker.
 * Returns the input unchanged — the very same string — when it carries none.
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

  const pathChars = canonicalize(url).filter((c) => c.end <= pathEnd);
  const tokenStart = findTokenStart(pathChars);
  if (tokenStart === -1) return url;

  // The token region ends at the next literal '/', or at the end of the path.
  const nextSlash = url.indexOf('/', tokenStart);
  const tokenEnd = nextSlash === -1 || nextSlash > pathEnd ? pathEnd : nextSlash;

  return url.slice(0, tokenStart) + REDACTED + url.slice(tokenEnd);
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
