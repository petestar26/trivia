import type { FastifyRequest } from 'fastify';
import { config } from '@socialplay/config';
import { ApiError } from '../middleware/api-error.js';

export function hasSessionCookie(request: FastifyRequest): boolean {
  return request.cookies?.sp_access_token !== undefined || request.cookies?.sp_refresh_token !== undefined;
}
export function isBrowserAuthRequest(request: FastifyRequest): boolean {
  return hasSessionCookie(request) || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined;
}
export function requireCookieOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  const trusted = [new URL(config.FRONTEND_URL).origin, ...config.CORS_ORIGIN.split(',').map(v => v.trim())];
  if (!origin || origin === 'null' || origin === '*' || !trusted.includes(origin)) {
    throw ApiError.forbidden('Untrusted session origin');
  }
}
/** Runs after cookie parsing, before authentication or mutation handlers. */
export async function protectCookieWrites(request: FastifyRequest): Promise<void> {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && hasSessionCookie(request)) {
    // Even a supplied Authorization header must not exempt ambient cookies.
    requireCookieOrigin(request);
  }
}
