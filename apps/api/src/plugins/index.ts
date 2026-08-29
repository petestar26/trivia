import { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import { config } from '@socialplay/config';

export async function registerPlugins(server: FastifyInstance): Promise<void> {
  await server.register(sensible);

  await server.register(cookie, {
    secret: config.JWT_ACCESS_SECRET,
    hook: 'onRequest',
  });

  await server.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  await server.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: config.CORS_CREDENTIALS,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  });

  await server.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX_REQUESTS,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorMessage: 'Too many requests',
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
  });

  await server.register(jwt, {
    secret: config.JWT_ACCESS_SECRET,
    sign: {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      expiresIn: config.JWT_ACCESS_EXPIRY,
    },
    verify: {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    },
    cookie: {
      cookieName: 'sp_access_token',
      signed: false,
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE,
    },
  });

  await server.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB max upload
      files: 1,
    },
  });

  server.decorate('config', config);
}

declare module 'fastify' {
  interface FastifyInstance {
    config: typeof config;
  }
}