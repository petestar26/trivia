import { PrismaClient, Prisma } from '@prisma/client';
import { parseUsdPolicy } from '../agents/usd-pricing.js';

// Deployment diagnostics only. No destinations, personal data, balances or secrets
// are logged. PostgreSQL also enforces that this transaction cannot write.
const db = new PrismaClient({ log: [] });
try {
  const report = await db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const countries = await tx.country.findMany({
        select: {
          id: true,
          code: true,
          currencyCode: true,
          isActive: true,
          agentPaymentEnabled: true,
          usdPricingEnabled: true,
        },
        orderBy: { code: 'asc' },
      });
      const readiness = [];
      for (const country of countries) {
        const rate = await tx.exchangeRateConfig.findFirst({
          where: {
            countryId: country.id,
            fiatCurrency: country.currencyCode,
            effectiveAt: { lte: new Date() },
            pricingPolicy: { not: Prisma.DbNull },
          },
          orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        });
        let freshRate = false;
        if (rate?.isActive && country.usdPricingEnabled) {
          try {
            parseUsdPolicy(rate.pricingPolicy);
            freshRate = true;
          } catch {
            /* readiness false */
          }
        }
        const [counts] = await tx.$queryRaw<Array<Record<string, number>>>`
        SELECT
          (SELECT count(*)::int FROM agents a JOIN users u ON u.id=a."userId"
           WHERE a."countryId"=${country.id} AND a.status='ACTIVE' AND u.status='ACTIVE') AS "activeAgents",
          (SELECT count(*)::int FROM agent_payment_accounts p
           JOIN agents a ON a.id=p."agentId" JOIN users u ON u.id=a."userId"
           JOIN payment_method_definitions m ON m.id=p."methodDefId"
           WHERE p."countryId"=${country.id} AND a."countryId"=p."countryId"
             AND m."countryId"=p."countryId" AND m."isActive" AND p.status='APPROVED' AND NOT p."safetyHold"
             AND a.status='ACTIVE' AND u.status='ACTIVE') AS "approvedReceivingAccounts",
          (SELECT count(*)::int FROM agent_inventories i JOIN agents a ON a.id=i."agentId"
           WHERE a."countryId"=${country.id} AND a.status='ACTIVE'
             AND i."totalBalance">i."reservedBalance") AS "agentsWithInventory",
          (SELECT count(*)::int FROM agent_fiat_liquidities l JOIN agents a ON a.id=l."agentId"
           WHERE a."countryId"=${country.id} AND a.status='ACTIVE'
             AND l."fiatCurrency"=${country.currencyCode}
             AND l."totalBalance">l."reservedBalance") AS "agentsWithPayoutLiquidity"`;
        const jurisdiction = await tx.countryJurisdiction.findUnique({
          where: { countryCode: country.code },
          select: {
            activePolicy: { select: { status: true, state: true, supportedPaymentMethods: true } },
          },
        });
        readiness.push({
          country: country.code,
          currency: country.currencyCode,
          active: country.isActive,
          agentPaymentsEnabled: country.agentPaymentEnabled,
          freshRate,
          ...counts,
          financialPolicy: jurisdiction?.activePolicy ?? null,
        });
      }
      const gates = await tx.platformGate.findMany({
        where: {
          key: {
            in: [
              'WITHDRAWAL_CREATE',
              'CRYPTO_DEPOSIT_CREATE',
              'CRYPTO_DEPOSIT_CREDIT',
              'CRYPTO_WITHDRAWAL_CREATE',
            ],
          },
        },
        select: { key: true, enabled: true },
        orderBy: { key: 'asc' },
      });
      const unusedCryptoAddresses = await tx.cryptoAddress.count({
        where: { retired: false, deposit: null },
      });
      return { countries: readiness, gates, unusedCryptoAddresses };
    },
    { timeout: 30_000 }
  );
  console.log(JSON.stringify({ event: 'SALEM_PAYMENT_READINESS', ...report }));
} catch {
  console.error(JSON.stringify({ event: 'SALEM_PAYMENT_READINESS_FAILED' }));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
