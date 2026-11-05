import type { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate, requireRole } from '../middleware/auth.js';
import { createSupportService, type NewTicket } from './service.js';
import { HELP_ARTICLES, assistantConfigured, answerSupport } from './assistant.js';
export async function supportRoutes(server: FastifyInstance) {
  const service = createSupportService(prisma);
  server.addHook('preHandler', authenticate);
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const uuid = { type: 'string', format: 'uuid' };
  const bodyText = { type: 'string', minLength: 1, maxLength: 4000, pattern: '\\S' };
  const params = { type: 'object', required: ['id'], properties: { id: uuid } };
  const pagination = {
    type: 'object',
    additionalProperties: false,
    properties: {
      page: { type: 'integer', minimum: 0, maximum: 10000, default: 0 },
      status: { enum: ['ALL', 'OPEN', 'RESOLVED'], default: 'ALL' },
    },
  };
  server.get('/help', async () => ({
    success: true,
    data: { articles: HELP_ARTICLES, aiEnabled: assistantConfigured() },
  }));
  server.post<{ Body: { question: string; language: string } }>(
    '/assistant',
    {
      config: {
        rateLimit: {
          hook: 'preHandler',
          max: 6,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.user?.sub ?? req.ip,
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'language'],
          properties: {
            question: { ...bodyText, maxLength: 1500 },
            language: { enum: ['en', 'am', 'om', 'ti', 'so', 'ar', 'sw', 'fr'] },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await answerSupport(request.body.question, request.body.language),
    })
  );
  server.post<{ Body: NewTicket }>(
    '/tickets',
    {
      config: {
        rateLimit: {
          hook: 'preHandler',
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.user?.sub ?? req.ip,
        },
      },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['subject', 'category', 'body', 'requestId'],
          properties: {
            subject: { type: 'string', minLength: 3, maxLength: 120, pattern: '\\S.*\\S' },
            category: { enum: ['GENERAL', 'ACCOUNT', 'PAYMENTS', 'GAME'] },
            body: bodyText,
            requestId: uuid,
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await service.create(request.user.sub, request.body),
    })
  );
  for (const admin of [false, true]) {
    const prefix = admin ? '/admin/tickets' : '/tickets';
    const preHandler = admin ? [requireRole('ADMIN', 'SUPER_ADMIN')] : [];
    server.get<{ Querystring: { page: number; status: string } }>(
      prefix,
      { preHandler, schema: { querystring: pagination } },
      async (request) => ({
        success: true,
        data: await service.list(request.user.sub, admin, request.query.page, request.query.status),
      })
    );
    server.get<{ Params: { id: string }; Querystring: { page: number } }>(
      `${prefix}/:id`,
      { preHandler, schema: { params, querystring: pagination } },
      async (request) => ({
        success: true,
        data: await service.read(request.user.sub, request.params.id, admin, request.query.page),
      })
    );
    server.post<{ Params: { id: string }; Body: { body: string; requestId: string } }>(
      `${prefix}/:id/messages`,
      {
        preHandler,
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: 20,
            timeWindow: '1 minute',
            keyGenerator: (req) => req.user?.sub ?? req.ip,
          },
        },
        schema: {
          params,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['body', 'requestId'],
            properties: { body: bodyText, requestId: uuid },
          },
        },
      },
      async (request) => ({
        success: true,
        data: await service.reply(request.user.sub, request.params.id, request.body, admin),
      })
    );
    server.post<{ Params: { id: string }; Body: { status: 'OPEN' | 'RESOLVED' } }>(
      `${prefix}/:id/status`,
      {
        preHandler,
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: 20,
            timeWindow: '1 minute',
            keyGenerator: (req) => req.user?.sub ?? req.ip,
          },
        },
        schema: {
          params,
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { enum: ['OPEN', 'RESOLVED'] } },
          },
        },
      },
      async (request) => ({
        success: true,
        data: await service.setStatus(
          request.user.sub,
          request.params.id,
          request.body.status,
          admin
        ),
      })
    );
  }
}
