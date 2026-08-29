import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '@socialplay/config';
import { JwtPayload, ErrorCode } from '@socialplay/shared';
import { ApiError } from './error-handler';

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    // request.jwtVerify() resolves the token from the Authorization header
    // (Bearer) OR from the configured cookie (sp_access_token) — see the
    // @fastify/jwt `cookie` option in plugins/index.ts. Do NOT pre-empt it
    // with a manual Bearer-header gate, or cookie-auth clients can never
    // authenticate.
    const decoded = await request.jwtVerify<JwtPayload>({
      secret: config.JWT_ACCESS_SECRET,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });

    request.user = decoded;
  } catch (err) {
    if (err instanceof Error && err.message.includes('expired')) {
      throw ApiError.unauthorized('Token expired', { code: ErrorCode.TOKEN_EXPIRED });
    }
    throw ApiError.unauthorized('Invalid token', { code: ErrorCode.TOKEN_INVALID });
  }
}

export function optionalAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return Promise.resolve();
  }

  const token = authHeader.substring(7);

  return request.jwtVerify<JwtPayload>({
    secret: config.JWT_ACCESS_SECRET,
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  })
    .then((decoded) => {
      request.user = decoded;
    })
    .catch(() => {
      // Ignore errors for optional auth
    });
}

export function requireRole(...allowedRoles: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    if (!allowedRoles.includes(request.user.roles[0])) {
      throw ApiError.forbidden('Insufficient permissions');
    }
  };
}

export function requirePermission(permission: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw ApiError.unauthorized('Authentication required');
    }

    // Prisma UserRole enum values are UPPERCASE ('ADMIN', 'SUPER_ADMIN').
    if (!request.user.roles.includes('ADMIN') && !request.user.roles.includes('SUPER_ADMIN')) {
      throw ApiError.forbidden(`Permission required: ${permission}`);
    }
  };
}