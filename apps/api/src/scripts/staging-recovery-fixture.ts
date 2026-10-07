/** Owner-only synthetic fixture. Never runs with the API or payment worker. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient, type Prisma } from '@prisma/client';
import { assertUsdStagingTarget } from './staging-payment-target.js';

export const FIXTURE = 'SYNTHETIC-RECOVERY-20261007';
const ACTION = 'STAGING_SYNTHETIC_RECOVERY_FIXTURE';
const id = (n: number) => `e5b06247-62bf-4935-bb93-${String(n).padStart(12, '0')}`;
export const fixtureIds = { buyer: id(1), agentUser: id(2), country: id(3), agent: id(4), method: id(5), order: id(6), reservation: id(7), recovery: id(8) };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Tx = Prisma.TransactionClient;

export function assertRecoveryFixtureTarget(env: NodeJS.ProcessEnv) {
  assertUsdStagingTarget(env);
  if (env.RECOVERY_FIXTURE_ACK !== FIXTURE) throw Error('SYNTHETIC_FIXTURE_ACK_REQUIRED');
  const url = new URL(env.DATABASE_URL!);
  if (url.hash || (url.port && url.port !== '5432')) throw Error('STAGING_TARGET_REFUSED');
  for (const [key, value] of url.searchParams) {
    if (!((key === 'schema' && value === 'public') ||
      (['connection_limit', 'connect_timeout', 'pool_timeout'].includes(key) && /^\d+$/.test(value)) ||
      (key === 'sslmode' && ['disable','prefer','require'].includes(value)))) throw Error('STAGING_TARGET_REFUSED');
  }
}

async function snapshot(tx: Tx) {
  const ids = fixtureIds;
  return {
    users: await tx.user.findMany({ where: { id: { in: [ids.buyer, ids.agentUser] } }, orderBy: { id: 'asc' } }),
    country: await tx.country.findUnique({ where: { id: ids.country } }),
    method: await tx.paymentMethodDefinition.findUnique({ where: { id: ids.method } }),
    agent: await tx.agent.findUnique({ where: { id: ids.agent } }),
    order: await tx.agentOrder.findUnique({ where: { id: ids.order } }),
    reservation: await tx.agentReservation.findUnique({ where: { id: ids.reservation } }),
    wallets: await tx.wallet.count({ where: { userId: { in: [ids.buyer, ids.agentUser] } } }),
    inventory: await tx.agentInventory.count({ where: { agentId: ids.agent } }),
    inventoryLedger: await tx.agentInventoryLedger.count({ where: { agentId: ids.agent } }),
    settlement: await tx.agentOrderSettlement.count({ where: { orderId: ids.order } }),
    walletEntries: await tx.walletTransaction.count({ where: { referenceId: ids.order } }),
    destinations: await tx.agentPaymentAccount.count({ where: { agentId: ids.agent } }),
    sessions: await tx.session.count({ where: { userId: { in: [ids.buyer, ids.agentUser] } } }),
  };
}

export async function recoveryFixture(tx: Tx, apply: boolean) {
  const [owner] = await tx.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
      WHERE d.datname=current_database() AND r.rolname=current_user) AS allowed`;
  if (!owner?.allowed) throw Error('DATABASE_OWNER_REQUIRED');
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${FIXTURE},0))::text`;
  let prior = await tx.auditLog.findFirst({ where: { action: ACTION, entityId: fixtureIds.recovery } });
  if (!prior) {
    if (!apply) throw Error('SYNTHETIC_FIXTURE_NOT_SEEDED');
    // create, never upsert: a collision or a partial/foreign fixture aborts atomically.
    const createdAt = new Date(Date.now() - 120_000);
    const closedAt = new Date(Date.now() - 90_000);
    const paidAt = new Date(Date.now() - 60_000);
    for (const [userId, suffix] of [[fixtureIds.buyer, 'buyer'], [fixtureIds.agentUser, 'agent']] as const) {
      await tx.user.create({ data: { id: userId, username: `synthetic_recovery_20261007_${suffix}`, displayName: `${FIXTURE} ${suffix}`, status: 'SUSPENDED', role: 'USER', passwordHash: null } });
    }
    await tx.country.create({ data: { id: fixtureIds.country, code: 'ZZ', name: FIXTURE, currencyCode: 'ETB', isActive: false, agentPaymentEnabled: false, usdPricingEnabled: false } });
    await tx.agent.create({ data: { id: fixtureIds.agent, userId: fixtureIds.agentUser, countryId: fixtureIds.country, status: 'DISABLED', displayName: FIXTURE, contactEmail: 'synthetic-recovery@example.invalid' } });
    await tx.paymentMethodDefinition.create({ data: { id: fixtureIds.method, countryId: fixtureIds.country, type: 'MOBILE_PAYMENT', name: FIXTURE, fieldSchema: {}, isActive: false } });
    await tx.agentOrder.create({ data: {
      id: fixtureIds.order, orderNumber: FIXTURE, userId: fixtureIds.buyer, agentId: fixtureIds.agent,
      countryId: fixtureIds.country, paymentMethodDefId: fixtureIds.method,
      paymentAccountId: 'SYNTHETIC-NO-DESTINATION', exchangeRateConfigId: 'SYNTHETIC-NO-RATE',
      paymentSnapshot: { synthetic: true, warning: 'NO REAL PAYMENT OR DESTINATION' },
      fiatAmount: 100, fiatCurrency: 'ETB', exchangeRateValue: 1, coinAmount: 100,
      status: 'CANCELLED', idempotencyKey: FIXTURE, createdAt, cancelledAt: closedAt,
      paymentInstructionsShownAt: createdAt,
    } });
    await tx.agentReservation.create({ data: { id: fixtureIds.reservation, orderId: fixtureIds.order, agentId: fixtureIds.agent, amount: 100, status: 'RELEASED', createdAt, releasedAt: closedAt } });
    await tx.latePaymentCase.create({ data: {
      id: fixtureIds.recovery, orderId: fixtureIds.order, openedBy: fixtureIds.buyer,
      idempotencyKey: FIXTURE, paymentReference: `${FIXTURE}-IN`, paidAmount: 100, paidAt,
      description: 'SYNTHETIC STAGING FIXTURE — no real payment, provider verification or refund. Application rehearsal only. Do not send money.',
    } });
    const baselineHash = hash(await snapshot(tx));
    prior = await tx.auditLog.create({ data: { action: ACTION, entity: 'LatePaymentCase', entityId: fixtureIds.recovery, newData: { synthetic: true, baselineHash } } });
  }
  const baseline = prior.newData as { baselineHash?: string } | null;
  const current = await snapshot(tx);
  if (!baseline?.baselineHash || hash(current) !== baseline.baselineHash) throw Error('SYNTHETIC_FIXTURE_BASELINE_CHANGED');
  const recovery = await tx.latePaymentCase.findUniqueOrThrow({ where: { id: fixtureIds.recovery } });
  if (recovery.orderId !== fixtureIds.order || recovery.openedBy !== fixtureIds.buyer || !recovery.description.startsWith('SYNTHETIC STAGING FIXTURE')) throw Error('SYNTHETIC_CASE_IDENTITY_CHANGED');
  const audit = await tx.auditLog.findMany({ where: { entityId: fixtureIds.recovery }, select: { action: true }, orderBy: { createdAt: 'asc' } });
  return { event: 'SYNTHETIC_RECOVERY_FIXTURE_VERIFIED', synthetic: true, caseId: recovery.id, orderNumber: FIXTURE,
    status: recovery.status, baselineUnchanged: true, walletCount: current.wallets, inventoryCount: current.inventory,
    settlementCount: current.settlement, walletEntryCount: current.walletEntries,
    referenceClaims: await tx.latePaymentReferenceClaim.count({ where: { caseId: recovery.id } }),
    auditActions: audit.map(row => row.action), providerSettlementVerified: false };
}

async function main() {
  assertRecoveryFixtureTarget(process.env);
  if (process.argv.length !== 3 || !['--seed', '--verify'].includes(process.argv[2])) throw Error('FIXTURE_MODE_REQUIRED');
  const db = new PrismaClient({ log: [] });
  try {
    const result = await db.$transaction(async tx => {
      const [target] = await tx.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
      if (target?.name !== 'playqube_spin_rehearsal_20261002') throw Error('STAGING_TARGET_REFUSED');
      return recoveryFixture(tx, process.argv[2] === '--seed');
    }, { timeout: 30_000 });
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED';
    console.error(JSON.stringify({ event: 'SYNTHETIC_RECOVERY_FIXTURE_REFUSED', reason }));
    process.exitCode = 1;
  });
}
