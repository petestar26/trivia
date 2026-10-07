import { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate, requireRole, ApiError } from '../middleware/index.js';

export async function workspaceRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  server.get('/access', { preHandler: [authenticate] }, async (request) => {
    const actor = await prisma.user.findUnique({
      where: { id: request.user!.sub },
      select: { role: true, status: true },
    });
    if (!actor || actor.status !== 'ACTIVE')
      throw ApiError.forbidden('An active account is required');
    const agent = await prisma.agent.findUnique({
      where: { userId: request.user!.sub },
      select: { status: true },
    });
    return {
      success: true,
      data: {
        role: actor.role,
        admin: ['ADMIN', 'SUPER_ADMIN'].includes(actor.role),
        agent: agent?.status === 'ACTIVE',
        agentStatus: agent?.status ?? null,
      },
    };
  });
  const admin = [authenticate, requireRole('ADMIN', 'SUPER_ADMIN')];
  server.get('/admin/overview', { preHandler: admin }, async () => {
    const [members, agents, groups, games, applications, accounts, countries] = await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.agent.count({ where: { status: 'ACTIVE', user: { status: 'ACTIVE' } } }),
      prisma.group.count({ where: { status: 'ACTIVE', expiresAt: { gt: new Date() } } }),
      prisma.gameDefinition.count(),
      prisma.agentApplication.count({ where: { status: 'SUBMITTED' } }),
      prisma.agentPaymentAccount.count({ where: { status: 'PENDING_APPROVAL' } }),
      prisma.country.count({ where: { isActive: true, agentPaymentEnabled: true } }),
    ]);
    return {
      success: true,
      data: {
        members,
        agents,
        groups,
        games,
        applications,
        accounts,
        countries,
        asOf: new Date().toISOString(),
      },
    };
  });
  server.get<{ Querystring: { page?: number; q?: string } }>(
    '/admin/accounts',
    {
      preHandler: admin,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
            q: { type: 'string', maxLength: 100 },
          },
        },
      },
    },
    async (request) => {
      const page = request.query.page ?? 1,
        q = request.query.q?.trim();
      const where = q
        ? {
            OR: [
              { username: { contains: q, mode: 'insensitive' as const } },
              { email: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {};
      const [rows, total] = await Promise.all([
        prisma.user.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * 50,
          take: 50,
          select: {
            id: true,
            username: true,
            email: true,
            role: true,
            status: true,
            createdAt: true,
            agentProfile: { select: { status: true } },
          },
        }),
        prisma.user.count({ where }),
      ]);
      return { success: true, data: { rows, total, page, pageSize: 50 } };
    }
  );
  server.get('/admin/games', { preHandler: admin }, async () => ({
    success: true,
    data: await prisma.gameDefinition.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        isActive: true,
        mode: true,
        catalogStatus: true,
        currentRulesVersion: true,
      },
    }),
  }));
  server.get('/admin/audit', { preHandler: admin }, async () => ({
    success: true,
    data: await prisma.auditLog.findMany({
      take: 100,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        userId: true,
        action: true,
        entity: true,
        entityId: true,
        createdAt: true,
      },
    }),
  }));
}
