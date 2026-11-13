import { prisma, type Prisma } from '@socialplay/database';
import { z } from 'zod';
import { ApiError } from '../middleware/api-error.js';
import { assertPlatformAdmin } from '../agents/agent-service.js';
import { selectPaymentRate } from '../agents/usd-config-service.js';
import { credentialDb } from '../agents/credential-database.js';
import { getSocketServer } from '../realtime/broadcast.js';

export const directoryQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    q: z.string().trim().max(100).default(''),
    status: z
      .enum(['ACTIVE', 'PENDING_VERIFICATION', 'TEMPORARILY_SUSPENDED', 'UNDER_REVIEW', 'DISABLED'])
      .optional(),
  })
  .strict();
const safeUser = {
  id: true,
  username: true,
  email: true,
  displayName: true,
  status: true,
  role: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
} as const;
const countryFields = {
  id: true,
  code: true,
  name: true,
  currencyCode: true,
  isActive: true,
  agentPaymentEnabled: true,
} as const;
const paymentFields = {
  id: true,
  status: true,
  coinAmount: true,
  fiatAmount: true,
  fiatCurrency: true,
  createdAt: true,
} as const;
const publicPayment = <T extends { fiatAmount: number | bigint }>(row: T) => ({
  ...row,
  fiatAmount: row.fiatAmount.toString(),
});

export async function adminAgents(actorId: string, input: unknown) {
  await assertPlatformAdmin(actorId);
  const parsed = directoryQuery.safeParse(input);
  if (!parsed.success) throw ApiError.badRequest('Invalid agent search or page.');
  const { q, page, status } = parsed.data;
  const where: Prisma.AgentWhereInput = {
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { displayName: { contains: q, mode: 'insensitive' } },
            { contactEmail: { contains: q, mode: 'insensitive' } },
            { user: { username: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.agent.findMany({
      where,
      take: 30,
      skip: (page - 1) * 30,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        displayName: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        user: { select: safeUser },
        country: { select: countryFields },
        inventory: { select: { totalBalance: true, reservedBalance: true } },
        _count: { select: { paymentAccounts: true, orders: true, withdrawals: true } },
      },
    }),
    prisma.agent.count({ where }),
  ]);
  return {
    rows: rows.map((row) => ({
      ...row,
      availableDepositFunding: row.inventory
        ? row.inventory.totalBalance - row.inventory.reservedBalance
        : 0,
    })),
    total,
    page,
    pageSize: 30,
  };
}

export async function adminAccountDetails(actorId: string, userId: string) {
  await assertPlatformAdmin(actorId);
  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...safeUser,
      isVerified: true,
      bio: true,
      identities: {
        where: { provider: 'PHONE' },
        select: { providerSubject: true, verifiedAt: true },
      },
      kycVerification: { select: { status: true, verifiedTier: true, verifiedAt: true } },
      agentProfile: {
        select: {
          id: true,
          status: true,
          displayName: true,
          contactEmail: true,
          contactPhone: true,
          suspendedReason: true,
          updatedAt: true,
          country: { select: countryFields },
        },
      },
    },
  });
  if (!account) throw ApiError.notFound('Account not found.');
  // Read the financial snapshot without creating a wallet or changing its lots.
  const [wallet] = await prisma.$queryRaw<
    Array<{
      balance: number;
      practicePoints: number;
      spendable: number;
      betOnly: number;
      reserved: number;
    }>
  >`
    SELECT w."coinsBalance" AS balance,w."gamePointsBalance" AS "practicePoints",
      COALESCE(sum(p."availableAmount") FILTER(WHERE p."lotClass"='WITHDRAWABLE' AND p.state='OPEN'),0)::integer AS spendable,
      COALESCE(sum(p."availableAmount") FILTER(WHERE p."lotClass"='RESTRICTED' AND p.state='OPEN' AND (p."expiresAt" IS NULL OR (p."expiresAt" AT TIME ZONE 'UTC')>clock_timestamp())),0)::integer AS "betOnly",
      COALESCE(sum(p."reservedAmount"),0)::integer AS reserved
    FROM wallets w LEFT JOIN coin_provenance p ON p."userId"=w."userId"
    WHERE w."userId"=${userId} GROUP BY w.id`;
  const [deposits, withdrawals, transactions, audit] = await Promise.all([
    prisma.agentOrder.findMany({
      where: { userId },
      take: 15,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ...paymentFields, orderNumber: true },
    }),
    prisma.withdrawal.findMany({
      where: { userId },
      take: 15,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ...paymentFields, withdrawalNumber: true },
    }),
    prisma.walletTransaction.findMany({
      where: { userId },
      take: 20,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        amount: true,
        currency: true,
        ledgerType: true,
        type: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { userId },
          { entity: 'User', entityId: userId },
          ...(account.agentProfile ? [{ entity: 'Agent', entityId: account.agentProfile.id }] : []),
        ],
      },
      take: 20,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, action: true, entity: true, createdAt: true },
    }),
  ]);
  const { identities, ...details } = account;
  return {
    account: {
      ...details,
      phone: identities[0]?.providerSubject ?? null,
      phoneVerified: !!identities[0]?.verifiedAt,
    },
    canChangeStatus:
      actorId !== userId &&
      account.role === 'USER' &&
      ['ACTIVE', 'SUSPENDED'].includes(account.status),
    wallet: wallet
      ? {
          ...wallet,
          pendingReview: Math.max(0, wallet.balance - wallet.spendable - wallet.betOnly),
        }
      : null,
    deposits: deposits.map(publicPayment),
    withdrawals: withdrawals.map(publicPayment),
    transactions,
    audit,
    asOf: new Date().toISOString(),
  };
}

export async function setMemberAccountStatus(actorId: string, userId: string, input: unknown) {
  const parsed = z
    .object({
      status: z.enum(['ACTIVE', 'SUSPENDED']),
      reason: z.string().trim().min(5).max(500),
      expectedUpdatedAt: z.string().datetime({ precision: 3 }),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw ApiError.badRequest(
      'Choose an account status and provide a reason and the displayed account version.'
    );
  if (actorId === userId) throw ApiError.forbidden('You cannot change your own account status.');
  await assertPlatformAdmin(actorId);
  const { status, reason, expectedUpdatedAt } = parsed.data;
  const result = await credentialDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id=${actorId} FOR SHARE`;
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      select: { role: true, status: true },
    });
    if (!actor || actor.status !== 'ACTIVE' || !['ADMIN', 'SUPER_ADMIN'].includes(actor.role))
      throw ApiError.forbidden('Admin privileges required.');
    await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
    const member = await tx.user.findUnique({
      where: { id: userId },
      select: { role: true, status: true, updatedAt: true },
    });
    if (!member) throw ApiError.notFound('Account not found.');
    if (member.role !== 'USER' || !['ACTIVE', 'SUSPENDED'].includes(member.status))
      throw ApiError.forbidden('Only active or suspended member accounts can be managed here.');
    if (member.updatedAt.toISOString() !== expectedUpdatedAt || member.status === status)
      throw ApiError.conflict('This account changed. Refresh its details before continuing.');
    // The database's owner-only status guard remains in force. No role or
    // financial record is changed. Keep bounded own-funds-return access valid.
    const updatedAt = new Date(Math.max(Date.now(), member.updatedAt.getTime() + 1));
    await tx.user.update({ where: { id: userId }, data: { status, updatedAt } });
    if (status === 'SUSPENDED') await tx.session.deleteMany({ where: { userId } });
    await tx.auditLog.create({
      data: {
        userId: actorId,
        action: status === 'ACTIVE' ? 'ADMIN_MEMBER_REACTIVATED' : 'ADMIN_MEMBER_SUSPENDED',
        entity: 'User',
        entityId: userId,
        oldData: { status: member.status },
        newData: { status, reason, refreshSessionsRevoked: status === 'SUSPENDED' },
      },
    });
    return { userId, status, updatedAt: updatedAt.toISOString() };
  });
  if (status === 'SUSPENDED') {
    try {
      getSocketServer()?.in(`user:${userId}`).disconnectSockets(true);
    } catch {
      /* Current status is checked on private access. */
    }
  }
  return result;
}

export async function agentOverview(actorId: string) {
  const agent = await prisma.agent.findUnique({
    where: { userId: actorId },
    select: {
      id: true,
      displayName: true,
      status: true,
      contactEmail: true,
      contactPhone: true,
      user: { select: { status: true } },
      country: true,
      inventory: { select: { totalBalance: true, reservedBalance: true } },
      fiatLiquidity: { select: { fiatCurrency: true, totalBalance: true, reservedBalance: true } },
      paymentAccounts: {
        select: {
          id: true,
          status: true,
          safetyHold: true,
          countryId: true,
          methodDef: { select: { countryId: true, isActive: true } },
        },
      },
    },
  });
  if (!agent || agent.status !== 'ACTIVE' || agent.user.status !== 'ACTIVE')
    throw ApiError.forbidden('Active agent access required.');
  const [deposits, payouts, recentDeposits, recentPayouts] = await Promise.all([
    prisma.agentOrder.groupBy({
      by: ['status'],
      where: { agentId: agent.id },
      _count: { _all: true },
    }),
    prisma.withdrawal.groupBy({
      by: ['status'],
      where: { agentId: agent.id },
      _count: { _all: true },
    }),
    prisma.agentOrder.findMany({
      where: { agentId: agent.id },
      take: 5,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ...paymentFields, orderNumber: true },
    }),
    prisma.withdrawal.findMany({
      where: { agentId: agent.id },
      take: 5,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { ...paymentFields, withdrawalNumber: true },
    }),
  ]);
  let rateReady = true;
  try {
    await selectPaymentRate(prisma, agent.country);
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
    rateReady = false;
  }
  const counts = (rows: Array<{ status: string; _count: { _all: number } }>) =>
    Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
  const approvedAccounts = agent.paymentAccounts.filter(
    (a) =>
      a.status === 'APPROVED' && !a.safetyHold &&
      a.countryId === agent.country.id &&
      a.methodDef.countryId === agent.country.id &&
      a.methodDef.isActive
  ).length;
  const available = agent.inventory
    ? agent.inventory.totalBalance - agent.inventory.reservedBalance
    : 0;
  return {
    agent: {
      id: agent.id,
      displayName: agent.displayName,
      status: agent.status,
      contactEmail: agent.contactEmail,
      contactPhone: agent.contactPhone,
    },
    country: {
      id: agent.country.id,
      name: agent.country.name,
      currencyCode: agent.country.currencyCode,
    },
    deposits: counts(deposits),
    payouts: counts(payouts),
    inventory: {
      total: agent.inventory?.totalBalance ?? 0,
      reserved: agent.inventory?.reservedBalance ?? 0,
      available,
    },
    liquidity: agent.fiatLiquidity.map((l) => ({
      currency: l.fiatCurrency,
      total: l.totalBalance.toString(),
      reserved: l.reservedBalance.toString(),
      available: (l.totalBalance - l.reservedBalance).toString(),
    })),
    setup: {
      countryActive: agent.country.isActive,
      paymentsEnabled: agent.country.agentPaymentEnabled,
      rateReady,
      approvedAccounts,
      pendingAccounts: agent.paymentAccounts.filter((a) => a.status === 'PENDING_APPROVAL').length,
      hasDepositFunding: available > 0,
      hasPayoutLiquidity: agent.fiatLiquidity.some(
        (l) => l.fiatCurrency === agent.country.currencyCode && l.totalBalance > l.reservedBalance
      ),
    },
    recentDeposits: recentDeposits.map(publicPayment),
    recentPayouts: recentPayouts.map(publicPayment),
    asOf: new Date().toISOString(),
  };
}
