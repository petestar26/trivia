import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@socialplay/database';
import { config } from '@socialplay/config';
import { registerSchema, loginSchema, refreshTokenSchema } from '@socialplay/shared';
import { ApiError, authenticate } from '../middleware';
import { ErrorCode } from '@socialplay/shared';
import { generateTokens, hashPassword, verifyPassword } from '../utils/auth';
import { safeRecordActivity } from '../rewards/activity-service';

export async function authRoutes(server: FastifyInstance): Promise<void> {
  server.post<{ Body: z.infer<typeof registerSchema> }>(
    '/register',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'email', 'password'],
          properties: {
            username: { type: 'string', minLength: 3, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$' },
            email: { type: 'string', format: 'email', maxLength: 255 },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            displayName: { type: 'string', minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, email, password, displayName } = request.body;

      const existingUser = await prisma.user.findFirst({
        where: {
          OR: [{ email }, { username }],
        },
      });

      if (existingUser) {
        if (existingUser.email === email) {
          throw ApiError.conflict('Email already registered');
        }
        throw ApiError.conflict('Username already taken');
      }

      const passwordHash = await hashPassword(password);

      const user = await prisma.user.create({
        data: {
          email,
          username,
          passwordHash,
          displayName: displayName || username,
        },
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          isVerified: true,
          role: true,
          createdAt: true,
        },
      });

      const tokens = generateTokens(user.id, user.email, user.username, [user.role]);

      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: tokens.refreshToken,
          userAgent: request.headers['user-agent'],
          ip: request.ip,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
        },
      });

      setAuthCookies(reply, tokens);

      reply.status(201).send({
        success: true,
        data: {
          user,
          ...tokens,
        },
      });
    }
  );

  server.post<{ Body: z.infer<typeof loginSchema> }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string' },
            rememberMe: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw ApiError.unauthorized('Invalid credentials');
      }

      if (user.status !== 'ACTIVE') {
        throw ApiError.forbidden('Account is not active');
      }

      const isValid = await verifyPassword(password, user.passwordHash);

      if (!isValid) {
        throw ApiError.unauthorized('Invalid credentials');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      const tokens = generateTokens(user.id, user.email, user.username, [user.role]);

      await prisma.session.create({
        data: {
          userId: user.id,
          refreshToken: tokens.refreshToken,
          userAgent: request.headers['user-agent'],
          ip: request.ip,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      setAuthCookies(reply, tokens);

      reply.send({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            username: user.username,
            displayName: user.displayName,
            isVerified: user.isVerified,
            role: user.role,
          },
          ...tokens,
        },
      });

      // Server-verified activity: daily login + streak (post-commit, best-effort).
      safeRecordActivity(user.id, { type: 'LOGIN' });
    }
  );

  server.post<{ Body: z.infer<typeof refreshTokenSchema> }>(
    '/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { refreshToken } = request.body;

      const session = await prisma.session.findUnique({
        where: { refreshToken },
        include: { user: true },
      });

      if (!session || session.expiresAt < new Date()) {
        throw ApiError.unauthorized('Refresh token expired or invalid', { code: ErrorCode.TOKEN_EXPIRED });
      }

      if (session.user.status !== 'ACTIVE') {
        throw ApiError.forbidden('Account is not active');
      }

      await prisma.session.delete({ where: { id: session.id } });

      const tokens = generateTokens(
        session.user.id,
        session.user.email,
        session.user.username,
        [session.user.role]
      );

      await prisma.session.create({
        data: {
          userId: session.user.id,
          refreshToken: tokens.refreshToken,
          userAgent: request.headers['user-agent'],
          ip: request.ip,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });

      setAuthCookies(reply, tokens);

      reply.send({
        success: true,
        data: tokens,
      });
    }
  );

  server.post(
    '/logout',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const authHeader = request.headers.authorization;
      const token = authHeader?.substring(7);

      if (token) {
        await prisma.session.deleteMany({
          where: { userId: request.user!.sub },
        });
      }

      clearAuthCookies(reply);

      reply.send({
        success: true,
        data: { message: 'Logged out successfully' },
      });
    }
  );

  server.get(
    '/me',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const user = await prisma.user.findUnique({
        where: { id: request.user!.sub },
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          bio: true,
          avatarUrl: true,
          isVerified: true,
          role: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
        },
      });

      if (!user) {
        throw ApiError.notFound('User not found');
      }

      reply.send({
        success: true,
        data: { user },
      });
    }
  );
}

function setAuthCookies(reply: FastifyInstance['reply'], tokens: { accessToken: string; refreshToken: string }): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
    domain: config.COOKIE_DOMAIN,
    path: '/',
  };

  reply.setCookie('sp_access_token', tokens.accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60, // 15 minutes
  });

  reply.setCookie('sp_refresh_token', tokens.refreshToken, {
    ...cookieOptions,
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });
}

function clearAuthCookies(reply: FastifyInstance['reply']): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAME_SITE as 'lax' | 'strict' | 'none',
    domain: config.COOKIE_DOMAIN,
    path: '/',
  };

  reply.clearCookie('sp_access_token', cookieOptions);
  reply.clearCookie('sp_refresh_token', cookieOptions);
}