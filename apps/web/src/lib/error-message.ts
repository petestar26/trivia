/**
 * Extract a safe, user-facing message from an unknown thrown value.
 *
 * `ApiClient.request()` signals a failed HTTP response by throwing
 * `new Error(JSON.stringify({ status, ...error }))`, so the message is JSON
 * with `code`/`message` at the *top level* — there is no nested `error` key.
 * Reading `parsed.error?.message` therefore always yielded `undefined` and
 * every server message ("Invalid credentials", "Email already registered")
 * was replaced by a generic fallback.
 *
 * The other half of the problem is that a genuine transport failure throws an
 * ordinary `TypeError` whose message is plain text like "Failed to fetch".
 * Calling `JSON.parse` on that throws *inside the caller's catch block*, so no
 * error was rendered at all. Parsing is contained here instead.
 *
 * Never returns a raw structured payload or a stack trace: if the message
 * parses as JSON but holds nothing user-facing, the caller's fallback wins.
 */
export function getErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — an ordinary message such as "Failed to fetch". Safe to show.
    return trimmed;
  }

  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;

    // Current shape: { status, code, message }
    const flat = obj.message;
    if (typeof flat === 'string' && flat.trim()) return flat.trim();

    // Older/nested shape: { error: { code, message } }
    const nested = obj.error;
    if (nested && typeof nested === 'object') {
      const nestedMessage = (nested as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
        return nestedMessage.trim();
      }
    }
  }

  // Parsed, but nothing worth showing — don't leak the payload.
  return fallback;
}

/**
 * Extract the HTTP status code from an ApiClient-thrown error, if present.
 *
 * Parses the same flattened `{ status, code, message }` shape `getErrorMessage`
 * reads. Returns `null` for anything that isn't that shape — a plain transport
 * error, a non-Error throw, or JSON with no numeric `status` — so callers can
 * distinguish a specific status (e.g. 429) without a second ad hoc parser.
 */
export function getErrorStatus(err: unknown): number | null {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (parsed && typeof parsed === 'object') {
    const status = (parsed as Record<string, unknown>).status;
    if (typeof status === 'number') return status;
  }

  return null;
}
