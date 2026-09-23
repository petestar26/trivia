// Direct-SQL attacks on the ledger's database guards. Every statement runs
// as ordinary SQL with all triggers active (no replica mode), exactly as a
// buggy writer or a hand-typed correction would. Each attack is shaped so
// that only the guard under test can stop it, and asserts that guard's own
// message, so an older, broader guard can never mask a missing one. Every
// transaction is rolled back, whatever the verdict.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';
import {
  accountSql, bareUserSql, entrySql, inRolledBackTransaction, legacyLotSql, lotSql, operationSql,
  purchasedFixture, reviewSql, uid, walletDeltaSql, walletSql,
} from '../test/ledger-integrity-fixtures.js';
import type { LotFields, PurchasedFixture, Statement, Tx } from '../test/ledger-integrity-fixtures.js';

beforeAll(async () => { await bootstrapLedgerTestGates(); });
afterAll(async () => { await prisma.$disconnect(); });

/** Runs the statements as ordinary SQL, then forces every deferred
 * constraint trigger to fire. Returns 'accepts' or the guard's message. */
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

/** Fires every queued deferred check now, so a later statement can only be
 * refused by the guard of the table it writes, not by an earlier row's check. */
const FLUSH: Statement[] = [['SET CONSTRAINTS ALL IMMEDIATE'], ['SET CONSTRAINTS ALL DEFERRED']];

/** A user with a wallet and an unclassified ledger account, as the upgrade
 * leaves every pre-ledger user until the M7 replay classifies it. */
function unclassifiedUser(coins: number): { id: string; setup: Statement[] } {
  const id = uid('guard-user');
  return { id, setup: [bareUserSql(id), walletSql(id, coins), accountSql(id, false)] };
}

/** An UNCLASSIFIED lot whose opening journal (WITHDRAWAL scope, so it may
 * RESERVE) explains its caches exactly; optionally under an OPEN review. */
function openingLot(userId: string, available: number, reserved: number, withReview: boolean) {
  const op = uid('guard-op'); const lot = uid('guard-lot'); const review = uid('guard-review');
  const statements: Statement[] = [
    operationSql(op, userId, uid('scope'), 'WITHDRAWAL'),
    lotSql(lot, userId, { lotClass: 'UNCLASSIFIED', sourceOperationId: op, amount: Math.max(available + reserved, 1) }),
  ];
  if (withReview) {
    statements.push(reviewSql(review, userId, lot, available + reserved, 'OPEN'),
      ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', lot, review]);
  }
  if (available + reserved > 0) statements.push(entrySql(op, lot, userId, 0, 'MINT', { available: available + reserved }));
  if (reserved > 0) statements.push(entrySql(op, lot, userId, 1, 'RESERVE', { available: -reserved, reserved }));
  return { op, lot, review, statements };
}

describe('ledger database guards reject malformed writes made with plain SQL', () => {
  let f: PurchasedFixture;
  let other: PurchasedFixture;
  beforeAll(async () => {
    f = await purchasedFixture(1000);
    other = await purchasedFixture(500);
  });

  describe('lot initialization', () => {
    it('refuses a managed lot with a NULL state', async () => {
      const u = unclassifiedUser(0); const op = uid('op'); const lot = uid('lot');
      expect(await verdict(() => [...u.setup, operationSql(op, u.id, lot),
        lotSql(lot, u.id, { state: null, lotClass: 'UNCLASSIFIED', sourceOperationId: op })]))
        .toMatch(/rejects: .*managed coin lot .* is not fully initialized/);
    });
    for (const cache of ['available', 'reserved', 'requirement', 'progress'] as const) {
      it(`refuses a managed lot with a NULL ${cache} cache`, async () => {
        const u = unclassifiedUser(0); const op = uid('op'); const lot = uid('lot');
        const fields: LotFields = { lotClass: 'UNCLASSIFIED', sourceOperationId: op };
        fields[cache] = null;
        expect(await verdict(() => [...u.setup, operationSql(op, u.id, lot), lotSql(lot, u.id, fields)]))
          .toMatch(/rejects: .*managed coin lot .* is not fully initialized/);
      });
    }
    for (const [field, sql] of [
      ['state', '"state" = \'OPEN\''], ['available cache', '"availableAmount" = 0'],
      ['reserved cache', '"reservedAmount" = 0'], ['requirement cache', '"requirementAmount" = 0'],
      ['progress cache', '"progressAmount" = 0'],
    ] as const) {
      it(`refuses a pre-journal lot that gains a ${field} without a lot class`, async () => {
        const u = unclassifiedUser(10); const lot = uid('legacy');
        expect(await verdict(() => [...u.setup, legacyLotSql(lot, u.id, 10),
          [`UPDATE "coin_provenance" SET ${sql} WHERE "id" = $1`, lot]]))
          .toMatch(/rejects: .*coin lot .* is partially initialized/);
      });
    }
    it('refuses a pre-journal lot that gains a source operation without a lot class', async () => {
      const u = unclassifiedUser(10); const lot = uid('legacy'); const op = uid('op');
      expect(await verdict(() => [...u.setup, operationSql(op, u.id, lot), legacyLotSql(lot, u.id, 10),
        ['UPDATE "coin_provenance" SET "sourceOperationId" = $2 WHERE "id" = $1', lot, op]]))
        .toMatch(/rejects: .*coin lot .* is partially initialized/);
    });
    it('accepts a fully pre-journal lot of an unclassified user (it awaits replay)', async () => {
      const u = unclassifiedUser(10);
      expect(await verdict(() => [...u.setup, legacyLotSql(uid('legacy'), u.id, 10)])).toBe('accepts');
    });
    it('accepts a fully initialized zero-value lot', async () => {
      const u = unclassifiedUser(0); const op = uid('op'); const lot = uid('lot');
      expect(await verdict(() => [...u.setup, operationSql(op, u.id, lot),
        lotSql(lot, u.id, { lotClass: 'UNCLASSIFIED', sourceOperationId: op })])).toBe('accepts');
    });
  });

  describe('wallet ownership', () => {
    it('refuses a lot for a user who has no wallet', async () => {
      const u = uid('no-wallet'); const op = uid('op'); const lot = uid('lot');
      expect(await verdict(() => [bareUserSql(u), operationSql(op, u, lot),
        lotSql(lot, u, { lotClass: 'UNCLASSIFIED', sourceOperationId: op })]))
        .toMatch(/rejects: .*coin_provenance .* belongs to user .* who has no wallet/);
    });
    it('refuses an unclassified ledger account for a user who has no wallet', async () => {
      const u = uid('no-wallet');
      expect(await verdict(() => [bareUserSql(u), accountSql(u, false)]))
        .toMatch(/rejects: .*coin_ledger_accounts .* belongs to user .* who has no wallet/);
    });
    it('refuses deleting the wallet of a user who has a ledger account', async () => {
      const u = unclassifiedUser(0);
      expect(await verdict(() => [...u.setup, ['DELETE FROM "wallets" WHERE "userId" = $1', u.id]]))
        .toMatch(/rejects: .*wallet of user .* cannot be removed while it owns ledger rows/);
    });
    it('refuses moving a wallet away from a user who has coin lots', async () => {
      const u = unclassifiedUser(10); const target = uid('target');
      expect(await verdict(() => [...u.setup, legacyLotSql(uid('legacy'), u.id, 10), bareUserSql(target),
        ['UPDATE "wallets" SET "userId" = $2 WHERE "userId" = $1', u.id, target]]))
        .toMatch(/rejects: .*wallet of user .* cannot be removed while it owns ledger rows/);
    });
    it('refuses deleting the wallet of a user who owns coin lots but has no ledger account', async () => {
      const u = uid('lots-only');
      expect(await verdict(() => [bareUserSql(u), walletSql(u, 10), legacyLotSql(uid('legacy'), u, 10), ...FLUSH,
        ['DELETE FROM "wallets" WHERE "userId" = $1', u]]))
        .toMatch(/rejects: .*wallet of user .* cannot be removed while it owns ledger rows/);
    });
    it('accepts deleting the wallet of a user with no ledger rows', async () => {
      const u = uid('plain');
      expect(await verdict(() => [bareUserSql(u), walletSql(u, 0),
        ['DELETE FROM "wallets" WHERE "userId" = $1', u]])).toBe('accepts');
    });
  });

  describe('review coverage of UNCLASSIFIED value', () => {
    it('refuses unlinking the review of reserved-only UNCLASSIFIED value of a classified user', async () => {
      const lot = openingLot(f.buyer.id, 0, 15, true);
      expect(await verdict(() => [...lot.statements,
        ['UPDATE "coin_provenance" SET "reviewId" = NULL WHERE "id" = $1', lot.lot]]))
        .toMatch(/rejects: .*UNCLASSIFIED lot .* of classified user .* holds 15 Coins without an open review/);
    });
    it('refuses resolving a review while its lot still holds the value', async () => {
      const lot = openingLot(f.buyer.id, 10, 0, true);
      expect(await verdict(() => [...lot.statements, walletDeltaSql(f.buyer.id, 10), ...FLUSH,
        [`UPDATE "legacy_balance_reviews" SET "status" = 'RESOLVED', "resolvedBy" = $2, "secondApproverId" = $3
          WHERE "id" = $1`, lot.review, f.superAdmin.id, other.superAdmin.id]]))
        .toMatch(/rejects: .*UNCLASSIFIED lot .* holds 10 Coins without an open review/);
    });
    it('refuses moving a review to another user while it covers the value', async () => {
      const lot = openingLot(f.buyer.id, 10, 0, true);
      expect(await verdict(() => [...lot.statements, walletDeltaSql(f.buyer.id, 10), ...FLUSH,
        ['UPDATE "legacy_balance_reviews" SET "userId" = $2 WHERE "id" = $1', lot.review, other.buyer.id]]))
        .toMatch(/rejects: .*UNCLASSIFIED lot .* holds 10 Coins without an open review/);
    });
    it('refuses classifying an account whose UNCLASSIFIED value has no review', async () => {
      const u = unclassifiedUser(10); const lot = openingLot(u.id, 10, 0, false);
      expect(await verdict(() => [...u.setup, ...lot.statements, ...FLUSH,
        ['UPDATE "coin_ledger_accounts" SET "classifiedAt" = now() WHERE "userId" = $1', u.id]]))
        .toMatch(/rejects: .*UNCLASSIFIED lot .* holds 10 Coins without an open review/);
    });
    it('accepts UNCLASSIFIED value of a classified user under an OPEN review', async () => {
      const lot = openingLot(f.buyer.id, 10, 5, true);
      expect(await verdict(() => [...lot.statements, walletDeltaSql(f.buyer.id, 10)])).toBe('accepts');
    });
    it('accepts UNCLASSIFIED value of a classified user under a FIRST_APPROVED review', async () => {
      const lot = openingLot(f.buyer.id, 10, 0, true);
      expect(await verdict(() => [...lot.statements, walletDeltaSql(f.buyer.id, 10),
        ['UPDATE "legacy_balance_reviews" SET "status" = \'FIRST_APPROVED\', "resolvedBy" = $2 WHERE "id" = $1',
          lot.review, f.superAdmin.id]])).toBe('accepts');
    });
    it('accepts a zero-value UNCLASSIFIED lot of a classified user without a review', async () => {
      const lot = openingLot(f.buyer.id, 0, 0, false);
      expect(await verdict(() => lot.statements)).toBe('accepts');
    });
    it('accepts unreviewed UNCLASSIFIED value while the account is still unclassified', async () => {
      const u = unclassifiedUser(10); const lot = openingLot(u.id, 10, 0, false);
      expect(await verdict(() => [...u.setup, ...lot.statements])).toBe('accepts');
    });
  });

  describe('reviewed foundation guards', () => {
    it('journal integrity: refuses a managed lot whose value has no journal entry', async () => {
      const u = unclassifiedUser(10); const op = uid('op'); const lot = uid('lot');
      expect(await verdict(() => [...u.setup, operationSql(op, u.id, lot),
        lotSql(lot, u.id, { lotClass: 'UNCLASSIFIED', sourceOperationId: op, available: 10 })]))
        .toMatch(/rejects: .*caches do not reconcile with its ledger entries/);
    });
    it('journal integrity: refuses a managed lot without a source operation', async () => {
      const u = unclassifiedUser(0);
      expect(await verdict(() => [...u.setup, lotSql(uid('lot'), u.id, { lotClass: 'UNCLASSIFIED' })]))
        .toMatch(/rejects: .*managed coin lot .* has no source operation/);
    });
    it('journal integrity: refuses a lot whose source operation belongs to another user', async () => {
      const u = unclassifiedUser(0); const lot = uid('lot');
      expect(await verdict(() => [...u.setup,
        lotSql(lot, u.id, { lotClass: 'UNCLASSIFIED', sourceOperationId: f.purchaseLot.sourceOperationId })]))
        .toMatch(/rejects: .*source operation is missing or cross-user/);
    });
    it('caches are entry-maintained: refuses a direct cache edit', async () => {
      expect(await verdict(() => [['UPDATE "coin_provenance" SET "availableAmount" = "availableAmount" + 1 WHERE "id" = $1', f.purchaseLot.id]]))
        .toMatch(/rejects: .*coin lot caches are entry-maintained/);
    });
    it('classified wallet equality: refuses a wallet balance its lots do not explain', async () => {
      expect(await verdict(() => [walletDeltaSql(f.buyer.id, 7)]))
        .toMatch(/rejects: .*classified wallet .* imbalance: wallet 1007, lots 1000/);
    });
    it('classified wallet equality: refuses a pre-journal lot for a classified user', async () => {
      expect(await verdict(() => [legacyLotSql(uid('legacy'), f.buyer.id, 10)]))
        .toMatch(/rejects: .*classified wallet .* has uninitialized lot/);
    });
    it('entries: refuses an entry whose user differs from its lot', async () => {
      const lot = openingLot(f.buyer.id, 0, 0, false);
      expect(await verdict(() => [lot.statements[0], lot.statements[1],
        entrySql(lot.op, lot.lot, other.buyer.id, 0, 'MINT', { available: 5 })]))
        .toMatch(/rejects: .*cross-user coin lot entry/);
    });
    it('reserved operation type: refuses an ADMIN_QUALIFY operation', async () => {
      expect(await verdict(() => [[`INSERT INTO "economic_operations" ("id","type","userId","scopeType","scopeId","walletTransactionIds","createdBy")
        VALUES ($1,'ADMIN_QUALIFY',$2,'LOT',$1,'{}','SYSTEM')`, uid('op'), f.buyer.id]]))
        .toMatch(/rejects: .*ADMIN_QUALIFY is reserved and disabled/);
    });
    it('terminal lots cannot reopen', async () => {
      const u = unclassifiedUser(0); const op = uid('op'); const lot = uid('lot');
      expect(await verdict(() => [...u.setup, operationSql(op, u.id, lot),
        lotSql(lot, u.id, { lotClass: 'UNCLASSIFIED', state: 'EXHAUSTED', sourceOperationId: op }),
        ['UPDATE "coin_provenance" SET "state" = \'OPEN\' WHERE "id" = $1', lot]]))
        .toMatch(/rejects: .*terminal coin lot .* cannot reopen/);
    });
    it('withdrawable lots carry no playthrough obligation', async () => {
      const u = unclassifiedUser(0); const op = uid('op');
      expect(await verdict(() => [...u.setup, operationSql(op, u.id, uid('scope')),
        lotSql(uid('lot'), u.id, { lotClass: 'WITHDRAWABLE', requirement: 5, sourceOperationId: op })]))
        .toMatch(/rejects: .*withdrawable lot .* has a playthrough obligation/);
    });
    it('legacy reviews need two different approvers', async () => {
      const lot = openingLot(f.buyer.id, 0, 0, false);
      expect(await verdict(() => [lot.statements[0], lot.statements[1],
        reviewSql(uid('review'), f.buyer.id, lot.lot, 5, 'FIRST_APPROVED', { first: f.superAdmin.id, second: f.superAdmin.id })]))
        .toMatch(/rejects: .*legacy_balance_reviews_distinct_approvers_chk/);
    });
    for (const [table, sql, key] of [
      ['economic_operations', 'UPDATE "economic_operations" SET "createdBy" = \'x\' WHERE "id" = $1', 'operation'],
      ['coin_lot_entries', 'DELETE FROM "coin_lot_entries" WHERE "lotId" = $1', 'lot'],
      ['wallet_transactions', 'UPDATE "wallet_transactions" SET "description" = \'x\' WHERE "userId" = $1', 'user'],
      ['coin_provenance', 'DELETE FROM "coin_provenance" WHERE "id" = $1', 'lot'],
    ] as const) {
      it(`financial history is append-only: ${table}`, async () => {
        const param = { operation: f.purchaseLot.sourceOperationId, lot: f.purchaseLot.id, user: f.buyer.id }[key];
        expect(await verdict(() => [[sql, param]])).toMatch(new RegExp(`rejects: .*${table} is append-only`));
      });
    }
  });
});
