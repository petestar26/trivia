// The forged mint path the Opus 5.5 review reproduced against 9e144b5: plain
// SQL minted UNCLASSIFIED value with an ADMIN_ADJUST operation naming no real
// actor or wallet credit, then reclassified it into a WITHDRAWABLE lot with a
// LEGACY_RESOLVE operation whose snapshot only carried the right keys.
// Migration 20260924010000 binds both operation types to the records that
// authorize them. The ADMIN_ADJUST half is proved in
// ledger-adjustment-authorization.contract.test.ts; this file proves, for
// LEGACY_RESOLVE:
//   1. both forged steps, run as ordinary SQL, are refused;
//   2. every authorization condition is enforced on its own (variants are
//      planted with triggers bypassed and judged by the same functions the
//      write-time guard and invariant I16 use);
//   3. legacy reviews follow their lifecycle: evidence is frozen from the
//      first approval, resolution needs a first approval, only a resolved
//      review names a resolution operation, resolved reviews never change,
//      nothing is deleted;
//   4. the application reopens a review whose first approver lost SUPER_ADMIN.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';
import { executeTestAdjustment, makeApprovers } from '../test/adjustment-fixtures.js';
import type { Approvers } from '../test/adjustment-fixtures.js';
import { firstApproveLegacyReview, secondApproveLegacyReview } from '../economy/legacy-review-service.js';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import { asLegacy, inRolledBackTransaction, purchasedFixture, signedAssertionSql, uid, user } from '../test/ledger-integrity-fixtures.js';
import type { PurchasedFixture, Statement, Tx } from '../test/ledger-integrity-fixtures.js';
import { ROW_LOCK_WAITS, waitForBlockedBackends } from '../test/pg-locks.js';

beforeAll(async () => { await bootstrapLedgerTestGates(); });
afterAll(async () => { await prisma.$disconnect(); });

async function verdict(statements: (tx: Tx) => Promise<Statement[]> | Statement[]): Promise<string> {
  return inRolledBackTransaction(async (tx) => {
    try {
      for (const [sql, ...params] of await statements(tx)) await tx.$executeRawUnsafe(sql, ...params);
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      return 'accepts';
    } catch (error) {
      return `rejects: ${String((error as Error).message).split('\n').map((line) => line.trim()).filter(Boolean).join(' ')}`;
    }
  });
}

const terms = { decision: 'WITHDRAWABLE' as const, rationale: 'Two administrators verified the source',
  supportingEvidence: ['case-authorization-001'] };

/** A classified buyer with a real, two-administrator approved credit (which
 * opens a legacy review) under a real first review approval. */
async function firstApprovedReview(f: PurchasedFixture, creditor: Approvers, approver: { id: string }, amount = 40) {
  const credit = await executeTestAdjustment(f.buyer.id, amount, creditor);
  const lotId = credit.reviewLotId!;
  const review = await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId } });
  await firstApproveLegacyReview(approver.id, review.id, terms);
  return { reviewId: review.id, lotId, amount };
}

interface Resolution {
  reviewId: string; lotId: string; owner: string; first: string; second: string; amount: number;
  opUser?: string; createdBy?: string; scopeType?: string; scopeId?: string; forgedEvidence?: boolean;
  snapshotFirst?: string; snapshotSecond?: string; snapshotAmount?: number; snapshotDecision?: string;
  outLot?: string; outAmount?: number; inAmount?: number; inParent?: string | null; inClass?: string;
  extraMint?: boolean; reviewStatus?: string; closeLot?: boolean;
  /** The second approver's signed assertion (default valid; the first one is the service's). */
  secondSignature?: 'valid' | 'none' | 'forged'; signedAmount?: number; signedBy?: string;
}

/** The exact writes secondApproveLegacyReview makes, as ordinary SQL, with
 * one deviation at a time. */
function resolutionSql(r: Resolution): { op: string; statements: Statement[] } {
  const op = uid('res-op'); const successor = uid('res-lot');
  const out = r.outAmount ?? r.amount; const inn = r.inAmount ?? r.amount;
  const statements: Statement[] = [
    [`INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId","walletTransactionIds","createdBy","snapshot")
      VALUES ($1,'LEGACY_RESOLVE',$2,$10,$3,'{}',$4, jsonb_build_object(
        'evidence', CASE WHEN $5::boolean THEN '{"forged": true}'::jsonb
                         ELSE (SELECT "evidence" FROM "legacy_balance_reviews" WHERE "id" = $3) END,
        'firstApproverId', $6::text, 'secondApproverId', $7::text,
        'decision', $8::text, 'amount', $9::int))`,
      op, r.opUser ?? r.owner, r.scopeId ?? r.reviewId, r.createdBy ?? r.second, r.forgedEvidence ?? false,
      r.snapshotFirst ?? r.first, r.snapshotSecond ?? r.second, r.snapshotDecision ?? 'WITHDRAWABLE', r.snapshotAmount ?? r.amount,
      r.scopeType ?? 'REVIEW'],
    [`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta")
      VALUES ($1,$2,$3,0,'RECLASS_OUT',$4)`, op, r.outLot ?? r.lotId, r.opUser ?? r.owner, -out],
    [`INSERT INTO "coin_provenance" ("id","userId","amount","provenanceType","restrictionStatus","originalSource",
        "lotClass","state","availableAmount","reservedAmount","requirementAmount","progressAmount",
        "mintedAt","availableAt","sourceOperationId","parentLotId","rootLotId","createdAt","updatedAt")
      VALUES ($1,$2,$3,'ADMIN_ADJUSTMENT','UNRESTRICTED','ADMIN_ADJUSTMENT',$4::"lot_class",'OPEN',0,0,0,0,
        now(),now(),$5,$6,$6,now(),now())`,
      successor, r.opUser ?? r.owner, inn, r.inClass ?? 'WITHDRAWABLE', op, r.inParent === undefined ? r.lotId : r.inParent],
    [`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta")
      VALUES ($1,$2,$3,1,'RECLASS_IN',$4)`, op, successor, r.opUser ?? r.owner, inn],
  ];
  if (r.extraMint) {
    statements.push([`INSERT INTO "coin_lot_entries" ("operationId","lotId","userId","sequence","entryType","availableDelta")
      VALUES ($1,$2,$3,2,'MINT',1)`, op, successor, r.opUser ?? r.owner]);
  }
  if (r.closeLot ?? true) {
    statements.push([`UPDATE "coin_provenance" SET "state" = 'RECLASSIFIED', "closedAt" = now() WHERE "id" = $1`, r.outLot ?? r.lotId]);
  }
  if ((r.secondSignature ?? 'valid') !== 'none') {
    statements.push(signedAssertionSql({
      subjectType: 'LEGACY_REVIEW', subjectId: r.reviewId, action: 'SECOND_APPROVAL', actorId: r.signedBy ?? r.second,
      userId: r.owner, amount: r.signedAmount ?? r.amount, caseId: r.reviewId,
      evidence: `(SELECT "evidence" -> 'proposal' FROM "legacy_balance_reviews" WHERE "id" = $9)`, evidenceParams: [r.reviewId],
      signature: r.secondSignature === 'forged' ? 'forged' : 'valid',
    }));
  }
  statements.push([`UPDATE "legacy_balance_reviews" SET "status" = $2, "secondApproverId" = $3,
      "resolutionOperationId" = CASE WHEN $2 = 'RESOLVED' THEN $4 ELSE NULL END,
      "resolvedAt" = CASE WHEN $2 = 'RESOLVED' THEN now() ELSE NULL END WHERE "id" = $1`,
    r.reviewId, r.reviewStatus ?? 'RESOLVED', (r.reviewStatus ?? 'RESOLVED') === 'RESOLVED' ? r.second : null, op]);
  return { op, statements };
}

describe('the forged LEGACY_RESOLVE / ADMIN_ADJUST mint path is closed', () => {
  let f: PurchasedFixture; let other: PurchasedFixture;
  let first: { id: string }; let second: { id: string }; let creditor: Approvers;
  beforeAll(async () => {
    f = await purchasedFixture(1000);
    other = await purchasedFixture(500);
    first = await user(uid('first'), 'SUPER_ADMIN');
    second = await user(uid('second'), 'SUPER_ADMIN');
    creditor = await makeApprovers('auth-creditor');
  });

  describe('1. the two forged steps, as ordinary SQL', () => {
    it('refuses the forged LEGACY_RESOLVE (a review nobody resolved, invented approvers)', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      const forged = resolutionSql({ ...r, owner: f.buyer.id, first: 'a', second: 'b', createdBy: 'attacker', reviewStatus: 'FIRST_APPROVED' });
      expect(await verdict(() => forged.statements))
        .toMatch(/rejects: .*legacy resolution .* is not the resolution of any legacy review/);
    });

    it('accepts the genuine resolution those steps imitate, written the same way', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => resolutionSql({ ...r, owner: f.buyer.id, first: first.id, second: second.id }).statements))
        .toBe('accepts');
    });

    for (const [name, change, message] of [
      ['a review that is still FIRST_APPROVED', { reviewStatus: 'FIRST_APPROVED' }, 'is not the resolution of any legacy review'],
      ['the review id under another scope type',{ scopeType: 'LEGACY_LOT' }, 'is scoped to LEGACY_LOT .* not to its review'],
      ['recorded by someone other than the second approver', { createdBy: 'creditor' }, 'was recorded by .* not by its second approver'],
      ['a second approver who is the owner', { second: 'owner' }, 'lacks two distinct independent approvers'],
      ['a second approver who is not a SUPER_ADMIN', { second: 'plain' }, 'needs two currently active SUPER_ADMIN approvers'],
      ['evidence that differs from the review', { forgedEvidence: true }, 'does not repeat the approved evidence'],
      ['a decision the review did not approve', { snapshotDecision: 'RESTRICTED' }, 'does not repeat the approved evidence'],
      ['a snapshot naming other approvers', { snapshotFirst: 'x' }, 'does not repeat the approved evidence'],
      ['a credit into a lot that does not descend from the review lot', { inParent: null }, 'must move exactly the approved'],
      ['a credit of another class than approved', { inClass: 'RESTRICTED' }, 'must move exactly the approved'],
    ] as const) {
      it(`refuses a resolution with ${name}`, async () => {
        const r = await firstApprovedReview(f, creditor, first);
        const plain = await user(uid('plain'));
        const actors: Record<string, string> = { creditor: creditor.first.id, owner: f.buyer.id, plain: plain.id };
        const spec: Resolution = { ...r, owner: f.buyer.id, first: first.id, second: second.id };
        for (const [key, value] of Object.entries(change)) {
          (spec as unknown as Record<string, unknown>)[key] = typeof value === 'string' && value in actors ? actors[value] : value;
        }
        expect(await verdict(() => resolutionSql(spec).statements)).toMatch(new RegExp(`rejects: .*${message}`));
      });
    }

    it('refuses a resolution whose first approver was suspended before the value moved', async () => {
      const approver = await user(uid('suspended'), 'SUPER_ADMIN');
      const r = await firstApprovedReview(f, creditor, approver);
      expect(await verdict(() => [
        ['UPDATE "users" SET "status" = \'SUSPENDED\' WHERE "id" = $1', approver.id],
        ...resolutionSql({ ...r, owner: f.buyer.id, first: approver.id, second: second.id }).statements,
      ])).toMatch(/rejects: .*needs two currently active SUPER_ADMIN approvers/);
    });

    it('refuses moving more or less than the approved amount (whichever guard sees it first)', async () => {
      for (const change of [{ outAmount: 41, inAmount: 41, snapshotAmount: 41 }, { outAmount: 40, inAmount: 39 }]) {
        const r = await firstApprovedReview(f, creditor, first);
        expect(await verdict(() => resolutionSql({ ...r, owner: f.buyer.id, first: first.id, second: second.id, ...change }).statements))
          .toMatch(/^rejects: /);
      }
    });
  });

  describe('2. every authorization condition, judged by the shared functions', () => {
    /** Plants a resolution with all triggers bypassed (plus any later edits
     * of the planted rows), then asks the function. */
    async function judge(spec: (r: Resolution & { reviewId: string }) => Resolution, active = true,
      after: (r: Resolution, op: string) => Statement[] = () => []) {
      const r = await firstApprovedReview(f, creditor, first);
      const base: Resolution = { ...r, owner: f.buyer.id, first: first.id, second: second.id };
      return inRolledBackTransaction(async (tx) => {
        const planted = resolutionSql(spec(base));
        await asLegacy(tx, [...planted.statements, ...after(base, planted.op)]);
        const [row] = await tx.$queryRawUnsafe<{ message: string | null }[]>(
          'SELECT "legacy_resolution_violation"($1, $2) AS message', planted.op, active);
        return row.message ?? 'valid';
      });
    }
    it('a genuine resolution is valid', async () => { expect(await judge((b) => b)).toBe('valid'); });
    it('the operation must be scoped to its review', async () => {
      expect(await judge((b) => ({ ...b, scopeId: uid('elsewhere') }))).toMatch(/is scoped to REVIEW .* not to its review/);
      expect(await judge((b) => ({ ...b, scopeType: 'LEGACY_LOT' }))).toMatch(/is scoped to LEGACY_LOT .* not to its review/);
    });
    it('the review must belong to the operation\'s user', async () => {
      expect(await judge((b) => ({ ...b, opUser: other.buyer.id, outLot: other.purchaseLot.id, closeLot: false })))
        .toMatch(/of user .* names review .* of user/);
    });
    it('the linked review must be RESOLVED, not rejected', async () => {
      expect(await judge((b) => b, true, (b) => [['UPDATE "legacy_balance_reviews" SET "status" = \'REJECTED\' WHERE "id" = $1', b.reviewId]]))
        .toMatch(/which is REJECTED, not RESOLVED/);
    });
    it('both approvals must be recorded, also for history (I16)', async () => {
      for (const column of ['resolvedBy', 'secondApproverId']) {
        expect(await judge((b) => b, false, (b) => [[`UPDATE "legacy_balance_reviews" SET "${column}" = NULL WHERE "id" = $1`, b.reviewId]]))
          .toMatch(/lacks two distinct independent approvers/);
      }
    });
    it('neither approver may be the owner (equal approvers are already refused by a CHECK)', async () => {
      expect(await judge((b) => ({ ...b, second: b.owner, createdBy: b.owner }))).toMatch(/lacks two distinct independent approvers/);
      expect(await judge((b) => ({ ...b, first: b.owner }), false,
        (b) => [['UPDATE "legacy_balance_reviews" SET "resolvedBy" = $2 WHERE "id" = $1', b.reviewId, b.owner]]))
        .toMatch(/lacks two distinct independent approvers/);
    });
    it('the review must hold an approved proposal: a positive numeric amount, WITHDRAWABLE or RESTRICTED', async () => {
      for (const [path, value, message] of [
        ['{proposal,decision}', '"UNCLASSIFIED"', /has no approved proposal/],
        ['{proposal,decision}', 'null', /has no approved proposal/],
        ['{proposal,amount}', '"40"', /has no approved proposal/],
        ['{proposal,amount}', '0', /approved a non-positive amount/],
      ] as const) {
        expect(await judge((b) => b, true, (b) => [[`UPDATE "legacy_balance_reviews"
          SET "evidence" = jsonb_set("evidence", $2::text[], $3::jsonb) WHERE "id" = $1`, b.reviewId, path, value]]))
          .toMatch(message);
      }
    });
    it('the operation may hold nothing but the one debit and the one credit', async () => {
      expect(await judge((b) => ({ ...b, extraMint: true }))).toMatch(/must move exactly the approved/);
      for (const [type, delta] of [['RECLASS_OUT', -1], ['RECLASS_IN', 1]] as const) {
        expect(await judge((b) => b, true, (b, op) => [[`INSERT INTO "coin_lot_entries"
            ("operationId","lotId","userId","sequence","entryType","availableDelta") VALUES ($1,$2,$3,7,$4::"entry_type",$5)`,
          op, b.lotId, b.owner, type, delta]])).toMatch(/must move exactly the approved/);
      }
    });
    it('the review lot must be the owner\'s UNCLASSIFIED lot, linked back to the review', async () => {
      for (const change of ['"lotClass" = \'RESTRICTED\'', '"reviewId" = NULL', '"userId" = $2']) {
        expect(await judge((b) => b, true, (b) => [[`UPDATE "coin_provenance" SET ${change} WHERE "id" = $1`,
          b.lotId, ...(change.includes('$2') ? [other.buyer.id] : [])] as Statement]))
          .toMatch(/does not own an UNCLASSIFIED lot linked back to it/);
      }
    });
    it('both approvals must be signed assertions for exactly these terms', async () => {
      const unsigned = /is not backed by signed first and second approvals of review/;
      expect(await judge((b) => ({ ...b, secondSignature: 'none' }))).toMatch(unsigned);
      expect(await judge((b) => ({ ...b, secondSignature: 'forged' }))).toMatch(unsigned);
      expect(await judge((b) => ({ ...b, signedBy: b.first }))).toMatch(unsigned);
      expect(await judge((b) => ({ ...b, signedAmount: b.amount + 1 }))).toMatch(unsigned);
      // The first approval's assertion (recorded by the service) must exist too.
      expect(await judge((b) => b, true, (b) => [['DELETE FROM "ledger_approval_assertions" WHERE "subjectId" = $1 AND "action" = \'FIRST_APPROVAL\'',
        b.reviewId]])).toMatch(unsigned);
      expect(await judge((b) => b, true, (b) => [[`UPDATE "legacy_balance_reviews"
        SET "evidence" = jsonb_set("evidence", '{proposal,amount}', '40.5') WHERE "id" = $1`, b.reviewId]]))
        .toMatch(/approved a fractional amount/);
    });

    it('each approval\'s assertion must be validly signed, for the approved amount and the approved proposal', async () => {
      const unsigned = /is not backed by signed first and second approvals of review/;
      const proposal = `(SELECT "evidence" -> 'proposal' FROM "legacy_balance_reviews" WHERE "id" = $9)`;
      // Re-records one approval's assertion with one term changed.
      const resign = (action: 'FIRST_APPROVAL' | 'SECOND_APPROVAL', change: { amount?: number; evidence?: string; forged?: boolean }) =>
        (b: Resolution): Statement[] => [
          ['DELETE FROM "ledger_approval_assertions" WHERE "subjectId" = $1 AND "action" = $2', b.reviewId, action],
          signedAssertionSql({ subjectType: 'LEGACY_REVIEW', subjectId: b.reviewId, action,
            actorId: action === 'FIRST_APPROVAL' ? b.first : b.second, userId: b.owner, amount: change.amount ?? b.amount,
            caseId: b.reviewId, evidence: change.evidence === undefined ? proposal : '$9::jsonb',
            evidenceParams: [change.evidence ?? b.reviewId], signature: change.forged ? 'forged' : 'valid' }),
        ];
      for (const action of ['FIRST_APPROVAL', 'SECOND_APPROVAL'] as const) {
        expect(await judge((b) => b, true, resign(action, {})), action).toBe('valid');
        expect(await judge((b) => b, true, (b) => resign(action, { amount: b.amount + 1 })(b)), action).toMatch(unsigned);
        expect(await judge((b) => b, true, resign(action, { evidence: '{"decision": "WITHDRAWABLE", "amount": 1}' })), action)
          .toMatch(unsigned);
        expect(await judge((b) => b, true, resign(action, { forged: true })), action).toMatch(unsigned);
      }
    });

    it('the snapshot amount must be the approved amount', async () => {
      expect(await judge((b) => ({ ...b, snapshotAmount: b.amount + 1 }))).toMatch(/does not repeat the approved evidence/);
    });
    it('the snapshot second approver must be the review\'s', async () => {
      expect(await judge((b) => ({ ...b, snapshotSecond: 'x' }))).toMatch(/does not repeat the approved evidence/);
    });
    it('the debit must be exactly the approved amount from the review lot', async () => {
      expect(await judge((b) => ({ ...b, outAmount: b.amount - 1, closeLot: false }))).toMatch(/must move exactly the approved/);
      expect(await judge((b) => ({ ...b, outLot: f.purchaseLot.id, closeLot: false }))).toMatch(/must move exactly the approved/);
    });
    it('the credit must be exactly the approved amount', async () => {
      expect(await judge((b) => ({ ...b, inAmount: b.amount + 1 }))).toMatch(/must move exactly the approved/);
    });
    it('approver activity counts at write time only: I16 accepts a resolution whose approver left later', async () => {
      const leaver = await user(uid('leaver'), 'SUPER_ADMIN');
      const r = await firstApprovedReview(f, creditor, leaver);
      const verdicts = await inRolledBackTransaction(async (tx) => {
        const planted = resolutionSql({ ...r, owner: f.buyer.id, first: leaver.id, second: second.id });
        await asLegacy(tx, planted.statements);
        await tx.$executeRawUnsafe('UPDATE "users" SET "status" = \'SUSPENDED\' WHERE "id" = $1', leaver.id);
        const [row] = await tx.$queryRawUnsafe<{ now: string | null; history: string | null }[]>(
          'SELECT "legacy_resolution_violation"($1, true) AS now, "legacy_resolution_violation"($1, false) AS history', planted.op);
        return row;
      });
      expect(verdicts.now).toMatch(/needs two currently active SUPER_ADMIN approvers/);
      expect(verdicts.history).toBeNull();
      const i16 = await inRolledBackTransaction(async (tx) => {
        const r2 = await firstApprovedReview(f, creditor, leaver);
        await asLegacy(tx, resolutionSql({ ...r2, owner: f.buyer.id, first: leaver.id, second: second.id }).statements);
        await tx.$executeRawUnsafe('UPDATE "users" SET "status" = \'SUSPENDED\' WHERE "id" = $1', leaver.id);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        return scan.violations.find((v) => v.invariant.startsWith('I16'))?.count ?? 0;
      });
      expect(i16).toBe(0);
    });

    it('invariant I16 reports a planted forged resolution', async () => {
      const flagged = await inRolledBackTransaction(async (tx) => {
        const r = await firstApprovedReview(f, creditor, first);
        await asLegacy(tx, resolutionSql({ ...r, owner: f.buyer.id, first: first.id, second: second.id, forgedEvidence: true }).statements);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        return scan.violations.find((v) => v.invariant.startsWith('I16'))?.count ?? 0;
      });
      expect(flagged).toBe(1);
    });
  });

  describe('3. legacy review lifecycle', () => {
    /** An OPEN review over a real admin credit. */
    async function openReview(): Promise<string> {
      const credit = await executeTestAdjustment(f.buyer.id, 7, creditor);
      return (await prisma.legacyBalanceReview.findFirstOrThrow({ where: { lotId: credit.reviewLotId! } })).id;
    }
    it('a review must be created OPEN, without any approval field', async () => {
      const lot = f.purchaseLot.id;
      expect(await verdict(() => [[`INSERT INTO "legacy_balance_reviews" ("id","userId","lotId","amount","status","resolvedBy")
        VALUES ($1,$2,$3,5,'FIRST_APPROVED',$4)`, uid('rev'), f.buyer.id, lot, first.id]]))
        .toMatch(/rejects: .*must be created OPEN, without approvals/);
      const insert = (columns: string, values: string, ...params: unknown[]): Statement =>
        [`INSERT INTO "legacy_balance_reviews" ("id","userId","lotId","amount","status"${columns}) VALUES ($1,$2,$3,5,${values})`,
          uid('rev'), f.buyer.id, lot, ...params];
      for (const statement of [
        insert('', `'REJECTED'`),
        insert(',"resolvedBy"', `'OPEN',$4`, first.id),
        insert(',"secondApproverId"', `'OPEN',$4`, second.id),
        insert(',"resolutionOperationId"', `'OPEN',$4`, f.purchaseLot.sourceOperationId),
        insert(',"resolvedAt"', `'OPEN',now()`),
      ]) {
        expect(await verdict(() => [statement])).toMatch(/rejects: .*must be created OPEN, without approvals/);
      }
    });
    it('evidence is frozen while FIRST_APPROVED', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "evidence" = jsonb_set("evidence", '{proposal,amount}', '999')
        WHERE "id" = $1`, r.reviewId]])).toMatch(/rejects: .*evidence and first approval are frozen/);
    });
    it('the first approver is frozen while FIRST_APPROVED', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => [['UPDATE "legacy_balance_reviews" SET "resolvedBy" = $2 WHERE "id" = $1', r.reviewId, second.id]]))
        .toMatch(/rejects: .*evidence and first approval are frozen/);
    });
    it('resolving needs a first approval, a second approver and the resolution operation', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'RESOLVED', "secondApproverId" = $2
        WHERE "id" = $1`, r.reviewId, second.id]])).toMatch(/rejects: .*can only be resolved from a first approval/);
    });
    it('resolving needs each of: a first approval, a second approver, the operation and the time', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      const op = f.purchaseLot.sourceOperationId;
      for (const set of ['"resolutionOperationId" = $2, "resolvedAt" = now()', '"secondApproverId" = $3, "resolvedAt" = now()',
        '"secondApproverId" = $3, "resolutionOperationId" = $2']) {
        expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'RESOLVED', ${set} WHERE "id" = $1`,
          r.reviewId, op, second.id]])).toMatch(/rejects: .*can only be resolved from a first approval/);
      }
      const open = await openReview();
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'RESOLVED', "secondApproverId" = $2,
        "resolutionOperationId" = $3, "resolvedAt" = now() WHERE "id" = $1`, open, second.id, op]]))
        .toMatch(/rejects: .*can only be resolved from a first approval/);
    });
    it('an OPEN review records no first approver, and a first approval needs one', async () => {
      const open = await openReview();
      expect(await verdict(() => [['UPDATE "legacy_balance_reviews" SET "resolvedBy" = $2 WHERE "id" = $1', open, first.id]]))
        .toMatch(/rejects: .*is OPEN but records a first approver/);
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'FIRST_APPROVED',
        "evidence" = "evidence" || '{"proposal": {"amount": 7, "decision": "WITHDRAWABLE"}}'::jsonb WHERE "id" = $1`, open]]))
        .toMatch(/rejects: .*first approval needs its approver and approved proposal/);
    });
    it('a REJECTED review never changes', async () => {
      const review = uid('rejected');
      expect(await verdict(() => [
        ['SET LOCAL session_replication_role = replica'],
        ['INSERT INTO "legacy_balance_reviews" ("id","userId","lotId","amount","status") VALUES ($1,$2,$3,5,\'REJECTED\')',
          review, f.buyer.id, f.purchaseLot.id],
        ['SET LOCAL session_replication_role = origin'],
        ['UPDATE "legacy_balance_reviews" SET "status" = \'OPEN\' WHERE "id" = $1', review],
      ])).toMatch(/rejects: .*is REJECTED; it can no longer change/);
    });
    it('a second approval cannot be recorded without resolving', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => [['UPDATE "legacy_balance_reviews" SET "secondApproverId" = $2 WHERE "id" = $1', r.reviewId, second.id]]))
        .toMatch(/rejects: .*records a second approval without being resolved/);
    });
    it('only a RESOLVED review names a resolution operation', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'REJECTED', "resolutionOperationId" = $2
        WHERE "id" = $1`, r.reviewId, f.purchaseLot.sourceOperationId]]))
        .toMatch(/rejects: .*names a resolution operation without being resolved/);
    });
    it('a first approval needs its approver and proposal', async () => {
      const review = await openReview();
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'FIRST_APPROVED', "resolvedBy" = $2
        WHERE "id" = $1`, review, first.id]])).toMatch(/rejects: .*first approval needs its approver and approved proposal/);
    });
    it('two identical concurrent second approvals resolve once; both succeed with the same resolution', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      const operationsBefore = await prisma.economicOperation.count({ where: { userId: f.buyer.id, type: 'LEGACY_RESOLVE' } });
      // Barrier: a third session holds the second approver's user row, so the
      // first request parks right after the review's scope lock; the second
      // then queues behind that lock with its snapshot already taken.
      let held!: () => void; let release!: () => void;
      const holding = new Promise<void>((resolve) => { held = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const blocker = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ${second.id} FOR UPDATE`;
        held();
        await released;
      }, { timeout: 60_000 });
      await holding;
      const resolve = () => secondApproveLegacyReview(second.id, r.reviewId)
        .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: String(error) }));
      const firstRequest = resolve();
      await waitForBlockedBackends(1, { waitEvents: ROW_LOCK_WAITS, queryLike: '%FOR SHARE%' });
      const secondRequest = resolve();
      await waitForBlockedBackends(1, { waitEvents: ['advisory'] });
      release();
      await blocker;
      const results = await Promise.all([firstRequest, secondRequest]);
      expect(results.map((result) => result.ok), JSON.stringify(results)).toEqual([true, true]);
      const resolved = results.map((result) => (result as { value: { operationId: string; idempotent: boolean } }).value);
      expect(resolved.map((value) => value.idempotent).sort()).toEqual([false, true]);
      expect(resolved[1].operationId).toBe(resolved[0].operationId);
      expect(await prisma.economicOperation.count({ where: { userId: f.buyer.id, type: 'LEGACY_RESOLVE' } }))
        .toBe(operationsBefore + 1);
    });
    it('a resolved review never changes and no review is deleted', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      await secondApproveLegacyReview(second.id, r.reviewId);
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "evidence" = '{}' WHERE "id" = $1`, r.reviewId]]))
        .toMatch(/rejects: .*is RESOLVED; it can no longer change/);
      expect(await verdict(() => [['DELETE FROM "legacy_balance_reviews" WHERE "id" = $1', r.reviewId]]))
        .toMatch(/rejects: .*legacy_balance_reviews is append-only/);
    });
    it('user, lot and amount are immutable', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      for (const [sql, value] of [['"amount" = "amount" + 1', null], ['"userId" = $2', other.buyer.id],
        ['"lotId" = $2', f.purchaseLot.id], ['"id" = $2', uid('renamed-review')],
        ['"createdAt" = "createdAt" - interval \'1 day\'', null]] as const) {
        expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET ${sql} WHERE "id" = $1`, r.reviewId,
          ...(value ? [value] : [])] as Statement]))
          .toMatch(/rejects: .*user, lot and amount are immutable/);
      }
    });
    it('reopening a first approval (the application path for stale approvals) is allowed', async () => {
      const r = await firstApprovedReview(f, creditor, first);
      expect(await verdict(() => [[`UPDATE "legacy_balance_reviews" SET "status" = 'OPEN', "resolvedBy" = NULL,
        "evidence" = "evidence" || '{"proposal": null}'::jsonb WHERE "id" = $1`, r.reviewId]])).toBe('accepts');
    });
  });

  describe('4. the application re-checks the first approver', () => {
    it('reopens the review when the first approver was suspended', async () => {
      const approver = await user(uid('suspended-first'), 'SUPER_ADMIN');
      const r = await firstApprovedReview(f, creditor, approver);
      await prisma.user.update({ where: { id: approver.id }, data: { status: 'SUSPENDED' } });
      await expect(secondApproveLegacyReview(second.id, r.reviewId)).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('First approver is no longer an active SUPER_ADMIN'),
      });
      expect((await prisma.legacyBalanceReview.findUniqueOrThrow({ where: { id: r.reviewId } })).status).toBe('OPEN');
    });
    it('reopens the review instead of resolving when the first approver is no longer an active SUPER_ADMIN', async () => {
      const approver = await user(uid('demoted'), 'SUPER_ADMIN');
      const r = await firstApprovedReview(f, creditor, approver);
      const operationsBefore = await prisma.economicOperation.count({ where: { userId: f.buyer.id } });
      await prisma.user.update({ where: { id: approver.id }, data: { role: 'ADMIN' } });
      await expect(secondApproveLegacyReview(second.id, r.reviewId)).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('First approver is no longer an active SUPER_ADMIN'),
      });
      const review = await prisma.legacyBalanceReview.findUniqueOrThrow({ where: { id: r.reviewId } });
      expect({ status: review.status, resolvedBy: review.resolvedBy }).toEqual({ status: 'OPEN', resolvedBy: null });
      expect(await prisma.economicOperation.count({ where: { userId: f.buyer.id } })).toBe(operationsBefore);
      await firstApproveLegacyReview(first.id, r.reviewId, terms);
      const resolved = await secondApproveLegacyReview(second.id, r.reviewId);
      expect(resolved.idempotent).toBe(false);
    });
  });
});
