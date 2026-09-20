/**
 * URL redaction for logs.
 *
 * `GET /groups/invites/:token` carries a bearer-equivalent secret in the
 * path: anyone holding that token can redeem the invitation. Request URLs
 * reach logs from two places — Fastify's own automatic request/response
 * lines (via the `req` serializer) and this codebase's `requestLogger` —
 * and log sinks are routinely shipped, indexed, and retained far longer
 * than the invite's own expiry. Neither place may emit the raw token.
 *
 * Redaction is deliberately path-shaped rather than a broad
 * "anything that looks like a secret" scrub: it keeps the route, method,
 * status and query string intact so logs stay useful for debugging, and
 * replaces only the token segment.
 */

const REDACTED = '[REDACTED]';

// `/groups/invites/<token>` — tolerates repeated slashes, double-slashes,
// and percent-encoded separators (`%2F`) that bypass the strict-slash form.
// With or without an /api/v1 style prefix, and stopping at the next path
// separator, query string, or fragment so the rest of the URL survives.
const INVITE_TOKEN_PATH = /((?:\/|%2F)+groups(?:\/|%2F)+invites(?:\/|%2F)+)([^/?#]+)/gi;

/**
 * Replace invite tokens in a URL (or path) with a redaction marker.
 * Returns the input unchanged when it carries no token.
 */
export function redactUrl(url: string): string {
  if (typeof url !== 'string' || url.length === 0) return url;
  return url.replace(INVITE_TOKEN_PATH, `$1${REDACTED}`);
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
