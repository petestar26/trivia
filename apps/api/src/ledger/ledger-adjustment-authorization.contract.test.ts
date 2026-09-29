// ADMIN_ADJUST authorization (migrations 20260924010000 and 20260924040000).
// Every Coin adjustment, credit or debit, executes exactly one immutable
// admin_adjustment_approvals record: requested with its user, signed amount
// and evidence, first-approved and then second-approved (which settles it) by
// two distinct active SUPER_ADMINs, neither of them the user. Each decision is
// also an assertion signed by the API (see ledger_approval_assertions). This
// file proves:
//   1. the service refuses malformed terms before any write, and the workflow
//      (request, first approval, settling second approval, reject, cancel)
//      moves value exactly once and conserves it;
//   2. SQL with every trigger active cannot record an ADMIN_ADJUST that an
//      executed, signed approval does not match exactly; the rows here are
//      written as the owner, who can sign (the runtime role cannot: see
//      runtime-role.contract.test.ts);
//   3. every binding condition, signatures and the backing wallet
//      transaction included, is enforced on its own, judged by the function
//      that the write-time guard, the migration's closing check, the UPGRADED
//      preflight and invariant I16 share;
//   4. the approval record's CHECKs, immutable terms and lifecycle.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';
import {
  MAX_COIN_ADJUSTMENT, adjustmentTerms, closeCoinAdjustment, executeCoinAdjustment,
  firstApproveCoinAdjustment, requestCoinAdjustment,
} from '../economy/admin-adjustment-service.js';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import { collectUnauthorizedOperations } from '../economy/ledger-upgrade-preflight.js';
import { executeTestAdjustment, makeApprovers } from '../test/adjustment-fixtures.js';
import { ROW_LOCK_WAITS, waitForBlockedBackends } from '../test/pg-locks.js';
import type { Approvers } from '../test/adjustment-fixtures.js';
import {
  asLegacy, inRolledBackTransaction, legacyLotSql, purchasedFixture, signedAssertionSql, uid, user,
} from '../test/ledger-integrity-fixtures.js';
import type { PurchasedFixture, Statement, Tx } from '../test/ledger-integrity-fixtures.js';

beforeAll(async () => { await bootstrapLedgerTestGates(); });
afterAll(async () => { await prisma.$disconnect(); });

const oneLine = (error: unknown) =>
  String((error as Error).message).split('\n').map((line) => line.trim()).filter(Boolean).join(' ');

async function verdict(statements: (tx: Tx) => Promise<Statement[]> | Statement[]): Promise<string> {
  return inRolledBackTransaction(async (tx) => {
    try {
      for (const [sql, ...params] of await statements(tx)) await tx.$executeRawUnsafe(sql, ...params);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      return 'accepts';
    } catch (error) {
      return `rejects: ${oneLine(error)}`;
    }
  });
}

const rationale = 'Documented historical balance correction';
const evidenceFor = (caseId: string) => ({ caseId, rationale, supportingEvidence: ['case-evidence-sql'] });

interface EntrySpec {
  type: 'MINT' | 'CONSUME' | 'RECLASS_IN' | 'RECLASS_OUT'; delta: number; reserved?: number;
  lot: 'new' | string; lotUser?: string; lotClass?: string;
}

/** One adjustment as ordinary SQL: the exact writes executeCoinAdjustment
 * makes (approval request and first approval, the wallet transaction and
 * balance, the operation, its lot and review, its entries, and the
 * approval's execution), with one deviation at a time. */
interface Plan {
  userId: string;
  amount: number;
  first: string;
  second: string;
  creator?: string;
  debitLot?: string;
  approval?: 'executed' | 'first-approved' | 'pending' | 'none' | 'pending-to-executed';
  approvalUser?: string;
  createdBy?: string;
  opUser?: string;
  opType?: string;
  snapshotApprovalId?: string;
  snapshotAmount?: number;
  snapshotEvidence?: Record<string, unknown>;
  entries?: EntrySpec[];
  wallet?: Partial<{ amount: number; ledgerType: 'CREDIT' | 'DEBIT'; currency: string; status: string; userId: string;
    referenceType: string; referenceId: string; type: string }>;
  walletIds?: 'one' | 'none' | 'two' | 'other';
  moveWallet?: boolean;
  /** Back the adjustment with this existing wallet transaction instead of a new one. */
  reuseWalletTransaction?: string;
  /** The signed assertions each recorded decision carries (default valid). */
  signatures?: 'valid' | 'none' | 'forged';
  unsigned?: 'REQUEST' | 'FIRST_APPROVAL' | 'SECOND_APPROVAL';
  signedTerms?: Partial<{ actorId: string; userId: string; amount: number; caseId: string; evidence: unknown }>;
}

interface Planted { approval: string; op: string; wtx: string; caseId: string; lots: string[]; statements: Statement[] }

function walletTxSql(id: string, userId: string, ledgerType: string, currency: string, amount: number, status: string,
  referenceId: string, referenceType = 'ADMIN', type?: string): Statement {
  return [`INSERT INTO "wallet_transactions" ("id","walletId","userId","type","ledgerType","currency","amount",
      "balanceBefore","balanceAfter","referenceType","referenceId","description","status","createdAt")
    SELECT $1, w."id", w."userId", $2::"EconomyTransactionType", $3::"LedgerType", $4::"CurrencyType", $5,
      w."coinsBalance", w."coinsBalance" + (CASE WHEN $3 = 'CREDIT' THEN $5 ELSE -$5 END),
      $9::"TransactionReferenceType", $6, 'Coin adjustment', $7::"WalletTransactionStatus", now()
    FROM "wallets" w WHERE w."userId" = $8`,
    id, type ?? (ledgerType === 'CREDIT' ? 'COIN_CREDIT' : 'COIN_DEBIT'), ledgerType, currency, amount, referenceId, status,
    userId, referenceType];
}

function planSql(p: Plan): Planted {
  const approval = uid('adj-approval'); const op = uid('adj-op'); const wtx2 = uid('adj-wtx2');
  const wtx = p.reuseWalletTransaction ?? uid('adj-wtx');
  const caseId = uid('adj-case'); const evidence = evidenceFor(caseId);
  const opUser = p.opUser ?? p.userId; const mode = p.approval ?? 'executed';
  const statements: Statement[] = []; const lots: string[] = [];
  if (mode !== 'none') {
    statements.push([`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy")
      VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, approval, p.approvalUser ?? p.userId, p.amount, caseId, JSON.stringify(evidence), p.creator ?? p.first]);
    if (mode === 'executed' || mode === 'first-approved') {
      statements.push([`UPDATE "admin_adjustment_approvals" SET "status" = 'FIRST_APPROVED', "firstApproverId" = $2,
        "firstApprovedAt" = now() WHERE "id" = $1`, approval, p.first]);
    }
  }
  const w = { amount: Math.abs(p.amount), ledgerType: p.amount > 0 ? 'CREDIT' : 'DEBIT', currency: 'COINS',
    status: 'SUCCEEDED', userId: opUser, referenceType: 'ADMIN', referenceId: caseId, type: undefined as string | undefined,
    ...p.wallet };
  if (!p.reuseWalletTransaction) {
    statements.push(walletTxSql(wtx, w.userId, w.ledgerType, w.currency, w.amount, w.status, w.referenceId, w.referenceType, w.type));
  }
  if (p.moveWallet ?? true) {
    statements.push(['UPDATE "wallets" SET "coinsBalance" = "coinsBalance" + $2, "updatedAt" = now() WHERE "userId" = $1',
      w.userId, w.ledgerType === 'CREDIT' ? w.amount : -w.amount]);
  }
  const walletIds: string[] = { one: [wtx], none: [], two: [wtx, wtx2], other: [wtx2] }[p.walletIds ?? 'one'];
  if (walletIds.includes(wtx2)) statements.push(walletTxSql(wtx2, w.userId, w.ledgerType, w.currency, w.amount, w.status, caseId));
  const snapshot = { evidence: p.snapshotEvidence ?? evidence, approvalId: p.snapshotApprovalId ?? approval, amount: p.snapshotAmount ?? p.amount };
  statements.push([`INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId","walletTransactionIds","createdBy","snapshot")
    VALUES ($1,$2::"operation_type",$3,'ADMIN_ADJUSTMENT',$4,
      CASE WHEN $5 = '' THEN ARRAY[]::text[] ELSE string_to_array($5, ',') END,$6,$7::jsonb)`,
    op, p.opType ?? 'ADMIN_ADJUST', opUser, caseId, walletIds.join(','), p.createdBy ?? p.second, JSON.stringify(snapshot)]);
  const entries = p.entries ?? (p.amount > 0
    ? [{ type: 'MINT' as const, delta: p.amount, lot: 'new' }]
    : [{ type: 'CONSUME' as const, delta: p.amount, lot: p.debitLot! }]);
  entries.forEach((e, sequence) => {
    const lotUser = e.lotUser ?? opUser;
    let lotId = e.lot;
    if (e.lot === 'new') {
      lotId = uid('adj-lot');
      const lotClass = e.lotClass ?? 'UNCLASSIFIED';
      statements.push([`INSERT INTO "coin_provenance" ("id","userId","walletTransactionId","amount","provenanceType",
          "restrictionStatus","originalSource","lotClass","state","availableAmount","reservedAmount",
          "requirementAmount","progressAmount","mintedAt","availableAt","sourceOperationId","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,'ADMIN_ADJUSTMENT',
          '${lotClass === 'WITHDRAWABLE' ? 'UNRESTRICTED' : 'RESTRICTED'}','ADMIN_ADJUSTMENT',$5::"lot_class",'OPEN',0,0,0,0,
          now(),now(),$6,now(),now())`, lotId, lotUser, wtx, Math.abs(e.delta), lotClass, op]);
      if (lotClass === 'UNCLASSIFIED') {
        const review = uid('adj-review');
        statements.push([`INSERT INTO "legacy_balance_reviews" ("id","userId","lotId","amount","evidence","status","createdAt")
          VALUES ($1,$2,$3,$4,jsonb_build_object('sourceOperationId', $5::text),'OPEN',now())`,
          review, lotUser, lotId, Math.abs(e.delta), op]);
        statements.push(['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', lotId, review]);
      }
    }
    lots.push(lotId);
    statements.push([`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta","reservedDelta")
      VALUES ($1,$2,$3,$4,$5::"entry_type",$6,$7)`, op, lotId, lotUser, sequence, e.type, e.delta, e.reserved ?? 0]);
  });
  if (mode === 'executed' || mode === 'pending-to-executed') {
    statements.push([`UPDATE "admin_adjustment_approvals" SET "status" = 'EXECUTED', "secondApproverId" = $2,
      "secondApprovedAt" = now(), "operationId" = $3, "walletTransactionId" = $4, "executedAt" = now()
      WHERE "id" = $1`, approval, p.second, op, wtx]);
  }
  const decisions: [NonNullable<Plan['unsigned']>, string][] = mode === 'none' ? [] : [
    ['REQUEST', p.creator ?? p.first],
    ...(mode === 'executed' || mode === 'first-approved' ? [['FIRST_APPROVAL', p.first] as [NonNullable<Plan['unsigned']>, string]] : []),
    ...(mode === 'executed' || mode === 'pending-to-executed' ? [['SECOND_APPROVAL', p.second] as [NonNullable<Plan['unsigned']>, string]] : []),
  ];
  if ((p.signatures ?? 'valid') !== 'none') {
    for (const [action, actor] of decisions.filter(([action]) => action !== p.unsigned)) {
      statements.push(signedAssertionSql({
        subjectType: 'ADMIN_ADJUSTMENT', subjectId: approval, action,
        actorId: p.signedTerms?.actorId ?? actor, userId: p.signedTerms?.userId ?? p.approvalUser ?? p.userId,
        amount: p.signedTerms?.amount ?? p.amount, caseId: p.signedTerms?.caseId ?? caseId,
        evidence: '$9::jsonb', evidenceParams: [JSON.stringify(p.signedTerms?.evidence ?? evidence)],
        signature: p.signatures === 'forged' ? 'forged' : 'valid',
      }));
    }
  }
  return { approval, op, wtx, caseId, lots, statements };
}

async function balances(userId: string) {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  const lots = await prisma.coinProvenance.findMany({ where: { userId } });
  return { wallet: wallet.coinsBalance, lots: lots.reduce((sum, lot) => sum + (lot.availableAmount ?? 0), 0) };
}

describe('Coin adjustments execute exactly one two-administrator approval', () => {
  let f: PurchasedFixture; let other: PurchasedFixture; let approvers: Approvers;
  let A: string; let B: string;
  beforeAll(async () => {
    f = await purchasedFixture(1000);
    other = await purchasedFixture(500);
    approvers = await makeApprovers('adj-auth');
    A = approvers.first.id; B = approvers.second.id;
  });
  const credit = (change: Partial<Plan> = {}): Plan => ({ userId: f.buyer.id, amount: 30, first: A, second: B, ...change });
  const debit = (change: Partial<Plan> = {}): Plan =>
    ({ userId: f.buyer.id, amount: -20, first: A, second: B, debitLot: f.purchaseLot.id, ...change });

  describe('1. the service', () => {
    const valid = () => ({ targetUserId: f.buyer.id, caseId: `svc-${randomUUID()}`, delta: 25, rationale,
      supportingEvidence: ['case-evidence-svc'] });

    it('refuses malformed terms before anything is recorded', async () => {
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ delta: 1.5 }, /whole number of Coins/], [{ delta: -0.5 }, /whole number of Coins/],
        [{ delta: '25' }, /whole number of Coins/], [{ delta: Number.NaN }, /whole number of Coins/],
        [{ delta: Number.POSITIVE_INFINITY }, /whole number of Coins/], [{ delta: 2 ** 53 }, /whole number of Coins/],
        [{ delta: null }, /whole number of Coins/], [{ delta: 0 }, /must not be zero/], [{ delta: -0 }, /must not be zero/],
        [{ delta: MAX_COIN_ADJUSTMENT + 1 }, /at most 1000000000 Coins/],
        [{ delta: -MAX_COIN_ADJUSTMENT - 1 }, /at most 1000000000 Coins/],
        [{ rationale: '' }, /rationale/], [{ rationale: '             ' }, /rationale/], [{ rationale: 'too short' }, /rationale/],
        [{ rationale: 42 }, /rationale/],
        [{ supportingEvidence: [] }, /supporting evidence/], [{ supportingEvidence: [''] }, /supporting evidence/],
        [{ supportingEvidence: ['   '] }, /supporting evidence/], [{ supportingEvidence: [3] }, /supporting evidence/],
        [{ supportingEvidence: 'case-evidence' }, /supporting evidence/], [{ supportingEvidence: {} }, /supporting evidence/],
        [{ supportingEvidence: undefined }, /supporting evidence/],
        [{ caseId: '' }, /case ID/], [{ caseId: '   ' }, /case ID/], [{ caseId: 'x'.repeat(129) }, /case ID/],
        [{ targetUserId: '' }, /affected user/], [{ targetUserId: 7 }, /affected user/],
      ];
      const before = await prisma.adminAdjustmentApproval.count();
      for (const [change, message] of cases) {
        const input = { ...valid(), ...change };
        expect(() => adjustmentTerms(input), JSON.stringify(change)).toThrow(message);
        await expect(requestCoinAdjustment(A, input), JSON.stringify(change)).rejects.toMatchObject({ statusCode: 400 });
      }
      expect(() => adjustmentTerms(null)).toThrow(/affected user/);
      expect(await prisma.adminAdjustmentApproval.count()).toBe(before);
      expect(adjustmentTerms({ ...valid(), delta: MAX_COIN_ADJUSTMENT }).amount).toBe(MAX_COIN_ADJUSTMENT);
    });

    it('refuses requesters who are not active SUPER_ADMINs, self-adjustment and unknown users', async () => {
      const admin = await user(uid('plain-admin'), 'ADMIN');
      await expect(requestCoinAdjustment(admin.id, valid())).rejects.toMatchObject({ statusCode: 403 });
      await expect(requestCoinAdjustment(A, { ...valid(), targetUserId: A })).rejects.toMatchObject({ statusCode: 403 });
      await expect(requestCoinAdjustment(A, { ...valid(), targetUserId: uid('nobody') })).rejects.toMatchObject({ statusCode: 404 });
    });

    it('a credit settles once, on the distinct second approval, minting only reviewable UNCLASSIFIED value', async () => {
      const start = await balances(f.buyer.id);
      const terms = valid();
      const requested = await requestCoinAdjustment(A, terms);
      expect(requested).toMatchObject({ status: 'PENDING', idempotent: false });
      expect(await requestCoinAdjustment(A, terms)).toMatchObject({ approvalId: requested.approvalId, idempotent: true });
      await expect(executeCoinAdjustment(B, requested.approvalId)).rejects.toMatchObject({ statusCode: 409 });
      await firstApproveCoinAdjustment(A, requested.approvalId);
      expect(await firstApproveCoinAdjustment(A, requested.approvalId)).toMatchObject({ idempotent: true });
      await expect(executeCoinAdjustment(A, requested.approvalId)).rejects.toMatchObject({ statusCode: 409 });
      expect(await balances(f.buyer.id)).toEqual(start);
      const executed = await executeCoinAdjustment(B, requested.approvalId);
      expect(await executeCoinAdjustment(B, requested.approvalId))
        .toMatchObject({ operationId: executed.operationId, idempotent: true });
      expect(await balances(f.buyer.id)).toEqual({ wallet: start.wallet + 25, lots: start.lots + 25 });

      const approval = await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: requested.approvalId } });
      const operation = await prisma.economicOperation.findUniqueOrThrow({ where: { id: executed.operationId } });
      expect(approval).toMatchObject({ status: 'EXECUTED', userId: f.buyer.id, amount: 25, createdBy: A,
        firstApproverId: A, secondApproverId: B, operationId: operation.id, walletTransactionId: operation.walletTransactionIds[0] });
      expect(operation).toMatchObject({ type: 'ADMIN_ADJUST', userId: f.buyer.id, createdBy: B,
        snapshot: { approvalId: approval.id, amount: 25, evidence: approval.evidence } });
      const entries = await prisma.coinLotEntry.findMany({ where: { operationId: operation.id }, include: { lot: true } });
      expect(entries.map((e) => [e.entryType, e.availableDelta, e.lot.lotClass, e.lot.userId]))
        .toEqual([['MINT', 25, 'UNCLASSIFIED', f.buyer.id]]);
      const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: executed.reviewLotId! } });
      expect(review.status).toBe('OPEN');
      const walletTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: approval.walletTransactionId! } });
      expect(walletTx).toMatchObject({ userId: f.buyer.id, currency: 'COINS', ledgerType: 'CREDIT', amount: 25, status: 'SUCCEEDED' });
    });

    it('two identical concurrent second approvals settle once; both succeed and return the same settlement', async () => {
      const requested = await requestCoinAdjustment(A, valid());
      await firstApproveCoinAdjustment(A, requested.approvalId);
      const operationsBefore = await prisma.economicOperation.count({ where: { userId: f.buyer.id, type: 'ADMIN_ADJUST' } });
      // Barrier: a third session holds the second approver's user row, so the
      // first request parks right after taking the approval's lock; the second
      // then queues behind that lock with its snapshot already taken.
      let held!: () => void; let release!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${B} FOR UPDATE`;
        held();
        await released;
      }, { timeout: 60_000 });
      await holding;
      const settle = () => executeCoinAdjustment(B, requested.approvalId)
        .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: String(error) }));
      const first = settle();
      await waitForBlockedBackends(1, { waitEvents: ROW_LOCK_WAITS, queryLike: '%FOR SHARE%' });
      const second = settle();
      await waitForBlockedBackends(1, { waitEvents: ['advisory'] });
      release();
      await blocker;
      const results = await Promise.all([first, second]);
      expect(results.map((r) => r.ok), JSON.stringify(results)).toEqual([true, true]);
      const settled = results.map((r) => (r as { value: Awaited<ReturnType<typeof executeCoinAdjustment>> }).value);
      expect(settled.map((r) => r.idempotent).sort()).toEqual([false, true]);
      // Apart from which request settled it, both answers are the same settled operation.
      const withoutFlag = (r: (typeof settled)[number]) => ({ ...r, idempotent: undefined });
      expect(withoutFlag(settled[1])).toEqual(withoutFlag(settled[0]));
      expect(await prisma.economicOperation.count({ where: { userId: f.buyer.id, type: 'ADMIN_ADJUST' } }))
        .toBe(operationsBefore + 1);
    });

    it('a debit consumes exactly the approved amount from the user\'s own lots and conserves value', async () => {
      const start = await balances(f.buyer.id);
      const executed = await executeTestAdjustment(f.buyer.id, -20, approvers);
      expect(await balances(f.buyer.id)).toEqual({ wallet: start.wallet - 20, lots: start.lots - 20 });
      const entries = await prisma.coinLotEntry.findMany({ where: { operationId: executed.operationId }, include: { lot: true } });
      expect(entries.every((e) => e.entryType === 'CONSUME' && e.lot.userId === f.buyer.id && e.lot.lotClass !== null)).toBe(true);
      expect(entries.reduce((sum, e) => sum + e.availableDelta, 0)).toBe(-20);
      const approval = await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: executed.approvalId } });
      expect(approval).toMatchObject({ status: 'EXECUTED', amount: -20 });
      const walletTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: approval.walletTransactionId! } });
      expect(walletTx).toMatchObject({ ledgerType: 'DEBIT', amount: 20, currency: 'COINS', status: 'SUCCEEDED' });
    });

    it('a debit beyond the tracked Coins is refused and leaves the approval awaiting its second approval', async () => {
      const start = await balances(other.buyer.id);
      const requested = await requestCoinAdjustment(A, { ...valid(), targetUserId: other.buyer.id, delta: -(start.wallet + 1) });
      await firstApproveCoinAdjustment(A, requested.approvalId);
      await expect(executeCoinAdjustment(B, requested.approvalId)).rejects.toMatchObject({ statusCode: 400 });
      expect((await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: requested.approvalId } })).status)
        .toBe('FIRST_APPROVED');
      expect(await balances(other.buyer.id)).toEqual(start);
    });

    it('nobody approves an adjustment of their own Coins', async () => {
      const target = await user(uid('target-admin'), 'SUPER_ADMIN');
      const requested = await requestCoinAdjustment(A, { ...valid(), targetUserId: target.id });
      await expect(firstApproveCoinAdjustment(target.id, requested.approvalId)).rejects.toMatchObject({ statusCode: 403 });
      await firstApproveCoinAdjustment(A, requested.approvalId);
      await expect(executeCoinAdjustment(target.id, requested.approvalId)).rejects.toMatchObject({ statusCode: 403 });
      const plain = await user(uid('plain-approver'), 'ADMIN');
      await expect(executeCoinAdjustment(plain.id, requested.approvalId)).rejects.toMatchObject({ statusCode: 403 });
      expect(await prisma.economicOperation.count({ where: { userId: target.id, type: 'ADMIN_ADJUST' } })).toBe(0);
    });

    it('rechecks the first approver when the adjustment settles', async () => {
      for (const change of [{ status: 'SUSPENDED' as const }, { role: 'ADMIN' as const }]) {
        const stale = await user(uid('stale-first'), 'SUPER_ADMIN');
        const requested = await requestCoinAdjustment(stale.id, valid());
        await firstApproveCoinAdjustment(stale.id, requested.approvalId);
        await prisma.user.update({ where: { id: stale.id }, data: change });
        const start = await balances(f.buyer.id);
        await expect(executeCoinAdjustment(B, requested.approvalId)).rejects.toMatchObject({
          statusCode: 403, message: expect.stringContaining('first approver is no longer an active SUPER_ADMIN'),
        });
        expect((await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: requested.approvalId } })).status)
          .toBe('FIRST_APPROVED');
        expect(await balances(f.buyer.id)).toEqual(start);
        await expect(closeCoinAdjustment(B, requested.approvalId, 'REJECTED', 'first approver left'))
          .resolves.toMatchObject({ status: 'REJECTED' });
      }
    });

    it('rejected and cancelled adjustments are terminal; only the requester cancels', async () => {
      const rejected = await requestCoinAdjustment(A, valid());
      await expect(closeCoinAdjustment(B, rejected.approvalId, 'REJECTED', '   ')).rejects.toMatchObject({ statusCode: 400 });
      await closeCoinAdjustment(B, rejected.approvalId, 'REJECTED', 'not supported by the evidence');
      expect(await closeCoinAdjustment(B, rejected.approvalId, 'REJECTED', 'again')).toMatchObject({ idempotent: true });
      await expect(firstApproveCoinAdjustment(A, rejected.approvalId)).rejects.toMatchObject({ statusCode: 409 });
      await expect(executeCoinAdjustment(B, rejected.approvalId)).rejects.toMatchObject({ statusCode: 409 });
      await expect(closeCoinAdjustment(A, rejected.approvalId, 'CANCELLED', 'withdrawn')).rejects.toMatchObject({ statusCode: 409 });

      const cancelled = await requestCoinAdjustment(A, valid());
      await firstApproveCoinAdjustment(A, cancelled.approvalId);
      await expect(closeCoinAdjustment(B, cancelled.approvalId, 'CANCELLED', 'withdrawn')).rejects.toMatchObject({ statusCode: 403 });
      await closeCoinAdjustment(A, cancelled.approvalId, 'CANCELLED', 'withdrawn by the requester');
      await expect(executeCoinAdjustment(B, cancelled.approvalId)).rejects.toMatchObject({ statusCode: 409 });

      const executed = await executeTestAdjustment(f.buyer.id, 3, approvers);
      await expect(closeCoinAdjustment(B, executed.approvalId, 'REJECTED', 'too late')).rejects.toMatchObject({ statusCode: 409 });
      const closed = await prisma.adminAdjustmentApproval.findMany({
        where: { id: { in: [rejected.approvalId, cancelled.approvalId] } }, orderBy: { status: 'asc' } });
      expect(closed.map((a) => [a.status, a.operationId, a.walletTransactionId]))
        .toEqual([['CANCELLED', null, null], ['REJECTED', null, null]]);
    });

    it('a case ID names one set of terms', async () => {
      const terms = valid();
      await requestCoinAdjustment(A, terms);
      for (const change of [{ delta: 26 }, { targetUserId: other.buyer.id }, { supportingEvidence: ['different'] },
        { rationale: `${rationale} (edited)` }]) {
        await expect(requestCoinAdjustment(A, { ...terms, ...change })).rejects.toMatchObject({ statusCode: 409 });
      }
    });
  });

  describe('2. ordinary SQL, every trigger active', () => {
    it('accepts the writes the service makes, for a credit and for a debit', async () => {
      expect(await verdict(() => planSql(credit()).statements)).toBe('accepts');
      expect(await verdict(() => planSql(debit()).statements)).toBe('accepts');
    });

    for (const [name, change, message] of [
      ['no approval at all', { approval: 'none' }, 'is not the execution of any adjustment approval'],
      ['an approval that is only requested', { approval: 'pending' }, 'is not the execution of any adjustment approval'],
      ['an approval that has only its first approval', { approval: 'first-approved' }, 'is not the execution of any adjustment approval'],
      ['an approval moved straight from PENDING to EXECUTED', { approval: 'pending-to-executed' }, 'cannot move from PENDING to EXECUTED'],
      ['an operation recorded by the first approver', { createdBy: 'A' }, 'was recorded by .* not by its executing approver'],
      ['a second approver who is not a SUPER_ADMIN', { second: 'plain' }, 'needs two currently active SUPER_ADMIN approvers'],
      ['a snapshot naming another amount', { snapshotAmount: 31 }, 'does not repeat the terms'],
      ['a mint of more than the approval', { entries: [{ type: 'MINT', delta: 31, lot: 'new' }], wallet: { amount: 31 } },
        'must mint exactly the approved 30 Coins'],
      ['an operation with no entries', { entries: [], moveWallet: false }, 'must mint exactly the approved 30 Coins'],
    ] as const) {
      it(`refuses an ADMIN_ADJUST credit with ${name}`, async () => {
        const plain = await user(uid('plain'));
        const actors: Record<string, string> = { A, plain: plain.id };
        const plan = credit();
        for (const [key, value] of Object.entries(change)) {
          (plan as unknown as Record<string, unknown>)[key] = typeof value === 'string' && value in actors ? actors[value] : value;
        }
        expect(await verdict(() => planSql(plan).statements)).toMatch(new RegExp(`rejects: .*${message}`));
      });
    }

    it('refuses an ADMIN_ADJUST operation with neither entries nor an approval (the operation itself is checked)', async () => {
      expect(await verdict(() => planSql(credit({ approval: 'none', entries: [], moveWallet: false })).statements))
        .toMatch(/rejects: .*is not the execution of any adjustment approval/);
    });

    it('refuses an adjustment backed by a wallet transaction that is not its own Coin adjustment', async () => {
      const purchase = await prisma.economicOperation.findUniqueOrThrow({ where: { id: f.purchaseLot.sourceOperationId! } });
      const purchaseTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: purchase.walletTransactionIds[0] } });
      // The buyer's purchase credit, already the backing of its PURCHASE
      // operation, cannot also back an adjustment of the same amount.
      expect(await verdict(() => planSql(credit({ amount: purchaseTx.amount, reuseWalletTransaction: purchaseTx.id })).statements))
        .toMatch(/rejects: .*is not backed by the approval's own Coin adjustment wallet transaction/);
      for (const wallet of [{ referenceType: 'REWARD' }, { referenceType: 'AGENT_ORDER' }, { referenceId: uid('another-case') },
        { type: 'GIFT_RECEIVE' }]) {
        expect(await verdict(() => planSql(credit({ wallet })).statements), JSON.stringify(wallet))
          .toMatch(/rejects: .*is not backed by the approval's own Coin adjustment wallet transaction/);
      }
    });

    it('refuses an adjustment whose wallet transaction another operation already names', async () => {
      const executed = await executeTestAdjustment(f.buyer.id, 5, approvers);
      const settled = await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: executed.approvalId } });
      const reuse = planSql(credit({ amount: 5, approval: 'none', reuseWalletTransaction: settled.walletTransactionId! }));
      expect(await verdict(() => reuse.statements)).toMatch(/^rejects: /);
      const wager = planSql(credit({ amount: 5, reuseWalletTransaction: settled.walletTransactionId! }));
      expect(await verdict(() => wager.statements))
        .toMatch(/rejects: .*(admin_adjustment_approvals_walletTransactionId_key|Key \("walletTransactionId"\)|is not backed by the approval's own)/);
    });

    it('refuses an approval created already executed', async () => {
      const planted = planSql(credit());
      expect(await verdict(() => [[`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence",
          "status","createdBy","firstApproverId","firstApprovedAt","secondApproverId","secondApprovedAt","executedAt")
        VALUES ($1,$2,30,$3,$4::jsonb,'EXECUTED',$5,$5,now(),$6,now(),now())`,
        uid('adj-approval'), f.buyer.id, planted.caseId, JSON.stringify(evidenceFor(planted.caseId)), A, B]]))
        .toMatch(/rejects: .*must be created PENDING, without approvals/);
    });

    it('refuses an approval executed by an operation of another type', async () => {
      const purchase = await prisma.economicOperation.findUniqueOrThrow({ where: { id: f.purchaseLot.sourceOperationId! } });
      const planted = planSql({ ...credit(), approval: 'first-approved' });
      expect(await verdict(() => [
        ...planted.statements.slice(0, 2),
        [`UPDATE "admin_adjustment_approvals" SET "status" = 'EXECUTED', "secondApproverId" = $2, "secondApprovedAt" = now(),
          "operationId" = $3, "walletTransactionId" = $4, "executedAt" = now() WHERE "id" = $1`,
        planted.approval, B, purchase.id, purchase.walletTransactionIds[0]],
      ])).toMatch(/rejects: .*was executed by .* which is not an ADMIN_ADJUST operation/);
    });

    it('an executed approval is consumed by its one operation: another cannot reuse it', async () => {
      const executed = await executeTestAdjustment(f.buyer.id, 4, approvers);
      const reuse = planSql({ ...credit({ amount: 4 }), approval: 'none', snapshotApprovalId: executed.approvalId });
      expect(await verdict(() => reuse.statements)).toMatch(/rejects: .*is not the execution of any adjustment approval/);
      expect(await verdict(() => [...reuse.statements,
        ['UPDATE "admin_adjustment_approvals" SET "operationId" = $2 WHERE "id" = $1', executed.approvalId, reuse.op]]))
        .toMatch(/rejects: .*is EXECUTED; it can no longer change/);
    });

    it('refuses a credit into a lot that is not reviewable, whichever guard sees it first', async () => {
      for (const lotClass of ['WITHDRAWABLE', 'RESTRICTED']) {
        expect(await verdict(() => planSql(credit({ entries: [{ type: 'MINT', delta: 30, lot: 'new', lotClass }] })).statements))
          .toMatch(/^rejects: /);
      }
    });
  });

  describe('3. every binding condition, judged by the shared function', () => {
    /** Plants with every trigger bypassed (plus later edits of the planted
     * rows), then asks admin_adjustment_violation. */
    async function judge(plan: Plan, active = true, after: (planted: Planted) => Statement[] = () => []) {
      return inRolledBackTransaction(async (tx) => {
        const planted = planSql(plan);
        await asLegacy(tx, [...planted.statements, ...after(planted)]);
        const [row] = await tx.$queryRawUnsafe<{ message: string | null }[]>(
          'SELECT "admin_adjustment_violation"($1, $2) AS message', planted.op, active);
        return row.message ?? 'valid';
      });
    }

    it('a genuine credit and a genuine debit are valid; other operation types are not its concern', async () => {
      expect(await judge(credit())).toBe('valid');
      expect(await judge(debit())).toBe('valid');
      expect(await judge(credit({ approval: 'none', opType: 'GIFT_SPEND' }))).toBe('valid');
    });
    it('the operation must be the execution of an approval', async () => {
      expect(await judge(credit({ approval: 'none' }))).toMatch(/is not the execution of any adjustment approval/);
    });
    it('the approval must be EXECUTED', async () => {
      for (const status of ['FIRST_APPROVED', 'PENDING', 'REJECTED', 'CANCELLED']) {
        expect(await judge(credit(), true, (p) => [['UPDATE "admin_adjustment_approvals" SET "status" = $2 WHERE "id" = $1', p.approval, status]]))
          .toMatch(new RegExp(`which is ${status}, not EXECUTED`));
      }
    });
    it('the approval must be for the operation\'s user', async () => {
      expect(await judge(credit({ approvalUser: other.buyer.id }))).toMatch(/of user .* names approval .* of user/);
      expect(await judge(debit({ opUser: other.buyer.id, debitLot: other.purchaseLot.id, approvalUser: f.buyer.id })))
        .toMatch(/of user .* names approval .* of user/);
    });
    it('both approvals must be recorded (equal or self approvals are refused by a CHECK, see section 4)', async () => {
      for (const column of ['firstApproverId', 'secondApproverId']) {
        expect(await judge(credit(), false, (p) => [[`UPDATE "admin_adjustment_approvals" SET "${column}" = NULL WHERE "id" = $1`, p.approval]]))
          .toMatch(/lacks two distinct independent approvals/);
      }
    });
    it('the operation must be recorded by the executing (second) approver', async () => {
      expect(await judge(credit({ createdBy: A }))).toMatch(/was recorded by .* not by its executing approver/);
      expect(await judge(credit({ createdBy: 'SYSTEM' }))).toMatch(/was recorded by SYSTEM/);
    });
    it('both approvers must be active SUPER_ADMINs when it is written, not afterwards (I16 history)', async () => {
      const plain = await user(uid('plain-second'));
      expect(await judge(credit({ second: plain.id }))).toMatch(/needs two currently active SUPER_ADMIN approvers/);
      expect(await judge(credit({ second: plain.id }), false)).toBe('valid');
      const leaver = await user(uid('leaver'), 'SUPER_ADMIN');
      const verdicts = await inRolledBackTransaction(async (tx) => {
        const planted = planSql(credit({ first: leaver.id, creator: leaver.id }));
        await asLegacy(tx, planted.statements);
        await tx.$executeRawUnsafe('UPDATE "users" SET "status" = \'SUSPENDED\' WHERE "id" = $1', leaver.id);
        const [row] = await tx.$queryRawUnsafe<{ now: string | null; history: string | null }[]>(
          'SELECT "admin_adjustment_violation"($1, true) AS now, "admin_adjustment_violation"($1, false) AS history', planted.op);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        return { ...row, i16: scan.violations.find((v) => v.invariant.startsWith('I16'))?.count ?? 0 };
      });
      expect(verdicts).toMatchObject({ now: expect.stringMatching(/needs two currently active/), history: null, i16: 0 });
    });
    it('the snapshot must repeat the approval id, evidence and amount', async () => {
      expect(await judge(credit({ snapshotApprovalId: uid('elsewhere') }))).toMatch(/does not repeat the terms/);
      expect(await judge(credit({ snapshotEvidence: { forged: true } }))).toMatch(/does not repeat the terms/);
      expect(await judge(credit({ snapshotEvidence: {} }))).toMatch(/does not repeat the terms/);
      expect(await judge(credit({ snapshotAmount: 29 }))).toMatch(/does not repeat the terms/);
      expect(await judge(credit({ snapshotAmount: -30 }))).toMatch(/does not repeat the terms/);
      expect(await judge(credit(), true, (p) => [['UPDATE "economic_operations" SET "snapshot" = NULL WHERE "id" = $1', p.op]]))
        .toMatch(/does not repeat the terms/);
    });
    it('the request and both approvals must be signed assertions for exactly these terms', async () => {
      const unsigned = /is not backed by a signed request, first approval and second approval/;
      expect(await judge(credit({ signatures: 'none' }))).toMatch(unsigned);
      expect(await judge(credit({ signatures: 'forged' }))).toMatch(unsigned);
      for (const action of ['REQUEST', 'FIRST_APPROVAL', 'SECOND_APPROVAL'] as const) {
        expect(await judge(credit({ unsigned: action })), action).toMatch(unsigned);
      }
      for (const signedTerms of [{ actorId: 'someone-else' }, { userId: 'another-user' }, { amount: 31 }, { amount: -30 },
        { caseId: 'another-case' }, { evidence: { forged: true } }]) {
        expect(await judge(credit({ signedTerms })), JSON.stringify(signedTerms)).toMatch(unsigned);
      }
      expect(await judge(debit({ signatures: 'forged' }))).toMatch(unsigned);
    });

    it('the entries must match the approval\'s polarity', async () => {
      expect(await judge(credit({ entries: [{ type: 'CONSUME', delta: -30, lot: f.purchaseLot.id }], wallet: { ledgerType: 'DEBIT' } })))
        .toMatch(/must mint exactly the approved 30 Coins into the user's own UNCLASSIFIED lots/);
      expect(await judge(debit({ entries: [{ type: 'MINT', delta: 20, lot: 'new' }], wallet: { ledgerType: 'CREDIT' } })))
        .toMatch(/must consume exactly the approved 20 Coins from the user's own managed lots/);
    });
    it('a credit mints exactly the approved amount, only into the user\'s own UNCLASSIFIED lots', async () => {
      for (const entries of [
        [{ type: 'MINT', delta: 29, lot: 'new' }],
        [{ type: 'MINT', delta: 31, lot: 'new' }],
        [{ type: 'MINT', delta: 30, lot: 'new', lotClass: 'RESTRICTED' }],
        [{ type: 'MINT', delta: 30, lot: 'new', lotClass: 'WITHDRAWABLE' }],
        [{ type: 'MINT', delta: 30, lot: 'new', lotUser: 'other' }],
        [{ type: 'MINT', delta: 31, lot: 'new' }, { type: 'CONSUME', delta: -1, lot: 'purchase' }],
        [{ type: 'MINT', delta: 15, lot: 'new' }, { type: 'MINT', delta: 15, lot: 'new', lotClass: 'RESTRICTED' }],
        [],
      ] as const) {
        const resolved = entries.map((e) => ({ ...e,
          lot: e.lot === 'purchase' ? f.purchaseLot.id : e.lot,
          ...('lotUser' in e ? { lotUser: other.buyer.id } : {}) }));
        expect(await judge(credit({ entries: resolved })), JSON.stringify(entries))
          .toMatch(/must mint exactly the approved 30 Coins/);
      }
      expect(await judge(credit({ entries: [{ type: 'MINT', delta: 10, lot: 'new' }, { type: 'MINT', delta: 20, lot: 'new' }] })))
        .toBe('valid');
      for (const entries of [
        [{ type: 'RECLASS_IN', delta: 30, lot: 'new' }],
        [{ type: 'MINT', delta: 35, lot: 'new' }, { type: 'MINT', delta: -5, lot: 'new' }],
        [{ type: 'MINT', delta: 30, reserved: 5, lot: 'new' }],
      ] as EntrySpec[][]) {
        expect(await judge(credit({ entries })), JSON.stringify(entries)).toMatch(/must mint exactly the approved 30 Coins/);
      }
    });
    it('a debit consumes exactly the approved amount, only from the user\'s own managed lots', async () => {
      const legacyLot = uid('legacy-lot');
      expect(await judge(debit({ entries: [{ type: 'CONSUME', delta: -19, lot: f.purchaseLot.id }] })))
        .toMatch(/must consume exactly the approved 20 Coins/);
      expect(await judge(debit({ entries: [{ type: 'CONSUME', delta: -20, lot: other.purchaseLot.id, lotUser: other.buyer.id }] })))
        .toMatch(/must consume exactly the approved 20 Coins/);
      expect(await inRolledBackTransaction(async (tx) => {
        await asLegacy(tx, [legacyLotSql(legacyLot, f.buyer.id, 50)]);
        const planted = planSql(debit({ entries: [{ type: 'CONSUME', delta: -20, lot: legacyLot }] }));
        await asLegacy(tx, planted.statements);
        const [row] = await tx.$queryRawUnsafe<{ message: string | null }[]>(
          'SELECT "admin_adjustment_violation"($1, true) AS message', planted.op);
        return row.message;
      })).toMatch(/must consume exactly the approved 20 Coins/);
      expect(await judge(debit({ entries: [{ type: 'CONSUME', delta: -21, lot: f.purchaseLot.id },
        { type: 'MINT', delta: 1, lot: 'new' }] }))).toMatch(/must consume exactly the approved 20 Coins/);
      for (const entries of [
        [{ type: 'RECLASS_OUT', delta: -20, lot: f.purchaseLot.id }],
        [{ type: 'CONSUME', delta: -25, lot: f.purchaseLot.id }, { type: 'CONSUME', delta: 5, lot: f.purchaseLot.id }],
        [{ type: 'CONSUME', delta: -20, reserved: 5, lot: f.purchaseLot.id }],
      ] as EntrySpec[][]) {
        expect(await judge(debit({ entries })), JSON.stringify(entries)).toMatch(/must consume exactly the approved 20 Coins/);
      }
    });
    it('one succeeded Coin wallet transaction of the same user, direction and amount backs it', async () => {
      for (const change of [
        { walletIds: 'none' }, { walletIds: 'two' }, { walletIds: 'other' },
        { wallet: { ledgerType: 'DEBIT' } }, { wallet: { amount: 31 } }, { wallet: { currency: 'GAME_POINTS' } },
        { wallet: { status: 'PENDING' } }, { wallet: { status: 'REVERSED' } }, { wallet: { userId: 'other' } },
        { wallet: { referenceType: 'REWARD' } }, { wallet: { referenceId: 'another-case' } }, { wallet: { type: 'GIFT_RECEIVE' } },
      ] as const) {
        const plan = credit(change as Partial<Plan>);
        if (plan.wallet?.userId === 'other') plan.wallet = { ...plan.wallet, userId: other.buyer.id };
        expect(await judge(plan), JSON.stringify(change)).toMatch(/is not backed by the approval's own Coin adjustment wallet transaction/);
      }
      expect(await judge(debit({ wallet: { ledgerType: 'CREDIT' } }))).toMatch(/is not backed by/);
      // The ledger direction is checked on its own, not only through the type.
      expect(await judge(credit({ wallet: { ledgerType: 'DEBIT', type: 'COIN_CREDIT' } }))).toMatch(/is not backed by/);
      expect(await judge(debit({ wallet: { ledgerType: 'CREDIT', type: 'COIN_DEBIT' } }))).toMatch(/is not backed by/);
      const purchase = await prisma.economicOperation.findUniqueOrThrow({ where: { id: f.purchaseLot.sourceOperationId! } });
      const purchaseTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: purchase.walletTransactionIds[0] } });
      expect(await judge(credit({ amount: purchaseTx.amount, reuseWalletTransaction: purchaseTx.id })))
        .toMatch(/is not backed by the approval's own Coin adjustment wallet transaction/);
    });
    it('its wallet transaction backs nothing else: no other operation, purchase settlement or other operation\'s lot', async () => {
      const notOwn = /is not backed by the approval's own Coin adjustment wallet transaction/;
      // Each case keeps every other condition on the wallet transaction true.
      expect(await judge(credit(), true, (p) => [[`INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId",
          "walletTransactionIds","createdBy","snapshot") VALUES ($1,'PURCHASE',$2,'AGENT_ORDER',$3,ARRAY[$4],$5,'{}'::jsonb)`,
        uid('adj-other-op'), f.buyer.id, uid('adj-order'), p.wtx, A]])).toMatch(notOwn);
      expect(await judge(credit(), true, (p) => [[`INSERT INTO "agent_order_settlements" ("id","orderId","reservationId",
          "coinAmount","walletTransactionId","resolvedVia","releasedBy","settledAt")
        VALUES ($1,$2,$3,30,$4,'AGENT_RELEASE',$5,now())`, uid('adj-settlement'), uid('adj-order'), uid('adj-res'), p.wtx, A]]))
        .toMatch(notOwn);
      expect(await judge(credit(), true, (p) => [[`INSERT INTO "coin_provenance" ("id","userId","walletTransactionId","amount",
          "provenanceType","restrictionStatus","originalSource","lotClass","state","availableAmount","reservedAmount",
          "requirementAmount","progressAmount","mintedAt","availableAt","sourceOperationId","createdAt","updatedAt")
        VALUES ($1,$2,$3,30,'PURCHASE','UNRESTRICTED','PURCHASE','WITHDRAWABLE','OPEN',0,0,0,0,now(),now(),$4,now(),now())`,
        uid('adj-other-lot'), f.buyer.id, p.wtx, uid('adj-other-op')]])).toMatch(notOwn);
      // Its own mint lot naming it is expected.
      expect(await judge(credit())).toBe('valid');
    });

    it('invariant I16 and the UPGRADED preflight report a planted forged adjustment', async () => {
      const found = await inRolledBackTransaction(async (tx) => {
        const planted = planSql(credit({ approval: 'none' }));
        await asLegacy(tx, planted.statements);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        const preflight = await collectUnauthorizedOperations(tx);
        return { op: planted.op, i16: scan.violations.find((v) => v.invariant.startsWith('I16')),
          preflight: preflight.filter((a) => a.subjectId === planted.op) };
      });
      expect(found.i16).toMatchObject({ count: 1, sample: [found.op] });
      expect(found.preflight).toEqual([{ category: 'UNAUTHORIZED_OPERATION', subjectType: 'economic_operation:ADMIN_ADJUST',
        subjectId: found.op, userId: f.buyer.id, detail: `admin adjustment ${found.op} is not the execution of any adjustment approval` }]);
    });

    it('invariant I16 and the UPGRADED preflight report a historical adjustment backed by a purchase credit', async () => {
      const purchase = await prisma.economicOperation.findUniqueOrThrow({ where: { id: f.purchaseLot.sourceOperationId! } });
      const purchaseTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: purchase.walletTransactionIds[0] } });
      const found = await inRolledBackTransaction(async (tx) => {
        // Recorded with every guard bypassed, as history written before them.
        const planted = planSql(credit({ amount: purchaseTx.amount, reuseWalletTransaction: purchaseTx.id }));
        await asLegacy(tx, planted.statements);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        const preflight = await collectUnauthorizedOperations(tx);
        return { op: planted.op, i16: scan.violations.find((v) => v.invariant.startsWith('I16')),
          preflight: preflight.filter((a) => a.subjectId === planted.op) };
      });
      expect(found.i16).toMatchObject({ count: 1, sample: [found.op] });
      expect(found.preflight).toEqual([{ category: 'UNAUTHORIZED_OPERATION', subjectType: 'economic_operation:ADMIN_ADJUST',
        subjectId: found.op, userId: f.buyer.id,
        detail: `admin adjustment ${found.op} is not backed by the approval's own Coin adjustment wallet transaction` }]);
    });
  });

  describe('4. the approval record', () => {
    const insert = (change: Record<string, unknown> = {}): Statement => {
      const caseId = (change.caseId as string | undefined) ?? uid('rec-case');
      const row = { id: uid('rec'), userId: f.buyer.id, amount: 30, caseId, evidence: JSON.stringify(evidenceFor(caseId)),
        createdBy: A, ...change };
      return [`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy")
        VALUES ($1,$2,$3::integer,$4,$5::jsonb,$6)`, row.id, row.userId, row.amount, row.caseId, row.evidence, row.createdBy];
    };
    const approvalRow = async (status: 'PENDING' | 'FIRST_APPROVED' | 'EXECUTED' | 'REJECTED' | 'CANCELLED') => {
      if (status === 'EXECUTED') return (await executeTestAdjustment(f.buyer.id, 2, approvers)).approvalId;
      const requested = await requestCoinAdjustment(A, { targetUserId: f.buyer.id, caseId: uid('rec-case'), delta: 2,
        rationale, supportingEvidence: ['case-evidence-record'] });
      if (status === 'FIRST_APPROVED') await firstApproveCoinAdjustment(A, requested.approvalId);
      if (status === 'REJECTED') await closeCoinAdjustment(B, requested.approvalId, 'REJECTED', 'record test');
      if (status === 'CANCELLED') await closeCoinAdjustment(A, requested.approvalId, 'CANCELLED', 'record test');
      return requested.approvalId;
    };

    it('evidence must be an object with the case ID, a real rationale and non-empty references', async () => {
      const caseId = uid('ev-case');
      for (const evidence of ['""', '"text"', '{}', '[]', 'null', '42',
        JSON.stringify({ ...evidenceFor(caseId), caseId: 'another-case' }),
        JSON.stringify({ ...evidenceFor(caseId), rationale: '' }),
        JSON.stringify({ ...evidenceFor(caseId), rationale: '             ' }),
        JSON.stringify({ ...evidenceFor(caseId), rationale: 'too short' }),
        JSON.stringify({ caseId, rationale }),
        JSON.stringify({ rationale, supportingEvidence: ['case-evidence-sql'] }),
        JSON.stringify({ ...evidenceFor(caseId), caseId: null }),
        JSON.stringify({ ...evidenceFor(caseId), rationale: null }),
        JSON.stringify({ ...evidenceFor(caseId), rationale: 12345678901 }),
        JSON.stringify({ ...evidenceFor(caseId), rationale: ['Documented historical balance correction'] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: null }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: ['case-evidence-sql', ''] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: [] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: [''] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: ['   '] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: [7] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: [{}] }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: 'case-evidence' }),
        JSON.stringify({ ...evidenceFor(caseId), supportingEvidence: {} })]) {
        expect(await verdict(() => [insert({ caseId, evidence })]), evidence).toMatch(/rejects: .*admin_adjustment_approvals_evidence_chk/);
      }
      expect(await verdict(() => [insert({ caseId, evidence: JSON.stringify(evidenceFor(caseId)) })])).toBe('accepts');
      const numeric = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      expect(await verdict(() => [insert({ caseId: numeric, evidence: JSON.stringify({ ...evidenceFor(numeric), caseId: Number(numeric) }) })]))
        .toMatch(/rejects: .*admin_adjustment_approvals_evidence_chk/);
    });

    it('the amount is a nonzero whole number of Coins within the limit', async () => {
      for (const amount of [0, 1_000_000_001, -1_000_000_001]) {
        expect(await verdict(() => [insert({ amount })])).toMatch(/rejects: .*admin_adjustment_approvals_amount_chk/);
      }
      for (const amount of ['2147483648', '-2147483649']) {
        expect(await verdict(() => [insert({ amount })])).toMatch(/rejects: .*out of range for type integer/);
      }
      for (const amount of ['1.5', 'NaN', 'Infinity', '']) {
        expect(await verdict(() => [insert({ amount })])).toMatch(/rejects: .*invalid input syntax for type integer/);
      }
      expect(await verdict(() => [insert({ amount: 1_000_000_000 })])).toBe('accepts');
      expect(await verdict(() => [insert({ amount: -1_000_000_000 })])).toBe('accepts');
    });

    it('two distinct approvers, neither of them the user (a CHECK, even with triggers bypassed)', async () => {
      for (const [first, second] of [[A, A], [f.buyer.id, B], [A, f.buyer.id]]) {
        const planted = planSql(credit({ first, second, creator: A }));
        expect(await verdict(async (tx) => { await asLegacy(tx, planted.statements); return []; }))
          .toMatch(/rejects: .*admin_adjustment_approvals_independent_chk/);
      }
    });

    it('status is one of the defined states (a CHECK, even with triggers bypassed)', async () => {
      const row = insert();
      expect(await verdict(async (tx) => {
        await asLegacy(tx, [row, ['UPDATE "admin_adjustment_approvals" SET "status" = \'DONE\' WHERE "id" = $1', row[1]]]);
        return [];
      })).toMatch(/rejects: .*admin_adjustment_approvals_status_chk/);
    });

    it('its terms never change', async () => {
      const id = await approvalRow('PENDING');
      for (const [set, value] of [['"amount" = "amount" + 1', null], ['"userId" = $2', other.buyer.id],
        ['"caseId" = $2', uid('renamed-case')], ['"evidence" = "evidence" || \'{"extra": true}\'::jsonb', null],
        ['"createdBy" = $2', B], ['"createdAt" = "createdAt" - interval \'1 day\'', null], ['"id" = $2', uid('renamed')]] as const) {
        expect(await verdict(() => [[`UPDATE "admin_adjustment_approvals" SET ${set} WHERE "id" = $1`, id,
          ...(value ? [value] : [])] as Statement])).toMatch(/rejects: .*terms \(user, amount, case, evidence, creator\) are immutable/);
      }
    });

    it('moves only PENDING -> FIRST_APPROVED -> EXECUTED, or to REJECTED/CANCELLED, each with exactly its fields', async () => {
      const pending = await approvalRow('PENDING');
      const firstApproved = await approvalRow('FIRST_APPROVED');
      const op = f.purchaseLot.sourceOperationId;
      for (const [id, set, message] of [
        [pending, `"status" = 'FIRST_APPROVED'`, 'first approval records exactly its approver and time'],
        [pending, `"status" = 'FIRST_APPROVED', "firstApproverId" = $2`, 'first approval records exactly its approver and time'],
        [pending, `"status" = 'FIRST_APPROVED', "firstApproverId" = $2, "firstApprovedAt" = now(), "secondApproverId" = $3`,
          'first approval records exactly its approver and time'],
        [pending, `"status" = 'FIRST_APPROVED', "firstApproverId" = $2, "firstApprovedAt" = now(), "closedBy" = $3`,
          'first approval records exactly its approver and time'],
        [pending, `"status" = 'EXECUTED'`, 'cannot move from PENDING to EXECUTED'],
        [pending, `"firstApproverId" = $2`, 'cannot move from PENDING to PENDING'],
        [firstApproved, `"status" = 'PENDING', "firstApproverId" = NULL, "firstApprovedAt" = NULL`, 'cannot move from FIRST_APPROVED to PENDING'],
        [firstApproved, `"firstApproverId" = $3`, 'cannot move from FIRST_APPROVED to FIRST_APPROVED'],
        [firstApproved, `"status" = 'EXECUTED', "secondApproverId" = $3, "secondApprovedAt" = now(), "executedAt" = now()`,
          'can only be executed from a first approval, by its second approver and operation'],
        [firstApproved, `"status" = 'EXECUTED', "firstApproverId" = $3, "secondApproverId" = $2, "secondApprovedAt" = now(),
          "operationId" = $4, "executedAt" = now()`, 'can only be executed from a first approval'],
        [firstApproved, `"status" = 'REJECTED', "closedBy" = $3, "closedAt" = now()`, 'closes with exactly who closed it, when and why'],
        [firstApproved, `"status" = 'REJECTED', "closedBy" = $3, "closedAt" = now(), "closeReason" = '   '`, 'closes with exactly who closed it'],
        [firstApproved, `"status" = 'CANCELLED', "closedAt" = now(), "closeReason" = 'x'`, 'closes with exactly who closed it'],
        [firstApproved, `"status" = 'REJECTED', "closedBy" = $3, "closedAt" = now(), "closeReason" = 'x', "operationId" = $4`,
          'closes with exactly who closed it'],
        [pending, `"status" = 'CANCELLED', "closedBy" = $2, "closedAt" = now(), "closeReason" = 'x', "firstApproverId" = $3`,
          'closes with exactly who closed it'],
      ] as const) {
        const params = [id, A, B, op].slice(0, Math.max(1, ...[...set.matchAll(/\$(\d)/g)].map((m) => Number(m[1]))));
        expect(await verdict(() => [[`UPDATE "admin_adjustment_approvals" SET ${set} WHERE "id" = $1`, ...params] as Statement]), set)
          .toMatch(new RegExp(`rejects: .*${message}`));
      }
    });

    it('each transition sets exactly its own fields: every other field is checked on its own', async () => {
      const purchase = await prisma.economicOperation.findUniqueOrThrow({ where: { id: f.purchaseLot.sourceOperationId! } });
      const [op, wtx, C] = [purchase.id, purchase.walletTransactionIds[0], f.superAdmin.id];
      const extras: Record<string, string> = {
        firstApproverId: `"firstApproverId" = '${C}'`, firstApprovedAt: '"firstApprovedAt" = now() - interval \'1 day\'',
        secondApproverId: `"secondApproverId" = '${B}'`, secondApprovedAt: '"secondApprovedAt" = now()',
        operationId: `"operationId" = '${op}'`, walletTransactionId: `"walletTransactionId" = '${wtx}'`,
        executedAt: '"executedAt" = now()', closedBy: `"closedBy" = '${B}'`, closedAt: '"closedAt" = now()',
        closeReason: '"closeReason" = \'a reason\'',
      };
      const update = (id: string, sets: string[]): Statement =>
        [`UPDATE "admin_adjustment_approvals" SET ${sets.join(', ')} WHERE "id" = $1`, id];

      const insertBase = insert();
      expect(await verdict(() => [insertBase])).toBe('accepts');
      for (const status of ['FIRST_APPROVED', 'EXECUTED', 'REJECTED', 'CANCELLED']) {
        const row = insert();
        expect(await verdict(() => [[`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy","status")
          VALUES ($1,$2,30,$3,$4::jsonb,$5,$6)`, uid('rec'), f.buyer.id, row[4], row[5], A, status]]), status)
          .toMatch(/rejects: .*must be created PENDING, without approvals/);
      }
      for (const [column, set] of Object.entries(extras)) {
        const row = insert();
        const value = set.slice(set.indexOf('=') + 2).replace('now() - interval \'1 day\'', 'now()');
        expect(await verdict(() => [[`INSERT INTO "admin_adjustment_approvals" ("id","userId","amount","caseId","evidence","createdBy","${column}")
          VALUES ($1,$2,30,$3,$4::jsonb,$5,${value})`, uid('rec'), f.buyer.id, row[4], row[5], A]]), column)
          .toMatch(/rejects: .*must be created PENDING, without approvals/);
      }

      const pending = await approvalRow('PENDING');
      const approve = [`"status" = 'FIRST_APPROVED'`, `"firstApproverId" = '${A}'`, '"firstApprovedAt" = now()'];
      expect(await verdict(() => [update(pending, approve)])).toBe('accepts');
      for (const required of approve.slice(1)) {
        expect(await verdict(() => [update(pending, approve.filter((set) => set !== required))]), required)
          .toMatch(/rejects: .*first approval records exactly its approver and time/);
      }
      for (const [column, set] of Object.entries(extras).filter(([column]) => !column.startsWith('first'))) {
        expect(await verdict(() => [update(pending, [...approve, set])]), column)
          .toMatch(/rejects: .*first approval records exactly its approver and time/);
      }

      const firstApproved = await approvalRow('FIRST_APPROVED');
      const execute = [`"status" = 'EXECUTED'`, extras.secondApproverId, extras.secondApprovedAt, extras.operationId,
        extras.walletTransactionId, extras.executedAt];
      expect(await verdict(() => [update(firstApproved, execute)]))
        .toMatch(/rejects: .*was executed by .* which is not an ADMIN_ADJUST operation/);
      for (const required of execute.slice(1)) {
        expect(await verdict(() => [update(firstApproved, execute.filter((set) => set !== required))]), required)
          .toMatch(/rejects: .*can only be executed from a first approval, by its second approver and operation/);
      }
      for (const column of ['firstApproverId', 'firstApprovedAt', 'closedBy', 'closedAt', 'closeReason']) {
        expect(await verdict(() => [update(firstApproved, [...execute, extras[column]])]), column)
          .toMatch(/rejects: .*can only be executed from a first approval, by its second approver and operation/);
      }

      for (const approval of [pending, firstApproved]) {
        const close = [`"status" = 'REJECTED'`, extras.closedBy, extras.closedAt, extras.closeReason];
        expect(await verdict(() => [update(approval, close)])).toBe('accepts');
        for (const required of close.slice(1)) {
          expect(await verdict(() => [update(approval, close.filter((set) => set !== required))]), required)
            .toMatch(/rejects: .*closes with exactly who closed it, when and why/);
        }
        for (const column of ['firstApproverId', 'firstApprovedAt', 'secondApproverId', 'secondApprovedAt', 'operationId',
          'walletTransactionId', 'executedAt']) {
          expect(await verdict(() => [update(approval, [...close, extras[column]])]), column)
            .toMatch(/rejects: .*closes with exactly who closed it, when and why/);
        }
      }
    });

    it('executed, rejected and cancelled approvals never change, and no approval is deleted', async () => {
      for (const status of ['EXECUTED', 'REJECTED', 'CANCELLED'] as const) {
        const id = await approvalRow(status);
        expect(await verdict(() => [['UPDATE "admin_adjustment_approvals" SET "closeReason" = \'edited\' WHERE "id" = $1', id]]))
          .toMatch(new RegExp(`rejects: .*is ${status}; it can no longer change`));
        expect(await verdict(() => [['DELETE FROM "admin_adjustment_approvals" WHERE "id" = $1', id]]))
          .toMatch(/rejects: .*admin_adjustment_approvals is append-only/);
      }
    });

    it('one approval per case, and one approval per operation and wallet transaction', async () => {
      const executed = await executeTestAdjustment(f.buyer.id, 2, approvers);
      const approval = await prisma.adminAdjustmentApproval.findUniqueOrThrow({ where: { id: executed.approvalId } });
      expect(await verdict(() => [insert({ caseId: approval.caseId, evidence: JSON.stringify(approval.evidence) })]))
        .toMatch(/rejects: .*Key \("caseId"\)=.* already exists/);
      for (const column of ['operationId', 'walletTransactionId']) {
        const row = insert();
        expect(await verdict(async (tx) => {
          await asLegacy(tx, [row, [`UPDATE "admin_adjustment_approvals" SET "${column}" = $2 WHERE "id" = $1`, row[1],
            (approval as unknown as Record<string, string>)[column]]]);
          return [];
        })).toMatch(new RegExp(`rejects: .*Key \\("${column}"\\)=.* already exists`));
      }
    });
  });
});

describe('invariant I3 reports each guard added by this release when it is disabled', () => {
  for (const [table, trigger] of [
    ['economic_operations', 'authorized_operation_guard'],
    ['admin_adjustment_approvals', 'admin_adjustment_approval_lifecycle_guard'],
    ['admin_adjustment_approvals', 'adjustment_execution_guard'],
    ['coin_lot_entries', 'operation_authorization_guard'],
    ['game_sessions', 'game_session_immutability_guard'],
    ['game_challenges', 'game_challenges_rules_pin_guard'],
    ['group_competitions', 'group_competitions_rules_pin_guard'],
    ['ledger_approval_assertions', 'ledger_approval_assertions_append_only'],
    ['users', 'users_privilege_guard'],
  ]) {
    it(`${trigger} on ${table}`, async () => {
      const sample = await inRolledBackTransaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        return scan.violations.find((v) => v.invariant.startsWith('I3'))?.sample ?? [];
      });
      expect(sample).toEqual([trigger]);
    });
  }
});

describe('invariant I3 reports a guard function without a pinned search_path', () => {
  it('flags the function and nothing else', async () => {
    const name = `unpinned_probe_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const sample = await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE FUNCTION "${name}"() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$`);
      const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
      return scan.violations.find((v) => v.invariant.startsWith('I3'))?.sample ?? [];
    });
    expect(sample).toEqual([`search_path:${name}()`]);
  });
});
