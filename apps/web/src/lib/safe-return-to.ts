/**
 * Validate the location a sign-in should return to.
 *
 * ProtectedRoute hands the login page the location the visitor was turned away
 * from (`{ pathname, search, hash }`); after signing in they should land back
 * on exactly that — an invite link's query string and a deep link's fragment
 * included, not just its path. Anything that is not a plain in-app location
 * falls back to '/'.
 *
 * The rules are conservative on purpose. A return target is a redirect
 * destination, the classic open-redirect shape, so it is accepted only when:
 *
 *  - it is an object with string `pathname` (and, when present, string
 *    `search` beginning "?" and `hash` beginning "#") — no bare strings, no
 *    absolute URLs, no `javascript:`/`data:` schemes;
 *  - the path is rooted at a single "/" — "//host" is protocol-relative, and
 *    browsers treat "/\host" the same way, so any backslash in the path is out;
 *  - it carries no control characters at all — the URL parser silently strips
 *    tab, CR and LF, which would turn "/<TAB>/host" into "//host";
 *  - it is short (an oversized value is never a real location);
 *  - resolved against this origin it stays on this origin, and the RESOLVED
 *    form — dot segments collapsed, exactly what the browser would load — is
 *    still a single-slash path;
 *  - it is not an authentication page, which would loop straight back here;
 *  - it is not hostile once DECODED. Every check above looks at the text as
 *    written, but a path is also read after percent-decoding, and
 *    "/%2F%2Fhost" (or "/%5Chost", or the double-encoded "/%252F%252Fhost")
 *    decodes to a protocol-relative host. So the path is decoded — repeatedly,
 *    up to a bound, since encoding can be nested — and every layer is held to
 *    the same rules: no leading "//", no backslash, no control character, and
 *    no scheme-looking first segment ("/javascript:...", "/https:%2F%2F...").
 *    A path whose FIRST decode is malformed ("%ZZ", a trailing "%", invalid
 *    UTF-8) is rejected outright; a "%" that only appears after a decode is a
 *    literal percent sign ("50%25" is "50%") and is left alone.
 *
 * What is returned is the resolved form, never the raw input.
 */
const FALLBACK = '/';
const MAX_LENGTH = 2048;
const AUTH_PAGES = ['/login', '/register', '/forgot-password'];

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const MAX_DECODE_ROUNDS = 4;

function hasHostileShape(path: string): boolean {
  return (
    path.startsWith('//') ||
    path.includes('\\') ||
    hasControlCharacter(path) ||
    /^\/+[a-z][a-z0-9+.-]*:/i.test(path)
  );
}

/** True if the path — as written or after any layer of percent-decoding — is not a plain in-app path. */
function isHostileWhenDecoded(pathname: string): boolean {
  let current = pathname;
  for (let round = 0; round <= MAX_DECODE_ROUNDS; round++) {
    if (hasHostileShape(current)) return true;
    if (!current.includes('%')) return false;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed as WRITTEN: not a destination. Malformed only after an
      // earlier decode: a literal "%", i.e. the end of the road, and safe.
      return round === 0;
    }
    if (next === current) return false;
    current = next;
  }
  // Still changing after the bound: it cannot be shown to be safe.
  return true;
}

export function safeReturnTo(from: unknown, origin: string = window.location.origin): string {
  if (from === null || typeof from !== 'object') return FALLBACK;
  const { pathname, search = '', hash = '' } = from as Record<string, unknown>;
  if (typeof pathname !== 'string' || typeof search !== 'string' || typeof hash !== 'string') return FALLBACK;

  const candidate = pathname + search + hash;
  if (candidate.length === 0 || candidate.length > MAX_LENGTH) return FALLBACK;
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return FALLBACK;
  if (search !== '' && !search.startsWith('?')) return FALLBACK;
  if (hash !== '' && !hash.startsWith('#')) return FALLBACK;
  if (pathname.includes('\\')) return FALLBACK;
  if (hasControlCharacter(candidate)) return FALLBACK;
  if (isHostileWhenDecoded(pathname)) return FALLBACK;

  let url: URL;
  try {
    url = new URL(candidate, origin);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== origin) return FALLBACK;

  const resolved = url.pathname + url.search + url.hash;
  if (!resolved.startsWith('/') || resolved.startsWith('//')) return FALLBACK;
  if (AUTH_PAGES.some((page) => url.pathname === page || url.pathname.startsWith(`${page}/`))) return FALLBACK;
  return resolved;
}
