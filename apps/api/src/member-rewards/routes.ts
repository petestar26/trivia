import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '@socialplay/database';
import { authenticate, requireRole } from '../middleware/auth.js';
import { ApiError } from '../middleware/api-error.js';
import {
  adminSummary,
  saveConfig,
  rewardSummary,
  checkIn,
  deliverPendingRewards,
  processMemberActivity,
  claimEntitlement,
  ensureReferralCode,
} from './service.js';

export async function memberRewardRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  const auth = [authenticate];
  const admin = [authenticate, requireRole('ADMIN', 'SUPER_ADMIN')];
  const limited = { rateLimit: { max: 30, timeWindow: '1 minute' } };
  server.get('/', { preHandler: auth }, async (request, reply) => {
    const q = z
      .object({ page: z.coerce.number().int().min(0).max(10000).default(0) })
      .safeParse(request.query);
    if (!q.success) throw ApiError.badRequest('Invalid reward history page');
    return reply.send({ success: true, data: await rewardSummary(request.user!.sub, q.data.page) });
  });
  server.post('/daily', { preHandler: auth, config: limited }, async (request, reply) => {
    const data = await checkIn(request.user!.sub);
    await deliverPendingRewards({ userId: request.user!.sub });
    return reply.send({ success: true, data });
  });
  server.post('/activity', { preHandler: auth, config: limited }, async (request, reply) =>
    reply.send({ success: true, data: await processMemberActivity(request.user!.sub) })
  );
  server.post<{ Params: { id: string } }>(
    '/:id/claim',
    { preHandler: auth, config: limited },
    async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.id).success)
        throw ApiError.badRequest('Invalid reward');
      return reply.send({
        success: true,
        data: await claimEntitlement(request.user!.sub, request.params.id),
      });
    }
  );
  server.post('/referral-code', { preHandler: auth, config: limited }, async (request, reply) =>
    reply.send({ success: true, data: await ensureReferralCode(request.user!.sub) })
  );
  server.get('/admin', { preHandler: admin }, async (_request, reply) =>
    reply.send({ success: true, data: await adminSummary() })
  );
  server.put('/admin', { preHandler: admin, config: limited }, async (request, reply) =>
    reply.send({ success: true, data: await saveConfig(request.user!.sub, request.body) })
  );
}

const editProfile = z
  .object({ displayName: z.string().trim().min(1).max(100), bio: z.string().trim().max(500) })
  .strict();
export async function memberProfileRoutes(server: FastifyInstance) {
  server.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  server.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.sub },
      select: {
        id: true,
        username: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        email: true,
        role: true,
        status: true,
        isVerified: true,
        createdAt: true,
        lastLoginAt: true,
        referralCode: true,
        identities: { select: { provider: true, providerSubject: true, verifiedAt: true } },
        kycVerification: { select: { status: true, verifiedTier: true, verifiedAt: true } },
        payoutAccounts: {
          where: { status: 'ACTIVE' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { country: { select: { code: true, name: true, currencyCode: true } } },
        },
      },
    });
    // Provider subjects for OAuth/Telegram are not contact details. Never return them.
    const { identities, payoutAccounts, ...account } = user;
    return reply.send({
      success: true,
      data: {
        ...account,
        phone: identities.find((i) => i.provider === 'PHONE')?.providerSubject ?? null,
        phoneVerified: !!identities.find((i) => i.provider === 'PHONE')?.verifiedAt,
        signInMethods: [...new Set(identities.map((i) => i.provider))],
        payoutCountry: payoutAccounts[0]?.country ?? null,
      },
    });
  });
  server.patch(
    '/',
    { preHandler: [authenticate], config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = editProfile.safeParse(request.body);
      if (!parsed.success)
        throw ApiError.badRequest(
          'Use a display name of 1–100 characters and a bio of up to 500 characters'
        );
      await prisma.$transaction(async (tx) => {
        const [actor] = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM users WHERE id=${request.user!.sub} AND status='ACTIVE' FOR UPDATE`;
        if (!actor) throw ApiError.forbidden('Active account required');
        const { displayName, bio } = parsed.data;
        await tx.user.update({ where: { id: actor.id }, data: { displayName, bio: bio || null } });
        await tx.profile.updateMany({
          where: { userId: actor.id },
          data: { displayName, bio: bio || null },
        });
      });
      return reply.send({ success: true, data: { saved: true } });
    }
  );
}
