import { prisma } from '@socialplay/database';
import type { Prisma } from '@socialplay/database';
import { splitPayout } from './coin-allocator.js';

// Release evidence is supplied by the internal release runner, never by an
// HTTP request. The SQL scan cannot prove replay-first behavior on its own.
export interface LedgerBehaviorEvidence {
  apiSuitePassed: boolean;
  exactReplayZeroWritesPassed: boolean;
  deterministicRacesPassed: boolean;
  financialMutationsCaught: boolean;
  migrationReplayPassed: boolean;
  runId: string;
}

export interface LedgerViolation {
  invariant: string;
  count: number;
  sample: string[];
  detail?: string;
}

type Tx = Prisma.TransactionClient;

type CountRow = { count: number; sample: string[] | null };

async function collectCount(tx: Tx, invariant: string, sql: string): Promise<LedgerViolation | null> {
  // Only compile-time SQL strings below are passed here; no user value may be
  // interpolated into a query. Each returns count and at most ten identifiers.
  const rows = (await tx.$queryRawUnsafe(sql)) as CountRow[];
  const row = rows[0];
  if (!row || row.count === 0) return null;
  return { invariant, count: row.count, sample: row.sample ?? [] };
}

const checks: ReadonlyArray<[string, string]> = [
  // CORRECTION 1: ADMIN_QUALIFY is reserved/disabled — no operation of this
  // type, and no lot entry attributed to one, may ever exist. This is a
  // second, independent line of defense behind the INSERT-time trigger in
  // migration 20260923110000_opus_reserve_admin_qualify.
  ['I0 ADMIN_QUALIFY minting is disabled', `
    WITH failures AS (
      SELECT o."id" AS id FROM "economic_operations" o WHERE o."type"='ADMIN_QUALIFY'
      UNION
      SELECT e."id" AS id FROM "coin_lot_entries" e
      JOIN "economic_operations" o ON o."id"=e."operationId"
      WHERE o."type"='ADMIN_QUALIFY'
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I1 wallet = available lots', `
    WITH balances AS (
      SELECT a."userId" AS id, w."coinsBalance" AS wallet,
             COALESCE(SUM(p."availableAmount"), 0)::bigint AS lots
      FROM "coin_ledger_accounts" a
      LEFT JOIN "wallets" w ON w."userId" = a."userId"
      LEFT JOIN "coin_provenance" p ON p."userId" = a."userId"
      WHERE a."classifiedAt" IS NOT NULL
      GROUP BY a."userId", w."coinsBalance"
    ), failures AS (SELECT id FROM balances WHERE wallet IS NULL OR wallet <> lots)
    SELECT COUNT(*)::int AS count,
           COALESCE((array_agg(id ORDER BY id))[1:10], ARRAY[]::text[]) AS sample
    FROM failures`],
  ['I2 entry-maintained nonnegative lot caches', `
    WITH failures AS (
      SELECT p."id" AS id
      FROM "coin_provenance" p
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(e."availableDelta"),0)::bigint AS available,
               COALESCE(SUM(e."reservedDelta"),0)::bigint AS reserved,
               COALESCE(SUM(e."progressDelta"),0)::bigint AS progress,
               COALESCE(SUM(e."progressDelta"+e."obligationDelta"),0)::bigint AS requirement
        FROM "coin_lot_entries" e WHERE e."lotId"=p."id"
      ) j ON true
      WHERE p."lotClass" IS NOT NULL AND (
        p."availableAmount" IS NULL OR p."reservedAmount" IS NULL
        OR p."progressAmount" IS NULL OR p."requirementAmount" IS NULL
        OR p."availableAmount" < 0 OR p."reservedAmount" < 0
        OR p."progressAmount" < 0 OR p."requirementAmount" < p."progressAmount"
        OR p."availableAmount" <> j.available OR p."reservedAmount" <> j.reserved
        OR p."progressAmount" <> j.progress OR p."requirementAmount" <> j.requirement
      )
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I3 financial history triggers present', `
    WITH expected(tab, trigger_name) AS (VALUES
      ('economic_operations','economic_operations_append_only'),
      ('coin_lot_entries','coin_lot_entries_append_only'),
      ('coin_lot_entries','purchase_settlement_proof_guard'),
      ('wallet_transactions','wallet_transactions_append_only'),
      ('coin_provenance','coin_provenance_no_delete'),
      ('coin_allocations','coin_allocations_frozen'),
      ('agent_order_settlements','agent_order_settlements_append_only'),
      ('agent_orders','settled_agent_order_proof_immutable'),
      ('agent_reservations','settled_agent_reservation_proof_immutable')
    ), failures AS (
      SELECT trigger_name AS id FROM expected x
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relname=x.tab AND t.tgname=x.trigger_name
          AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
      )
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I4 operation identity indexes present', `
    WITH expected(name) AS (VALUES
      ('economic_operations_scope_key'),('economic_operations_user_type_key_unique'),
      ('coin_lot_entries_reversesEntryId_key'),('country_casino_policies_one_active_per_country')
    ), failures AS (
      SELECT name AS id FROM expected x WHERE NOT EXISTS (
        SELECT 1 FROM pg_indexes i WHERE i.schemaname=current_schema() AND i.indexname=x.name
      )
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I5 withdrawable credit operation whitelist', `
    WITH failures AS (
      SELECT e."id" AS id FROM "coin_lot_entries" e
      JOIN "coin_provenance" p ON p."id"=e."lotId"
      JOIN "economic_operations" o ON o."id"=e."operationId"
      WHERE p."lotClass"='WITHDRAWABLE' AND e."availableDelta">0
        AND NOT (
          (o."type"='PURCHASE' AND e."entryType"='MINT' AND EXISTS (
            SELECT 1 FROM "agent_orders" a
            JOIN "agent_reservations" r ON r."orderId"=a."id"
            JOIN "agent_order_settlements" s ON s."orderId"=a."id"
            JOIN "wallet_transactions" wt ON wt."id"=s."walletTransactionId"
            WHERE o."scopeType"='AGENT_ORDER' AND o."scopeId"=a."id"
              AND o."userId"=a."userId" AND o."createdBy"=s."releasedBy"
              AND a."status"='COMPLETED' AND a."coinAmount"=e."availableDelta"
              AND r."id"=s."reservationId" AND r."agentId"=a."agentId"
              AND r."status"='CONSUMED' AND r."amount"=a."coinAmount"
              AND s."coinAmount"=a."coinAmount"
              AND cardinality(o."walletTransactionIds")=1
              AND o."walletTransactionIds"[1]=wt."id"
              AND wt."userId"=o."userId" AND wt."currency"='COINS'
              AND wt."type"='COIN_CREDIT' AND wt."ledgerType"='CREDIT'
              AND wt."status"='SUCCEEDED' AND wt."referenceType"='AGENT_ORDER'
              AND wt."referenceId"=a."id" AND wt."amount"=a."coinAmount"
              AND wt."balanceAfter"-wt."balanceBefore"=a."coinAmount"
              AND p."userId"=o."userId" AND p."sourceOperationId"=o."id"
              AND p."walletTransactionId"=wt."id"
              AND (SELECT COUNT(*) FROM "coin_lot_entries" minted
                   WHERE minted."operationId"=o."id" AND minted."entryType"='MINT')=1
          )) OR
          (o."type"='BONUS_CONVERSION' AND e."entryType"='CONVERT_IN') OR
          (o."type"='PAYOUT' AND e."entryType"='RETURN') OR
          (o."type"='WITHDRAWAL_RELEASE' AND e."entryType"='RELEASE') OR
          (o."type"='COMPETITION_RELEASE' AND e."entryType"='RELEASE') OR
          (o."type"='LEGACY_OPENING' AND o."scopeType"='AGENT_ORDER'
            AND e."entryType"='RECLASS_IN' AND o."snapshot" ? 'ledgerReplayHash') OR
          (o."type"='LEGACY_RESOLVE' AND e."entryType"='RECLASS_IN'
            AND o."snapshot" ? 'evidence' AND o."snapshot" ? 'firstApproverId'
            AND o."snapshot" ? 'secondApproverId') OR
          (o."type"='COMPENSATION' AND e."reversesEntryId" IS NOT NULL)
        )
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I7 restricted obligation conservation', `
    WITH totals AS (
      SELECT o."id", o."type", COALESCE(SUM(e."obligationDelta"),0) AS obligation,
             COALESCE(SUM(e."progressDelta"),0) AS progress
      FROM "economic_operations" o LEFT JOIN "coin_lot_entries" e ON e."operationId"=o."id"
      GROUP BY o."id",o."type"
    ), failures AS (
      SELECT "id" FROM totals WHERE
        ("type"='WAGER' AND obligation<>-progress) OR
        ("type" IN ('PAYOUT','P2P_TRANSFER','COMPETITION_ESCROW','COMPETITION_RELEASE',
                    'COMPETITION_PAYOUT','BONUS_CONVERSION') AND obligation<>0)
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg("id" ORDER BY "id"))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I8 conversion is unique and terminal', `
    WITH failures AS (
      SELECT p."id" AS id FROM "coin_provenance" p
      WHERE p."state"='CONVERTED' AND (
        p."lotClass"<>'RESTRICTED' OR p."availableAmount"<>0 OR p."reservedAmount"<>0
        OR p."progressAmount"<p."requirementAmount" OR
        (SELECT COUNT(*) FROM "economic_operations" o
         WHERE o."type"='BONUS_CONVERSION' AND o."scopeType"='LOT' AND o."scopeId"=p."id")<>1
      )
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I9 exact entry reversals', `
    WITH failures AS (
      SELECT e."id" AS id FROM "coin_lot_entries" e
      JOIN "coin_lot_entries" src ON src."id"=e."reversesEntryId"
      JOIN "economic_operations" o ON o."id"=e."operationId"
      JOIN "coin_provenance" target ON target."id"=e."lotId"
      JOIN "coin_provenance" original ON original."id"=src."lotId"
      WHERE o."reversesOperationId" IS DISTINCT FROM src."operationId"
         OR e."userId"<>src."userId"
         OR (e."lotId"<>src."lotId" AND
             (target."parentLotId" IS DISTINCT FROM src."lotId"
              OR target."lotClass" IS DISTINCT FROM original."lotClass"
              OR target."availableAt" IS DISTINCT FROM original."availableAt"))
         OR (e."entryType"='RELEASE' AND
             (src."entryType"<>'RESERVE' OR e."availableDelta"<>-src."availableDelta"
              OR e."reservedDelta"<>-src."reservedDelta"))
         OR (e."entryType"='FINALIZE' AND
             (src."entryType"<>'RESERVE' OR e."availableDelta"<>0
              OR e."reservedDelta"<>-src."reservedDelta"))
         OR (o."type"='COMPENSATION' AND
             (e."availableDelta"<>-src."availableDelta"
              OR e."reservedDelta"<>-src."reservedDelta"
              OR e."progressDelta"<>-src."progressDelta"
              OR e."obligationDelta"<>-src."obligationDelta"))
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I10 no Game Points debit to Coins credit', `
    WITH failures AS (
      SELECT o."id" AS id FROM "economic_operations" o
      JOIN "wallet_transactions" w ON w."id"=ANY(o."walletTransactionIds")
      GROUP BY o."id"
      HAVING BOOL_OR(w."currency"='GAME_POINTS' AND w."ledgerType"='DEBIT')
         AND BOOL_OR(w."currency"='COINS' AND w."ledgerType"='CREDIT')
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I11 policy pointer and pinned versions', `
    WITH failures AS (
      SELECT 'country:'||p."countryCode" AS id
      FROM "country_casino_policies" p WHERE p."state"='ACTIVE'
      GROUP BY p."countryCode" HAVING COUNT(*)>1
      UNION ALL
      SELECT 'pointer:'||j."countryCode" FROM "country_jurisdictions" j
      LEFT JOIN "country_casino_policies" p ON p."id"=j."activePolicyId"
      WHERE (j."activePolicyId" IS NOT NULL AND
             (p."countryCode" IS DISTINCT FROM j."countryCode" OR p."state"<>'ACTIVE'))
         OR (j."activePolicyId" IS NULL AND EXISTS (
              SELECT 1 FROM "country_casino_policies" q
              WHERE q."countryCode"=j."countryCode" AND q."state"='ACTIVE'))
      UNION ALL
      SELECT 'operation:'||o."id" FROM "economic_operations" o
      LEFT JOIN "country_casino_policies" p ON p."id"=o."countryPolicyId"
      WHERE o."type" IN ('WAGER','PAYOUT','BONUS_GRANT','WITHDRAWAL_HOLD','BONUS_CONVERSION')
        AND (p."id" IS NULL OR p."version" IS DISTINCT FROM o."countryPolicyVersion")
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I12 active withdrawal reservations', `
    WITH totals AS (
      SELECT h."id",h."coinAmount",h."holdOperationId",h."status",
             COALESCE(SUM(CASE WHEN e."entryType"='RESERVE' THEN e."reservedDelta" ELSE 0 END),0) AS held,
             COALESCE(SUM(CASE WHEN e."entryType"='RESERVE' AND rev."id" IS NOT NULL THEN 1 ELSE 0 END),0) AS reversed
      FROM "withdrawal_holds" h
      LEFT JOIN "coin_lot_entries" e ON e."operationId"=h."holdOperationId"
      LEFT JOIN "coin_lot_entries" rev ON rev."reversesEntryId"=e."id"
      GROUP BY h."id",h."coinAmount",h."holdOperationId",h."status"
    ), failures AS (
      SELECT "id" FROM totals WHERE
        ("status"='ACTIVE' AND
         ("holdOperationId" IS NULL OR held<>"coinAmount" OR reversed<>0))
        OR ("status" IN ('CONSUMED','REFUNDED') AND "holdOperationId" IS NOT NULL
            AND reversed<>(SELECT COUNT(*) FROM "coin_lot_entries" e
                            WHERE e."operationId"=totals."holdOperationId"
                              AND e."entryType"='RESERVE'))
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg("id" ORDER BY "id"))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['I13 Trivia has zero stake', `
    WITH failures AS (
      SELECT s."id" AS id FROM "game_sessions" s
      WHERE s."mode"='BONUS' AND (s."betAmount"<>0 OR EXISTS (
        SELECT 1 FROM "wallet_transactions" w
        WHERE w."referenceType"='GAME' AND w."referenceId"=s."id"
          AND w."currency"='COINS' AND w."ledgerType"='DEBIT'
      ))
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  ['Review-required value has open review', `
    WITH failures AS (
      SELECT p."id" AS id FROM "coin_provenance" p
      JOIN "coin_ledger_accounts" a ON a."userId"=p."userId" AND a."classifiedAt" IS NOT NULL
      LEFT JOIN "legacy_balance_reviews" r ON r."id"=p."reviewId"
      WHERE p."lotClass"='UNCLASSIFIED'
        AND (COALESCE(p."availableAmount",0)+COALESCE(p."reservedAmount",0))>0
        AND (r."id" IS NULL OR r."status" NOT IN ('OPEN','FIRST_APPROVED')
             OR r."userId"<>p."userId")
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
  // The ledger upgrade gate's own definitions (migration
  // 20260924000000_ledger_integrity_gate), evaluated by the same database
  // function the gate ran, so this scan and the gate cannot disagree. A
  // missing function makes the whole scan fail, keeping every gate closed.
  ['I15 ledger integrity (upgrade gate definitions)', `
    WITH failures AS (
      SELECT a."category" || ':' || COALESCE(a."subjectId", 'NULL') AS id
      FROM "ledger_integrity_anomalies"() a
    ) SELECT COUNT(*)::int AS count,
       COALESCE((array_agg(id ORDER BY id))[1:10],ARRAY[]::text[]) AS sample FROM failures`],
];

async function checkPayoutSplits(tx: Tx): Promise<LedgerViolation | null> {
  const payouts = await tx.economicOperation.findMany({
    where: { type: 'PAYOUT' }, select: { id: true, scopeType: true, scopeId: true, walletTransactionIds: true },
    orderBy: { id: 'asc' },
  });
  const failures: string[] = [];
  for (const payout of payouts) {
    const wager = await tx.economicOperation.findUnique({
      where: { type_scopeType_scopeId: { type: 'WAGER', scopeType: payout.scopeType, scopeId: payout.scopeId } },
      select: { id: true },
    });
    if (!wager) { failures.push(payout.id); continue; }
    const stakeEntries = await tx.coinLotEntry.findMany({
      where: { operationId: wager.id, entryType: 'CONSUME' },
      include: { lot: { select: { lotClass: true, expiresAt: true } } },
      orderBy: { sequence: 'asc' },
    });
    const creditRows = await tx.walletTransaction.findMany({
      where: { id: { in: payout.walletTransactionIds }, currency: 'COINS',
        type: 'COIN_CREDIT', ledgerType: 'CREDIT', status: 'SUCCEEDED' },
      select: { amount: true },
    });
    if (creditRows.length !== payout.walletTransactionIds.length || stakeEntries.length === 0) {
      failures.push(payout.id); continue;
    }
    const amount = creditRows.reduce((sum: number, row: { amount: number }) => sum + row.amount, 0);
    const actual = await tx.coinLotEntry.findMany({
      where: { operationId: payout.id, entryType: 'RETURN' },
      select: { lotId: true, availableDelta: true },
    });
    try {
      const expected = splitPayout(stakeEntries.map((entry) => {
        if (!entry.lot.lotClass) throw new Error('stake entry lot has no lotClass');
        return {
          lotId: entry.lotId,
          lotClass: entry.lot.lotClass,
          amount: -entry.availableDelta,
          expiresAt: entry.lot.expiresAt,
        };
      }), amount);
      const byLot = new Map<string, number>();
      for (const entry of actual) byLot.set(entry.lotId, (byLot.get(entry.lotId) ?? 0) + entry.availableDelta);
      if (actual.reduce((sum, entry) => sum + entry.availableDelta, 0) !== amount
          || expected.some((share) => (byLot.get(share.lotId) ?? 0) !== share.amount)
          || byLot.size !== expected.filter((share) => share.amount > 0).length) {
        failures.push(payout.id);
      }
    } catch {
      failures.push(payout.id);
    }
  }
  return failures.length ? { invariant: 'I6 proportional payout and wallet credit',
    count: failures.length, sample: failures.slice(0, 10) } : null;
}

export async function runLedgerInvariantCheckInTransaction(
  tx: Tx, evidence: LedgerBehaviorEvidence | null,
  requireReleaseEvidence = false,
): Promise<{ runId: string; passed: boolean; violations: LedgerViolation[] }> {
  const run = await tx.invariantCheckRun.create({ data: { startedAt: new Date() } });
  const violations: LedgerViolation[] = [];
  for (const [invariant, sql] of checks) {
    const violation = await collectCount(tx, invariant, sql);
    if (violation) violations.push(violation);
  }
  const payout = await checkPayoutSplits(tx);
  if (payout) violations.push(payout);
  if (requireReleaseEvidence && (!evidence || !evidence.runId || !evidence.apiSuitePassed
      || !evidence.exactReplayZeroWritesPassed || !evidence.deterministicRacesPassed
      || !evidence.financialMutationsCaught || !evidence.migrationReplayPassed)) {
    violations.push({ invariant: 'I14 and release behavior evidence', count: 1, sample: [],
      detail: 'Missing passing API, replay, race, mutation, or migration evidence' });
  }
  const passed = violations.length === 0;
  await tx.invariantCheckRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), passed, violations: violations as unknown as Prisma.InputJsonValue },
  });
  return { runId: run.id, passed, violations };
}

/** Database-only scan for migration and test bootstrap; it does not attest I14. */
export async function runLedgerInvariantCheck(evidence: LedgerBehaviorEvidence | null = null) {
  return prisma.$transaction((tx) => runLedgerInvariantCheckInTransaction(tx, evidence, evidence !== null),
    { isolationLevel: 'Serializable', timeout: 120_000 });
}
