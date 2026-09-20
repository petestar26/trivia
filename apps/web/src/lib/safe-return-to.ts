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
 *  - it is not an authentication page, which would loop straight back here.
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
