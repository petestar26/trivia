-- Ledger upgrade, pre-upgrade gate. Runs before any ledger migration, on the
-- supported pre-upgrade (master) schema, and changes nothing.
--
-- It projects exactly what the following migrations will create from the
-- existing data (the 20260922050000 backfill and the 20260923030000 opening
-- journal) and evaluates the same ledger-integrity definitions as the final
-- gate (20260924000000), the runtime invariant checker (I15) and the
-- read-only preflight (pnpm --filter api preflight:ledger-upgrade). The
-- blocks between the ledger-integrity markers are copies of
-- apps/api/src/economy/ledger-integrity-definitions.ts; a test fails if they
-- ever differ.
--
-- If this gate stops the upgrade, nothing has been changed and the running
-- application is unaffected. Follow docs/deployment/ledger-upgrade-gate.md.
DO $gate$
DECLARE
  gate_total integer;
  gate_summary text;
BEGIN
  WITH
-- ledger-integrity:source-projected:begin
ledger_accounts AS (
  SELECT DISTINCT w."userId" AS user_id, false AS classified
  FROM "wallets" w
),
ledger_wallets AS (
  SELECT w."userId" AS user_id, w."coinsBalance"::bigint AS coins_balance
  FROM "wallets" w
),
projected_balances AS (
  SELECT w."userId" AS user_id, w."coinsBalance"::bigint AS amount
  FROM "wallets" w
  WHERE w."coinsBalance" > 0
),
projected_holds AS (
  SELECT h."id" AS hold_id, h."withdrawalId" AS withdrawal_id, d."userId" AS user_id,
         h."coinAmount"::bigint AS coin_amount
  FROM "withdrawal_holds" h
  LEFT JOIN "withdrawals" d ON d."id" = h."withdrawalId"
  WHERE h."status"::text = 'ACTIVE'
),
ledger_lots AS (
  SELECT 'projected-balance:' || b.user_id AS id, b.user_id AS user_id, 'UNCLASSIFIED'::text AS lot_class,
         'OPEN'::text AS state, b.amount AS available, 0::bigint AS reserved,
         2000000000::bigint AS requirement, 0::bigint AS progress,
         'projected-balance-opening:' || b.user_id AS source_operation_id, NULL::text AS review_id
  FROM projected_balances b
  UNION ALL
  SELECT 'legacy-hold:' || h.hold_id, h.user_id, 'UNCLASSIFIED'::text, 'OPEN'::text, 0::bigint, h.coin_amount,
         0::bigint, 0::bigint, 'projected-hold-opening:' || h.withdrawal_id, 'legacy-hold-review:' || h.hold_id
  FROM projected_holds h
),
ledger_entries AS (
  SELECT 'projected-balance:' || b.user_id AS lot_id, b.amount AS available_delta, 0::bigint AS reserved_delta,
         0::bigint AS progress_delta, 2000000000::bigint AS obligation_delta
  FROM projected_balances b
  UNION ALL
  SELECT 'legacy-hold:' || h.hold_id, h.coin_amount, 0::bigint, 0::bigint, 0::bigint
  FROM projected_holds h
  UNION ALL
  SELECT 'legacy-hold:' || h.hold_id, -h.coin_amount, h.coin_amount, 0::bigint, 0::bigint
  FROM projected_holds h
),
ledger_operations AS (
  SELECT 'projected-balance-opening:' || b.user_id AS id, b.user_id AS user_id
  FROM projected_balances b
  UNION ALL
  SELECT DISTINCT 'projected-hold-opening:' || h.withdrawal_id, h.user_id
  FROM projected_holds h
),
ledger_reviews AS (
  SELECT 'legacy-hold-review:' || h.hold_id AS id, h.user_id AS user_id, 'OPEN'::text AS status
  FROM projected_holds h
)
-- ledger-integrity:source-projected:end
  , anomalies AS (
-- ledger-integrity:predicates:begin
SELECT 'LOT_STATE_NULL'::text AS category, 'lot'::text AS subject_type, l.id AS subject_id, l.user_id AS user_id,
       format('managed %s lot %s has no state', l.lot_class, l.id) AS detail
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL AND l.state IS NULL
UNION ALL
SELECT 'LOT_CACHE_NULL', 'lot', l.id, l.user_id,
       format('managed lot %s has a NULL cache (available %s, reserved %s, requirement %s, progress %s)',
              l.id, COALESCE(l.available::text, 'NULL'), COALESCE(l.reserved::text, 'NULL'),
              COALESCE(l.requirement::text, 'NULL'), COALESCE(l.progress::text, 'NULL'))
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL
  AND (l.available IS NULL OR l.reserved IS NULL OR l.requirement IS NULL OR l.progress IS NULL)
UNION ALL
SELECT 'LOT_PARTIALLY_LEGACY', 'lot', l.id, l.user_id,
       format('lot %s has no lot class but some ledger fields set; a pre-journal lot keeps all of them NULL', l.id)
FROM ledger_lots l
WHERE l.lot_class IS NULL
  AND (l.state IS NOT NULL OR l.available IS NOT NULL OR l.reserved IS NOT NULL
       OR l.requirement IS NOT NULL OR l.progress IS NOT NULL OR l.source_operation_id IS NOT NULL)
UNION ALL
SELECT 'LEGACY_LOT_OF_CLASSIFIED_OWNER', 'lot', l.id, l.user_id,
       format('pre-journal lot %s belongs to user %s, whose ledger account is already classified', l.id, l.user_id)
FROM ledger_lots l
WHERE l.lot_class IS NULL
  AND EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.user_id = l.user_id AND a.classified)
UNION ALL
SELECT 'WALLET_MISSING', 'user', o.user_id, o.user_id,
       format('user %s has %s but no wallet row', COALESCE(o.user_id, 'NULL'),
              string_agg(DISTINCT o.owns, ' and ' ORDER BY o.owns))
FROM (
  SELECT a.user_id, 'a ledger account'::text AS owns FROM ledger_accounts a
  UNION ALL
  SELECT l.user_id, 'coin lots'::text FROM ledger_lots l
) o
WHERE NOT EXISTS (SELECT 1 FROM ledger_wallets w WHERE w.user_id = o.user_id)
GROUP BY o.user_id
UNION ALL
SELECT 'WALLET_LOT_MISMATCH', 'user', a.user_id, a.user_id,
       format('classified wallet of user %s holds %s Coins but its lots hold %s',
              a.user_id, w.coins_balance, COALESCE(t.total, 0))
FROM ledger_accounts a
LEFT JOIN ledger_wallets w ON w.user_id = a.user_id
LEFT JOIN (
  SELECT l.user_id, SUM(l.available) AS total FROM ledger_lots l GROUP BY l.user_id
) t ON t.user_id = a.user_id
WHERE a.classified
  AND w.user_id IS NOT NULL
  AND w.coins_balance IS DISTINCT FROM COALESCE(t.total, 0)
UNION ALL
SELECT 'CACHE_JOURNAL_MISMATCH', 'lot', l.id, l.user_id,
       format('managed lot %s caches (available %s, reserved %s, requirement %s, progress %s) differ from its journal (%s, %s, %s, %s)',
              l.id, COALESCE(l.available::text, 'NULL'), COALESCE(l.reserved::text, 'NULL'),
              COALESCE(l.requirement::text, 'NULL'), COALESCE(l.progress::text, 'NULL'),
              COALESCE(j.available, 0), COALESCE(j.reserved, 0), COALESCE(j.requirement, 0), COALESCE(j.progress, 0))
FROM ledger_lots l
LEFT JOIN (
  SELECT e.lot_id,
         SUM(e.available_delta) AS available,
         SUM(e.reserved_delta) AS reserved,
         SUM(e.progress_delta) AS progress,
         SUM(COALESCE(e.progress_delta, 0) + COALESCE(e.obligation_delta, 0)) AS requirement
  FROM ledger_entries e
  GROUP BY e.lot_id
) j ON j.lot_id = l.id
WHERE l.lot_class IS NOT NULL
  AND (l.available IS DISTINCT FROM COALESCE(j.available, 0)
       OR l.reserved IS DISTINCT FROM COALESCE(j.reserved, 0)
       OR l.requirement IS DISTINCT FROM COALESCE(j.requirement, 0)
       OR l.progress IS DISTINCT FROM COALESCE(j.progress, 0))
UNION ALL
SELECT 'SOURCE_OPERATION_MISSING', 'lot', l.id, l.user_id,
       format('managed lot %s has no source operation', l.id)
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL AND l.source_operation_id IS NULL
UNION ALL
SELECT 'SOURCE_OPERATION_INVALID', 'lot', l.id, l.user_id,
       format('managed lot %s names source operation %s, which does not exist', l.id, l.source_operation_id)
FROM ledger_lots l
WHERE l.lot_class IS NOT NULL AND l.source_operation_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ledger_operations o WHERE o.id = l.source_operation_id)
UNION ALL
SELECT 'SOURCE_OPERATION_CROSS_USER', 'lot', l.id, l.user_id,
       format('managed lot %s of user %s names source operation %s of user %s',
              l.id, COALESCE(l.user_id, 'NULL'), o.id, COALESCE(o.user_id, 'NULL'))
FROM ledger_lots l
JOIN ledger_operations o ON o.id = l.source_operation_id -- a missing operation is SOURCE_OPERATION_INVALID above
WHERE l.lot_class IS NOT NULL AND o.user_id IS DISTINCT FROM l.user_id
UNION ALL
SELECT 'UNCLASSIFIED_VALUE_UNREVIEWED', 'lot', l.id, l.user_id,
       format('UNCLASSIFIED lot %s of classified user %s holds %s Coins without an open review (review: %s)',
              l.id, l.user_id, COALESCE(l.available, 0) + COALESCE(l.reserved, 0),
              COALESCE(l.review_id || ' is ' || COALESCE(r.status, 'missing') || ' for user ' || COALESCE(r.user_id, 'NULL'), 'none'))
FROM ledger_lots l
LEFT JOIN ledger_reviews r ON r.id = l.review_id
WHERE l.lot_class = 'UNCLASSIFIED'
  AND COALESCE(l.available, 0) + COALESCE(l.reserved, 0) > 0
  AND EXISTS (SELECT 1 FROM ledger_accounts a WHERE a.user_id = l.user_id AND a.classified)
  AND (r.id IS NULL OR r.user_id IS DISTINCT FROM l.user_id
       OR r.status IS NULL OR r.status NOT IN ('OPEN', 'FIRST_APPROVED'))
-- ledger-integrity:predicates:end
  ), by_category AS (
    SELECT a.category, count(*) AS n,
           array_to_string((array_agg(COALESCE(a.subject_id, 'NULL') ORDER BY a.subject_id))[1:10], ', ') AS sample
    FROM anomalies a
    GROUP BY a.category
  )
  SELECT COALESCE(sum(c.n), 0)::integer,
         string_agg(format('%s x%s [%s]', c.category, c.n, c.sample), '; ' ORDER BY c.category)
    INTO gate_total, gate_summary
  FROM by_category c;

  IF gate_total > 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('LEDGER PRE-UPGRADE GATE STOPPED THE UPGRADE before any ledger migration ran: upgrading this data would create %s anomalous ledger record(s): %s', gate_total, gate_summary),
      DETAIL = 'This migration changed nothing and no ledger table exists yet; the running application is unaffected.',
      HINT = 'Run the read-only preflight (pnpm --filter api preflight:ledger-upgrade) to list every record, then follow docs/deployment/ledger-upgrade-gate.md: escalate each record for a separately reviewed, case-specific correction. Never mark this migration as applied.';
  END IF;
END
$gate$;
