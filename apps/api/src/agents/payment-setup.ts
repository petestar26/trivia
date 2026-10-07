import { prisma } from '@socialplay/database';
import { ApiError } from '../middleware/index.js';
import { assertPlatformAdmin } from './agent-service.js';
import { selectPaymentRate } from './usd-config-service.js';

import { cryptoPaymentCatalog } from './crypto-catalog.js';

export async function getPaymentSetup(adminId: string, countryId: string) {
  await assertPlatformAdmin(adminId);
  const country = await prisma.country.findUnique({
    where: { id: countryId },
    include: {
      paymentMethods: { orderBy: { name: 'asc' } },
    },
  });
  if (!country) throw ApiError.notFound('Country not found');
  const [agents, agentCount] = await Promise.all([
    prisma.agent.findMany({
      where: { countryId },
      orderBy: { id: 'asc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        displayName: true,
        status: true,
        user: { select: { status: true } },
        inventory: true,
        fiatLiquidity: true,
        paymentAccounts: {
          select: {
            id: true,
            countryId: true,
            status: true,
            methodDef: { select: { countryId: true, name: true, isActive: true } },
          },
        },
      },
    }),
    prisma.agent.count({ where: { countryId } }),
  ]);
  let rateStatus = 'Configured',
    rateId: string | null = null;
  try {
    rateId = (await selectPaymentRate(prisma, country)).id;
  } catch (e) {
    if (!(e instanceof ApiError) || e.statusCode !== 400) throw e;
    rateStatus = e.message;
  }
  return {
    country,
    rateId,
    rateStatus,
    agentCount,
    truncated: agentCount > agents.length,
    // This is a point-in-time setup view, never authoritative admission.
    admissionNotice:
      'Each request still checks current rates, amount limits, available funds and account/jurisdiction eligibility.',
    agents: agents.map((a) => ({
      ...a,
      availableCoins: a.inventory ? a.inventory.totalBalance - a.inventory.reservedBalance : 0,
      approvedPaymentAccounts: a.paymentAccounts.filter(
        (p) =>
          p.status === 'APPROVED' &&
          p.countryId === countryId &&
          p.methodDef.countryId === countryId &&
          p.methodDef.isActive
      ).length,
      fiatLiquidity: a.fiatLiquidity.map((l) => ({
        ...l,
        totalBalance: l.totalBalance.toString(),
        reservedBalance: l.reservedBalance.toString(),
        availableBalance: (l.totalBalance - l.reservedBalance).toString(),
      })),
    })),
    crypto: cryptoPaymentCatalog,
  };
}
