// Shared fixtures for the ledger-integrity contract tests. Users are funded
// through the real agent-order purchase path; malformed legacy states are
// planted with triggers bypassed (session_replication_role = replica), the
// way pre-existing data would look to a guard that was installed later.
// Every planting helper is meant to run inside a transaction the caller
// always rolls back, because the financial tables are append-only.
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '@socialplay/database';
import { submitAgentApplication, approveAgentApplication } from '../agents/agent-service.js';
import { createAgentPaymentAccount, approveAgentPaymentAccount } from '../agents/payment-account-service.js';
import { fundAgentInventory } from '../agents/inventory-service.js';
import { fundAgentFiatLiquidity } from '../withdrawals/liquidity-service.js';
import { createAgentOrder, submitOrderPayment, settleAgentOrder } from '../agents/order-service.js';
import { activateTestPolicy } from '../ledger/test-policy-fixture.js';

export type Tx = Prisma.TransactionClient;
export type Statement = [string, ...unknown[]];

export const uid = (prefix: string) => `${prefix}-${randomUUID()}`;

export async function user(label: string, role?: 'ADMIN' | 'SUPER_ADMIN') {
  const tag = randomUUID().replaceAll('-', '');
  return prisma.user.create({
    data: { email: `integrity-${label}-${tag}@test.local`, username: `i${tag.slice(0, 14)}`,
      passwordHash: 'fixture-only', displayName: label, ...(role ? { role } : {}) },
  });
}

async function unusedCountryCode() {
  for (;;) {
    const code = `Q${randomUUID().replaceAll('-', '').slice(0, 2)}`.toUpperCase();
    if (!await prisma.country.findUnique({ where: { code } })) return code;
  }
}

/** A buyer whose Coins come from one real, settled agent order. The buyer's
 * account is classified and its wallet equals its single WITHDRAWABLE lot. */
export async function purchasedFixture(amount: number) {
  const tag = randomUUID().replaceAll('-', '').slice(0, 12);
  const admin = await user(`admin-${tag}`, 'ADMIN');
  const superAdmin = await user(`super-${tag}`, 'SUPER_ADMIN');
  const agentUser = await user(`agent-${tag}`);
  const buyer = await user(`buyer-${tag}`);
  const countryCode = await unusedCountryCode();
  const country = await prisma.country.create({
    data: { code: countryCode, name: `Integrity ${tag}`, currencyCode: 'USD', isActive: true, agentPaymentEnabled: true },
  });
  const method = await prisma.paymentMethodDefinition.create({
    data: { countryId: country.id, type: 'BANK_TRANSFER', name: `Integrity bank ${tag}`,
      fieldSchema: { requiredFields: ['bankName', 'accountNumber'] }, isActive: true },
  });
  await prisma.exchangeRateConfig.create({
    data: { countryId: country.id, fiatCurrency: 'USD', coinsPerUnit: 2, isActive: true,
      setBy: admin.id, effectiveAt: new Date(Date.now() - 1000) },
  });
  const policy = await prisma.countryCasinoPolicy.create({
    data: {
      countryCode, version: 1, status: 'ENABLED', enabledAt: new Date(),
      minWithdrawal: 1, maxWithdrawal: 1000000, dailyWithdrawalLimit: 1000000,
      monthlyWithdrawalLimit: 10000000, playthroughMultiplier: 2,
      qualifyingGames: ['dice'], maxQualifyingStake: 1000, holdingPeriodHours: 0,
      giftDailyLimit: 100000, kycTierRequired: 0, supportedPaymentMethods: ['BANK_TRANSFER'],
      withdrawalFeePercent: 0, manualReviewThreshold: 1000000,
    },
  });
  await activateTestPolicy(policy.id, countryCode, admin.id);
  const application = await submitAgentApplication(agentUser.id, {
    countryId: country.id, displayName: `Integrity agent ${tag}`, contactEmail: `agent-${tag}@test.local`,
  });
  await approveAgentApplication(admin.id, application.application.id, undefined);
  const agent = await prisma.agent.findUniqueOrThrow({ where: { userId: agentUser.id } });
  const agentAccount = await createAgentPaymentAccount(agentUser.id, {
    countryId: country.id, methodDefId: method.id,
    accountDetails: { bankName: 'Test Bank', accountNumber: '000111222' },
  });
  await approveAgentPaymentAccount(admin.id, agentAccount.id);
  await fundAgentInventory(superAdmin.id, agent.id, amount * 4, uid('inventory'));
  await fundAgentFiatLiquidity(superAdmin.id, agent.id, 'USD', BigInt(amount * 4), uid('liquidity'));
  const created = await createAgentOrder(buyer.id, {
    agentId: agent.id, countryId: country.id, paymentAccountId: agentAccount.id,
    fiatAmount: amount / 2, idempotencyKey: uid('order'),
  });
  await submitOrderPayment(buyer.id, created.order.id);
  await settleAgentOrder(agentUser.id, created.order.id);
  const purchaseLot = await prisma.coinProvenance.findFirstOrThrow({
    where: { userId: buyer.id, lotClass: 'WITHDRAWABLE' },
  });
  return { buyer, country, purchaseLot, superAdmin };
}
export type PurchasedFixture = Awaited<ReturnType<typeof purchasedFixture>>;

/** Run statements with ordinary triggers bypassed, then restore them. */
export async function asLegacy(tx: Tx, statements: Statement[]): Promise<void> {
  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
  for (const [sql, ...params] of statements) await tx.$executeRawUnsafe(sql, ...params);
  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
}

export interface LotFields {
  lotClass?: string | null; state?: string | null;
  available?: number | null; reserved?: number | null;
  requirement?: number | null; progress?: number | null;
  sourceOperationId?: string | null; reviewId?: string | null; amount?: number;
}

/** INSERT for one coin_provenance row; every ledger field is explicit. */
export function lotSql(id: string, userId: string, f: LotFields): Statement {
  return [
    `INSERT INTO "coin_provenance" ("id","userId","amount","provenanceType","restrictionStatus","originalSource",
       "lotClass","state","availableAmount","reservedAmount","requirementAmount","progressAmount",
       "mintedAt","availableAt","sourceOperationId","reviewId","createdAt","updatedAt")
     VALUES ($1,$2,$3,'ADMIN_ADJUSTMENT','UNRESTRICTED','ADMIN_ADJUSTMENT',
       $4::"lot_class",$5::"lot_state",$6,$7,$8,$9,now(),now(),$10,$11,now(),now())`,
    id, userId, f.amount ?? Math.max(f.available ?? 0, f.reserved ?? 0, 1),
    f.lotClass === undefined ? 'WITHDRAWABLE' : f.lotClass,
    f.state === undefined ? 'OPEN' : f.state,
    f.available === undefined ? 0 : f.available, f.reserved === undefined ? 0 : f.reserved,
    f.requirement === undefined ? 0 : f.requirement, f.progress === undefined ? 0 : f.progress,
    f.sourceOperationId ?? null, f.reviewId ?? null,
  ];
}

/** A pre-journal ("fully legacy") row: every ledger field NULL. */
export function legacyLotSql(id: string, userId: string, amount: number): Statement {
  return [
    `INSERT INTO "coin_provenance" ("id","userId","amount","provenanceType","restrictionStatus","originalSource",
       "requiredPlaythrough","completedPlaythrough","createdAt","updatedAt")
     VALUES ($1,$2,$3,'LEGACY_UNTRACKED','RESTRICTED','LEGACY_UNTRACKED',0,0,now(),now())`,
    id, userId, amount,
  ];
}

/** A LEGACY_OPENING operation; scope WITHDRAWAL is the only one whose
 * opening journal may also RESERVE (a pre-ledger active withdrawal hold). */
export function operationSql(id: string, userId: string, scopeId = id, scopeType = 'LEGACY_LOT'): Statement {
  return [
    `INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId","walletTransactionIds","createdBy","createdAt")
     VALUES ($1,'LEGACY_OPENING',$2,$4,$3,'{}','SYSTEM',now())`,
    id, userId, scopeId, scopeType,
  ];
}

export function entrySql(operationId: string, lotId: string, userId: string, sequence: number,
  entryType: string, deltas: { available?: number; reserved?: number; progress?: number; obligation?: number }): Statement {
  return [
    `INSERT INTO "coin_lot_entries" ("id","operationId","lotId","userId","sequence","entryType",
       "availableDelta","reservedDelta","progressDelta","obligationDelta")
     VALUES ($1,$2,$3,$4,$5,$6::"entry_type",$7,$8,$9,$10)`,
    uid('entry'), operationId, lotId, userId, sequence, entryType,
    deltas.available ?? 0, deltas.reserved ?? 0, deltas.progress ?? 0, deltas.obligation ?? 0,
  ];
}

export function reviewSql(id: string, userId: string, lotId: string, amount: number, status: string,
  approvers?: { first: string; second: string; operationId?: string }): Statement {
  return [
    `INSERT INTO "legacy_balance_reviews" ("id","userId","lotId","amount","evidence","status",
       "resolvedBy","secondApproverId","resolutionOperationId","resolvedAt","createdAt")
     VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,CASE WHEN $5 = 'RESOLVED' THEN now() ELSE NULL END,now())`,
    id, userId, lotId, amount, status,
    approvers?.first ?? null, approvers?.second ?? null, approvers?.operationId ?? null,
  ];
}

export const walletDeltaSql = (userId: string, delta: number): Statement =>
  ['UPDATE "wallets" SET "coinsBalance" = "coinsBalance" + $2 WHERE "userId" = $1', userId, delta];

export const accountSql = (userId: string, classified: boolean): Statement =>
  [`INSERT INTO "coin_ledger_accounts" ("userId","classifiedAt") VALUES ($1, CASE WHEN $2 THEN now() ELSE NULL END)`, userId, classified];

export const walletSql = (userId: string, coins: number): Statement =>
  [`INSERT INTO "wallets" ("id","userId","coinsBalance","gamePointsBalance","updatedAt") VALUES ($1,$2,$3,0,now())`,
    uid('wallet'), userId, coins];

/** A user row with no wallet, account or lots. */
export const bareUserSql = (userId: string): Statement => [
  `INSERT INTO "users" ("id","email","username","passwordHash","displayName","status","createdAt","updatedAt")
   VALUES ($1, $1 || '@integrity.test.local', substr(md5($1), 1, 14), 'fixture-only', 'fixture', 'ACTIVE', now(), now())`,
  userId,
];

/** Probes whether the database guards reject any write touching the given
 * row, evaluating deferred constraint triggers immediately. */
export async function constraintVerdict(tx: Tx, probe: string): Promise<string> {
  await tx.$executeRawUnsafe('SAVEPOINT integrity_probe');
  try {
    await tx.$executeRawUnsafe(probe);
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL DEFERRED');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT integrity_probe');
    return 'accepts';
  } catch (error) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT integrity_probe');
    const lines = String((error as Error).message).split('\n').filter(Boolean);
    return `rejects: ${lines[lines.length - 1]?.slice(0, 160) ?? ''}`;
  }
}

export const touchLot = (id: string) => `UPDATE "coin_provenance" SET "updatedAt" = now() WHERE "id" = '${id}'`;
export const touchWallet = (userId: string) => `UPDATE "wallets" SET "updatedAt" = now() WHERE "userId" = '${userId}'`;
export const touchAccount = (userId: string) =>
  `UPDATE "coin_ledger_accounts" SET "classifiedAt" = "classifiedAt" WHERE "userId" = '${userId}'`;

/** Always roll the fixture back; the resolved value is the observation. */
export class RolledBack<T> extends Error {
  constructor(public readonly value: T) { super('rolled back by design'); }
}
export async function inRolledBackTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => { throw new RolledBack(await fn(tx)); }, { timeout: 120_000 });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as T;
    throw error;
  }
  throw new Error('unreachable: fixture transaction committed');
}

export interface AssertionTerms {
  subjectType: 'ADMIN_ADJUSTMENT' | 'LEGACY_REVIEW';
  subjectId: string;
  action: 'REQUEST' | 'FIRST_APPROVAL' | 'SECOND_APPROVAL' | 'REJECT' | 'CANCEL' | 'REOPEN';
  actorId: string;
  userId: string;
  amount: number;
  caseId: string;
  /** SQL expression of type jsonb; extra parameters are numbered from $9. */
  evidence: string;
  evidenceParams?: unknown[];
  /** 'forged': a well-formed digest that no approval key produced. */
  signature?: 'valid' | 'forged';
}

/**
 * One approval assertion as the API records it, signed inside SQL with the
 * installed test key. Only the owner can do this: it reads
 * ledger_approval_keys, which the runtime role can neither read nor write.
 */
export function signedAssertionSql(a: AssertionTerms): Statement {
  const nonce = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const signature = a.signature === 'forged'
    ? `encode(sha256(convert_to($8::text, 'UTF8')), 'hex')`
    : `encode(hmac(convert_to("ledger_approval_payload"($1::text, $2::text, $3::text, $4::text, $5::text, $6::numeric,
        $7::text, d."digest", $8::text), 'UTF8'), k."secret", 'sha256'), 'hex')`;
  return [`INSERT INTO "ledger_approval_assertions" ("subjectType","subjectId","action","actorId","userId","amount",
      "caseId","evidenceDigest","nonce","keyId","signature")
    SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::numeric, $7::text, d."digest", $8::text, k."keyId", ${signature}
    FROM (SELECT "ledger_evidence_digest"(${a.evidence}) AS "digest") d
    CROSS JOIN LATERAL (SELECT * FROM "ledger_approval_keys" WHERE "retiredAt" IS NULL ORDER BY "installedAt" LIMIT 1) k`,
  a.subjectType, a.subjectId, a.action, a.actorId, a.userId, a.amount, a.caseId, nonce, ...(a.evidenceParams ?? [])];
}
