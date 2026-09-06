/** VITE_API_URL is public build-time configuration; omit it for the Vite proxy. */
function apiOrigin(value: string | undefined): string {
  const normalized = value?.trim().replace(/\/+$/, '').replace(/(?:\/api\/v1)+$/, '');
  if (!normalized) return '';

  const url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('VITE_API_URL must be an HTTP(S) origin, optionally ending in /api/v1');
  }
  return url.origin;
}

export const API_ORIGIN = apiOrigin(import.meta.env.VITE_API_URL);
export const API_BASE = `${API_ORIGIN}/api/v1`;
