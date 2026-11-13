import { FastifyInstance } from 'fastify';
import { prisma } from '@socialplay/database';
import { authenticate, requireRole, ApiError } from '../middleware/index.js';
import { z } from 'zod';
import { adminAgents, adminAccountDetails, agentOverview, setMemberAccountStatus } from '../workspaces/service.js';
import type { StaffDatabase } from '../database/staff-database.js';
import type { StatusApprovalSigner } from '../database/status-approval.js';

export type WorkspaceRouteOptions = {
  /** Restricted staff writes (member status). Required: there is no default. */
  staffDb: StaffDatabase;
  /** Signs isolated status changes; null closes them (503). Unused when dormant. */
  statusApproval?: StatusApprovalSigner | null;
};

export async function workspaceRoutes(server: FastifyInstance, options: WorkspaceRouteOptions) {
  const staffDb = options?.staffDb;
  if (!staffDb) throw new Error('STAFF_DATABASE_REQUIRED');
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
  server.get('/admin/agents', { preHandler: admin }, async request => ({ success: true, data: await adminAgents(request.user!.sub, request.query) }));
  server.get<{ Params: { id: string } }>('/admin/accounts/:id', { preHandler: admin }, async request => {
    if (!z.string().uuid().safeParse(request.params.id).success) throw ApiError.badRequest('Invalid account reference.');
    return { success: true, data: await adminAccountDetails(request.user!.sub, request.params.id) };
  });
  server.get('/agent/overview', { preHandler: [authenticate] }, async request => ({ success: true, data: await agentOverview(request.user!.sub) }));
  server.post<{ Params: { id: string } }>('/admin/accounts/:id/status', {
    preHandler: admin, bodyLimit: 8192,
    config: { rateLimit: { hook: 'preHandler', max: 20, timeWindow: '1 minute', keyGenerator: request => `member-status:${request.user!.sub}` } },
  }, async request => {
    if (!z.string().uuid().safeParse(request.params.id).success) throw ApiError.badRequest('Invalid account reference.');
    return { success: true, data: await setMemberAccountStatus(staffDb, request.user!.sub, request.params.id, request.body, {
      actorTokenVersion: request.user!.tokenVersion ?? 0,
      signer: options.statusApproval ?? null,
    }) };
  });
  server.get('/admin/overview', { preHandler: admin }, async () => {
    const [members, agents, groups, games, applications, accounts, countries, support] =
      await Promise.all([
        prisma.user.count({ where: { role: 'USER' } }),
        prisma.agent.count({ where: { status: 'ACTIVE', user: { status: 'ACTIVE' } } }),
        prisma.group.count({ where: { status: 'ACTIVE', expiresAt: { gt: new Date() } } }),
        prisma.gameDefinition.count(),
        prisma.agentApplication.count({ where: { status: 'SUBMITTED' } }),
        prisma.agentPaymentAccount.count({ where: { status: 'PENDING_APPROVAL' } }),
        prisma.country.count({ where: { isActive: true, agentPaymentEnabled: true } }),
        prisma.$queryRaw<
          { count: number }[]
        >`SELECT count(*)::int AS count FROM support_tickets WHERE status='OPEN' AND last_sender='USER'`,
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
        support: support[0].count,
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
