// Consistency matrix from the Opus 5.5 review of a0c14b7 (items 10 and 11),
// extended with the states that review found each component classifying
// differently. For every fixture, four independent observers must agree:
//   gate      - "ledger_integrity_anomalies"(), used by the upgrade migration
//   preflight - the read-only preflight's own copy of the same definitions
//   checker   - the runtime ledger invariant scan
//   database  - the guards: any write touching the anomalous row is refused
// Each fixture also pins the exact anomaly categories the gate must report.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@socialplay/database';
import { bootstrapLedgerTestGates } from '../economy/ledger-test-bootstrap.js';
import { runLedgerInvariantCheckInTransaction } from '../economy/ledger-invariant-checker.js';
import {
  accountSql, asLegacy, bareUserSql, constraintVerdict, entrySql, inRolledBackTransaction,
  legacyLotSql, lotSql, operationSql, purchasedFixture, reviewSql, touchAccount, touchLot,
  touchWallet, uid, user, walletDeltaSql, walletSql,
} from '../test/ledger-integrity-fixtures.js';
import type { LotFields, PurchasedFixture, Tx } from '../test/ledger-integrity-fixtures.js';

beforeAll(async () => { await bootstrapLedgerTestGates(); });
afterAll(async () => { await prisma.$disconnect(); });

interface Planted { subjects: string[]; probe: string }
interface Fixture {
  expected: string[];
  plant: (tx: Tx, f: PurchasedFixture, other: PurchasedFixture) => Promise<Planted>;
}

/** A consistent managed lot for `userId`: its own opening operation and a
 * journal that explains the cache exactly. */
function journaledLot(userId: string, lotId: string, lotClass: string, available: number, reserved = 0) {
  const op = uid('op');
  return {
    op,
    statements: [
      operationSql(op, userId, lotId),
      lotSql(lotId, userId, { lotClass, available, reserved, sourceOperationId: op }),
      entrySql(op, lotId, userId, 0, 'MINT', { available: available + reserved }),
      ...(reserved > 0 ? [entrySql(op, lotId, userId, 1, 'RESERVE', { available: -reserved, reserved })] : []),
    ],
  };
}

const fixtures: Record<string, Fixture> = {
  'F1 phantom managed lot: no source, no journal, not in the wallet': {
    expected: ['CACHE_JOURNAL_MISMATCH', 'SOURCE_OPERATION_MISSING', 'WALLET_LOT_MISMATCH'],
    plant: async (tx, f) => {
      const id = uid('f1');
      await asLegacy(tx, [lotSql(id, f.buyer.id, { available: 10 })]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F2 real purchase lot lost its source pointer (wallet consistent)': {
    expected: ['SOURCE_OPERATION_MISSING'],
    plant: async (tx, f) => {
      await asLegacy(tx, [['UPDATE "coin_provenance" SET "sourceOperationId" = NULL WHERE "id" = $1', f.purchaseLot.id]]);
      return { subjects: [f.purchaseLot.id, f.buyer.id], probe: touchLot(f.purchaseLot.id) };
    },
  },
  'F3 source operation belongs to another user': {
    expected: ['SOURCE_OPERATION_CROSS_USER'],
    plant: async (tx, f, other) => {
      await asLegacy(tx, [['UPDATE "coin_provenance" SET "sourceOperationId" = $2 WHERE "id" = $1',
        f.purchaseLot.id, other.purchaseLot.sourceOperationId]]);
      return { subjects: [f.purchaseLot.id, f.buyer.id], probe: touchLot(f.purchaseLot.id) };
    },
  },
  'F4 source operation does not exist (foreign key bypassed)': {
    expected: ['SOURCE_OPERATION_INVALID'],
    plant: async (tx, f) => {
      await asLegacy(tx, [['UPDATE "coin_provenance" SET "sourceOperationId" = $2 WHERE "id" = $1', f.purchaseLot.id, uid('ghost-op')]]);
      return { subjects: [f.purchaseLot.id, f.buyer.id], probe: touchLot(f.purchaseLot.id) };
    },
  },
  'F6 classified wallet above its lots': {
    expected: ['WALLET_LOT_MISMATCH'],
    plant: async (tx, f) => {
      await asLegacy(tx, [walletDeltaSql(f.buyer.id, 25)]);
      return { subjects: [f.buyer.id], probe: touchWallet(f.buyer.id) };
    },
  },
  'F7 classified wallet below its lots': {
    expected: ['WALLET_LOT_MISMATCH'],
    plant: async (tx, f) => {
      await asLegacy(tx, [walletDeltaSql(f.buyer.id, -25)]);
      return { subjects: [f.buyer.id], probe: touchWallet(f.buyer.id) };
    },
  },
  'F8 NULL-state lot with unjournaled value that the wallet does hold': {
    expected: ['CACHE_JOURNAL_MISMATCH', 'LOT_STATE_NULL', 'SOURCE_OPERATION_MISSING'],
    plant: async (tx, f) => {
      const id = uid('f8');
      await asLegacy(tx, [lotSql(id, f.buyer.id, { state: null, available: 10 }), walletDeltaSql(f.buyer.id, 10)]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F9 NULL-state lot with unjournaled value the wallet does not hold': {
    expected: ['CACHE_JOURNAL_MISMATCH', 'LOT_STATE_NULL', 'SOURCE_OPERATION_MISSING', 'WALLET_LOT_MISMATCH'],
    plant: async (tx, f) => {
      const id = uid('f9');
      await asLegacy(tx, [lotSql(id, f.buyer.id, { state: null, available: 10 })]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F11 journaled UNCLASSIFIED value of a classified user, no review': {
    expected: ['UNCLASSIFIED_VALUE_UNREVIEWED'],
    plant: async (tx, f) => {
      const id = uid('f11');
      await asLegacy(tx, [...journaledLot(f.buyer.id, id, 'UNCLASSIFIED', 10).statements, walletDeltaSql(f.buyer.id, 10)]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F12 classified ledger account without a wallet row': {
    expected: ['WALLET_MISSING'],
    plant: async (tx) => {
      const u = uid('f12');
      await asLegacy(tx, [bareUserSql(u), accountSql(u, true)]);
      return { subjects: [u], probe: touchAccount(u) };
    },
  },
  'F13 NULL-state lot that is otherwise valid (zero value, valid source)': {
    expected: ['LOT_STATE_NULL'],
    plant: async (tx, f) => {
      const id = uid('f13'); const op = uid('op');
      await asLegacy(tx, [operationSql(op, f.buyer.id, id), lotSql(id, f.buyer.id, { state: null, sourceOperationId: op })]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F14 unclassified ledger account without a wallet row': {
    expected: ['WALLET_MISSING'],
    plant: async (tx) => {
      const u = uid('f14');
      await asLegacy(tx, [bareUserSql(u), accountSql(u, false)]);
      return { subjects: [u], probe: touchAccount(u) };
    },
  },
  'F15 journaled lot (like a legacy hold) owned by a user with no wallet': {
    expected: ['WALLET_MISSING'],
    plant: async (tx) => {
      const u = uid('f15'); const id = uid('f15-lot');
      const review = uid('f15-review');
      const lot = journaledLot(u, id, 'UNCLASSIFIED', 0, 40);
      await asLegacy(tx, [bareUserSql(u), ...lot.statements, reviewSql(review, u, id, 40, 'OPEN'),
        ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', id, review]]);
      return { subjects: [id, u], probe: touchLot(id) };
    },
  },
  'F16 reserved-only UNCLASSIFIED value of a classified user, no review': {
    expected: ['UNCLASSIFIED_VALUE_UNREVIEWED'],
    plant: async (tx, f) => {
      const id = uid('f16');
      await asLegacy(tx, journaledLot(f.buyer.id, id, 'UNCLASSIFIED', 0, 15).statements);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F17 UNCLASSIFIED value whose review is already RESOLVED': {
    expected: ['UNCLASSIFIED_VALUE_UNREVIEWED'],
    plant: async (tx, f, other) => {
      const id = uid('f17'); const review = uid('f17-review');
      await asLegacy(tx, [...journaledLot(f.buyer.id, id, 'UNCLASSIFIED', 10).statements, walletDeltaSql(f.buyer.id, 10),
        reviewSql(review, f.buyer.id, id, 10, 'RESOLVED', { first: f.superAdmin.id, second: other.superAdmin.id }),
        ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', id, review]]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F18 UNCLASSIFIED value linked to another user\'s review': {
    expected: ['UNCLASSIFIED_VALUE_UNREVIEWED'],
    plant: async (tx, f, other) => {
      const id = uid('f18'); const review = uid('f18-review');
      await asLegacy(tx, [...journaledLot(f.buyer.id, id, 'UNCLASSIFIED', 10).statements, walletDeltaSql(f.buyer.id, 10),
        reviewSql(review, other.buyer.id, id, 10, 'OPEN'),
        ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', id, review]]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'F19 pre-journal lot owned by a classified user': {
    expected: ['LEGACY_LOT_OF_CLASSIFIED_OWNER'],
    plant: async (tx, f) => {
      const id = uid('f19');
      await asLegacy(tx, [legacyLotSql(id, f.buyer.id, 10)]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'CONTROL legitimate purchase, untouched': {
    expected: [],
    plant: async (_tx, f) => ({ subjects: [f.purchaseLot.id, f.buyer.id], probe: touchLot(f.purchaseLot.id) }),
  },
  'CONTROL pre-journal lot of an unclassified user awaiting replay': {
    expected: [],
    plant: async (tx) => {
      const u = uid('c-legacy'); const id = uid('c-legacy-lot');
      await asLegacy(tx, [bareUserSql(u), walletSql(u, 10), accountSql(u, false), legacyLotSql(id, u, 10)]);
      return { subjects: [id, u], probe: touchLot(id) };
    },
  },
  'CONTROL UNCLASSIFIED value of a classified user under an OPEN review': {
    expected: [],
    plant: async (tx, f) => {
      const id = uid('c-review'); const review = uid('c-review-row');
      await asLegacy(tx, [...journaledLot(f.buyer.id, id, 'UNCLASSIFIED', 10).statements, walletDeltaSql(f.buyer.id, 10),
        reviewSql(review, f.buyer.id, id, 10, 'OPEN'),
        ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', id, review]]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
};

for (const cache of ['available', 'reserved', 'requirement', 'progress'] as const) {
  fixtures[`F10 managed lot with a NULL ${cache} cache`] = {
    expected: ['CACHE_JOURNAL_MISMATCH', 'LOT_CACHE_NULL'],
    plant: async (tx, f) => {
      const id = uid('f10'); const op = uid('op');
      const fields: LotFields = { sourceOperationId: op };
      fields[cache] = null;
      await asLegacy(tx, [operationSql(op, f.buyer.id, id), lotSql(id, f.buyer.id, fields)]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  };
}
for (const [cache, column] of [['available', 'availableAmount'], ['reserved', 'reservedAmount'],
  ['requirement', 'requirementAmount'], ['progress', 'progressAmount']] as const) {
  fixtures[`F5 ${cache} cache above its journal${cache === 'available' ? ', wallet raised to match' : ''}`] = {
    expected: ['CACHE_JOURNAL_MISMATCH'],
    plant: async (tx, f) => {
      if (cache === 'progress') {
        // Progress may never exceed the requirement (a CHECK), so drift it on
        // a journaled RESTRICTED lot that carries an obligation.
        const id = uid('f5-restricted'); const op = uid('op');
        await asLegacy(tx, [operationSql(op, f.buyer.id, id),
          lotSql(id, f.buyer.id, { lotClass: 'RESTRICTED', available: 10, requirement: 20, sourceOperationId: op }),
          entrySql(op, id, f.buyer.id, 0, 'MINT', { available: 10, obligation: 20 }), walletDeltaSql(f.buyer.id, 10),
          ['UPDATE "coin_provenance" SET "progressAmount" = "progressAmount" + 5 WHERE "id" = $1', id]]);
        return { subjects: [id, f.buyer.id], probe: touchLot(id) };
      }
      await asLegacy(tx, [[`UPDATE "coin_provenance" SET "${column}" = "${column}" + 5 WHERE "id" = $1`, f.purchaseLot.id],
        ...(cache === 'available' ? [walletDeltaSql(f.buyer.id, 5)] : [])]);
      return { subjects: [f.purchaseLot.id, f.buyer.id], probe: touchLot(f.purchaseLot.id) };
    },
  };
}
for (const [field, sql] of [['state', '"state" = \'OPEN\''], ['available cache', '"availableAmount" = 0'],
  ['reserved cache', '"reservedAmount" = 0'], ['requirement cache', '"requirementAmount" = 0'],
  ['progress cache', '"progressAmount" = 0'], ['source operation', '"sourceOperationId" = $2']] as const) {
  fixtures[`F20 pre-journal lot with a ${field} but no lot class`] = {
    expected: ['LOT_PARTIALLY_LEGACY'],
    plant: async (tx) => {
      const u = uid('f20'); const id = uid('f20-lot'); const op = uid('op');
      await asLegacy(tx, [bareUserSql(u), walletSql(u, 0), accountSql(u, false), operationSql(op, u, id),
        legacyLotSql(id, u, 10),
        [`UPDATE "coin_provenance" SET ${sql} WHERE "id" = $1`, id, ...(sql.includes('$2') ? [op] : [])]]);
      return { subjects: [id, u], probe: touchLot(id) };
    },
  };
}
Object.assign(fixtures, {
  'CONTROL zero-value UNCLASSIFIED lot of a classified user, no review': {
    expected: [],
    plant: async (tx: Tx, f: PurchasedFixture) => {
      const id = uid('c-zero'); const op = uid('op');
      await asLegacy(tx, [operationSql(op, f.buyer.id, id), lotSql(id, f.buyer.id, { lotClass: 'UNCLASSIFIED', sourceOperationId: op })]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
  'CONTROL unreviewed UNCLASSIFIED value of a not-yet-classified user (awaits replay)': {
    expected: [],
    plant: async (tx: Tx) => {
      const u = uid('c-unclassified'); const id = uid('c-unclassified-lot');
      await asLegacy(tx, [bareUserSql(u), walletSql(u, 10), accountSql(u, false),
        ...journaledLot(u, id, 'UNCLASSIFIED', 10).statements]);
      return { subjects: [id, u], probe: touchLot(id) };
    },
  },
  'CONTROL UNCLASSIFIED value of a classified user under a FIRST_APPROVED review': {
    expected: [],
    plant: async (tx: Tx, f: PurchasedFixture) => {
      const id = uid('c-first'); const review = uid('c-first-row');
      await asLegacy(tx, [...journaledLot(f.buyer.id, id, 'UNCLASSIFIED', 10).statements, walletDeltaSql(f.buyer.id, 10),
        reviewSql(review, f.buyer.id, id, 10, 'FIRST_APPROVED', { first: f.superAdmin.id, second: '' }),
        ['UPDATE "legacy_balance_reviews" SET "secondApproverId" = NULL WHERE "id" = $1', review],
        ['UPDATE "coin_provenance" SET "reviewId" = $2 WHERE "id" = $1', id, review]]);
      return { subjects: [id, f.buyer.id], probe: touchLot(id) };
    },
  },
});

async function gateCategories(tx: Tx, subjects: string[]): Promise<string[] | 'MISSING'> {
  await tx.$executeRawUnsafe('SAVEPOINT integrity_gate');
  try {
    const rows = await tx.$queryRawUnsafe<{ category: string }[]>(
      'SELECT DISTINCT "category" FROM "ledger_integrity_anomalies"() WHERE "subjectId" = ANY($1::text[]) ORDER BY 1', subjects);
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT integrity_gate');
    return rows.map((row) => row.category);
  } catch {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT integrity_gate');
    return 'MISSING';
  }
}

async function preflightCategories(tx: Tx, subjects: string[]): Promise<string[] | 'MISSING'> {
  let collect: ((db: Tx, mode: 'UPGRADED') => Promise<{ category: string; subjectId: string | null }[]>) | undefined;
  try {
    ({ collectLedgerIntegrityAnomalies: collect } = await import('../economy/ledger-upgrade-preflight.js'));
  } catch {
    return 'MISSING';
  }
  const rows = await collect!(tx, 'UPGRADED');
  return [...new Set(rows.filter((row) => row.subjectId !== null && subjects.includes(row.subjectId))
    .map((row) => row.category))].sort();
}

describe('ledger integrity: gate, preflight, checker and database guards classify every fixture identically', () => {
  let f: () => Promise<PurchasedFixture>;
  let other: PurchasedFixture;
  beforeAll(async () => {
    other = await purchasedFixture(500);
    f = () => purchasedFixture(1000);
  });

  for (const [name, fixture] of Object.entries(fixtures)) {
    it(name, async () => {
      const base = await f();
      const observed = await inRolledBackTransaction(async (tx) => {
        const { subjects, probe } = await fixture.plant(tx, base, other);
        const gate = await gateCategories(tx, subjects);
        const preflight = await preflightCategories(tx, subjects);
        const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
        const database = await constraintVerdict(tx, probe);
        return { gate, preflight, checkerFlags: scan.violations.map((v) => v.invariant.split(' ')[0]), database };
      });
      const anomalous = fixture.expected.length > 0;
      expect({
        gate: observed.gate,
        preflight: observed.preflight,
        checkerFlagged: observed.checkerFlags.length > 0,
        databaseRejects: observed.database.startsWith('rejects'),
      }, JSON.stringify(observed)).toEqual({
        gate: [...fixture.expected].sort(),
        preflight: [...fixture.expected].sort(),
        checkerFlagged: anomalous,
        databaseRejects: anomalous,
      });
      if (anomalous) expect(observed.checkerFlags).toContain('I15');
    });
  }

  it('the checker\'s I15 invariant is backed by the same database function as the gate', async () => {
    const observed = await inRolledBackTransaction(async (tx) => {
      const u = uid('i15'); await asLegacy(tx, [bareUserSql(u), accountSql(u, false)]);
      const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
      return scan.violations.find((v) => v.invariant.startsWith('I15'));
    });
    expect(observed?.sample.some((sample) => sample.startsWith('WALLET_MISSING:'))).toBe(true);
  });

  it('an anomaly keeps every platform gate closed: the invariant run that would open them fails', async () => {
    const admin = await user('i15-gate-admin', 'SUPER_ADMIN');
    const outcome = await inRolledBackTransaction(async (tx) => {
      const u = uid('i15-gate'); await asLegacy(tx, [bareUserSql(u), accountSql(u, false)]);
      const scan = await runLedgerInvariantCheckInTransaction(tx, null, false);
      await tx.$executeRawUnsafe('SAVEPOINT open_gate');
      try {
        // Never opened by the test bootstrap, so this is a real closed-to-open transition.
        await tx.platformGate.update({ where: { key: 'COINS_COMPETITION_PRIZES' }, data: {
          enabled: true, lastInvariantRunId: scan.runId, changedBy: admin.id, changedAt: new Date() } });
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        return { passed: scan.passed, opened: true };
      } catch {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT open_gate');
        return { passed: scan.passed, opened: false };
      }
    });
    expect(outcome).toEqual({ passed: false, opened: false });
  });
});
