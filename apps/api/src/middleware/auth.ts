import { prisma } from '@socialplay/database';
import { FastifyRequest, FastifyReply } from 'fastify';
import { JwtPayload, ErrorCode } from '@socialplay/shared';
import { ApiError } from './error-handler.js';

// Canonical @fastify/jwt user augmentation. The plugin type-checks the
// decoded access token against `FastifyJWT.user`; this replaces the previous
// direct `FastifyRequest.user` augmentation (which conflicted with the
// plugin's own declaration).
declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: JwtPayload;
  }
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    // request.jwtVerify() resolves the token from the Authorization header
    // (Bearer) OR from the configured cookie (sp_access_token) — see the
    // @fastify/jwt `cookie` option in plugins/index.ts. Do NOT pre-empt it
    // with a manual Bearer-header gate, or cookie-auth clients can never
    // authenticate.
    const decoded = await request.jwtVerify<JwtPayload>();

    request.user = decoded;
  } catch (err) {
    if (err instanceof Error && err.message.includes('expired')) {
      throw ApiError.unauthorized('Token expired', { code: ErrorCode.TOKEN_EXPIRED });
    }
    throw ApiError.unauthorized('Invalid token', { code: ErrorCode.TOKEN_INVALID });
  }
  // A still-valid token must not preserve access after suspension/deletion.
  // Keep DB failures outside the token catch: an outage is not a bad credential.
  const actor = await prisma.user.findUnique({
    where: { id: request.user!.sub },
    select: { status: true },
  });
  if (actor?.status !== 'ACTIVE') throw ApiError.forbidden('An active account is required');
}

export function optionalAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return Promise.resolve();
  }

  const token = authHeader.substring(7);

  return request
    .jwtVerify<JwtPayload>()
    .then(async (decoded) => {
      const actor = await prisma.user.findUnique({
        where: { id: decoded.sub },
        select: { status: true },
      });
      if (actor?.status === 'ACTIVE') request.user = decoded;
      else delete (request as Partial<FastifyRequest>).user;
    })
    .catch(() => {
      delete (request as Partial<FastifyRequest>).user;
      // Ignore errors for optional auth
    });
}

export function requireRole(...allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    const actor = await prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { role: true, status: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || !allowedRoles.includes(actor.role)) {
      throw ApiError.forbidden('Insufficient permissions');
    }
  };
}

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    // A signed token can outlive demotion or suspension. Administrative reads
    // must use current authority, just like the financial mutation services.
    const actor = await prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { role: true, status: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role)) {
      throw ApiError.forbidden(`Permission required: ${permission}`);
    }
  };
}
