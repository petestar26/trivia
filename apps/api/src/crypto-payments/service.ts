import { randomUUID } from 'node:crypto';
import { prisma, type Prisma } from '@socialplay/database';
import { z } from 'zod';
import { ApiError } from '../middleware/error-handler.js';
import { activePolicyForCountry, requirePlatformGate } from '../economy/jurisdiction-service.js';
import {
  lockUserEconomicScope,
  lockEconomicWallet,
  reserveWithdrawalCoins,
  releaseWithdrawalCoins,
  finalizeWithdrawalCoins,
  creditCoins,
} from '../economy/coin-ledger-service.js';
import { requireStepUp } from '../security/step-up-service.js';
import { selectPaymentRate } from '../agents/usd-config-service.js';
import { parseUsdPolicy } from '../agents/usd-pricing.js';
import { assertWithdrawalPolicyLimits } from '../withdrawals/withdrawal-service.js';
import {
  validAddress,
  parseUsdt,
  formatUsdt,
  depositCoins,
  withdrawalUsdt,
  USDT_CONTRACT,
  type Transfer,
} from './tron.js';

type Tx = Prisma.TransactionClient;
export type Deposit = {
  id: string;
  userId: string;
  countryId: string;
  address: string;
  amountMicro: bigint;
  coinAmount: number;
  requestKey: string;
  createdAt: Date;
  expiresAt: Date;
  status: string;
  reviewReason: string | null;
  lastCheckedAt: Date | null;
  checkError: string | null;
  pricingSnapshot: Prisma.JsonValue;
};
export type Withdrawal = {
  id: string;
  userId: string;
  countryId: string;
  address: string;
  amountMicro: bigint;
  coinAmount: number;
  requestKey: string;
  holdOperationId: string;
  terminalOperationId: string | null;
  status: string;
  assignedAdminId: string | null;
  txHash: string | null;
  createdAt: Date;
  completedAt: Date | null;
  pricingSnapshot: Prisma.JsonValue;
};
const key = z.string().uuid(),
  country = z.string().uuid();
const destination = z.string().trim().refine(validAddress, 'Enter a valid TRON wallet address');
export const depositSchema = z
  .object({ countryId: country, amount: z.string().max(20), idempotencyKey: key })
  .strict();
export const withdrawalSchema = z
  .object({
    countryId: country,
    coinAmount: z.number().int().positive().max(1_000_000_000),
    address: destination,
    idempotencyKey: key,
  })
  .strict();
export const addressSchema = z
  .object({
    address: destination,
    label: z.string().trim().min(1).max(100),
    unusedAddressConfirmed: z.literal(true),
  })
  .strict();
export const confirmSchema = z
  .object({
    txHash: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .transform((v) => v.toLowerCase()),
    transferred: z.literal(true),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw ApiError.badRequest(r.error.issues[0]?.message ?? 'Invalid request');
  return r.data;
}
export async function actor(tx: Tx, id: string, admin = false, ownFundsReturn = false) {
  const [u] = await tx.$queryRaw<
    Array<{ status: string; role: string }>
  >`SELECT status::text,role::text FROM users WHERE id=${id} FOR SHARE`;
  if (
    !u ||
    (!ownFundsReturn && u.status !== 'ACTIVE') ||
    (admin && !['ADMIN', 'SUPER_ADMIN'].includes(u.role))
  )
    throw ApiError.forbidden(admin ? 'Active administrator required' : 'Active account required');
}
async function flush(tx: Tx) {
  await tx.$executeRawUnsafe(
    'SET CONSTRAINTS crypto_deposit_proof,crypto_settlement_proof,crypto_withdrawal_proof IMMEDIATE'
  );
  await tx.$executeRawUnsafe(
    'SET CONSTRAINTS crypto_deposit_proof,crypto_settlement_proof,crypto_withdrawal_proof DEFERRED'
  );
}
async function audit(tx: Tx, userId: string, id: string, action: string) {
  await tx.auditLog.create({ data: { userId, entity: 'CryptoPayment', entityId: id, action } });
}
export function paymentView(row: Deposit | Withdrawal) {
  return {
    id: row.id,
    address: row.address,
    amount: formatUsdt(row.amountMicro),
    coinAmount: row.coinAmount,
    status: row.status,
    createdAt: row.createdAt,
    ...('expiresAt' in row
      ? {
          expiresAt: row.expiresAt,
          reviewReason: row.reviewReason,
          lastCheckedAt: row.lastCheckedAt,
          verificationDelayed: !!row.checkError,
        }
      : { txHash: row.txHash, completedAt: row.completedAt }),
  };
}
async function context(
  tx: Tx,
  userId: string,
  countryId: string,
  direction: 'deposit' | 'withdrawal'
) {
  await requirePlatformGate(
    tx,
    direction === 'deposit' ? 'CRYPTO_DEPOSIT_CREATE' : 'CRYPTO_WITHDRAWAL_CREATE'
  );
  if (direction === 'withdrawal') await requirePlatformGate(tx, 'WITHDRAWAL_CREATE');
  const [account] = await tx.$queryRaw<
    Array<{ countryId: string }>
  >`SELECT "countryId" FROM user_payout_accounts WHERE "userId"=${userId} AND status='ACTIVE' ORDER BY "createdAt" DESC,id DESC LIMIT 1 FOR SHARE`;
  if (account?.countryId !== countryId)
    throw ApiError.forbidden('Choose the country of your active payment profile');
  const [c] = await tx.$queryRaw<
    Array<{
      id: string;
      code: string;
      currencyCode: string;
      usdPricingEnabled: boolean;
      isActive: boolean;
    }>
  >`SELECT id,code,"currencyCode","usdPricingEnabled","isActive" FROM countries WHERE id=${countryId} FOR SHARE`;
  if (!c?.isActive) throw ApiError.forbidden('Payments are unavailable in this country');
  const policy = await activePolicyForCountry(tx, c.code);
  if (!policy) throw ApiError.forbidden('Payments are paused in this country');
  if (
    !Array.isArray(policy.supportedPaymentMethods) ||
    !policy.supportedPaymentMethods.includes('USDT_TRC20')
  )
    throw ApiError.forbidden('USDT on TRON is not approved for this country');
  if (policy.withdrawalFeePercent !== 0)
    throw ApiError.forbidden('Crypto fee policy is not supported');
  const [kyc] = await tx.$queryRaw<
    Array<{ verifiedTier: number }>
  >`SELECT "verifiedTier" FROM user_kyc_verifications WHERE "userId"=${userId} AND status='VERIFIED' FOR SHARE`;
  if (policy.kycTierRequired > 0 && (!kyc || kyc.verifiedTier < policy.kycTierRequired))
    throw ApiError.forbidden('Verified identity tier is insufficient');
  const rate = await selectPaymentRate(tx, c),
    pricing = parseUsdPolicy(rate.pricingPolicy);
  return {
    policy,
    pricing,
    snapshot: {
      ...pricing,
      asset: 'USDT',
      network: 'TRON',
      contract: USDT_CONTRACT,
      usdtPerUsd: '1',
      rateId: rate.id,
      policyId: policy.id,
      policyVersion: policy.version,
    },
  };
}
export async function options(userId: string) {
  return prisma.$transaction(async (tx) => {
    await actor(tx, userId);
    const gates = await tx.platformGate.findMany({
      where: {
        key: { in: ['CRYPTO_DEPOSIT_CREATE', 'CRYPTO_WITHDRAWAL_CREATE', 'WITHDRAWAL_CREATE'] },
      },
    });
    const on = (k: string) => gates.some((g) => g.key === k && g.enabled);
    const countries = await tx.$queryRaw<
      Array<{ id: string; name: string }>
    >`SELECT c.id,c.name FROM countries c JOIN user_payout_accounts a ON a."countryId"=c.id WHERE a."userId"=${userId} AND a.status='ACTIVE' AND c."isActive"=true ORDER BY a."createdAt" DESC,a.id DESC LIMIT 1`;
    return {
      asset: 'USDT',
      network: 'TRON (TRC20)',
      contract: USDT_CONTRACT,
      coinsPerUsdt: 96,
      depositEnabled: on('CRYPTO_DEPOSIT_CREATE'),
      withdrawalEnabled: on('CRYPTO_WITHDRAWAL_CREATE') && on('WITHDRAWAL_CREATE'),
      countries,
    };
  });
}
export async function listPayments(userId: string, admin = false, query: unknown = {}) {
  const { page } = parse(
    z.object({ page: z.coerce.number().int().min(0).max(100000).default(0) }).strict(),
    query
  );
  const offset = (page ?? 0) * 50;
  return prisma.$transaction(async (tx) => {
    await actor(tx, userId, admin);
    const deposits = admin
      ? await tx.$queryRaw<
          Deposit[]
        >`SELECT * FROM crypto_deposits ORDER BY (status IN ('REVIEW','WAITING')) DESC,"createdAt",id LIMIT 50 OFFSET ${offset}`
      : await tx.$queryRaw<
          Deposit[]
        >`SELECT * FROM crypto_deposits WHERE "userId"=${userId} ORDER BY "createdAt" DESC,id DESC LIMIT 50 OFFSET ${offset}`;
    const withdrawals = admin
      ? await tx.$queryRaw<
          Withdrawal[]
        >`SELECT * FROM crypto_withdrawals ORDER BY (status IN ('HELD','PAYOUT_IN_PROGRESS')) DESC,"createdAt",id LIMIT 50 OFFSET ${offset}`
      : await tx.$queryRaw<
          Withdrawal[]
        >`SELECT * FROM crypto_withdrawals WHERE "userId"=${userId} ORDER BY "createdAt" DESC,id DESC LIMIT 50 OFFSET ${offset}`;
    const addresses = admin
      ? await tx.$queryRaw<
          Array<{ address: string; label: string; retired: boolean; used: boolean }>
        >`SELECT a.address,a.label,a.retired,EXISTS(SELECT 1 FROM crypto_deposits d WHERE d.address=a.address) AS used FROM crypto_addresses a ORDER BY (NOT a.retired AND NOT EXISTS(SELECT 1 FROM crypto_deposits d WHERE d.address=a.address)) DESC,a."createdAt" DESC LIMIT 50 OFFSET ${offset}`
      : undefined;
    const receipts = await tx.cryptoReceipt.findMany({
      take: 1000,
      where: { depositId: { in: deposits.map((d) => d.id) } },
      orderBy: [{ blockTime: 'asc' }, { logIndex: 'asc' }],
      select: {
        depositId: true,
        txHash: true,
        logIndex: true,
        amountMicro: true,
        blockNumber: true,
        blockTime: true,
      },
    });
    return {
      deposits: deposits.map((d) => ({
        ...paymentView(d),
        transfers: receipts
          .filter((r) => r.depositId === d.id)
          .map((r) => ({
            txHash: r.txHash,
            logIndex: r.logIndex,
            amount: formatUsdt(r.amountMicro),
            blockNumber: r.blockNumber.toString(),
            blockTime: r.blockTime,
          })),
        ...(admin ? { userId: d.userId, checkError: d.checkError } : {}),
      })),
      withdrawals: withdrawals.map((w) => ({
        ...paymentView(w),
        ...(admin ? { userId: w.userId, assignedAdminId: w.assignedAdminId } : {}),
      })),
      ...(admin ? { addresses } : {}),
    };
  });
}
export async function addAddress(adminId: string, tokenIat: number, body: unknown) {
  const b = parse(addressSchema, body);
  return prisma.$transaction(async (tx) => {
    await actor(tx, adminId, true);
    await requireStepUp({ userId: adminId, tokenIat }, 'CRYPTO_ADDRESS_ADD', tx);
    const exists = await tx.$queryRaw<
      Array<{ address: string }>
    >`SELECT address FROM crypto_addresses WHERE address=${b.address}`;
    if (exists.length) throw ApiError.conflict('This address is already registered');
    await tx.$executeRaw`INSERT INTO crypto_addresses(address,label,"addedBy") VALUES(${b.address},${b.label},${adminId})`;
    await audit(tx, adminId, b.address, 'CRYPTO_ADDRESS_ADDED');
    return { address: b.address };
  });
}
export async function retireAddress(adminId: string, address: string) {
  return prisma.$transaction(async (tx) => {
    await actor(tx, adminId, true);
    const count =
      await tx.$executeRaw`UPDATE crypto_addresses SET retired=true WHERE address=${address} AND retired=false AND NOT EXISTS(SELECT 1 FROM crypto_deposits WHERE address=${address})`;
    if (count !== 1) throw ApiError.conflict('Only unused addresses can be retired');
    await audit(tx, adminId, address, 'CRYPTO_ADDRESS_RETIRED');
    return { retired: true };
  });
}
export async function createDeposit(userId: string, body: unknown) {
  const b = parse(depositSchema, body);
  let amount: bigint, coins: number;
  try {
    amount = parseUsdt(b.amount);
    coins = depositCoins(amount);
  } catch (e) {
    throw ApiError.badRequest((e as Error).message);
  }
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `crypto:${userId}`);
    await actor(tx, userId);
    const [old] = await tx.$queryRaw<
      Deposit[]
    >`SELECT * FROM crypto_deposits WHERE "userId"=${userId} AND "requestKey"=${b.idempotencyKey}`;
    if (old) {
      if (old.amountMicro !== amount || old.countryId !== b.countryId)
        throw ApiError.conflict('Idempotency key has different payment details');
      return paymentView(old);
    }
    const { pricing, snapshot } = await context(tx, userId, b.countryId, 'deposit');
    if (amount < BigInt(pricing.cryptoDepositMinUsdCents) * 10_000n)
      throw ApiError.badRequest(
        `Minimum deposit is ${formatUsdt(BigInt(pricing.cryptoDepositMinUsdCents) * 10_000n)} USDT`
      );
    await tx.$executeRaw`UPDATE crypto_deposits SET status='EXPIRED' WHERE "userId"=${userId} AND status='WAITING' AND "expiresAt"<=now()`;
    const [pending] = await tx.$queryRaw<
      Deposit[]
    >`SELECT * FROM crypto_deposits WHERE "userId"=${userId} AND status='WAITING'`;
    if (pending) throw ApiError.conflict('You already have a deposit waiting for payment');
    const [slot] = await tx.$queryRaw<
      Array<{ address: string }>
    >`SELECT a.address FROM crypto_addresses a WHERE NOT a.retired AND NOT EXISTS(SELECT 1 FROM crypto_deposits d WHERE d.address=a.address) ORDER BY a."createdAt",a.address LIMIT 1 FOR UPDATE OF a SKIP LOCKED`;
    if (!slot) throw ApiError.conflict('No deposit address is available. Please try later.');
    const id = randomUUID(),
      createdAt = new Date(),
      expiresAt = new Date(
        Math.min(createdAt.getTime() + 15 * 60_000, Date.parse(pricing.expiresAt))
      );
    if (expiresAt.getTime() - createdAt.getTime() < 60_000)
      throw ApiError.conflict('Pricing is expiring; please request a fresh rate');
    const [d] = await tx.$queryRaw<
      Deposit[]
    >`INSERT INTO crypto_deposits(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","createdAt","expiresAt") VALUES(${id},${userId},${b.countryId},${slot.address},${amount},${coins},${JSON.stringify(snapshot)}::jsonb,${b.idempotencyKey},${createdAt},${expiresAt}) RETURNING *`;
    await audit(tx, userId, id, 'CRYPTO_DEPOSIT_CREATED');
    await flush(tx);
    return paymentView(d);
  });
}
export async function createWithdrawal(userId: string, tokenIat: number, body: unknown) {
  const b = parse(withdrawalSchema, body),
    amount = withdrawalUsdt(b.coinAmount);
  return prisma.$transaction(async (tx) => {
    await lockUserEconomicScope(tx, `crypto:${userId}`);
    await actor(tx, userId);
    const [old] = await tx.$queryRaw<
      Withdrawal[]
    >`SELECT * FROM crypto_withdrawals WHERE "userId"=${userId} AND "requestKey"=${b.idempotencyKey}`;
    if (old) {
      if (
        old.coinAmount !== b.coinAmount ||
        old.countryId !== b.countryId ||
        old.address !== b.address
      )
        throw ApiError.conflict('Idempotency key has different withdrawal details');
      return paymentView(old);
    }
    const { pricing, policy, snapshot } = await context(tx, userId, b.countryId, 'withdrawal');
    if (amount <= BigInt(pricing.cryptoWithdrawalAboveUsdCents) * 10_000n)
      throw ApiError.badRequest(
        `Withdrawal must exceed ${formatUsdt(BigInt(pricing.cryptoWithdrawalAboveUsdCents) * 10_000n)} USDT`
      );
    if (policy.manualReviewThreshold > 0 && b.coinAmount >= policy.manualReviewThreshold)
      throw ApiError.forbidden('Amount requires a separately approved enhanced review');
    const security = await tx.userSecurityPolicy.findUnique({ where: { userId } });
    if (security?.requiresStepUpForSensitiveOps)
      await requireStepUp({ userId, tokenIat }, 'CRYPTO_WITHDRAWAL_CREATE', tx);
    // Same wallet serialization as the P2P path: cross-channel limits cannot race.
    await lockEconomicWallet(tx, userId);
    await assertWithdrawalPolicyLimits(tx, userId, b.coinAmount, policy, new Date());
    const [live] = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM crypto_withdrawals WHERE "userId"=${userId} AND status IN ('HELD','PAYOUT_IN_PROGRESS')`;
    if (live) throw ApiError.conflict('You already have an active crypto withdrawal');
    if (
      await tx.withdrawal.count({
        where: {
          userId,
          status: { in: ['HELD', 'PAYOUT_IN_PROGRESS', 'PAYMENT_SUBMITTED', 'DISPUTED'] },
        },
      })
    )
      throw ApiError.conflict('You already have an active withdrawal');
    const id = randomUUID();
    const held = await reserveWithdrawalCoins(tx, userId, b.coinAmount, {
      withdrawalId: id,
      policyId: policy.id,
      policyVersion: policy.version,
      holdingPeriodHours: policy.holdingPeriodHours,
    });
    const [w] = await tx.$queryRaw<
      Withdrawal[]
    >`INSERT INTO crypto_withdrawals(id,"userId","countryId",address,"amountMicro","coinAmount","pricingSnapshot","requestKey","holdOperationId") VALUES(${id},${userId},${b.countryId},${b.address},${amount},${b.coinAmount},${JSON.stringify(snapshot)}::jsonb,${b.idempotencyKey},${held.holdOperationId}) RETURNING *`;
    await audit(tx, userId, id, 'CRYPTO_WITHDRAWAL_HELD');
    await flush(tx);
    return paymentView(w);
  });
}
export async function processWithdrawal(
  actorId: string,
  tokenIat: number,
  id: string,
  action: 'claim' | 'cancel' | 'confirm',
  body: unknown,
  admin: boolean
) {
  const confirmation = action === 'confirm' ? parse(confirmSchema, body) : null;
  return prisma.$transaction(async (tx) => {
    const [preview] = await tx.$queryRaw<
      Withdrawal[]
    >`SELECT * FROM crypto_withdrawals WHERE id=${id}`;
    if (!preview) throw ApiError.notFound('Withdrawal not found');
    await lockUserEconomicScope(tx, `crypto:${preview.userId}`);
    // User locks always precede business locks, including for suspended owners.
    for (const uid of [...new Set([actorId, preview.userId])].sort())
      await tx.$queryRaw`SELECT id FROM users WHERE id=${uid} FOR SHARE`;
    await actor(tx, actorId, admin, !admin && action === 'cancel');
    if (admin ? preview.userId === actorId : preview.userId !== actorId)
      throw ApiError.forbidden('You cannot process this withdrawal');
    if (!admin && action !== 'cancel') throw ApiError.forbidden('Administrator required');
    const [w] = await tx.$queryRaw<
      Withdrawal[]
    >`SELECT * FROM crypto_withdrawals WHERE id=${id} FOR UPDATE`;
    if (action === 'claim') {
      if (w.status === 'PAYOUT_IN_PROGRESS' && w.assignedAdminId === actorId) return paymentView(w);
      if (w.status !== 'HELD')
        throw ApiError.conflict('Withdrawal is no longer awaiting an administrator');
      await requireStepUp({ userId: actorId, tokenIat }, `CRYPTO_WITHDRAWAL_CLAIM:${id}`, tx);
      await tx.$executeRaw`UPDATE crypto_withdrawals SET status='PAYOUT_IN_PROGRESS',"assignedAdminId"=${actorId} WHERE id=${id}`;
    } else if (action === 'cancel') {
      if (w.status === 'CANCELLED') return paymentView(w);
      if (w.status !== 'HELD')
        throw ApiError.conflict('Payout has started; cancellation is no longer available');
      const r = await releaseWithdrawalCoins(tx, w.userId, id, {
        holdOperationId: w.holdOperationId,
        amount: w.coinAmount,
        createdBy: actorId,
      });
      await tx.$executeRaw`UPDATE crypto_withdrawals SET status='CANCELLED',"terminalOperationId"=${r.releaseOperationId} WHERE id=${id}`;
    } else {
      if (
        w.status === 'COMPLETED' &&
        w.assignedAdminId === actorId &&
        w.txHash === confirmation!.txHash
      )
        return paymentView(w);
      if (w.status !== 'PAYOUT_IN_PROGRESS' || w.assignedAdminId !== actorId)
        throw ApiError.conflict('Only the assigned administrator can confirm this payout');
      await requireStepUp({ userId: actorId, tokenIat }, `CRYPTO_WITHDRAWAL_CONFIRM:${id}`, tx);
      const r = await finalizeWithdrawalCoins(tx, w.userId, id, {
        holdOperationId: w.holdOperationId,
        amount: w.coinAmount,
        createdBy: actorId,
      });
      await tx.$executeRaw`UPDATE crypto_withdrawals SET status='COMPLETED',"txHash"=${confirmation!.txHash},"completedAt"=now(),"terminalOperationId"=${r.finalizeOperationId} WHERE id=${id}`;
    }
    await audit(tx, actorId, id, `CRYPTO_WITHDRAWAL_${action.toUpperCase()}`);
    await flush(tx);
    const [updated] = await tx.$queryRaw<
      Withdrawal[]
    >`SELECT * FROM crypto_withdrawals WHERE id=${id}`;
    return paymentView(updated);
  });
}
/** Worker only. Its separate DB identity is the only runtime that can insert evidence. */
export async function settleDeposit(
  id: string,
  transfers: Transfer[],
  db: { $transaction<T>(body: (tx: Tx) => Promise<T>): Promise<T> } = prisma
) {
  return db.$transaction(async (tx) => {
    const [preview] = await tx.$queryRaw<Deposit[]>`SELECT * FROM crypto_deposits WHERE id=${id}`;
    if (!preview) throw ApiError.notFound('Deposit not found');
    await lockUserEconomicScope(tx, `crypto:${preview.userId}`);
    await actor(tx, preview.userId);
    await requirePlatformGate(tx, 'CRYPTO_DEPOSIT_CREDIT');
    const [d] = await tx.$queryRaw<
      Deposit[]
    >`SELECT * FROM crypto_deposits WHERE id=${id} FOR UPDATE`;
    if (d.status === 'CREDITED' || d.status === 'REVIEW') return;
    // Stop new credits when jurisdiction authority is removed; preserve evidence for recovery.
    const c = await tx.country.findUnique({ where: { id: d.countryId } }),
      policy = c && (await activePolicyForCountry(tx, c.code));
    if (
      !c?.isActive ||
      !policy ||
      !Array.isArray(policy.supportedPaymentMethods) ||
      !policy.supportedPaymentMethods.includes('USDT_TRC20')
    )
      throw ApiError.forbidden('Deposit credit is paused for this country');
    const unique = [...new Map(transfers.map((t) => [`${t.txHash}:${t.logIndex}`, t])).values()];
    for (const t of unique)
      await tx.$executeRaw`INSERT INTO crypto_receipts(id,"depositId","txHash","logIndex",contract,address,"amountMicro","blockNumber","blockTime") VALUES(${randomUUID()},${id},${t.txHash},${t.logIndex},${USDT_CONTRACT},${d.address},${t.amount},${t.blockNumber},${t.blockTime}) ON CONFLICT("txHash","logIndex") DO NOTHING`;
    const receipts = await tx.$queryRaw<
      Array<{ id: string; amountMicro: bigint; blockTime: Date }>
    >`SELECT id,"amountMicro","blockTime" FROM crypto_receipts WHERE "depositId"=${id}`;
    if (!receipts.length) {
      await tx.$executeRaw`UPDATE crypto_deposits SET status=CASE WHEN "expiresAt"<=now() THEN 'EXPIRED' ELSE status END,"lastCheckedAt"=now(),"checkError"=NULL WHERE id=${id}`;
      return;
    }
    const exact =
      receipts.length === 1 &&
      receipts[0].amountMicro === d.amountMicro &&
      receipts[0].blockTime >= d.createdAt &&
      receipts[0].blockTime <= d.expiresAt;
    if (!exact) {
      await tx.$executeRaw`UPDATE crypto_deposits SET status='REVIEW',"reviewReason"='Transfer amount, time or number of transfers needs review',"lastCheckedAt"=now(),"checkError"=NULL WHERE id=${id}`;
      await audit(tx, d.userId, id, 'CRYPTO_DEPOSIT_REVIEW');
      return;
    }
    await creditCoins(tx, d.userId, d.coinAmount, {
      type: 'PURCHASE',
      scopeType: 'CRYPTO_DEPOSIT',
      scopeId: id,
      referenceType: 'PURCHASE',
      referenceId: id,
      description: 'Verified USDT on TRON deposit',
      completePurchaseProof: async (inner, walletTransactionId) => {
        const sid = randomUUID();
        await inner.$executeRaw`UPDATE crypto_deposits SET status='CREDITED',"lastCheckedAt"=now(),"checkError"=NULL WHERE id=${id}`;
        await inner.$executeRaw`INSERT INTO crypto_deposit_settlements(id,"depositId","receiptId","walletTransactionId") VALUES(${sid},${id},${receipts[0].id},${walletTransactionId})`;
        return sid;
      },
    });
    await audit(tx, d.userId, id, 'CRYPTO_DEPOSIT_CREDITED');
    await flush(tx);
  });
}
