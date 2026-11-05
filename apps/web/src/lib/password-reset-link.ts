// A recovery link is independent of the current signed-in identity. Keep it
// in this tab until its short expiry so an auth remount or reload cannot lose
// the form after the URL fragment has been removed. Never store the password.
const key = 'salem.password-reset-link';
const maxAge = 15 * 60_000;
type Link = { token: string; expiresAt: number };
let memory: Link | null = null;

function usable(value: unknown): value is Link {
  if (!value || typeof value !== 'object') return false;
  const link = value as Link;
  return typeof link.token === 'string' && link.token.length > 0 && link.token.length <= 2048 &&
    Number.isFinite(link.expiresAt) && link.expiresAt > Date.now() &&
    link.expiresAt <= Date.now() + maxAge;
}

export function clearPasswordResetLink(): void {
  memory = null;
  try { sessionStorage.removeItem(key); } catch { /* Storage can be unavailable. */ }
}

export function readPasswordResetLink(): string {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has('token')) {
    clearPasswordResetLink();
    const token = fragment.get('token') || '';
    let expiresAt = Date.now() + maxAge;
    try {
      const body = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(body));
      // This is only a retention limit, never proof that a token is valid.
      // The server verifies its signature, account, expiry and single use.
      if (typeof claims.exp === 'number') expiresAt = Math.min(expiresAt, claims.exp);
    } catch { /* Invalid links are rejected by the server. */ }
    const link = { token, expiresAt };
    if (!usable(link)) return '';
    memory = link;
    try { sessionStorage.setItem(key, JSON.stringify(link)); } catch { /* Remount fallback. */ }
    return token;
  }
  try {
    const raw = sessionStorage.getItem(key);
    if (raw) memory = JSON.parse(raw);
  } catch { /* Keep the in-memory fallback when storage is unavailable. */ }
  if (usable(memory)) return memory.token;
  clearPasswordResetLink();
  return '';
}
