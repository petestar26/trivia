/**
 * The single definition of a ledger-integrity anomaly.
 *
 * The predicates below read six relations (ledger_accounts, ledger_wallets,
 * ledger_lots, ledger_entries, ledger_operations, ledger_reviews). Two
 * sources provide them:
 *   - LEDGER_SOURCE_CURRENT reads the upgraded ledger tables. It backs the
 *     "ledger_integrity_anomalies"() function that the final upgrade gate,
 *     the runtime invariant checker (I15) and the preflight all evaluate.
 *   - LEDGER_SOURCE_PROJECTED reads a pre-upgrade (master) schema and
 *     projects exactly what the upgrade migrations will create from it
 *     (20260922050000 backfill and 20260923030000 opening journal): one
 *     unclassified account per wallet, one UNCLASSIFIED opening lot per
 *     positive balance, and one reserved UNCLASSIFIED lot under an OPEN
 *     legacy review per ACTIVE withdrawal hold.
 *
 * Migrations cannot import code, so 20260917900000_ledger_preupgrade_gate and
 * 20260924000000_ledger_integrity_gate carry copies of these blocks between
 * `-- ledger-integrity:<name>:begin/end` markers, and a test fails if any
 * copy differs from this file.
 *
 * SQL NULL is handled explicitly throughout: IS DISTINCT FROM instead of =
 * or <>, COALESCE only where an absent row genuinely means zero, and outer
 * joins or NOT EXISTS wherever a missing row is itself the anomaly.
 */

export const LEDGER_ANOMALY_CATEGORIES = [
  'GAME_RULES_CHANGED',
  'LOT_STATE_NULL',
  'LOT_CACHE_NULL',
  'LOT_PARTIALLY_LEGACY',
  'LEGACY_LOT_OF_CLASSIFIED_OWNER',
  'WALLET_MISSING',
  'WALLET_LOT_MISMATCH',
  'CACHE_JOURNAL_MISMATCH',
  'SOURCE_OPERATION_MISSING',
  'SOURCE_OPERATION_INVALID',
  'SOURCE_OPERATION_CROSS_USER',
  'UNCLASSIFIED_VALUE_UNREVIEWED',
] as const;
export type LedgerAnomalyCategory = typeof LEDGER_ANOMALY_CATEGORIES[number];

export const LEDGER_SOURCE_CURRENT = `
ledger_accounts AS (
  SELECT a."userId" AS user_id, (a."classifiedAt" IS NOT NULL) AS classified
  FROM "coin_ledger_accounts" a
),
ledger_wallets AS (
  SELECT w."userId" AS user_id, w."coinsBalance"::bigint AS coins_balance
  FROM "wallets" w
),
ledger_lots AS (
  SELECT p."id" AS id, p."userId" AS user_id, p."lotClass"::text AS lot_class, p."state"::text AS state,
         p."availableAmount"::bigint AS available, p."reservedAmount"::bigint AS reserved,
         p."requirementAmount"::bigint AS requirement, p."progressAmount"::bigint AS progress,
         p."sourceOperationId" AS source_operation_id, p."reviewId" AS review_id
  FROM "coin_provenance" p
),
ledger_entries AS (
  SELECT e."lotId" AS lot_id, e."availableDelta"::bigint AS available_delta,
         e."reservedDelta"::bigint AS reserved_delta, e."progressDelta"::bigint AS progress_delta,
         e."obligationDelta"::bigint AS obligation_delta
  FROM "coin_lot_entries" e
),
ledger_operations AS (
  SELECT o."id" AS id, o."userId" AS user_id
  FROM "economic_operations" o
),
ledger_reviews AS (
  SELECT r."id" AS id, r."userId" AS user_id, r."status"::text AS status
  FROM "legacy_balance_reviews" r
)
`;

// Mirrors the upgrade on master-era data, where coin_provenance and
// coin_allocations do not exist yet: the backfill mints each positive
// balance as one lot (requirement 2,000,000,000, no progress), and the
// opening journal turns every ACTIVE hold into a reserved lot under an OPEN
// review. A hold whose withdrawal row is missing is kept (with a NULL owner)
// so it is reported instead of silently vanishing as an inner join would.
export const LEDGER_SOURCE_PROJECTED = `
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
`;

export const LEDGER_ANOMALY_PREDICATES = `
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
`;

// Pre-upgrade only. The upgrade hashes each legacy game's stored
// configuration as its immutable v1 rules and verifies the hash against fixed
// literals (20260922060000). A configuration that differs from the one this
// release verifies would stop that migration after the casino schema already
// exists, so the pre-upgrade gate refuses it first. jsonb equality compares
// numbers by value, exactly like the canonical rules hash: the pre-casino
// API's 0.1 equals the seed's 0.10, while 0.11 is a genuine rule change.
export const LEGACY_CATALOG_PRECONDITIONS = `
SELECT 'GAME_RULES_CHANGED'::text AS category, 'game'::text AS subject_type, d."key" AS subject_id,
       NULL::text AS user_id,
       format('legacy game %s is configured as %s, but this release verifies its rules as %s (numbers compare by value)',
              d."key", COALESCE(d."configuration"::text, 'NULL'), e.expected::text) AS detail
FROM "game_definitions" d
JOIN (VALUES
  ('lucky_spin', '{"outcomes": [{"name": "LOSE", "multiplier": 0, "probability": 0.45}, {"name": "SMALL_WIN", "multiplier": 1.5, "probability": 0.25}, {"name": "MEDIUM_WIN", "multiplier": 3, "probability": 0.15}, {"name": "LARGE_WIN", "multiplier": 5, "probability": 0.10}, {"name": "JACKPOT", "multiplier": 10, "probability": 0.05}]}'::jsonb),
  ('dice', '{"winThreshold": 7, "multiplier": 2}'::jsonb),
  ('number_challenge', '{"range": {"min": 1, "max": 100}, "rewards": {"exact": 5, "within1": 3, "within5": 2, "within10": 1.5}}'::jsonb)
) AS e(game_key, expected) ON e.game_key = d."key"
WHERE d."configuration" IS DISTINCT FROM e.expected
`;

/** The complete query for one source; also the exact body of the database
 * function "ledger_integrity_anomalies"() (source = LEDGER_SOURCE_CURRENT).
 * The pre-upgrade form also evaluates the legacy catalog preconditions. */
export function buildAnomalyQuery(source: string, preconditions?: string): string {
  return `WITH
${source}
, anomalies AS (
${LEDGER_ANOMALY_PREDICATES}${preconditions ? `
UNION ALL
${preconditions}` : ''}
)
SELECT a.category, a.subject_type, a.subject_id, a.user_id, a.detail
FROM anomalies a
ORDER BY a.category, a.subject_id NULLS FIRST`;
}

export const LEDGER_FUNCTION_BODY = buildAnomalyQuery(LEDGER_SOURCE_CURRENT);

/** Comparison form: SQL comments removed, whitespace collapsed. */
export function normalizeSql(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
}
